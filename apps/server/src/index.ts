import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { findWikiLinks, parseTasks } from '@spark/core/markdown';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { BRAINDUMP_SYSTEM, aiEnabled, aiSettings, streamCompletion } from './ai.js';
import type { AiProvider, AiSettings } from './ai-settings.js';
import { AuthStore, authorizeUrl, exchangeCode, fetchGitHubUser } from './auth.js';
import { ChatStore, type ChatToolCall } from './chats.js';
import { config } from './config.js';
import { FileStore, MAX_UPLOAD } from './files.js';
import { githubSettings } from './github-settings.js';
import { GitService } from './git.js';
import { MemoryStore, type MemoryKind } from './memory.js';
import { clearEmbeddings, embeddingsEnabled } from './retrieval.js';
import { describeSandbox, sandboxEnabled, sandboxRuntime } from './sandbox.js';
import { skills } from './skills.js';
import { seedSpace } from './seed.js';
import { FileSpace, InvalidPageName, PageNotFound, RevisionConflict } from './space.js';
import { runSpark, type SparkContext } from './spark.js';
import { SPARK_TOOLS } from './spark-tools.js';

const space = new FileSpace(config.spaceDir);
const auth = new AuthStore();
const gitService = new GitService(space, () => auth.token());
const chats = new ChatStore();
const memory = new MemoryStore(space);
const files = new FileStore(config.spaceDir);

const app = new Hono();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

app.get('/api/config', (c) =>
  c.json({
    spaceName: config.spaceName,
    ai: aiEnabled(),
    git: true,
    githubAuth: githubSettings.enabled(),
    user: auth.user(),
    // Capabilities the *server* decides, which the client cannot infer from a
    // preference: whether vectors are available, and whether this machine will
    // run code at all. The UI has to describe what is possible, not what was
    // asked for.
    embeddings: embeddingsEnabled(),
    sandbox: sandboxEnabled() ? { runtime: sandboxRuntime(), describe: describeSandbox() } : null,
  }),
);

/**
 * Runtime shim for the plugin SDK.
 *
 * Space plugins are loaded as real ES modules, so their
 * `import { definePlugin } from '@spark/plugin-sdk'` has to resolve to
 * something. The SDK is types-only at runtime, so this is all it needs to be.
 */
app.get('/plugin-sdk.js', (c) =>
  c.body('export const definePlugin = (plugin) => plugin;\nexport default { definePlugin };\n', 200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-cache',
  }),
);

// ---------------------------------------------------------------------------
// Space
// ---------------------------------------------------------------------------

app.get('/api/space', async (c) => c.json(await space.list()));

/**
 * Folders, including the empty ones.
 *
 * A folder is otherwise only implied by a page name containing a slash, which
 * means one you just created and have not filled yet does not exist as far as
 * the client can tell. It exists on disk, so the navigator should show it.
 */
app.get('/api/folders', async (c) => c.json(await space.listFolders()));

app.post('/api/folders', async (c) => {
  const { name } = (await c.req.json()) as { name?: string };
  if (!name) return c.text('missing "name"', 400);
  return c.json({ name: await space.createFolder(name) });
});

app.on('HEAD', '/api/space/:name{.+}', async (c) => {
  const name = decodePageName(c.req.param('name'));
  return c.body(null, (await space.exists(name)) ? 200 : 404);
});

app.get('/api/space/:name{.+}', async (c) => {
  const name = decodePageName(c.req.param('name'));
  const page = await space.read(name);
  return c.json(page);
});

app.put('/api/space/:name{.+}', async (c) => {
  const name = decodePageName(c.req.param('name'));
  const text = await c.req.text();

  // A missing header means "overwrite, I know what I'm doing" — used by
  // conflict resolution. A present-but-empty one means "this page is new".
  const header = c.req.header('x-spark-base-rev');
  const baseRev = header === undefined ? null : header;

  const page = await space.write(name, text, baseRev);
  return c.json({
    name: page.name,
    rev: page.rev,
    modified: page.modified,
    size: page.size,
  });
});

app.delete('/api/space/:name{.+}', async (c) => {
  await space.delete(decodePageName(c.req.param('name')));
  return c.body(null, 204);
});

