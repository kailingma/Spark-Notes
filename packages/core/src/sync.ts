import type { SyncStatus } from '@spark/plugin-sdk';
import type { EventBus } from './events.js';

export interface GitStatus {
  /** False when the space isn't a git repo or no remote is configured. */
  configured: boolean;
  /** Whether a GitHub account is connected. */
  authenticated: boolean;
  remote?: string;
  branch?: string;
  /** Uncommitted file count. */
  dirty: number;
  ahead: number;
  behind: number;
  lastSync?: number;
  /** Files that came back from a pull with conflict markers. */
  conflicts: string[];
}

/**
 * Owns the online/sync distinction.
 *
 * **Online mode** (the default, and what every page load starts in) reads and
 * writes straight through to the server. There is no local replica, so there is
 * nothing to reconcile and no stale data — you are always looking at the file
 * on disk.
 *
 * **Sync mode** additionally runs git in the background: pull, commit, push on
 * an interval and on demand. It is opt-in because it needs a remote and a
 * GitHub token, and because pushing on someone's behalf should be a choice they
 * made rather than a default they discover.
 */
export class SyncController {
  #status: SyncStatus = { mode: 'online' };
  #git: GitStatus | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<GitStatus | null> | null = null;

  constructor(
    private readonly events: EventBus,
    private readonly baseUrl = '/api/git',
    /** How often sync mode reconciles with the remote. */
    private readonly intervalMs = 60_000,
  ) {}

  get status(): SyncStatus {
    return this.#status;
  }

  get git(): GitStatus | null {
    return this.#git;
  }

  get mode(): 'online' | 'sync' {
    return this.#status.mode;
  }

  /** Reads git state without changing anything. Safe to call in online mode. */
  async refresh(): Promise<GitStatus | null> {
    try {
      const res = await fetch(`${this.baseUrl}/status`);
      if (!res.ok) return null;
      this.#git = (await res.json()) as GitStatus;
      return this.#git;
    } catch {
      return null;
    }
  }

  /**
   * Turns on background sync. Returns false when git isn't set up yet, so the
   * caller can walk the user through connecting GitHub instead of failing
   * silently.
   */
  async enableSyncMode(): Promise<boolean> {
    const git = await this.refresh();
    if (!git?.configured || !git.authenticated) return false;

    this.#set({ mode: 'sync', state: 'idle' });
    this.#timer ??= setInterval(() => {
      void this.syncNow();
    }, this.intervalMs);
    void this.syncNow();
    return true;
  }

  disableSyncMode(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    this.#set({ mode: 'online' });
  }

  /**
   * Runs one pull/commit/push cycle. Concurrent callers share the in-flight
   * request rather than stacking up git operations on the same repo.
   */
  async syncNow(): Promise<GitStatus | null> {
    if (this.#inFlight) return this.#inFlight;

    this.#set({ mode: 'sync', state: 'syncing' });
    this.#inFlight = (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/sync`, { method: 'POST' });
        const body = (await res.json()) as
          | { ok: true; status: GitStatus }
          | { ok: false; error: string; status?: GitStatus };

        if (!res.ok || !body.ok) {
          const message = 'error' in body ? body.error : `Sync failed (${res.status})`;
          this.#git = body.status ?? this.#git;
          this.#set({ mode: 'sync', state: 'error', message });
          return this.#git;
        }

        this.#git = body.status;
        this.#set(
          body.status.conflicts.length > 0
            ? {
                mode: 'sync',
                state: 'error',
                message: `${body.status.conflicts.length} file(s) need conflict resolution`,
              }
            : { mode: 'sync', state: 'idle' },
        );
        return this.#git;
      } catch (err) {
        this.#set({
          mode: 'sync',
          state: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        return this.#git;
      } finally {
        this.#inFlight = null;
      }
    })();

    return this.#inFlight;
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #set(status: SyncStatus): void {
    this.#status = status;
    this.events.emit('sync:change', { status });
  }
}
