import { useCallback, useEffect, useState } from 'react';
import { normalizePageName, pageBasename, pageFolder, type Workspace } from '@spark/core';
import type { PageMeta } from '@spark/plugin-sdk';
import { forgetCachedPage } from '../lib/page-cache';

/**
 * Acting on what is in the navigator.
 *
 * The navigator could show you the space and open things in it, and that was
 * all — every other verb meant leaving the app for Finder. These are the rest:
 * rename, move, duplicate, delete, and the clipboard the first three are
 * usually reached through.
 *
 * The load-bearing decision is that **a folder is still not a thing.** It is a
 * directory on disk, and there is no folder API to rename or delete one, by
 * design — see AGENTS → Folders. So a folder operation here is the operation
 * applied to every page underneath it, and it is spelled out that way rather
 * than hidden behind an endpoint that would pretend otherwise. The visible
 * consequence is honest: moving a folder moves the pages in it, and an *empty*
 * folder is created at the destination rather than carried, because there is
 * nothing in it to carry.
 */

/** What the navigator can act on: a page, or a folder path. */
export type Entry =
  | { kind: 'page'; path: string }
  | { kind: 'folder'; path: string };

// ---------------------------------------------------------------------------
// The clipboard
// ---------------------------------------------------------------------------

export interface Clipboard {
  mode: 'cut' | 'copy';
  entries: Entry[];
}

/**
 * Module state rather than context.
 *
 * Cutting in one navigator and pasting in another — a second navigator in a
 * tab, or a floated one — is the obvious expectation the moment two of them can
 * exist, and threading this through a provider would make the clipboard a
 * property of a subtree it is not a property of.
 */
let clipboard: Clipboard | null = null;
const listeners = new Set<() => void>();

export function setClipboard(next: Clipboard | null): void {
  clipboard = next;
  for (const listener of [...listeners]) listener();
}

