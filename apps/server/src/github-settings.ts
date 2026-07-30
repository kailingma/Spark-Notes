import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

/**
 * The GitHub OAuth app Spark signs in through.
 *
 * This used to be environment-only: `GITHUB_CLIENT_ID` and
 * `GITHUB_CLIENT_SECRET`, set before the server starts. That is fine for a
 * container and hopeless for a person, because it means the one setup step
 * sync needs is the one step the app cannot walk you through — you have to
 * find a shell, edit a file, and restart the thing you were using.
 *
 * So the credentials are stored the same way the AI key is: `.spark/github.json`
 * at mode 0600, outside the space, never committed, never pushed. The browser
 * is told the client id (it is not a secret — it appears in the authorize URL
 * it is about to be redirected to) and only the last four characters of the
 * secret, so you can tell which app is configured without the server handing
 * back a credential it was trusted with.
 *
 * The environment still works and still wins nothing: whatever is stored takes
 * precedence, so a server handed variables at boot keeps working and can also
 * be reconfigured from the app without the two disagreeing.
 */

export interface GitHubAppSettings {
  clientId: string;
  clientSecret: string;
  /**
   * Public origin the callback URL is built from. It has to match the
   * "Authorization callback URL" on the GitHub app exactly, which is the single
   * most common thing to get wrong, so it is editable rather than assumed.
   */
  origin: string;
}

/** The redacted view the browser is allowed to see. */
export interface PublicGitHubAppSettings {
  clientId: string;
  hasSecret: boolean;
  /** Last four characters of the secret, for telling two apps apart. */
  secretHint: string;
  origin: string;
  /** Exactly what to paste into GitHub, assembled here so nobody types it. */
  callbackUrl: string;
  source: 'stored' | 'env' | 'none';
  /** True when sign-in would actually work right now. */
  configured: boolean;
}

export class GitHubSettingsStore {
  #stored: GitHubAppSettings | null = null;
  #loaded = false;

  get #file(): string {
    return join(config.stateDir, 'github.json');
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as Partial<GitHubAppSettings>;
      this.#stored = parsed && parsed.clientId ? normalize(parsed) : null;
    } catch {
      // No file yet, or an unreadable one: fall back to the environment.
      this.#stored = null;
    }
  }

  /** The settings in force, file first and environment second. */
  get(): GitHubAppSettings {
    return this.#stored ?? fromEnv();
  }

  enabled(): boolean {
    const settings = this.get();
    return settings.clientId.length > 0 && settings.clientSecret.length > 0;
  }

  publicView(): PublicGitHubAppSettings {
    const settings = this.get();
    return {
      clientId: settings.clientId,
      hasSecret: settings.clientSecret.length > 0,
      secretHint: settings.clientSecret.slice(-4),
      origin: settings.origin,
      callbackUrl: callbackUrl(settings),
      source: this.#stored ? 'stored' : this.enabled() ? 'env' : 'none',
      configured: this.enabled(),
    };
  }

  /**
   * Writes new settings.
   *
   * The same rule as the AI key, for the same reason: an absent field means
   * "leave that one alone", because the browser never receives the secret and
   * so cannot send it back, and saving a corrected origin must not wipe the
   * credential. Absence is tested for, not falsiness — an empty string is a
   * real value everywhere except the secret, where it is how you say "I did
   * not retype it".
   */
  async save(patch: Partial<GitHubAppSettings>): Promise<void> {
    const current = this.get();
    const secret = patch.clientSecret?.trim();

    this.#stored = normalize({
      clientId: patch.clientId ?? current.clientId,
      clientSecret: secret ? secret : current.clientSecret,
      origin: patch.origin ?? current.origin,
    });

    await mkdir(config.stateDir, { recursive: true });
    await writeFile(this.#file, JSON.stringify(this.#stored, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  /** Forgets the stored app, falling back to the environment. */
  async clear(): Promise<void> {
    this.#stored = null;
    try {
      await writeFile(this.#file, 'null', { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* nothing to clear */
    }
  }
}

export const githubSettings = new GitHubSettingsStore();

export function callbackUrl(settings: GitHubAppSettings): string {
  return `${settings.origin.replace(/\/+$/, '')}/api/auth/github/callback`;
}

function normalize(raw: Partial<GitHubAppSettings>): GitHubAppSettings {
  return {
    clientId: (raw.clientId ?? '').trim(),
    clientSecret: (raw.clientSecret ?? '').trim(),
    origin: (raw.origin ?? '').trim() || config.github.origin,
  };
}

function fromEnv(): GitHubAppSettings {
  return normalize({
    clientId: config.github.clientId,
    clientSecret: config.github.clientSecret,
    origin: config.github.origin,
  });
}
