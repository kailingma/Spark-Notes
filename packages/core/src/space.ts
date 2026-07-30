import type { Page, PageMeta, SpaceApi } from '@spark/plugin-sdk';
import { normalizePageName } from './markdown.js';

/**
 * A page plus the revision the server had when we last saw it. Writes send the
 * revision back so the server can detect that someone else changed the file
 * underneath us instead of silently clobbering it.
 */
export interface RevisionedPage extends Page {
  rev: string;
}

/** What a write returns: the new metadata plus the revision it produced. */
export interface WrittenPage extends PageMeta {
  rev: string;
}

export class ConflictError extends Error {
  constructor(
    readonly page: string,
    /** What the server has right now. */
    readonly serverText: string,
    readonly serverRev: string,
    /** What we tried to write. */
    readonly localText: string,
  ) {
    super(`"${page}" changed on the server since it was opened`);
    this.name = 'ConflictError';
  }
}

export class SpaceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SpaceError';
  }
}

/**
 * Talks to the server's space API. This is "online mode": every read and write
 * is a request, there is no local copy, and what you see is what is on disk.
 */
export class HttpSpace implements SpaceApi {
  /** Last revision seen per page, used for conflict detection on write. */
  #revisions = new Map<string, string>();

  constructor(
    private readonly baseUrl = '/api/space',
    /** Folders sit beside the space rather than under it: `/api/space/:name`
     *  matches any path, so a nested route could never be reached. */
    private readonly folderUrl = '/api/folders',
  ) {}

  async list(): Promise<PageMeta[]> {
    const res = await this.#fetch('');
    return (await res.json()) as PageMeta[];
  }

  /**
   * Every folder, including empty ones.
   *
   * Separate from `list()` because a folder is not a page and has no metadata
   * to speak of. It lives on its own endpoint rather than being inferred from
   * page names, which is the only way an empty one can be known about.
   */
  async folders(): Promise<string[]> {
    const res = await fetch(this.folderUrl);
    if (!res.ok) return [];
    return (await res.json()) as string[];
  }

  async createFolder(name: string): Promise<string> {
    const res = await fetch(this.folderUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: normalizePageName(name) }),
    });
    if (!res.ok) throw new SpaceError((await res.text()) || 'could not create the folder', res.status);
    return ((await res.json()) as { name: string }).name;
  }

  async read(name: string): Promise<RevisionedPage> {
    const page = normalizePageName(name);
    const res = await this.#fetch(`/${encodePageName(page)}`);
    const body = (await res.json()) as RevisionedPage;
    this.#revisions.set(page, body.rev);
    return body;
  }

  /**
   * Writes a page.
   *
   * `baseRev` is the revision the caller last saw. Pass it whenever you have
   * one: two components sharing this client have independent ideas of what is
   * on disk, so relying on the shared cache would let one of them write on the
   * strength of a revision the *other* one read — which is exactly the
   * clobber the revision check exists to prevent.
   *
   * Omit it to fall back to the cached revision (fine for read-then-write in
   * one place), or pass `null` to force the write through.
   */
  async write(name: string, text: string, baseRev?: string | null): Promise<WrittenPage> {
    const page = normalizePageName(name);
    const effectiveRev =
      baseRev === undefined ? (this.#revisions.get(page) ?? '') : baseRev;

    const res = await this.#fetch(`/${encodePageName(page)}`, {
      method: 'PUT',
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        // An empty base means "create if absent"; the server treats a
        // pre-existing file as a conflict in that case. Omitting the header
        // entirely means "overwrite regardless".
        ...(effectiveRev === null ? {} : { 'x-spark-base-rev': effectiveRev }),
      },
      body: text,
    });

    if (res.status === 409) {
      const conflict = (await res.json()) as { text: string; rev: string };
      throw new ConflictError(page, conflict.text, conflict.rev, text);
    }

    const meta = (await res.json()) as WrittenPage;
    this.#revisions.set(page, meta.rev);
    return meta;
  }

  async delete(name: string): Promise<void> {
    const page = normalizePageName(name);
    await this.#fetch(`/${encodePageName(page)}`, { method: 'DELETE' });
    this.#revisions.delete(page);
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalizePageName(from);
    await this.#fetch(`/${encodePageName(source)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: normalizePageName(to) }),
    });
    this.#revisions.delete(source);
  }

  async exists(name: string): Promise<boolean> {
    const res = await fetch(
      `${this.baseUrl}/${encodePageName(normalizePageName(name))}`,
      { method: 'HEAD' },
    );
    return res.ok;
  }

  async #fetch(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, init);
    if (!res.ok && res.status !== 409) {
      const detail = await res.text().catch(() => '');
      throw new SpaceError(detail || `${res.status} ${res.statusText}`, res.status);
    }
    return res;
  }
}

/**
 * Page names can contain slashes, which we want to survive as path segments so
 * URLs stay readable, but every other special character must be escaped.
 */
export function encodePageName(name: string): string {
  return name.split('/').map(encodeURIComponent).join('/');
}
