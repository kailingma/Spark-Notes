/**
 * A local copy of what you have already looked at.
 *
 * Opening a page you read a minute ago should not be a network round trip
 * before anything appears. This keeps the text and the revision of recently
 * opened pages in `localStorage` so the editor can paint immediately and then
 * reconcile with the server — the ordinary stale-while-revalidate shape.
 *
 * Three rules make it safe to do that in an app whose first principle is never
 * losing a keystroke:
 *
 * 1. **A cached revision is never written against.** The cache is for painting.
 *    `Editor` holds its writes until the server read lands, because writing
 *    with a revision from disk from an hour ago is precisely how you manufacture
 *    the conflict this app refuses to resolve for you.
 * 2. **Every write updates it.** A cache that disagrees with what the app itself
 *    just saved would show you your own edit being undone on the next open.
 * 3. **It is disposable.** Anything unparseable, oversized or from another
 *    schema is dropped rather than migrated. Losing it costs one fetch.
 *
 * It is also per-browser and per-origin, like the preferences: the folder of
 * markdown is still the whole database.
 */

const PREFIX = 'spark:page:';
const INDEX_KEY = 'spark:page-cache';

/** Roughly a book's worth of recently read pages, and no more. */
const MAX_PAGES = 60;

/** A single page bigger than this is not what the cache is for. */
const MAX_BYTES = 256 * 1024;

export interface CachedPage {
  text: string;
  /** The revision the server reported when this text was read. */
  rev: string;
  /** When it was cached, so the index can evict the least recent. */
  at: number;
}

interface Entry {
  text: string;
  rev: string;
  at: number;
}

export function readCachedPage(name: string): CachedPage | null {
  const raw = get(PREFIX + name);
  if (!raw) return null;
  try {
    const entry = JSON.parse(raw) as Partial<Entry>;
    if (typeof entry.text !== 'string' || typeof entry.rev !== 'string') return null;
    return { text: entry.text, rev: entry.rev, at: typeof entry.at === 'number' ? entry.at : 0 };
  } catch {
    return null;
  }
}

export function writeCachedPage(name: string, text: string, rev: string): void {
  // A page with no revision has not been confirmed by the server, and caching
  // it would mean painting text next time that nothing has agreed to.
  if (!rev || text.length > MAX_BYTES) {
    forgetCachedPage(name);
    return;
  }

  const entry: Entry = { text, rev, at: Date.now() };
  if (!set(PREFIX + name, JSON.stringify(entry))) return;
  touch(name);
}

export function forgetCachedPage(name: string): void {
  remove(PREFIX + name);
  writeIndex(readIndex().filter((entry) => entry !== name));
}

/** Drops everything. Offered so "something looks wrong" has an answer. */
export function clearPageCache(): void {
  for (const name of readIndex()) remove(PREFIX + name);
  remove(INDEX_KEY);
}

// ---------------------------------------------------------------------------
// The page list
//
// Separate from the pages themselves because it is one value, it is read on
// every boot before anything else can be drawn, and it is what makes the
// navigator appear with content in it rather than empty and then full.
// ---------------------------------------------------------------------------

const LIST_KEY = 'spark:page-list';
const FOLDER_KEY = 'spark:folder-list';

export function readCachedList<T>(kind: 'pages' | 'folders'): T[] | null {
  const raw = get(kind === 'pages' ? LIST_KEY : FOLDER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

export function writeCachedList(kind: 'pages' | 'folders', value: unknown[]): void {
  set(kind === 'pages' ? LIST_KEY : FOLDER_KEY, JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Storage, defensively
//
// `localStorage` throws in private windows, when quota is exhausted, and when
// a browser has disabled it outright. None of that should break the editor, so
// every access is wrapped and every failure means "there is no cache".
// ---------------------------------------------------------------------------

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function set(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    // Almost always quota. Make room the only way that is certainly enough,
    // then give up on this write rather than looping.
    clearPageCache();
    return false;
  }
}

function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nothing to remove from */
  }
}

function readIndex(): string[] {
  const raw = get(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function writeIndex(names: string[]): void {
  set(INDEX_KEY, JSON.stringify(names));
}

/** Moves a page to the front of the index, evicting the oldest past the cap. */
function touch(name: string): void {
  const next = [name, ...readIndex().filter((entry) => entry !== name)];
  for (const evicted of next.slice(MAX_PAGES)) remove(PREFIX + evicted);
  writeIndex(next.slice(0, MAX_PAGES));
}
