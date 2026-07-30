import { useMemo, useState } from 'react';
import { pageFolder } from '@spark/core';
import type { PageMeta } from '@spark/plugin-sdk';
import { FolderRow, PageRow } from './rows';
import { folderAtPath, type TreeFolder, type TreeNode } from './tree';

/**
 * Three ways of looking at the same space.
 *
 * They are separate components rather than one component with a mode flag
 * because they are genuinely different navigations, not different skins: a tree
 * is for structure you already know, a list is for recency and for search
 * results, and columns are for walking into a hierarchy you don't. Each is
 * small, and each is a pure function of the tree plus a cursor.
 */

export interface ModeProps {
  root: TreeFolder;
  currentPage: string | null;
  onOpen: (page: string, event: React.MouseEvent) => void;
  /** Creates a page inside a folder. */
  onAddPage: (folder: string) => void;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export function TreeMode({
  root,
  currentPage,
  onOpen,
  onAddPage,
  expanded,
  onToggle,
}: ModeProps & {
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
}) {
  const rows = useMemo(() => flatten(root, expanded, 0), [root, expanded]);

  if (rows.length === 0) return <Empty />;

  return (
    <div className="nav-rows" role="tree">
      {rows.map(({ node, depth }) =>
        node.kind === 'folder' ? (
          <FolderRow
            key={`f:${node.path}`}
            label={node.name}
            count={node.count}
            depth={depth}
            expanded={expanded.has(node.path)}
            onToggle={() => onToggle(node.path)}
            hasPage={node.hasPage}
            onOpenPage={(event) => onOpen(node.path, event)}
            onAddPage={() => onAddPage(node.path)}
          />
        ) : (
          <PageRow
            key={`p:${node.path}`}
            label={node.name}
            depth={depth}
            current={node.path === currentPage}
            title={node.path}
            onOpen={(event) => onOpen(node.path, event)}
          />
        ),
      )}
    </div>
  );
}

function flatten(
  folder: TreeFolder,
  expanded: ReadonlySet<string>,
  depth: number,
): Array<{ node: TreeNode; depth: number }> {
  const rows: Array<{ node: TreeNode; depth: number }> = [];
  for (const child of folder.children) {
    rows.push({ node: child, depth });
    if (child.kind === 'folder' && expanded.has(child.path)) {
      rows.push(...flatten(child, expanded, depth + 1));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** Flat and recency-ordered. The mode search results always fall back to. */
export function ListMode({
  pages,
  currentPage,
  onOpen,
}: {
  pages: PageMeta[];
  currentPage: string | null;
  onOpen: (page: string, event: React.MouseEvent) => void;
}) {
  if (pages.length === 0) return <Empty />;

  return (
    <div className="nav-rows">
      {pages.map((page) => (
        <PageRow
          key={page.name}
          label={page.name.split('/').pop() ?? page.name}
          // The folder is the useful second line here: without the tree around
          // it, two notes called "notes" are otherwise indistinguishable.
          detail={pageFolder(page.name) || undefined}
          current={page.name === currentPage}
          title={page.name}
          onOpen={(event) => onOpen(page.name, event)}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * Miller columns: one level per column, the selection in each opening the next.
 *
 * Only offered when the navigator is wide enough for two columns to be legible;
 * squeezed into a phone-width rail this is a worse tree, so the switcher hides
 * it rather than letting you choose something that cannot work.
 */
export function ColumnsMode({ root, currentPage, onOpen, onAddPage }: ModeProps) {
  const [path, setPath] = useState('');

  const columns = useMemo(() => {
    const out: Array<{ path: string; folder: TreeFolder }> = [{ path: '', folder: root }];
    let running = '';
    for (const segment of path ? path.split('/') : []) {
      running = running ? `${running}/${segment}` : segment;
      const folder = folderAtPath(root, running);
      if (!folder) break;
      out.push({ path: running, folder });
    }
    return out;
  }, [root, path]);

  return (
    <div className="nav-columns">
      {columns.map((column) => (
        <div className="nav-column" key={column.path || '(root)'}>
          {column.folder.children.length === 0 && <Empty />}
          {column.folder.children.map((child) =>
            child.kind === 'folder' ? (
              <FolderRow
                key={`f:${child.path}`}
                label={child.name}
                count={child.count}
                selected={path === child.path || path.startsWith(`${child.path}/`)}
                onToggle={() => setPath(child.path)}
                hasPage={child.hasPage}
                onOpenPage={(event) => onOpen(child.path, event)}
                onAddPage={() => onAddPage(child.path)}
              />
            ) : (
              <PageRow
                key={`p:${child.path}`}
                label={child.name}
                current={child.path === currentPage}
                title={child.path}
                onOpen={(event) => onOpen(child.path, event)}
              />
            ),
          )}
        </div>
      ))}
    </div>
  );
}

function Empty() {
  return <p className="nav-empty">Nothing here.</p>;
}