export function useClipboard(): Clipboard | null {
  const [value, setValue] = useState(clipboard);
  useEffect(() => {
    const listener = () => setValue(clipboard);
    listeners.add(listener);
    // Something may have been cut between the first render and here.
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Every page at or under a folder path. */
export function pagesUnder(pages: PageMeta[], folder: string): string[] {
  const prefix = `${folder}/`;
  return pages
    .filter((page) => page.name.startsWith(prefix) || page.name === folder)
    .map((page) => page.name);
}

/** The page names an entry stands for — itself, or everything inside it. */
export function pagesOf(pages: PageMeta[], entry: Entry): string[] {
  return entry.kind === 'page' ? [entry.path] : pagesUnder(pages, entry.path);
}

function join(folder: string, name: string): string {
  return normalizePageName(folder ? `${folder}/${name}` : name);
}

/**
 * `notes/idea` → `notes/idea copy`, then `notes/idea copy 2`.
 *
 * A suffix rather than a prefix, so the copy sorts next to the original and
 * reads as what it is. Numbering starts at 2 because the first one is "copy".
 */
export function uniqueName(taken: Set<string>, wanted: string): string {
  if (!taken.has(wanted)) return wanted;
  const folder = pageFolder(wanted);
  const base = pageBasename(wanted);
  for (let n = 1; n < 500; n++) {
    const candidate = join(folder, n === 1 ? `${base} copy` : `${base} copy ${n}`);
    if (!taken.has(candidate)) return candidate;
  }
  return join(folder, `${base} copy ${Date.now()}`);
}

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

export interface OperationContext {
  workspace: Workspace;
  pages: PageMeta[];
}

/** How many pages an operation touched, so the caller can say so. */
export interface OperationResult {
  moved: number;
  /** Where a single page ended up, for reopening it under its new name. */
  destination: string | null;
}

/**
 * Renames a page, or a folder's worth of them.
 *
 * `next` is a *basename*: renaming `work/notes` to `journal` gives
 * `work/journal`, never `journal`. Moving somewhere else is `moveEntry`, and
 * keeping the two apart is what stops a typo with a slash in it relocating a
 * folder you meant to rename.
 */
export async function renameEntry(
  { workspace, pages }: OperationContext,
  entry: Entry,
  next: string,
): Promise<OperationResult> {
  const parent = pageFolder(entry.path);
  const destination = join(parent, next);
  if (destination === entry.path) return { moved: 0, destination };

  if (entry.kind === 'page') {
    await workspace.space.rename(entry.path, destination);
    forgetCachedPage(entry.path);
    return { moved: 1, destination };
  }

  // A folder rename is every page under it moving by one path segment. The
  // folder itself is created first so that renaming an empty one still leaves
  // you with the folder you asked for rather than with nothing at all.
  await workspace.space.createFolder(destination).catch(() => {});
  const inside = pagesUnder(pages, entry.path);
  for (const page of inside) {
    await workspace.space.rename(page, `${destination}${page.slice(entry.path.length)}`);
    forgetCachedPage(page);
  }
  return { moved: inside.length, destination };
}

/** Moves an entry into a folder, keeping its own name. */
export async function moveEntry(
  context: OperationContext,
  entry: Entry,
  folder: string,
): Promise<OperationResult> {
  const { workspace, pages } = context;
  const base = pageBasename(entry.path);
  const destination = join(folder, base);

  if (destination === entry.path) return { moved: 0, destination };
  // Dropping a folder inside itself would rename pages into a path that keeps
  // growing. Refused rather than clamped, because there is no sensible result.
  if (entry.kind === 'folder' && (folder === entry.path || folder.startsWith(`${entry.path}/`))) {
    throw new Error(`"${base}" cannot go inside itself.`);
  }

  if (entry.kind === 'page') {
    if (await workspace.space.exists(destination)) {
      throw new Error(`"${destination}" already exists.`);
    }
    await workspace.space.rename(entry.path, destination);
    forgetCachedPage(entry.path);
    return { moved: 1, destination };
  }

  await workspace.space.createFolder(destination).catch(() => {});
  const inside = pagesUnder(pages, entry.path);
  for (const page of inside) {
    await workspace.space.rename(page, `${destination}${page.slice(entry.path.length)}`);
    forgetCachedPage(page);
  }
  return { moved: inside.length, destination };
}

/**
 * Copies an entry into a folder.
 *
 * Read-then-write rather than a server-side copy: there is no copy endpoint,
 * and adding one would be a second way to create a page — with its own opinion
 * about revisions — for something the space API can already express. The empty
 * base revision on the write is what makes a collision an error instead of an
 * overwrite.
 */
export async function copyEntry(
  { workspace, pages }: OperationContext,
  entry: Entry,
  folder: string,
): Promise<OperationResult> {
  const taken = new Set(pages.map((page) => page.name));
  const base = pageBasename(entry.path);

  if (entry.kind === 'page') {
    const destination = uniqueName(taken, join(folder, base));
    const source = await workspace.space.read(entry.path);
    await workspace.space.write(destination, source.text, '');
    return { moved: 1, destination };
  }

  const destination = uniqueName(taken, join(folder, base));
  await workspace.space.createFolder(destination).catch(() => {});
  const inside = pagesUnder(pages, entry.path);
  for (const page of inside) {
    const source = await workspace.space.read(page);
    await workspace.space.write(`${destination}${page.slice(entry.path.length)}`, source.text, '');
  }
  return { moved: inside.length, destination };
}

/**
 * Deletes an entry.
 *
 * The caller confirms; this only does it. A folder takes everything under it,
 * which is why the count matters enough to be in the return value — "deleted"
 * and "deleted 34 pages" are different things to have just done.
 */
export async function deleteEntry(
  { workspace, pages }: OperationContext,
  entry: Entry,
): Promise<OperationResult> {
  const targets = pagesOf(pages, entry);
  for (const page of targets) {
    await workspace.space.delete(page);
    workspace.events.emit('page:delete', { page });
  }
  return { moved: targets.length, destination: null };
}

/** Runs the pending clipboard into a folder. Cut clears it; copy does not. */
export async function pasteInto(
  context: OperationContext,
  board: Clipboard,
  folder: string,
): Promise<OperationResult> {
  let moved = 0;
  let destination: string | null = null;

  for (const entry of board.entries) {
    const result =
      board.mode === 'cut'
        ? await moveEntry(context, entry, folder)
        : await copyEntry(context, entry, folder);
    moved += result.moved;
    destination = result.destination;
  }

  // A cut is consumed by the paste; a copy stays on the board, because pasting
  // the same thing into three folders is a normal thing to want.
  if (board.mode === 'cut') setClipboard(null);
  return { moved, destination };
}

/** A label for the clipboard's contents, for the Paste row in a menu. */
export function describeClipboard(board: Clipboard | null): string | null {
  if (!board || board.entries.length === 0) return null;
  const verb = board.mode === 'cut' ? 'Move' : 'Copy';
  if (board.entries.length === 1) return `${verb} ${pageBasename(board.entries[0].path)} here`;
  return `${verb} ${board.entries.length} items here`;
}

/** Binds the operations to one workspace, with the toasting and refreshing. */
export function useNavigatorOperations(
  workspace: Workspace,
  pages: PageMeta[],
  refresh: () => Promise<void>,
  toast: (message: string, kind?: 'info' | 'success' | 'error') => void,
) {
  const run = useCallback(
    async (
      action: (context: OperationContext) => Promise<OperationResult>,
      describe: (result: OperationResult) => string,
    ): Promise<OperationResult | null> => {
      try {
        const result = await action({ workspace, pages });
        await refresh();
        if (result.moved > 0) toast(describe(result), 'success');
        return result;
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
        return null;
      }
    },
    [workspace, pages, refresh, toast],
  );

  return run;
}
