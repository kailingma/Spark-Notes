import { pageBasename } from '@spark/core';
import type { PageMeta } from '@spark/plugin-sdk';

/**
 * The folder tree, derived from page names.
 *
 * There is no folder object anywhere in Spark — a folder exists exactly as long
 * as a page name contains a slash, which is what keeps the space honest when
 * you move a file in Finder. So the tree is rebuilt from the flat list every
 * time, and this module is pure: give it names, get a hierarchy.
 */

export interface TreeFolder {
  kind: 'folder';
  /** Last segment, e.g. `projects` in `work/projects`. */
  name: string;
  /** Full path from the root, and the identity used for expansion state. */
  path: string;
  children: TreeNode[];
  /** Pages inside, at any depth. */
  count: number;
  /** Most recent modification anywhere inside, for recency sorting. */
  modified: number;
  /**
   * True when the folder's own page — `projects.md` beside `projects/` — is
   * already written. The page is offered either way; this only says whether
   * opening it will show you something or start you a blank one.
   */
  hasPage: boolean;
}

export interface TreePage {
  kind: 'page';
  name: string;
  path: string;
  meta: PageMeta;
}

export type TreeNode = TreeFolder | TreePage;

export type SortMode = 'recent' | 'name';

/**
 * Builds the tree.
 *
 * `folders` comes from the server and includes empty ones, which page names
 * alone can never reveal. Any folder implied by a page name is added on the
 * way through, so the two sources agree without either being authoritative.
 *
 * A folder's own page — `projects.md` sitting beside `projects/` — is not
 * listed as a sibling of the folder. It *is* the folder as far as reading goes,
 * so it hangs off the folder row instead, and showing it twice would make the
 * list read as though there were two of them.
 */
export function buildTree(
  pages: PageMeta[],
  folders: string[] = [],
  sort: SortMode = 'recent',
): TreeFolder {
  const root: TreeFolder = {
    kind: 'folder',
    name: '',
    path: '',
    children: [],
    count: 0,
    modified: 0,
    hasPage: false,
  };
  const index = new Map<string, TreeFolder>([['', root]]);

  const folderAt = (path: string): TreeFolder => {
    const existing = index.get(path);
    if (existing) return existing;

    const cut = path.lastIndexOf('/');
    const parent = folderAt(cut === -1 ? '' : path.slice(0, cut));
    const folder: TreeFolder = {
      kind: 'folder',
      name: cut === -1 ? path : path.slice(cut + 1),
      path,
      children: [],
      count: 0,
      modified: 0,
      hasPage: false,
    };
    index.set(path, folder);
    parent.children.push(folder);
    return folder;
  };

  // Every folder path, from both sources, worked out before anything is placed:
  // whether a page is a companion depends on folders that may only be implied
  // by a page appearing later in the list.
  const paths = new Set(folders);
  for (const meta of pages) {
    let running = '';
    for (const segment of meta.name.split('/').slice(0, -1)) {
      running = running ? `${running}/${segment}` : segment;
      paths.add(running);
    }
  }

  // Sorted so a parent is always created before its children.
  for (const path of [...paths].sort()) folderAt(path);

  for (const meta of pages) {
    if (paths.has(meta.name)) {
      folderAt(meta.name).hasPage = true;
      continue;
    }

    const cut = meta.name.lastIndexOf('/');
    const parent = folderAt(cut === -1 ? '' : meta.name.slice(0, cut));
    parent.children.push({
      kind: 'page',
      name: pageBasename(meta.name),
      path: meta.name,
      meta,
    });
  }

  tally(root);
  sortFolder(root, sort);
  return root;
}

/** Counts and newest-modified, bottom up, so a folder can be sorted by either. */
function tally(folder: TreeFolder): void {
  let count = 0;
  let modified = 0;
  for (const child of folder.children) {
    if (child.kind === 'folder') {
      tally(child);
      count += child.count;
      modified = Math.max(modified, child.modified);
    } else {
      count += 1;
      modified = Math.max(modified, child.meta.modified);
    }
  }
  folder.count = count;
  folder.modified = modified;
}

function sortFolder(folder: TreeFolder, sort: SortMode): void {
  folder.children.sort((a, b) => {
    // Folders first, always: a folder is a place and a page is a thing, and
    // mixing them by date makes a list you cannot scan.
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    if (sort === 'name') return labelOf(a).localeCompare(labelOf(b));
    return modifiedOf(b) - modifiedOf(a) || labelOf(a).localeCompare(labelOf(b));
  });
  for (const child of folder.children) {
    if (child.kind === 'folder') sortFolder(child, sort);
  }
}

const labelOf = (node: TreeNode) => node.name;
const modifiedOf = (node: TreeNode) => (node.kind === 'folder' ? node.modified : node.meta.modified);

/** The folder at a path, or null. Backs the columns view's cursor. */
export function folderAtPath(root: TreeFolder, path: string): TreeFolder | null {
  if (!path) return root;
  let current: TreeFolder = root;
  for (const segment of path.split('/')) {
    const next = current.children.find(
      (child): child is TreeFolder => child.kind === 'folder' && child.name === segment,
    );
    if (!next) return null;
    current = next;
  }
  return current;
}

/** Every folder path on the way to a page, for revealing it in the tree. */
export function ancestorsOf(pagePath: string): string[] {
  const parts = pagePath.split('/');
  parts.pop();
  const out: string[] = [];
  let running = '';
  for (const part of parts) {
    running = running ? `${running}/${part}` : part;
    out.push(running);
  }
  return out;
}

/**
 * A flat, filtered list.
 *
 * Filtering deliberately collapses the hierarchy: once you have typed a query
 * you are looking for a page, not for where it lives, and making you expand
 * three folders to reach the match you can already see is the opposite of
 * helpful. The full path still shows on each row.
 */
export function filterPages(pages: PageMeta[], query: string): PageMeta[] {
  const search = query.trim().toLowerCase();
  if (!search) return pages;

  // Every term has to appear somewhere, so "proj spark" finds
  // `projects/spark` without anyone having to remember the separator.
  const terms = search.split(/\s+/);
  return pages.filter((page) => {
    const name = page.name.toLowerCase();
    return terms.every((term) => name.includes(term));
  });
}
