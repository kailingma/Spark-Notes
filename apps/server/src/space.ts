import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The space is a directory of markdown files. That is the entire storage layer.
 *
 * No database, no index, no proprietary container — the files on disk are the
 * source of truth, so the notes stay readable, greppable, and portable with or
 * without this app.
 */

export interface PageMeta {
  name: string;
  modified: number;
  size: number;
}

export interface PageContent extends PageMeta {
  text: string;
  /** Content hash used for optimistic concurrency on writes. */
  rev: string;
}

/** Extensions stored verbatim; everything else is a markdown page. */
const VERBATIM_EXTENSIONS = ['.js', '.mjs', '.json', '.css', '.txt', '.csv'];

/** Directories we never walk — noise, or someone else's business. */
const IGNORED_DIRS = new Set(['.git', '.spark', 'node_modules', '.obsidian', '.trash']);

export class InvalidPageName extends Error {}
export class PageNotFound extends Error {}
export class RevisionConflict extends Error {
  constructor(
    readonly current: PageContent,
  ) {
    super('revision conflict');
  }
}

export class FileSpace {
  constructor(private readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  /**
   * Maps a page name to an absolute path, refusing anything that would escape
   * the space root. Traversal is checked after resolution, so encoded and
   * symlink-free tricks are caught the same way.
   */
  pathFor(name: string): string {
    const clean = name.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!clean) throw new InvalidPageName('page name is empty');
    if (clean.length > 400) throw new InvalidPageName('page name is too long');
    if (/[\0<>:"|?*]/.test(clean)) throw new InvalidPageName('page name has illegal characters');
    if (clean.split('/').some((part) => part === '.' || part === '..' || part === '')) {
      throw new InvalidPageName('page name has an empty or relative segment');
    }

    const withExtension = hasVerbatimExtension(clean) ? clean : `${clean}.md`;
    const full = resolve(this.root, withExtension);
    const rel = relative(this.root, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new InvalidPageName('page name escapes the space');
    }
    return full;
  }

  /** Inverse of `pathFor`: absolute path back to a page name. */
  nameFor(path: string): string {
    const rel = relative(this.root, path).split(sep).join('/');
    return hasVerbatimExtension(rel) ? rel : rel.replace(/\.md$/i, '');
  }

  async list(): Promise<PageMeta[]> {
    const pages: PageMeta[] = [];
    await this.#walk(this.root, pages);
    return pages.sort((a, b) => b.modified - a.modified);
  }

  async read(name: string): Promise<PageContent> {
    const path = this.pathFor(name);
    let text: string;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    } catch {
      throw new PageNotFound(name);
    }
    return {
      name: this.nameFor(path),
      text,
      rev: revisionOf(text),
      modified: info.mtimeMs,
      size: info.size,
    };
  }

  async exists(name: string): Promise<boolean> {
    try {
      await access(this.pathFor(name), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Writes a page, refusing the write when the file changed since the client
   * last read it.
   *
   * `baseRev` is what the client believes is on disk: an empty string means
   * "this is a new page". Either way a mismatch throws `RevisionConflict`
   * carrying the current content, so the caller can merge rather than lose
   * somebody's edit.
   */
  async write(name: string, text: string, baseRev: string | null): Promise<PageContent> {
    const path = this.pathFor(name);

    let current: PageContent | null = null;
    try {
      current = await this.read(name);
    } catch {
      current = null;
    }

    if (baseRev !== null) {
      const expected = current?.rev ?? '';
      if (expected !== baseRev) {
        // Writing identical content is never a conflict — it's a no-op.
        if (current && current.text === text) return current;
        throw new RevisionConflict(
          current ?? {
            name,
            text: '',
            rev: '',
            modified: Date.now(),
            size: 0,
          },
        );
      }
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
    const info = await stat(path);

    return {
      name: this.nameFor(path),
      text,
      rev: revisionOf(text),
      modified: info.mtimeMs,
      size: info.size,
    };
  }

  async delete(name: string): Promise<void> {
    const path = this.pathFor(name);
    await rm(path, { force: true });
    await this.#pruneEmptyParents(dirname(path));
  }

  async rename(from: string, to: string): Promise<void> {
    const source = this.pathFor(from);
    const target = this.pathFor(to);
    if (await pathExists(target)) {
      throw new InvalidPageName(`"${to}" already exists`);
    }
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
    await this.#pruneEmptyParents(dirname(source));
  }

  /** Every markdown page's name and text, for the task scan. */
  async readAllMarkdown(): Promise<Array<{ name: string; text: string }>> {
    const metas = await this.list();
    const pages = await Promise.all(
      metas
        .filter((page) => !hasVerbatimExtension(page.name))
        .map(async (page) => {
          try {
            return { name: page.name, text: await readFile(this.pathFor(page.name), 'utf8') };
          } catch {
            return null;
          }
        }),
    );
    return pages.filter((page): page is { name: string; text: string } => page !== null);
  }

  async #walk(dir: string, out: PageMeta[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.#walk(full, out);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md') && !hasVerbatimExtension(entry.name)) continue;

      try {
        const info = await stat(full);
        out.push({
          name: this.nameFor(full),
          modified: info.mtimeMs,
          size: info.size,
        });
      } catch {
        // Vanished between readdir and stat — skip it.
      }
    }
  }

  /** Deleting the last page in a folder shouldn't leave an empty folder behind. */
  async #pruneEmptyParents(dir: string): Promise<void> {
    let current = dir;
    while (current.startsWith(this.root) && current !== this.root) {
      try {
        const entries = await readdir(current);
        if (entries.length > 0) return;
        await rm(current, { recursive: false });
      } catch {
        return;
      }
      current = dirname(current);
    }
  }
}

export function revisionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function hasVerbatimExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return VERBATIM_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
