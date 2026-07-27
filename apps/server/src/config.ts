import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Defaults are anchored to the repository root rather than the working
 * directory: npm runs workspace scripts from inside `apps/server`, and a space
 * that quietly appears there instead of where the user expects is exactly the
 * kind of surprise a notes app cannot afford.
 */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    const manifest = resolve(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { workspaces?: unknown };
        if (pkg.workspaces) return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const ROOT = repoRoot();

/**
 * All configuration comes from the environment, with defaults that let
 * `npm run dev` work in a fresh clone with nothing set up.
 */
export const config = {
  port: Number(process.env.PORT ?? 3001),

  /** Root of the markdown space. This directory is the whole database. */
  spaceDir: resolve(ROOT, process.env.SPARK_SPACE ?? 'space'),

  /** Where server-side state lives — never inside the space, never in git. */
  stateDir: resolve(ROOT, process.env.SPARK_STATE ?? '.spark'),

  spaceName: process.env.SPARK_SPACE_NAME ?? 'Spark',

  /** Anthropic API key. Absent means AI features are simply off. */
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  aiModel: process.env.SPARK_AI_MODEL ?? 'claude-opus-5',

  github: {
    clientId: process.env.GITHUB_CLIENT_ID ?? '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
    /** Public origin used to build the OAuth callback URL. */
    origin: process.env.SPARK_ORIGIN ?? 'http://localhost:3001',
  },

  git: {
    /** Author used for sync commits. */
    authorName: process.env.SPARK_GIT_NAME ?? 'Spark Notes',
    authorEmail: process.env.SPARK_GIT_EMAIL ?? 'spark@localhost',
    branch: process.env.SPARK_GIT_BRANCH ?? 'main',
  },

  /** In dev the Vite server owns the browser; in production we serve the build. */
  isDev: process.env.NODE_ENV !== 'production',
  webDist: resolve(ROOT, process.env.SPARK_WEB_DIST ?? 'apps/web/dist'),
} as const;

export const aiEnabled = (): boolean => config.anthropicKey.length > 0;
export const githubAuthEnabled = (): boolean =>
  config.github.clientId.length > 0 && config.github.clientSecret.length > 0;
