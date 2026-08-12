import type { ReactNode } from 'react';
import { ChevronIcon, FolderIcon, PageIcon, PlusIcon } from '../components/Icons';

/**
 * The two rows every navigator mode is built from.
 *
 * Sharing them is what keeps tree, list and columns feeling like one thing:
 * the same target size, the same hover, the same way the current page is
 * marked, the same drag and the same menu, whichever shape you happen to be
 * looking at the space in.
 */

/** What a row needs to be draggable and right-clickable, threaded from the top. */
export interface RowActions {
  /** Begins a workbench drag of this row's page. */
  onDragStart?: (event: React.PointerEvent) => void;
  /** Opens the actions menu at a point. Bound to right-click and to long-press. */
  onMenu?: (event: React.MouseEvent | React.PointerEvent) => void;
  /** True while this row is the cut/copy source, or a live drop target. */
  cut?: boolean;
  dropping?: boolean;
  /**
   * The folder a drop on this row lands in — itself for a folder, its parent
   * for a page. The drag hit test walks up with `closest`, so a row without one
   * falls through to the panel, which is the root of the space.
   */
  dropPath?: string;
}

export function PageRow({
  label,
  detail,
  current,
  depth = 0,
  icon,
  onOpen,
  title,
  actions,
}: {
  label: string;
  detail?: string;
  current?: boolean;
  depth?: number;
  icon?: ReactNode;
  onOpen: (event: React.MouseEvent) => void;
  title?: string;
  actions?: RowActions;
}) {
  return (
    <button
      className="nav-row"
      data-kind="page"
      data-depth={depth}
      data-cut={actions?.cut || undefined}
      aria-current={current ? 'page' : undefined}
      title={title ?? label}
      onClick={onOpen}
      // The press that opens a page is also the press that drags it, which is
      // why the drag has a movement threshold — see `startPointerDrag`.
      onPointerDown={actions?.onDragStart}
      onContextMenu={actions?.onMenu}
      data-nav-folder={actions?.dropPath}
    >
      <span className="nav-row-icon">{icon ?? <PageIcon />}</span>
      <span className="nav-row-label">{label}</span>
      {detail && <span className="nav-row-detail">{detail}</span>}
    </button>
  );
}

/**
 * A folder, and the page that belongs to it.
 *
 * The row is two controls in one: the folder opens and closes, and the small
 * page icon on the right opens `<folder>.md` — the note *about* the folder,
 * which lives beside it in the parent. It is offered whether or not that file
 * exists yet, faintly when it does not, because "write something about this
 * folder" and "read what I wrote about it" are the same gesture.
 */
export function FolderRow({
  label,
  count,
  expanded,
  depth = 0,
  selected,
  onToggle,
  onOpenPage,
  hasPage,
  onAddPage,
  actions,
}: {
  label: string;
  count: number;
  /** Undefined in the columns view, which has no twisty. */
  expanded?: boolean;
  depth?: number;
  selected?: boolean;
  onToggle: () => void;
  onOpenPage?: (event: React.MouseEvent) => void;
  hasPage?: boolean;
  onAddPage?: () => void;
  actions?: RowActions;
}) {
  return (
    <div
      className="nav-row-group"
      data-dropping={actions?.dropping || undefined}
      data-nav-folder={actions?.dropPath}
    >
      <button
        className="nav-row"
        data-kind="folder"
        data-depth={depth}
        data-expanded={expanded || undefined}
        data-selected={selected || undefined}
        data-cut={actions?.cut || undefined}
        aria-expanded={expanded}
        onClick={onToggle}
        onPointerDown={actions?.onDragStart}
        onContextMenu={actions?.onMenu}
        title={label}
      >
        {expanded === undefined ? (
          <span className="nav-row-icon">
            <FolderIcon />
          </span>
        ) : (
          <span className="nav-row-twisty">
            <ChevronIcon />
          </span>
        )}
        <span className="nav-row-label">{label}</span>
        <span className="nav-row-detail">{count}</span>
      </button>

      <span className="nav-row-tools">
        {onAddPage && (
          <button
            className="nav-row-tool"
            title={`New page in ${label}`}
            aria-label={`New page in ${label}`}
            onClick={onAddPage}
          >
            <PlusIcon />
          </button>
        )}
        {onOpenPage && (
          <button
            className="nav-row-tool"
            data-empty={!hasPage || undefined}
            title={hasPage ? `Open the page for ${label}` : `Start a page for ${label}`}
            aria-label={hasPage ? `Open the page for ${label}` : `Start a page for ${label}`}
            onClick={onOpenPage}
          >
            <PageIcon />
          </button>
        )}
      </span>
    </div>
  );
}
