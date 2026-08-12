import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { findWikiLinks, parseFrontmatter, parseTasks } from '@spark/core/markdown';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BRAINDUMP_SYSTEM, aiEnabled, aiSettings, streamCompletion } from './ai.js';
import { normalizeProfile, type AiProviderProfile, type AiSettings } from './ai-settings.js';
import { forgetApprovals, resolveApproval, type ApprovalDecision } from './approvals.js';
import { AuthStore, authorizeUrl, exchangeCode, fetchGitHubUser, type GitHubUser } from './auth.js';
import { chats, type ChatMessage, type ChatSegment, type ChatToolCall } from './chats.js';
import { expandCommand, listCommands } from './commands.js';
import { config } from './config.js';
import { webSearchEnabled, activeSearchLabel } from './web-search.js';
import { FileStore, MAX_UPLOAD } from './files.js';
import { githubSettings, type GitHubAppSettings } from './github-settings.js';
import { GitService } from './git.js';
import { MemoryStore, type MemoryKind } from './memory.js';
import { listModels } from './models.js';
import { estimateCost } from './pricing.js';
import { ProactiveScanner } from './proactive.js';
import { clearEmbeddings, embeddingsEnabled, find } from './retrieval.js';
import { describeSandbox, sandboxEnabled, sandboxRuntime } from './sandbox.js';
import { skills } from './skills.js';
import { seedSpace } from './seed.js';
import { FileSpace, InvalidPageName, PageNotFound, RevisionConflict } from './space.js';
import { runSpark, type SparkContext } from './spark.js';
import { sparkSettings, type SparkSettings } from './spark-settings.js';
import { SPARK_TOOLS, isPermissionMode, type PermissionMode } from './spark-tools.js';

const space = new FileSpace(config.spaceDir);
const auth = new AuthStore();
const gitService = new GitService(space, () => auth.token());
const memory = new MemoryStore(space);
const files = new FileStore(config.spaceDir);
const proactive = new ProactiveScanner(space, memory);

const app = new Hono();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

app.get('/api/config', async (c) =>
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
    webSearch: webSearchEnabled(),
    // The natural "the app was just opened" trigger the proactive scan
    // piggybacks on instead of a timer — see `proactive.ts`. `null` unless
    // the setting is on and there is something unseen to badge.
    proactiveFinding: await proactive.checkIn().catch(() => null),
  }),
);

// ---------------------------------------------------------------------------
// Settings backup
// ---------------------------------------------------------------------------

/**
 * Reads one store's raw file, or `null` if it was never written.
 *
 * The stores keep their file paths private (and correctly so — nothing outside
 * them should need to know), so the export reads the files it knows live in the
 * state dir by name. That is also what makes this honest: the export is the
 * files themselves, not a second opinion on them.
 */
