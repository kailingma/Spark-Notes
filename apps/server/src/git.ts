import fs, { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import { config } from './config.js';
import { hasConflictMarkers, merge3 } from './merge.js';
import type { FileSpace } from './space.js';

/**
 * Git sync for the space.
 *
 * Uses isomorphic-git rather than shelling out, so there is no dependency on a
 * `git` binary and auth is a token we pass explicitly instead of a credential
 * helper we have to trust. Merges go through the line-level three-way merge in
 * `merge.ts`, which is the whole point: two devices editing different parts of
 * a note should just work.
 */

export interface GitStatus {
  configured: boolean;
  authenticated: boolean;
  remote?: string;
  branch?: string;
  dirty: number;
  ahead: number;
  behind: number;
  lastSync?: number;
  conflicts: string[];
}

export interface SyncOutcome {
  status: GitStatus;
  pulled: number;
  pushed: boolean;
  committed: boolean;
}

const dir = () => config.spaceDir;

const author = () => ({
  name: config.git.authorName,
  email: config.git.authorEmail,
});

export class GitService {
  #lastSync: number | undefined;

  constructor(
    private readonly space: FileSpace,
    /** Returns the current GitHub token, or null when not connected. */
    private readonly getToken: () => string | null,
  ) {}

  /** Read-only. Safe to call in online mode, on every page load. */
  async status(): Promise<GitStatus> {
    const token = this.getToken();
    const base: GitStatus = {
      configured: false,
      authenticated: token !== null,
      dirty: 0,
      ahead: 0,
      behind: 0,
      lastSync: this.#lastSync,
      conflicts: [],
    };

    if (!(await this.#isRepo())) return base;

    const [remote, branch] = await Promise.all([this.#remoteUrl(), this.#branch()]);
    const changed = await this.#changedFiles();
    const conflicts = await this.#conflictedFiles();
    const { ahead, behind } = await this.#divergence(branch);

    return {
      ...base,
      configured: remote !== undefined,
      remote,
      branch,
      dirty: changed.modified.length + changed.deleted.length,
      ahead,
      behind,
      conflicts,
    };
  }

  /**
   * Creates the repo and points it at a remote. Called once, when the user
   * connects a repository from the UI.
   */
  async setup(remoteUrl: string): Promise<GitStatus> {
    if (!(await this.#isRepo())) {
      await git.init({ fs, dir: dir(), defaultBranch: config.git.branch });
    }
    await git.addRemote({
      fs,
      dir: dir(),
      remote: 'origin',
      url: remoteUrl,
      force: true,
    });
    return this.status();
  }

  /**
   * One full reconcile: commit local work, fetch, merge, push.
   *
   * Committing first is deliberate — it means a merge always has a real base
   * to work from, and nothing in the working tree can be lost by a pull.
   */
  async sync(): Promise<SyncOutcome> {
    const token = this.getToken();
    if (!(await this.#isRepo())) throw new Error('The space is not a git repository yet.');

    const remote = await this.#remoteUrl();
    if (!remote) throw new Error('No git remote is configured.');
    if (!token) throw new Error('Connect a GitHub account before syncing.');

    const branch = (await this.#branch()) ?? config.git.branch;
    const committed = await this.#commitAll();

    // Fetch, then merge with our own driver so text conflicts resolve per line.
    await git.fetch({
      fs,
      http,
      dir: dir(),
      remote: 'origin',
      ref: branch,
      singleBranch: true,
      tags: false,
      onAuth: () => ({ username: token, password: 'x-oauth-basic' }),
    });

    let pulled = 0;
    let conflicted = false;
    const remoteRef = `refs/remotes/origin/${branch}`;
    if (await this.#refExists(remoteRef)) {
      const before = await this.#headOid(branch);
      try {
        await git.merge({
          fs,
          dir: dir(),
          ours: branch,
          theirs: remoteRef,
          author: author(),
          message: `Merge origin/${branch} into ${branch}`,
          abortOnConflict: false,
          mergeDriver: ({ contents, path }) => {
            const [base, ours, theirs] = contents;
            const result = merge3(base, ours, theirs, {
              ours: `local (${path})`,
              theirs: 'remote',
            });
            return { cleanMerge: result.clean, mergedText: result.text };
          },
        });
      } catch (err) {
        // A conflict is an outcome, not a failure. With `abortOnConflict:
        // false` the merged text — both sides, wrapped in markers by our merge
        // driver — has already been written to the working tree; isomorphic-git
        // just signals it by throwing. Keep going so the result gets committed
        // and reported instead of being silently rolled back.
        if (!isMergeConflict(err)) {
          throw new Error(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        conflicted = true;
        pulled = 1;
      }

      const after = await this.#headOid(branch);
      if (!conflicted && after && after !== before) {
        pulled = 1;
        // A clean merge only moves the ref; the working tree has to be brought
        // up to match it before anyone reads a page again. After a conflicted
        // merge the tree already holds the merged text — checking out would
        // throw it away.
        await git.checkout({ fs, dir: dir(), ref: branch, force: true });
      }
    }

    // Commit whatever the merge produced, conflict markers included, so the
    // state is durable and visible rather than living only in the working tree.
    const conflicts = await this.#conflictedFiles();
    if (conflicts.length > 0) {
      await this.#commitAll(`Merge with conflicts in ${conflicts.length} page(s)`);
    } else if (conflicted) {
      await this.#commitAll(`Merge origin/${branch}`);
    }

    // Never push conflict markers to the remote — that would spread one
    // device's unresolved merge to every other device. The commit is safe
    // locally; the push waits until a human has cleaned the page up.
    if (conflicts.length > 0) {
      this.#lastSync = Date.now();
      return { status: await this.status(), pulled, pushed: false, committed };
    }

    let pushed = false;
    try {
      await git.push({
        fs,
        http,
        dir: dir(),
        remote: 'origin',
        ref: branch,
        onAuth: () => ({ username: token, password: 'x-oauth-basic' }),
      });
      pushed = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Someone pushed between our fetch and our push — the next cycle picks
      // it up, so this is a retry, not a failure.
      if (!/not a fast-forward|rejected/i.test(message)) throw err;
    }

    this.#lastSync = Date.now();
    return {
      status: await this.status(),
      pulled,
      pushed,
      committed,
    };
  }

  // -- internals ------------------------------------------------------------

  /**
   * The space is a repo only if it owns a `.git` of its own.
   *
   * Deliberately does not walk up the tree: a space that happens to live inside
   * some unrelated checkout must never be mistaken for that project's repo, or
   * sync would start committing someone's notes into it.
   */
  async #isRepo(): Promise<boolean> {
    return existsSync(join(dir(), '.git'));
  }

  async #remoteUrl(): Promise<string | undefined> {
    try {
      const remotes = await git.listRemotes({ fs, dir: dir() });
      return remotes.find((r) => r.remote === 'origin')?.url ?? remotes[0]?.url;
    } catch {
      return undefined;
    }
  }

  async #branch(): Promise<string | undefined> {
    try {
      return (await git.currentBranch({ fs, dir: dir(), fullname: false })) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Working-tree changes relative to HEAD, split into writes and deletes. */
  async #changedFiles(): Promise<{ modified: string[]; deleted: string[] }> {
    const matrix = await git.statusMatrix({ fs, dir: dir() });
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const [filepath, head, workdir] of matrix) {
      if (workdir === 0 && head === 1) deleted.push(filepath);
      else if (workdir === 2) modified.push(filepath);
    }
    return { modified, deleted };
  }

  async #commitAll(message?: string): Promise<boolean> {
    const { modified, deleted } = await this.#changedFiles();
    if (modified.length === 0 && deleted.length === 0) return false;

    for (const filepath of modified) {
      await git.add({ fs, dir: dir(), filepath });
    }
    for (const filepath of deleted) {
      await git.remove({ fs, dir: dir(), filepath });
    }

    await git.commit({
      fs,
      dir: dir(),
      author: author(),
      message: message ?? describeCommit(modified, deleted),
    });
    return true;
  }

  /** Pages left with conflict markers after a merge. */
  async #conflictedFiles(): Promise<string[]> {
    const pages = await this.space.list();
    const conflicted: string[] = [];

    await Promise.all(
      pages.map(async (page) => {
        try {
          const text = await readFile(this.space.pathFor(page.name), 'utf8');
          if (hasConflictMarkers(text)) conflicted.push(page.name);
        } catch {
          /* unreadable — not our problem here */
        }
      }),
    );
    return conflicted.sort();
  }

  async #refExists(ref: string): Promise<boolean> {
    try {
      await git.resolveRef({ fs, dir: dir(), ref });
      return true;
    } catch {
      return false;
    }
  }

  async #headOid(branch: string): Promise<string | undefined> {
    try {
      return await git.resolveRef({ fs, dir: dir(), ref: branch });
    } catch {
      return undefined;
    }
  }

  /** How far the local branch and its remote-tracking ref have drifted. */
  async #divergence(branch?: string): Promise<{ ahead: number; behind: number }> {
    if (!branch) return { ahead: 0, behind: 0 };

    const remoteRef = `refs/remotes/origin/${branch}`;
    if (!(await this.#refExists(remoteRef))) return { ahead: 0, behind: 0 };

    try {
      const [local, remote] = await Promise.all([
        git.log({ fs, dir: dir(), ref: branch, depth: 500 }),
        git.log({ fs, dir: dir(), ref: remoteRef, depth: 500 }),
      ]);
      const localOids = new Set(local.map((c) => c.oid));
      const remoteOids = new Set(remote.map((c) => c.oid));

      return {
        ahead: local.filter((c) => !remoteOids.has(c.oid)).length,
        behind: remote.filter((c) => !localOids.has(c.oid)).length,
      };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }
}

/** isomorphic-git signals "merged, but with conflicts" by throwing this. */
function isMergeConflict(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'MergeConflictError'
  );
}

function describeCommit(modified: string[], deleted: string[]): string {
  const parts: string[] = [];
  if (modified.length > 0) parts.push(`update ${summarize(modified)}`);
  if (deleted.length > 0) parts.push(`delete ${summarize(deleted)}`);
  return parts.join(', ') || 'Spark sync';
}

function summarize(files: string[]): string {
  if (files.length === 1) return files[0];
  return `${files[0]} and ${files.length - 1} more`;
}