app.patch('/api/space/:name{.+}', async (c) => {
  const from = decodePageName(c.req.param('name'));
  const { to } = (await c.req.json()) as { to?: string };
  if (!to) return c.text('missing "to"', 400);
  await space.rename(from, to);
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * The workspace-wide task scan.
 *
 * Done here rather than in the browser because the server can read the whole
 * space off local disk in one pass, where the client would need one request
 * per page.
 */
app.get('/api/tasks', async (c) => {
  const pages = await space.readAllMarkdown();
  const tasks = pages.flatMap((page) => parseTasks(page.name, page.text));
  return c.json(tasks);
});

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

/**
 * Every page that links to `:name`, with the line it was mentioned on.
 *
 * Scanned on demand rather than maintained as an index: the whole point of a
 * folder of markdown is that anything may edit it, so a cached graph would go
 * stale the moment you touched a file outside the app. A space would have to
 * get very large before a grep over it costs more than keeping it honest.
 */
app.get('/api/backlinks/:name{.+}', async (c) => {
  const target = decodePageName(c.req.param('name'));
  const targetKey = target.toLowerCase();
  const pages = await space.readAllMarkdown();

  const results: Array<{ page: string; line: number; text: string }> = [];

  for (const page of pages) {
    if (page.name.toLowerCase() === targetKey) continue;

    const lines = page.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const links = findWikiLinks(lines[i]);
      if (!links.some((link) => link.target.toLowerCase() === targetKey)) continue;
      results.push({ page: page.name, line: i, text: lines[i].trim().slice(0, 300) });
    }
  }

  return c.json(results);
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** `#tag` and `#nested/tag`, ignoring `#` used as a heading marker. */
const TAG_SCAN_RE = /(?:^|[\s([])#([A-Za-z0-9][\w/-]*)/g;

/** Every tag in the space with the number of mentions, for the tag index. */
app.get('/api/tags', async (c) => {
  const pages = await space.readAllMarkdown();
  const counts = new Map<string, number>();

  for (const page of pages) {
    for (const line of scannableLines(page.text)) {
      for (const match of line.matchAll(TAG_SCAN_RE)) {
        counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
      }
    }
  }

  return c.json(
    [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
  );
});

/**
 * Every mention of one tag. Backs the tag's virtual page.
 *
 * A tag nobody has used is not an error — it returns an empty list, so a link
 * to a tag that doesn't exist yet still leads somewhere sensible.
 */
app.get('/api/tags/:tag{.+}', async (c) => {
  const tag = decodePageName(c.req.param('tag')).toLowerCase();
  const pages = await space.readAllMarkdown();
  const results: Array<{ page: string; line: number; text: string }> = [];

  for (const page of pages) {
    const lines = page.text.split('\n');
    let inFence = false;

    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      const hit = [...lines[i].matchAll(TAG_SCAN_RE)].some(
        (match) => match[1].toLowerCase() === tag,
      );
      if (hit) results.push({ page: page.name, line: i, text: lines[i].trim().slice(0, 300) });
    }
  }

  return c.json(results);
});

/** Document lines outside fenced code blocks. */
function scannableLines(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * What Spark knows, as the app shows it.
 *
 * There is a read endpoint even though the four files are ordinary pages the
 * editor can already open, because "what does this thing believe about me" is a
 * question that deserves one screen rather than four tabs. Editing still happens
 * in the pages themselves; this is a window onto them.
 */
app.get('/api/memory', async (c) => c.json(await memory.snapshot()));

/**
 * Run a consolidation pass now.
 *
 * `force` is the whole reason this is a route: the automatic trigger is at the end
 * of a turn and only when a pass is due, and someone looking at their memory page
 * wanting it tidied should not have to invent a conversation to make that happen.
 */
app.post('/api/memory/consolidate', async (c) => {
  if (!aiEnabled()) return c.text('Spark is not configured on this server.', 501);
  const recent = await recentChatMessages();
  const report = await memory.consolidate(recent, { force: true, signal: c.req.raw.signal });
  return c.json(report);
});

app.delete('/api/memory/:kind', async (c) => {
  const kind = c.req.param('kind');
  if (kind !== 'essentials' && kind !== 'conventions' && kind !== 'threads') {
    return c.text('kind must be essentials, conventions or threads', 400);
  }
  const { match } = (await c.req.json()) as { match?: string };
  if (!match) return c.text('missing "match"', 400);
  return c.json({ removed: await memory.forget(kind as MemoryKind, match) });
});

/**
 * The conversation the consolidation pass reads.
 *
 * The most recent few chats rather than all of them: a pass is about what has
 * happened lately, and reading a year of transcripts to decide what to write down
 * would cost more than the memory is worth.
 */
async function recentChatMessages(limit = 4): Promise<Awaited<ReturnType<typeof chats.read>>['messages']> {
  const summaries = (await chats.list()).slice(0, limit);
  const loaded = await Promise.all(summaries.map((chat) => chats.read(chat.id).catch(() => null)));
  return loaded
    .filter((chat): chat is Awaited<ReturnType<typeof chats.read>> => chat !== null)
    .flatMap((chat) => chat.messages)
    .sort((a, b) => a.at - b.at);
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

app.get('/api/files', async (c) => c.json(await files.list()));

app.post('/api/files', async (c) => {
  const body = await c.req.parseBody();
  const upload = body.file;
  if (!(upload instanceof File)) return c.text('expected a "file" field', 400);
  if (upload.size > MAX_UPLOAD) {
    return c.text(`that file is larger than ${Math.round(MAX_UPLOAD / 1024 / 1024)} MB`, 413);
  }

  const bytes = new Uint8Array(await upload.arrayBuffer());
  return c.json(await files.save(upload.name || 'upload', bytes));
});

/**
 * Serves an attachment.
 *
 * `Content-Disposition: attachment` for everything that is not an image or a
 * PDF: the space is a folder of files anybody can put anything in, and a browser
 * that renders an uploaded `.html` from this origin would be running it beside
 * the notes it can then read.
 */
app.get('/api/files/:name{.+}', async (c) => {
  const name = decodePageName(c.req.param('name'));
  try {
    const { bytes, mime } = await files.bytes(name);
    const inline = mime.startsWith('image/') && mime !== 'image/svg+xml';
    return c.body(bytes, 200, {
      'content-type': mime,
      'content-disposition': `${inline || mime === 'application/pdf' ? 'inline' : 'attachment'}; filename="${name.split('/').pop() ?? 'file'}"`,
      'cache-control': 'private, max-age=60',
    });
  } catch {
    return c.text('no such file', 404);
  }
});

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

app.get('/api/skills', async (c) => c.json(await skills.list()));

app.get('/api/skills/:name', async (c) => {
  try {
    return c.json(await skills.read(c.req.param('name')));
  } catch (err) {
    return c.text(err instanceof Error ? err.message : 'no such skill', 404);
  }
});

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

app.get('/api/git/status', async (c) => c.json(await gitService.status()));

app.post('/api/git/sync', async (c) => {
  try {
    const outcome = await gitService.sync();
    return c.json({ ok: true, ...outcome });
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        status: await gitService.status(),
      },
      // A failed sync is an expected operational state, not a server fault:
      // the client shows it in the status bar and retries on the next tick.
      200,
    );
  }
});

app.post('/api/git/setup', async (c) => {
  const { remote } = (await c.req.json()) as { remote?: string };
  if (!remote) return c.text('missing "remote"', 400);
  return c.json(await gitService.setup(remote));
});

// ---------------------------------------------------------------------------
// GitHub auth
// ---------------------------------------------------------------------------

/**
 * The OAuth app itself — the thing you have to create on GitHub before sign-in
 * can happen at all.
 *
 * Editable from Settings → Sync rather than only from the environment, because
 * "restart the server with two variables set" is a setup step the app cannot
 * walk anyone through. The secret goes out redacted; see `github-settings.ts`.
 */
app.get('/api/github/app', (c) => c.json(githubSettings.publicView()));

app.put('/api/github/app', async (c) => {
  const body = (await c.req.json()) as {
    clientId?: string;
    /** Absent means "keep the secret I already have". */
    clientSecret?: string;
    origin?: string;
  };

  await githubSettings.save({
    clientId: body.clientId,
    clientSecret: body.clientSecret,
    origin: body.origin,
  });
  return c.json(githubSettings.publicView());
});

app.delete('/api/github/app', async (c) => {
  await githubSettings.clear();
  return c.json(githubSettings.publicView());
});

app.get('/api/auth/github', (c) => {
  if (!githubSettings.enabled()) {
    return c.text(
      'GitHub sign-in is not set up. Add a client ID and secret in Settings → Sync.',
      501,
    );
  }
  return c.redirect(authorizeUrl(auth.issueState()));
});

app.get('/api/auth/github/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');

  if (!code || !state || !auth.consumeState(state)) {
    return c.html(closingPage('Sign-in failed: the request could not be verified.'), 400);
  }

  try {
    const token = await exchangeCode(code);
    await auth.connect(token, await fetchGitHubUser(token));
    return c.html(closingPage('GitHub connected. You can close this window.'));
  } catch (err) {
    return c.html(
      closingPage(`Sign-in failed: ${err instanceof Error ? err.message : String(err)}`),
      400,
    );
  }
});

app.post('/api/auth/logout', async (c) => {
  await auth.disconnect();
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

/**
 * The AI settings, redacted.
 *
 * The key itself is never sent to the browser — only whether one is present and
 * its last four characters, which is enough to tell two keys apart and not
 * enough to spend anyone's money.
 */
app.get('/api/ai/config', (c) => c.json(aiSettings.publicView()));

app.put('/api/ai/config', async (c) => {
  const body = (await c.req.json()) as {
    provider?: string;
    model?: string;
    endpoint?: string;
    /** Absent means "keep the key I already have". */
    apiKey?: string;
  };

  if (body.provider !== undefined && body.provider !== 'openai' && body.provider !== 'anthropic') {
    return c.text('provider must be "openai" or "anthropic"', 400);
  }

  await aiSettings.save({
    provider: body.provider as AiProvider | undefined,
    model: body.model,
    endpoint: body.endpoint,
    apiKey: body.apiKey,
  });

  return c.json(aiSettings.publicView());
});

app.delete('/api/ai/config', async (c) => {
  await aiSettings.clear();
  return c.json(aiSettings.publicView());
});

/**
 * Throws away the cached vectors.
 *
 * Offered because a cache with no button to clear it is a cache people stop
 * trusting. Nothing is lost: the vectors are keyed by the hash of the text they
 * describe, so the next search re-embeds whatever it needs.
 */
app.post('/api/ai/embeddings/clear', async (c) => {
  await clearEmbeddings();
  return c.json({ ok: true });
});

/**
 * One tiny real completion, against whatever settings the caller names.
 *
 * A key that is present but wrong looks exactly like a working one until the
 * first time you ask for something, which is the worst moment to find out.
 *
 * The body overrides the stored settings field by field, so the settings page
 * can test the model and key **as typed** rather than as saved. Testing the
 * stored ones is the wrong question: nobody presses "test connection" to find
 * out whether the key they are replacing used to work, and making them save an
 * untested credential first is how a working key gets overwritten by a typo.
 * Nothing is written to disk here — the override is used for this one call.
 */
app.post('/api/ai/test', async (c) => {
  const patch = await c.req.json<Partial<AiSettings>>().catch(() => ({}) as Partial<AiSettings>);

  if (patch.provider !== undefined && patch.provider !== 'openai' && patch.provider !== 'anthropic') {
    return c.json({ ok: false, error: 'Provider must be "openai" or "anthropic".' });
  }

  const stored = aiSettings.get();
  const settings: AiSettings = {
    provider: patch.provider ?? stored.provider,
    model: (patch.model ?? '').trim() || stored.model,
    // An empty endpoint is a real value — "use the provider's own" — so it is
    // taken whenever the field is present, the same rule `save()` follows.
    endpoint: patch.endpoint ?? stored.endpoint,
    // An empty key means "I did not retype it", because the browser is never
    // sent the stored one and so cannot send it back.
    apiKey: (patch.apiKey ?? '').trim() || stored.apiKey,
    // The embedding half is not what this tests, so it is passed through
    // unchanged rather than taken from the form.
    embedModel: stored.embedModel,
    embedEndpoint: stored.embedEndpoint,
    embedKey: stored.embedKey,
  };

  if (!settings.apiKey && !settings.endpoint.trim()) {
    return c.json({ ok: false, error: 'No API key is configured.' });
  }

  try {
    let reply = '';
    for await (const chunk of streamCompletion({
      // As small as a real call can be: two tokens out, and the loop stops at
      // the first one that arrives. What is being tested is whether the
      // provider accepts the credential and knows the model, and that is
      // settled by the first byte of the response, not by the last.
      prompt: 'ok',
      system: 'Reply with the single word: ok',
      signal: c.req.raw.signal,
      settings,
    })) {
      reply += chunk;
      if (reply.trim().length > 0) break;
    }
    return c.json({ ok: true, model: settings.model, reply: reply.trim().slice(0, 80) });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/ai/complete', async (c) => {
  if (!aiEnabled()) return c.text('AI is not configured on this server.', 501);

  const body = (await c.req.json()) as { prompt?: string; system?: string; mode?: string };
  if (!body.prompt?.trim()) return c.text('missing "prompt"', 400);

  const system = body.mode === 'braindump' ? BRAINDUMP_SYSTEM : body.system;

  return stream(c, async (writer) => {
    c.header('content-type', 'text/plain; charset=utf-8');
    c.header('cache-control', 'no-store');
    try {
      for await (const chunk of streamCompletion({
        prompt: body.prompt!,
        system,
        signal: c.req.raw.signal,
      })) {
        await writer.write(chunk);
      }
    } catch (err) {
      // The stream is already open, so the error has to travel inline.
      await writer.write(
        `\n\n> AI request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Spark: conversations, and the tools behind them
// ---------------------------------------------------------------------------

/** What Spark can do, so the settings panel can describe it without guessing. */
app.get('/api/spark/tools', (c) =>
  c.json(
    SPARK_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      needs: tool.needs ?? null,
    })),
  ),
);

app.get('/api/spark/chats', async (c) => c.json(await chats.list()));

app.post('/api/spark/chats', async (c) => c.json(await chats.create()));

app.get('/api/spark/chats/:id', async (c) => {
  try {
    return c.json(await chats.read(c.req.param('id')));
  } catch {
    return c.text('no such conversation', 404);
  }
});

app.patch('/api/spark/chats/:id', async (c) => {
  const { title } = (await c.req.json()) as { title?: string };
  if (!title) return c.text('missing "title"', 400);
  return c.json(await chats.rename(c.req.param('id'), title));
});

app.delete('/api/spark/chats/:id', async (c) => {
  await chats.delete(c.req.param('id'));
  return c.body(null, 204);
});

/**
 * One turn of a conversation.
 *
 * Streams newline-delimited JSON rather than server-sent events: the client is
 * `fetch`, not `EventSource`, and a turn carries four kinds of thing (text,
 * a tool starting, a tool finishing, an action for the browser) which want to
 * stay distinguishable. The reply is stored only once the turn completes, so an
 * abandoned request leaves no half a message behind.
 */
app.post('/api/spark/chat', async (c) => {
  if (!aiEnabled()) return c.text('Spark is not configured on this server.', 501);

  const body = (await c.req.json()) as {
    chatId?: string;
    message?: string;
    context?: SparkContext;
    permissions?: { write?: boolean; destroy?: boolean; remember?: boolean; run?: boolean };
    historyDepth?: number;
    /** Names of files already uploaded through `/api/files`. */
    attachments?: string[];
  };

  if (!body.message?.trim()) return c.text('missing "message"', 400);

  const chat = await chats.ensure(body.chatId);
  const depth = Math.min(Math.max(body.historyDepth ?? 12, 0), 40);
  const permissions = {
    write: body.permissions?.write ?? false,
    destroy: body.permissions?.destroy ?? false,
    remember: body.permissions?.remember ?? false,
    // Two gates, and both have to be open: the person asked for it, and this
    // machine has somewhere to run it.
    run: (body.permissions?.run ?? false) && sandboxEnabled(),
  };

  return stream(c, async (writer) => {
    c.header('content-type', 'application/x-ndjson; charset=utf-8');
    c.header('cache-control', 'no-store');

    const send = (event: unknown) => writer.write(`${JSON.stringify(event)}\n`);

    let reply = '';
    const used: ChatToolCall[] = [];
    const pending = new Map<string, { name: string; input: Record<string, unknown> }>();

    try {
      // The chat id goes first so the client can attach an in-flight reply to
      // a conversation that this very request just created.
      await send({ type: 'chat', id: chat.id });

      for await (const event of runSpark({
        message: body.message!,
        history: chat.messages.slice(-depth),
        context: body.context ?? {},
        permissions,
        space,
        memory,
        files,
        attachments: body.attachments,
        signal: c.req.raw.signal,
      })) {
        if (event.type === 'text') reply += event.text;
        if (event.type === 'tool') pending.set(event.id, { name: event.name, input: event.input });
        if (event.type === 'tool-result') {
          const call = pending.get(event.id);
          used.push({
            name: call?.name ?? 'unknown',
            input: call?.input ?? {},
            ok: event.ok,
            summary: event.summary,
          });
        }
        await send(event);
      }

      const now = Date.now();
      const saved = await chats.append(
        chat.id,
        { role: 'user', text: body.message!, at: now },
        { role: 'assistant', text: reply, tools: used.length > 0 ? used : undefined, at: Date.now() },
      );
      await send({ type: 'saved', title: saved.title });

      // Consolidation goes here, after the reply has been streamed and stored,
      // which is what keeps it from being a background job: the person asked for
      // this turn, so the tidying happens inside it and nothing runs while
      // nobody is looking. It cannot fail the turn — the answer is already sent
      // and delivered, and a memory pass that goes wrong is a memory pass that
      // goes wrong, not a lost reply.
      if (permissions.remember && (await memory.isDue())) {
        try {
          const report = await memory.consolidate(saved.messages, { signal: c.req.raw.signal });
          if (report.ran) await send({ type: 'memory', summary: report.summary });
        } catch (err) {
          console.error('[spark] consolidation failed', err);
        }
      }
    } catch (err) {
      // The stream is already open, so the failure has to travel inline.
      await send({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

app.onError((err, c) => {
  if (err instanceof PageNotFound) return c.text('page not found', 404);
  if (err instanceof InvalidPageName) return c.text(err.message, 400);
  if (err instanceof RevisionConflict) {
    return c.json({ text: err.current.text, rev: err.current.rev }, 409);
  }
  console.error('[spark]', err);
  return c.text('internal error', 500);
});

// ---------------------------------------------------------------------------
// Static client (production only — in dev, Vite serves and proxies here)
// ---------------------------------------------------------------------------

if (!config.isDev) {
  app.use('/*', serveStatic({ root: config.webDist }));
  // SPA fallback: any unmatched path renders the app shell.
  app.get('*', serveStatic({ path: 'index.html', root: config.webDist }));
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function decodePageName(raw: string): string {
  // Hono hands back the raw path segment; slashes are meaningful (folders),
  // everything else was percent-encoded by the client.
  return raw
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

function closingPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Spark</title>
<body style="font:16px/1.5 system-ui;display:grid;place-items:center;height:100vh;margin:0">
<p>${escapeHtml(message)}</p>
<script>if (window.opener) { window.opener.postMessage('spark:auth', '*'); setTimeout(() => window.close(), 800); }</script>
</body>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

await space.init();
await auth.load();
await aiSettings.load();
await githubSettings.load();
await memory.load();
if (await seedSpace(space)) {
  console.log('  Seeded an empty space with a welcome page and an example plugin.');
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`\n  Spark server  →  http://localhost:${info.port}`);
  console.log(`  Space         →  ${config.spaceDir}`);
  const ai = aiSettings.get();
  console.log(
    `  AI            →  ${aiEnabled() ? `${ai.provider} · ${ai.model}` : 'off (configure it in Settings)'}`,
  );
  console.log(
    `  GitHub OAuth  →  ${githubSettings.enabled() ? 'configured' : 'off (set it up in Settings → Sync)'}`,
  );
  console.log(
    `  Semantic find →  ${embeddingsEnabled() ? `${ai.embedModel}` : 'off (name an embedding model in Settings)'}`,
  );
  console.log(`  Sandbox       →  ${describeSandbox()}\n`);
});
