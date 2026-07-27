import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { parseTasks } from '@spark/core/markdown';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { BRAINDUMP_SYSTEM, streamCompletion } from './ai.js';
import { AuthStore, authorizeUrl, exchangeCode, fetchGitHubUser } from './auth.js';
import { aiEnabled, config, githubAuthEnabled } from './config.js';
import { GitService } from './git.js';
import { seedSpace } from './seed.js';
import { FileSpace, InvalidPageName, PageNotFound, RevisionConflict } from './space.js';

const space = new FileSpace(config.spaceDir);
const auth = new AuthStore();
const gitService = new GitService(space, () => auth.token());

const app = new Hono();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

app.get('/api/config', (c) =>
  c.json({
    spaceName: config.spaceName,
    ai: aiEnabled(),
    git: true,
    githubAuth: githubAuthEnabled(),
    user: auth.user(),
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

app.get('/api/auth/github', (c) => {
  if (!githubAuthEnabled()) {
    return c.text('GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.', 501);
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
if (await seedSpace(space)) {
  console.log('  Seeded an empty space with a welcome page and an example plugin.');
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`\n  Spark server  →  http://localhost:${info.port}`);
  console.log(`  Space         →  ${config.spaceDir}`);
  console.log(`  AI            →  ${aiEnabled() ? config.aiModel : 'off (set ANTHROPIC_API_KEY)'}`);
  console.log(
    `  GitHub OAuth  →  ${githubAuthEnabled() ? 'configured' : 'off (set GITHUB_CLIENT_ID / SECRET)'}\n`,
  );
});
