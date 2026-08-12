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
 * Loads `.env` from the repository root, if there is one.
 *
 * Anchored to `ROOT` for the same reason everything else here is: npm runs
 * workspace scripts from inside `apps/server`, so a path relative to the
 * working directory would look for the file in the wrong place.
 *
 * Node's own loader is used rather than a dependency, and it has the
 * precedence everyone expects: a variable already set in the real environment
 * wins, so `PORT=4000 npm run dev` still overrides the file. A missing file is
 * not a problem to report — a fresh clone is meant to run with nothing set up.
 */
function loadDotEnv(): void {
  try {
    process.loadEnvFile(resolve(ROOT, '.env'));
  } catch {
    /* no .env, or an unreadable one: defaults and the real environment stand */
  }
}

loadDotEnv();

/**
 * All configuration comes from the environment, with defaults that let
 * `npm run dev` work in a fresh clone with nothing set up.
 */
export const config = {
  port: Number(process.env.PORT ?? 3001),

  /**
   * Network interface to bind. Defaults to `0.0.0.0` (every interface) so the
   * server is reachable from other machines on the network — and, inside a
   * container, from outside the container at all — without any configuration.
   * Set `HOST=127.0.0.1` to restrict it to the local machine.
   */
  host: process.env.HOST ?? '0.0.0.0',

  /** Root of the markdown space. This directory is the whole database. */
  spaceDir: resolve(ROOT, process.env.SPARK_SPACE ?? 'space'),

  /** Where server-side state lives — never inside the space, never in git. */
  stateDir: resolve(ROOT, process.env.SPARK_STATE ?? '.spark'),

  spaceName: process.env.SPARK_SPACE_NAME ?? 'Spark',

  /**
   * AI defaults from the environment.
   *
   * These are only a starting point: whatever is saved from the settings page
   * lands in `.spark/ai.json` and takes precedence, so a server can be handed a
   * key at boot *or* configured from the app, and neither way surprises the
   * other. Nothing set here means AI features are simply off.
   */
  ai: {
    provider: process.env.SPARK_AI_PROVIDER ?? '',
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
    openaiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.SPARK_AI_MODEL ?? '',
    /** Base URL, for OpenAI-compatible servers: OpenRouter, Ollama, vLLM… */
    endpoint: process.env.SPARK_AI_ENDPOINT ?? process.env.OPENAI_BASE_URL ?? '',

    /** Embedding model for semantic search. Empty means text matching only. */
    embedModel: process.env.SPARK_EMBED_MODEL ?? '',
    /** Where to send embeddings, when it is not the same place as the chat. */
    embedEndpoint: process.env.SPARK_EMBED_ENDPOINT ?? '',
  },

  /**
   * Spark's own defaults, for the same reason the AI ones are here: a container
   * can be handed a name and a search key at boot without anyone opening the
   * settings page. Whatever is saved from Settings wins — read through
   * `spark-settings.ts`, never directly.
   */
  spark: {
    userName: process.env.SPARK_USER_NAME ?? '',
    instructions: process.env.SPARK_INSTRUCTIONS ?? '',
    /**
     * Seeds the default web-search engine (Exa). Every other engine's key lives
     * only in the settings file; the env var exists for the container that
     * should work before anyone opens Settings. Empty means Exa is not ready
     * until a key is added there.
     */
    exaKey: process.env.EXA_API_KEY ?? '',
  },

  /**
   * The code sandbox.
   *
   * Off unless a runtime is named, and named here rather than in the settings
   * file on purpose: switching on code execution is a decision about the machine
   * the server runs on, not a preference of whoever is using the app, and it
   * should take a deliberate edit to a file or an environment variable rather
   * than a toggle anybody can find. See `sandbox.ts` for what each runtime
   * actually isolates.
   */
  sandbox: {
    /**
     * `auto` | `off` | `docker` | `node` | `python` | a command of your own.
     *
     * `auto` is the default and resolves at boot: Docker when the daemon
     * answers, and a local subprocess otherwise. It is a default rather than a
     * refusal because the *second* gate is still shut — `sparkCanRun` is off
     * until someone turns it on — and an agent that cannot add a column up is
     * worse at the job than one whose arithmetic runs in a container.
     */
    runtime: process.env.SPARK_SANDBOX ?? 'auto',
    /** Docker image. Empty means a small official one per language. */
    image: process.env.SPARK_SANDBOX_IMAGE ?? '',
    timeoutMs: Number(process.env.SPARK_SANDBOX_TIMEOUT ?? 20_000),
    /**
     * The agent's own directory, which survives between runs.
     *
     * Outside the space, because scratch work is not notes: a half-finished CSV
     * and three attempts at a chart do not belong in the page list, in search or
     * in git. It is the working directory of every `run_code` call, so a script
     * can leave something behind for the next one to pick up.
     */
    workDir: resolve(ROOT, process.env.SPARK_SANDBOX_WORKDIR ?? '.spark/workspace'),
    /** Whether a run gets the persistent directory or a fresh temporary one. */
    persist: process.env.SPARK_SANDBOX_PERSIST !== 'false',
  },

  /**
   * GitHub OAuth defaults from the environment.
   *
   * Only a starting point, like the AI settings above: whatever is saved from
   * Settings → Sync lands in `.spark/github.json` and takes precedence. Read
   * through `github-settings.ts`, never directly — it is the one place that
   * knows which of the two is in force.
   */
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