const readStore = async (name: string) => {
  try {
    return JSON.parse(await readFile(join(config.stateDir, name), 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Everything the server was told, in one JSON document.
 *
 * Secrets are included, on purpose and only here: moving a server means moving
 * its keys, and the export is the one place they are allowed to leave the
 * machine. The file has to be handled like a credential — see the Settings
 * panel's warning.
 */
app.get('/api/settings/export', async (c) =>
  c.json({
    version: 1,
    exportedAt: new Date().toISOString(),
    ai: await readStore('ai.json'),
    spark: await readStore('spark.json'),
    github: await readStore('github.json'),
    auth: await readStore('auth.json'),
  }),
);

/**
 * Applies a prior export.
 *
 * Sections are applied independently and reported, so one section that fails
 * (a deleted model id, a malformed field) does not take the other three down
 * with it. An absent `clientSecret` in a patch means "leave the stored one
 * alone" — that is the normal per-field merge, not a special import rule.
 */
app.post('/api/settings/import', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { ai?: unknown; spark?: Partial<SparkSettings>; github?: Record<string, unknown>; auth?: unknown }
    | null;
  if (!body || typeof body !== 'object') return c.text('expected a settings export', 400);

  const applied: string[] = [];

  try {
    const ai = body.ai as { profiles?: AiProviderProfile[]; defaultId?: string } | undefined;
    if (ai && Array.isArray(ai.profiles)) {
      for (const profile of ai.profiles) {
        await aiSettings.saveProfile(profile);
      }
      if (ai.defaultId) {
        try {
          await aiSettings.setDefaultProfile(ai.defaultId);
        } catch {
          // The list is restored even when its default no longer exists —
          // setting the default is a separate, best-effort step.
          applied.push('ai (default profile not found)');
        }
      }
      applied.push('ai');
    }
  } catch {
    applied.push('ai (failed)');
  }

  try {
    await sparkSettings.save(body.spark ?? {}, aiSettings.get().provider);
    applied.push('spark');
  } catch {
    applied.push('spark (failed)');
  }

  try {
    await githubSettings.save((body.github ?? {}) as Partial<GitHubAppSettings>);
    applied.push('github');
  } catch {
    applied.push('github (failed)');
  }

  try {
    const authBody = body.auth as { token?: unknown; user?: GitHubUser } | undefined;
    if (authBody && typeof authBody?.token === 'string' && authBody.token.trim()) {
      await auth.connect(authBody.token, authBody.user ?? { login: 'unknown' });
      applied.push('auth');
    }
  } catch {
    applied.push('auth (failed)');
  }

  return c.json({ ok: true, applied });
});

/** Back to a fresh server: every stored setting is forgotten. */
app.post('/api/settings/reset', async (c) => {
  await aiSettings.clear();
  await sparkSettings.clear();
  await githubSettings.clear();
  await auth.disconnect();
  return c.json({ ok: true });
});

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
 *
 * Only pages that opt in with `tasks: true` in their frontmatter are scanned.
 * Without that, every `- [ ]` anywhere in the space showed up here — a stray
 * checkbox in a recipe or a template read the same as a real task, and there
 * was no way to write about tasks without adding one. `memory/threads` carries
 * the same flag (see `renderMemory`), which is what keeps Spark's threads
 * showing up here exactly as they did before.
 */
app.get('/api/tasks', async (c) => {
  const pages = await space.readAllMarkdown();
  const tasks = pages
    .filter((page) => parseFrontmatter(page.text).data.tasks === 'true')
    .flatMap((page) => parseTasks(page.name, page.text));
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

/**
 * Fast, global, content-aware search — the navigator's filename filter only
 * matches names, and this is the one place in the app that can answer "which
 * page has this word in it" with a snippet to show for it.
 *
 * A thin wrapper over `find()`, the same ranking Spark's own `search` tool
 * already uses: BM25 always, with embeddings layered in only if a model is
 * configured. Nothing new to keep in step with retrieval.ts, and the same
 * "text-only when nothing is configured" degrade Spark gets — which is also
 * the fast path, no network round trip, for the common case of typing into
 * the navigator's search field.
 */
app.get('/api/search', async (c) => {
  const q = c.req.query('q')?.trim() ?? '';
  if (!q) return c.json({ hits: [], semantic: false });

  const limit = Number(c.req.query('limit')) || 8;
  const result = await find(space, q, { limit, signal: c.req.raw.signal });
  return c.json(result);
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

app.delete('/api/files/:name{.+}', async (c) => {
  await files.remove(decodePageName(c.req.param('name')));
  return c.body(null, 204);
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

// A clone can fail for expected reasons — not connected, non-empty space —
// and the message is the whole point of the error, so it is sent as text with
// the guard check rather than swallowed into a generic 500.
app.post('/api/git/clone', async (c) => {
  const { remote } = (await c.req.json()) as { remote?: string };
  if (!remote) return c.text('missing "remote"', 400);
  try {
    return c.json(await gitService.clone(remote));
  } catch (err) {
    return c.text(err instanceof Error ? err.message : String(err), 400);
  }
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
 * Every configured provider profile, redacted.
 *
 * A key is never sent to the browser — only whether one is present and its
 * last four characters, enough to tell two keys apart and not enough to
 * spend anyone's money. Replaces the old single-object `/api/ai/config`:
 * there can be more than one provider now, each a mode preset can point at
 * independently (`spark-settings.ts`'s `SparkMode.providerId`), with one
 * marked default for modes that name none.
 */
app.get('/api/ai/profiles', (c) => c.json(aiSettings.listPublicProfiles()));

/**
 * Creates a profile, or updates one by id.
 *
 * The same absence-means-leave-alone rule the old route used: an omitted
 * field keeps what is stored, and an empty string is a real value — "use
 * the provider's default endpoint" — so absence has to be tested for, not
 * falsiness.
 */
app.put('/api/ai/profiles', async (c) => {
  const body = await c
    .req.json<Partial<AiProviderProfile> & { id?: string }>()
    .catch(() => ({}) as Partial<AiProviderProfile>);

  if (body.provider !== undefined && body.provider !== 'openai' && body.provider !== 'anthropic') {
    return c.text('provider must be "openai" or "anthropic"', 400);
  }

  const saved = await aiSettings.saveProfile(body);
  return c.json(aiSettings.publicProfile(saved));
});

app.delete('/api/ai/profiles/:id', async (c) => {
  await aiSettings.deleteProfile(c.req.param('id'));
  return c.json(aiSettings.listPublicProfiles());
});

/** Which profile a mode falls back to when it names none. */
app.post('/api/ai/profiles/:id/default', async (c) => {
  try {
    await aiSettings.setDefaultProfile(c.req.param('id'));
  } catch (err) {
    return c.text(err instanceof Error ? err.message : String(err), 404);
  }
  return c.json(aiSettings.listPublicProfiles());
});

/** Forgets every stored profile, falling back to whatever the environment describes. */
app.delete('/api/ai/profiles', async (c) => {
  await aiSettings.clear();
  return c.json(aiSettings.listPublicProfiles());
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
 * One tiny real completion, against whatever profile the caller names.
 *
 * A key that is present but wrong looks exactly like a working one until the
 * first time you ask for something, which is the worst moment to find out.
 *
 * `id` names a stored profile to test changes against — the body overrides
 * it field by field, so the settings page can test the model and key **as
 * typed** rather than as saved. Testing the stored ones is the wrong
 * question: nobody presses "test connection" to find out whether the key
 * they are replacing used to work, and making them save an untested
 * credential first is how a working key gets overwritten by a typo. `id`
 * omitted (and no matching stored profile) means a wholly new profile being
 * tested before it has ever been saved. Nothing is written to disk here —
 * the override is used for this one call.
 */
app.post('/api/ai/test', async (c) => {
  const patch = await c
    .req.json<Partial<AiProviderProfile> & { id?: string }>()
    .catch(() => ({}) as Partial<AiProviderProfile>);

  if (patch.provider !== undefined && patch.provider !== 'openai' && patch.provider !== 'anthropic') {
    return c.json({ ok: false, error: 'Provider must be "openai" or "anthropic".' });
  }

  const stored = patch.id ? aiSettings.profile(patch.id) : null;
  const settings = normalizeProfile({
    id: stored?.id,
    label: stored?.label,
    provider: patch.provider ?? stored?.provider,
    model: (patch.model ?? '').trim() || stored?.model,
    // An empty endpoint is a real value — "use the provider's own" — so it is
    // taken whenever the field is present, the same rule `saveProfile` follows.
    endpoint: patch.endpoint ?? stored?.endpoint,
    // An empty key means "I did not retype it", because the browser is never
    // sent the stored one and so cannot send it back.
    apiKey: (patch.apiKey ?? '').trim() || stored?.apiKey,
    // The embedding half is not what this tests, so it is passed through
    // unchanged rather than taken from the form.
    embedModel: stored?.embedModel,
    embedEndpoint: stored?.embedEndpoint,
    embedKey: stored?.embedKey,
  })!;

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

/**
 * Quick capture, with a model behind it.
 *
 * A separate endpoint from the conversation, and it should stay separate. Capture
 * is not a chat: there is one input, no history, no tools and no back-and-forth,
 * and the whole product promise is that the thought lands in the day's page
 * before you have finished having it. Routing it through the agent loop would
 * make the fastest surface in the app wait on the slowest one.
 *
 * What it *is* is a rewrite with a destination. The instructions are different in
 * kind from Spark's: never answer, never converse, never add a thought that was
 * not there. Turn what was said into the markdown it should have been, in their
 * own voice, ready to append.
 */
app.post('/api/capture/shape', async (c) => {
  if (!aiEnabled()) return c.text('AI is not configured on this server.', 501);

  const body = (await c.req.json()) as {
    text?: string;
    /** The capture mode's label — "Task", "Idea" — which changes the shape. */
    mode?: string;
    /** Names of files already uploaded, for a capture that carries a photo. */
    attachments?: string[];
    /** What is already on the day's page, so the shaping matches its voice. */
    page?: string;
  };

  if (!body.text?.trim()) return c.text('missing "text"', 400);

  const settings = sparkSettings.get(aiSettings.get().provider);
  const system = [
    CAPTURE_SYSTEM,
    settings.userName ? `\nThe person writing is ${settings.userName}.` : '',
    settings.instructions.trim()
      ? `\nThey have told you how they want you to work, and it applies here too:\n\n${settings.instructions.trim()}`
      : '',
    body.mode ? `\nThey chose the "${body.mode}" shape for this capture. Honour it.` : '',
    body.page?.trim()
      ? `\nThe page it is going onto already reads like this. Match its voice, its formatting habits and its level of detail:\n\n<page>\n${body.page.slice(0, 8000)}\n</page>`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return stream(c, async (writer) => {
    c.header('content-type', 'text/plain; charset=utf-8');
    c.header('cache-control', 'no-store');
    try {
      for await (const chunk of streamCompletion({
        prompt: body.text!,
        system,
        signal: c.req.raw.signal,
      })) {
        await writer.write(chunk);
      }
    } catch (err) {
      await writer.write(`\n\n> Could not shape that: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
});

const CAPTURE_SYSTEM = `You turn a raw capture into the markdown it should have been, for a personal notes app. What you produce is appended to the person's daily journal page as-is.

You are not answering and not talking to them. Never write a preamble, a heading like "Here is", a comment on what they wrote, or an offer to help. Output only the markdown that goes on the page.

Keep their words. This is their note, in their voice: keep their vocabulary, their level of detail and their habits of formatting. Do not summarise away detail, do not make it sound like a report, and do not add a thought, a conclusion or a task that was not there.

What to change:

- Punctuate and paragraph it properly. Spoken input arrives unpunctuated and full of restarts; typed input is usually fine and should be left almost exactly alone.
- Drop filler, false starts and repetition — "um", "you know", "like", "so anyway".
- Anything that is a commitment or an intention becomes "- [ ] task".
- A list of things becomes a list of lines.
- Use "##" headings only if there is genuinely more than one subject. A single train of thought needs none.
- Keep any "#tag" and "[[wiki link]]" exactly as written.

Never use emoji. Never use em-dashes. If you are unsure whether something was meant, leave it as they said it.`;

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

/**
 * Spark's own settings: your name, your standing instructions, the model presets.
 *
 * Separate from `/api/ai/config` because nothing here is a credential except the
 * search key, which is redacted the same way. Everything else is meant to come
 * back to the browser and be edited there.
 */
app.get('/api/spark/settings', (c) => c.json(sparkSettings.publicView(aiSettings.get().provider)));

app.put('/api/spark/settings', async (c) => {
  const body = (await c.req.json()) as Partial<SparkSettings>;
  await sparkSettings.save(body, aiSettings.get().provider);
  return c.json(sparkSettings.publicView(aiSettings.get().provider));
});

/** For Settings' "Scheduled" section — when the proactive scan last ran and is next due. See `proactive.ts`. */
app.get('/api/spark/proactive', async (c) => c.json(await proactive.status()));

/** The person opened the panel and saw the badge (if there was one) — it will not come back. */
app.post('/api/spark/proactive/ack', async (c) => {
  await proactive.acknowledge();
  return c.body(null, 204);
});

/** The slash command menu: the built-ins, and every skill under its own name. */
app.get('/api/spark/commands', async (c) => c.json(await listCommands()));

/**
 * One provider's model list, so a mode preset can be picked rather than
 * typed — `id` names which profile.
 *
 * A `POST` rather than a `GET` because it takes an optional settings patch: the
 * settings page fetches models for the provider and key **as typed**, before they
 * are saved, for the same reason "Test connection" does.
 */
app.post('/api/ai/models', async (c) => {
  const patch = await c
    .req.json<Partial<AiProviderProfile> & { id?: string }>()
    .catch(() => ({}) as Partial<AiProviderProfile>);
  const stored = patch.id ? aiSettings.profile(patch.id) : aiSettings.defaultProfile();
  const settings: AiSettings = normalizeProfile({
    ...stored,
    provider: patch.provider ?? stored?.provider,
    endpoint: patch.endpoint ?? stored?.endpoint,
    apiKey: (patch.apiKey ?? '').trim() || stored?.apiKey,
  })!;

  try {
    return c.json({ ok: true, models: await listModels(settings, c.req.raw.signal) });
  } catch (err) {
    // Returned rather than thrown: the field can still be typed by hand, and a
    // sentence beside the button beats an error state for the whole panel.
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err), models: [] });
  }
});

/**
 * Answering a tool call that is waiting.
 *
 * Its own request because the turn it belongs to is a response that is still
 * open — see `approvals.ts` for why the promise cannot live in that closure.
 */
app.post('/api/spark/approve', async (c) => {
  const { id, decision } = (await c.req.json()) as { id?: string; decision?: string };
  if (!id) return c.text('missing "id"', 400);
  if (decision !== 'once' && decision !== 'always' && decision !== 'deny') {
    return c.text('decision must be "once", "always" or "deny"', 400);
  }
  // False means nothing was waiting: a stale click, or a turn that was stopped.
  // Not an error — there is nothing for the person to do about it.
  return c.json({ answered: resolveApproval(id, decision as ApprovalDecision) });
});

app.get('/api/spark/chats', async (c) => {
  // `?q=` searches inside the conversations, not just their titles — see
  // `ChatStore.search`. A phrase is usually remembered as part of a reply,
  // never as a title. `?archived=1` lists the archived instead of the live.
  const q = c.req.query('q')?.trim() ?? '';
  const archived = c.req.query('archived') === '1';
  return c.json(
    q
      ? await chats.search(q)
      : archived
        ? await chats.list(true)
        : await chats.list(),
  );
});

app.post('/api/spark/chats', async (c) => c.json(await chats.create()));

app.get('/api/spark/chats/:id', async (c) => {
  try {
    return c.json(await chats.read(c.req.param('id')));
  } catch {
    return c.text('no such conversation', 404);
  }
});

app.patch('/api/spark/chats/:id', async (c) => {
  const { title, archived, project } = (await c.req.json()) as {
    title?: string;
    archived?: boolean;
    project?: string | null;
  };
  if (typeof title === 'string') {
    return c.json(await chats.rename(c.req.param('id'), title));
  }
  if (typeof archived === 'boolean') {
    return c.json(await chats.setArchived(c.req.param('id'), archived));
  }
  if (typeof project === 'string' || project === null) {
    return c.json(await chats.setProject(c.req.param('id'), project));
  }
  return c.text('nothing to change', 400);
});

app.delete('/api/spark/chats/:id', async (c) => {
  await chats.delete(c.req.param('id'));
  // The "always allow this tool" answers belonged to that conversation.
  forgetApprovals(c.req.param('id'));
  return c.body(null, 204);
});

/** Switch which of a regenerated turn's stored replies is showing. */
app.post('/api/spark/chats/:id/messages/:index/variant', async (c) => {
  const { variantIndex } = (await c.req.json()) as { variantIndex?: number };
  if (typeof variantIndex !== 'number') return c.text('missing "variantIndex"', 400);
  try {
    return c.json(await chats.setActiveVariant(c.req.param('id'), Number(c.req.param('index')), variantIndex));
  } catch (err) {
    return c.text(err instanceof Error ? err.message : String(err), 404);
  }
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
    /** Journal and templates folder names, as this device has them set. */
    dirs?: { journal?: string; templates?: string };
    permissions?: { write?: boolean; destroy?: boolean; remember?: boolean; run?: boolean };
    /** How much happens without being asked about. */
    mode?: string;
    /** Which model preset to answer with. */
    modeId?: string;
    historyDepth?: number;
    /** Names of files already uploaded through `/api/files`. */
    attachments?: string[];
    /**
     * Set for "Try again": the index, in this chat's own stored messages, of
     * the assistant reply being replaced. The question is re-read from
     * storage rather than from `message`, and history is sliced from
     * *before* that question — never from the tail of what's on disk, which
     * would still hold the reply this turn exists to discard.
     */
    regenerateAt?: number;
    /**
     * Set when the turn continues from a prompt that was rewound to: the
     * index of that prompt. `message` is its re-worded successor, which
     * replaces it; nothing stored after it — the superseded prompt's own
     * replies — travels with this turn or stays in the active line. The old
     * wording and its continuation are kept as the new prompt's variants,
     * reachable by switching.
     */
    rewindTo?: number;
  };

  const chat = await chats.ensure(body.chatId);
  const depth = Math.min(Math.max(body.historyDepth ?? 12, 0), 40);

  const regenerateAt = typeof body.regenerateAt === 'number' ? body.regenerateAt : undefined;
  const rewindTo = typeof body.rewindTo === 'number' ? body.rewindTo : undefined;
  let rawMessage: string;
  let historySource: ChatMessage[];
  if (regenerateAt !== undefined) {
    const target = chat.messages[regenerateAt];
    const asked = chat.messages[regenerateAt - 1];
    if (target?.role !== 'assistant' || asked?.role !== 'user') {
      return c.text('nothing to regenerate there', 400);
    }
    rawMessage = asked.text;
    historySource = chat.messages.slice(0, regenerateAt - 1);
  } else if (rewindTo !== undefined) {
    if (!body.message?.trim()) return c.text('missing "message"', 400);
    const prior = chat.messages[rewindTo];
    if (prior?.role !== 'user') return c.text('nothing to continue from there', 400);
    rawMessage = body.message.trim();
    // The new wording takes the rewound-to prompt's place, and nothing after
    // it travels with the turn: the superseded prompt and the responses beyond
    // it are exactly what rewinding means to leave behind. The client has
    // already dropped them from its own view; this is what stops them being
    // sent again from storage.
    historySource = [...chat.messages.slice(0, rewindTo), { role: 'user', text: rawMessage, at: Date.now() }];
  } else {
    if (!body.message?.trim()) return c.text('missing "message"', 400);
    rawMessage = body.message.trim();
    historySource = chat.messages;
  }

  const permissions = {
    write: body.permissions?.write ?? false,
    destroy: body.permissions?.destroy ?? false,
    remember: body.permissions?.remember ?? false,
    // Two gates, and both have to be open: the person asked for it, and this
    // machine has somewhere to run it.
    run: (body.permissions?.run ?? false) && sandboxEnabled(),
  };
  // `edit` rather than `auto` when the client says nothing, because a default
  // that skips every question is not a default anybody chose.
  const mode: PermissionMode = isPermissionMode(body.mode) ? body.mode : 'edit';

  // A leading `/journal` becomes the paragraph it stands for. Done here rather
  // than in the loop so that what gets *stored* is what the person typed: a
  // transcript should read back as the conversation, not as its expansion.
  const expanded = await expandCommand(rawMessage);

  return stream(c, async (writer) => {
    c.header('content-type', 'application/x-ndjson; charset=utf-8');
    c.header('cache-control', 'no-store');

    const send = (event: unknown) => writer.write(`${JSON.stringify(event)}\n`);

    let reply = '';
    let thinking = '';
    let thinkingStartedAt: number | undefined;
    let thinkingMs: number | undefined;
    /** Set the moment `runSpark` yields an `error` event, rather than thrown — see the loop below. */
    let failure: string | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    /** Which profile actually answered — the fallback, if the primary didn't. */
    let answeredBy: { providerId: string; model: string } | undefined;
    const used: ChatToolCall[] = [];
    const presented: string[] = [];
    const pending = new Map<string, { name: string; input: Record<string, unknown> }>();

    /**
     * The reply's true order — thinking, the calls it led to, more thinking,
     * more calls, the answer — built the same way `SparkView.tsx`'s live
     * `run()` builds its own `entry.segments`, event by event, so a turn
     * reloaded later shows the order it actually happened in rather than
     * `segmentsOf`'s thinking-then-tools-then-text fallback. Kept in step
     * with `reply`/`thinking`/`used` above rather than derived from them
     * afterwards, because the interleaving is exactly the information those
     * flat accumulators throw away.
     */
    const segments: ChatSegment[] = [];
    let segmentThinkingStartedAt: number | undefined;
    const closeSegmentThinking = (): void => {
      const last = segments[segments.length - 1];
      if (last?.kind === 'thinking' && last.elapsedMs === undefined) {
        last.elapsedMs = Date.now() - (segmentThinkingStartedAt ?? Date.now());
      }
    };

    try {
      // The chat id goes first so the client can attach an in-flight reply to
      // a conversation that this very request just created.
      await send({ type: 'chat', id: chat.id });

      for await (const event of runSpark({
        message: expanded.message,
        history: historySource.slice(-depth),
        context: body.context ?? {},
        dirs: {
          journal: body.dirs?.journal || 'journal',
          templates: body.dirs?.templates || '_templates',
        },
        permissions,
        mode,
        modeId: body.modeId,
        chatId: chat.id,
        space,
        memory,
        files,
        attachments: body.attachments,
        signal: c.req.raw.signal,
      })) {
        if (event.type === 'text') {
          reply += event.text;
          // Same merge-or-start rule the client's `onText` uses: text keeps
          // growing the segment already in progress, and a tool call in
          // between starts a fresh one.
          closeSegmentThinking();
          const last = segments[segments.length - 1];
          if (last?.kind === 'text') last.text += event.text;
          else segments.push({ kind: 'text', text: event.text });
        }
        // `thinking` is never stored as answer text — it is captured
        // separately, purely so a reloaded conversation can show it again.
        if (event.type === 'thinking') {
          if (thinkingStartedAt === undefined) thinkingStartedAt = Date.now();
          thinking += event.text;
          const last = segments[segments.length - 1];
          // Still growing the same segment only if it's both a thinking
          // segment *and* nobody has closed it out yet — mirrors the
          // client's `onThinking` exactly, so a later round's thinking is
          // never mistaken for a continuation of one a tool call already
          // ended.
          if (last?.kind === 'thinking' && last.elapsedMs === undefined) {
            last.text += event.text;
          } else {
            segmentThinkingStartedAt = Date.now();
            segments.push({ kind: 'thinking', text: event.text });
          }
        }
        if (thinkingStartedAt !== undefined && thinkingMs === undefined && event.type !== 'thinking') {
          thinkingMs = Date.now() - thinkingStartedAt;
        }
        if (event.type === 'action' && event.action.kind === 'present') presented.push(event.action.page);
        if (event.type === 'tool') {
          pending.set(event.id, { name: event.name, input: event.input });
          // A tool call is the other way a thinking segment stops being the
          // live one.
          closeSegmentThinking();
          const last = segments[segments.length - 1];
          if (last?.kind !== 'tools') segments.push({ kind: 'tools', tools: [] });
        }
        if (event.type === 'tool-result') {
          const call = pending.get(event.id);
          const toolCall: ChatToolCall = {
            name: call?.name ?? 'unknown',
            input: call?.input ?? {},
            ok: event.ok,
            summary: event.summary,
            ...(event.pages ? { pages: event.pages } : {}),
            ...(event.detail ? { detail: event.detail } : {}),
            ...(event.citations ? { citations: event.citations } : {}),
          };
          used.push(toolCall);
          // The tool events for one call are never interrupted by another
          // call's events or by text/thinking — `runSpark` runs tool calls
          // one at a time within a round — so the `tools` segment `tool`
          // just opened (or extended) above is still the last one here.
          const last = segments[segments.length - 1];
          if (last?.kind === 'tools') last.tools.push(toolCall);
        }
        // `runSpark` yields this rather than throwing, so the loop above would
        // otherwise run to a normal `done` and fall through here as if the turn
        // had simply finished — storing a truncated reply as a clean success and
        // losing any tool call that was still in flight. Recording it here is
        // what lets the turn be marked, below, instead of replayed next time as
        // if it were a complete answer.
        if (event.type === 'error') failure = event.message;
        if (event.type === 'usage') {
          const costUsd = estimateCost(event.model, event.inputTokens, event.outputTokens);
          usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            ...(costUsd !== null ? { costUsd } : {}),
          };
          answeredBy = { providerId: event.profileId, model: event.model };
        }
        await send(event);
      }

      // The fetch's own abort (the person clicking Stop, or the tab going away)
      // surfaces the same way a provider error does — as an `error` event, since
      // it is what breaks the provider request out from under `runSpark` — so it
      // has to be told apart from a real failure here rather than shown as one.
      const errorNote = failure
        ? c.req.raw.signal.aborted
          ? 'Stopped before finishing.'
          : `Did not finish: ${failure}`
        : undefined;

      // Covers the one path `text` and `tool` events above don't: a turn
      // that ends — aborted, or the model stopped without ever answering —
      // while thinking was still the last thing that happened. Mirrors the
      // client's own `finally`-block call to `closeThinking`.
      closeSegmentThinking();

      const assistant: ChatMessage = {
        role: 'assistant',
        text: reply,
        tools: used.length > 0 ? used : undefined,
        presented: presented.length > 0 ? presented : undefined,
        thinking: thinking || undefined,
        thinkingMs,
        segments: segments.length > 0 ? segments : undefined,
        modeId: body.modeId,
        providerId: answeredBy?.providerId,
        model: answeredBy?.model,
        usage,
        error: errorNote,
        at: Date.now(),
      };
      const saved =
        regenerateAt !== undefined
          ? await chats.regenerate(chat.id, regenerateAt, assistant)
          : rewindTo !== undefined
            ? await chats.rewindAndAppend(
                chat.id,
                rewindTo,
                // What they typed, not what it expanded into: a transcript should
                // read back as the conversation that happened.
                { role: 'user', text: rawMessage, at: Date.now() },
                assistant,
              )
            : await chats.append(
                chat.id,
                // What they typed, not what it expanded into: a transcript should
                // read back as the conversation that happened.
                { role: 'user', text: rawMessage, at: Date.now() },
                assistant,
              );
      await send({ type: 'saved', title: saved.title });

      // Consolidation goes here, after the reply has been streamed and stored,
      // which is what keeps it from being a background job: the person asked for
      // this turn, so the tidying happens inside it and nothing runs while
      // nobody is looking. It cannot fail the turn — the answer is already sent
      // and delivered, and a memory pass that goes wrong is a memory pass that
      // goes wrong, not a lost reply.
      // A turn that didn't finish is nothing to consolidate from — its buffer
      // is whatever fragment happened to stream before the failure.
      if (!errorNote && permissions.remember && (await memory.isDue())) {
        try {
          // A signal of its own, not the request's: by this point the reply
          // is already fully sent and stored, so the person closing the tab
          // or navigating away right as the last chunk lands would otherwise
          // abort this pass too, even though nothing about it depends on the
          // connection still being open. Bounded instead so a consolidation
          // that genuinely hangs doesn't run forever.
          const report = await memory.consolidate(saved.messages, {
            signal: AbortSignal.timeout(30_000),
            chatId: chat.id,
          });
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
await sparkSettings.load();
await githubSettings.load();
await memory.load();
if (await seedSpace(space)) {
  console.log('  Seeded an empty space with a welcome page, an example plugin and an example skill.');
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`\n  Spark server  →  http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${info.port}`);
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
  console.log(
    `  Web search    →  ${
      webSearchEnabled()
        ? activeSearchLabel()
        : 'off (configure a search engine in Settings → Spark)'
    }`,
  );
  console.log(`  Sandbox       →  ${describeSandbox()}\n`);
});
