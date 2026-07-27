import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, githubAuthEnabled } from './config.js';

/**
 * GitHub connection state.
 *
 * Spark is a personal server: one space, one owner. The GitHub token is
 * therefore stored server-side (mode 0600, outside the space, never committed)
 * rather than handed to the browser — the browser only ever learns *that* an
 * account is connected, never the credential. Anyone who can reach this server
 * can already read the notes, so a per-request session layer would add
 * ceremony without adding a boundary.
 */

export interface GitHubUser {
  login: string;
  name?: string;
  avatar?: string;
}

interface StoredAuth {
  token: string;
  user: GitHubUser;
  connectedAt: number;
}

const OAUTH_STATE_TTL_MS = 10 * 60_000;

export class AuthStore {
  #auth: StoredAuth | null = null;
  #loaded = false;
  #pendingStates = new Map<string, number>();

  get #file(): string {
    return join(config.stateDir, 'auth.json');
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      this.#auth = JSON.parse(await readFile(this.#file, 'utf8')) as StoredAuth;
    } catch {
      this.#auth = null;
    }
  }

  token(): string | null {
    return this.#auth?.token ?? null;
  }

  user(): GitHubUser | undefined {
    return this.#auth?.user;
  }

  async connect(token: string, user: GitHubUser): Promise<void> {
    this.#auth = { token, user, connectedAt: Date.now() };
    await mkdir(config.stateDir, { recursive: true });
    await writeFile(this.#file, JSON.stringify(this.#auth, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async disconnect(): Promise<void> {
    this.#auth = null;
    try {
      await writeFile(this.#file, 'null', { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* nothing to clear */
    }
  }

  /** Mints a single-use OAuth `state` value to bind the callback to this flow. */
  issueState(): string {
    this.#sweepStates();
    const state = randomBytes(24).toString('hex');
    this.#pendingStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
    return state;
  }

  consumeState(state: string): boolean {
    this.#sweepStates();
    const expires = this.#pendingStates.get(state);
    if (expires === undefined) return false;
    this.#pendingStates.delete(state);
    return expires > Date.now();
  }

  #sweepStates(): void {
    const now = Date.now();
    for (const [state, expires] of this.#pendingStates) {
      if (expires <= now) this.#pendingStates.delete(state);
    }
  }
}

export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: `${config.github.origin}/api/auth/github/callback`,
    // `repo` is what sync needs; nothing broader is requested.
    scope: 'repo',
    state,
  });
  return `https://github.com/login/oauth/authorize?${params}`;
}

export async function exchangeCode(code: string): Promise<string> {
  if (!githubAuthEnabled()) throw new Error('GitHub OAuth is not configured on this server.');

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
      redirect_uri: `${config.github.origin}/api/auth/github/callback`,
    }),
  });

  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!body.access_token) {
    throw new Error(body.error_description ?? 'GitHub did not return an access token.');
  }
  return body.access_token;
}

export async function fetchGitHubUser(token: string): Promise<GitHubUser> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'spark-notes',
    },
  });
  if (!res.ok) throw new Error(`GitHub rejected the token (${res.status}).`);

  const body = (await res.json()) as { login: string; name?: string; avatar_url?: string };
  return { login: body.login, name: body.name ?? undefined, avatar: body.avatar_url };
}
