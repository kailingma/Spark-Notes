import type { SidebarSide, DropTarget, Rect, Side } from './model';

/**
 * Turning a pointer position into a place to drop.
 *
 * The zones are measured once, when a drag starts, and then only arithmetic
 * happens per pointer move. Measuring on every move would force a layout read
 * sixty times a second against a tree that is also animating, which is both
 * slow and wrong — the rects you want are the ones from before the drop preview
 * started shifting things around.
 */

export interface GroupZone {
  groupId: string;
  rect: Rect;
  /** The tab strip, when the group has one; dropping here reorders rather than splits. */
  tabStrip?: Rect;
  /** Left edge of each tab, for working out where an insertion lands. */
  tabEdges?: number[];
}

export interface SidebarZone {
  side: SidebarSide;
  rect: Rect;
}

export interface DropZones {
  /** The whole tile area, in viewport coordinates. */
  workbench: Rect;
  groups: GroupZone[];
  sidebars: SidebarZone[];
}

export interface DropResolution {
  target: DropTarget;
  /** Where to draw the preview, in viewport coordinates. */
  preview: Rect;
}

/** How close to an edge counts as "against it", as a fraction of the tile. */
const SPLIT_BAND = 0.16;
/**
 * How close to the workbench edge counts as a full-height snap, in px.
 *
 * Deliberately tight. A wide band made a window feel like it snapped the
 * moment it came anywhere near an edge, which left no room to simply set a
 * window down near the side of the screen without it turning into a split.
 * Narrow it and there is real margin to work in before docking takes over —
 * a window only snaps once it is genuinely against the edge.
 */
const EDGE_BAND = 12;

export function collectZones(root: HTMLElement): DropZones {
  const workbench = rectOf(root);
  const groups: GroupZone[] = [];

  for (const el of root.querySelectorAll<HTMLElement>('[data-window-group]')) {
    const groupId = el.dataset.windowGroup;
    if (!groupId) continue;
    const strip = el.querySelector<HTMLElement>('[data-window-tabs]');
    const tabs = strip ? [...strip.querySelectorAll<HTMLElement>('[data-window-tab]')] : [];
    groups.push({
      groupId,
      rect: rectOf(el),
      tabStrip: strip ? rectOf(strip) : undefined,
      tabEdges: tabs.map((tab) => tab.getBoundingClientRect().left),
    });
  }

  // From the layer, not from the tiles' parent: the left and right rails are
  // siblings of `.workbench-centre`, so looking only at the tiles' own parent
  // found the bottom rail and nothing else — dropping a tab on the navigator
  // rail silently did nothing.
  const layer = root.closest('.workbench-layer') ?? root.ownerDocument;
  const sidebars: SidebarZone[] = [];
  for (const el of layer.querySelectorAll<HTMLElement>('[data-window-sidebar]')) {
    const side = el.dataset.windowSidebar as SidebarSide | undefined;
    if (side) sidebars.push({ side, rect: rectOf(el) });
  }

  return { workbench, groups, sidebars };
}

/**
 * Where a view dropped at `point` would land.
 *
 * Order matters and encodes the priorities: a tab strip is an explicit target
 * and wins over everything; the outer edges of the workbench come next, because
 * they are how you make a new full-height column; then the tile under the
 * pointer. `allowFloat` is false while dragging a window that is already
 * floating, where "drop it nowhere" means "leave it where the pointer is" and
 * is handled by the caller instead.
 */
export function resolveDrop(
  point: { x: number; y: number },
  zones: DropZones,
  options: {
    allowFloat?: boolean;
    /**
     * Only the deliberate targets — the outer edges and a tab strip. Used while
     * dragging a window that is already floating, where merely passing over a
     * tile must not swallow it.
     */
    edgesOnly?: boolean;
    /**
     * Snapping off entirely: the thing lands as a floating window wherever the
     * pointer is, even over the middle of a tile.
     *
     * Held on ⌥ during the drag. Without it, floating a note *over the editor
     * area* was impossible — every point inside the workbench resolves to some
     * tile, so the only place a float could be dropped was the thin strip of
     * header and status bar outside it, which is not a place anybody thinks to
     * aim for. The float button in the tile corner still exists; this is the
     * same intent expressed during a drag you have already started.
     */
    forceFloat?: boolean;
    floatSize?: { width: number; height: number };
  } = {},
): DropResolution | null {
  if (options.forceFloat && options.allowFloat !== false) return floatAt(point, zones, options);

  for (const group of zones.groups) {
    if (group.tabStrip && contains(group.tabStrip, point)) {
      const index = insertionIndex(group.tabEdges ?? [], point.x);
      return {
        target: { kind: 'tab', groupId: group.groupId, index },
        preview: group.rect,
      };
    }
  }

  for (const sidebar of zones.sidebars) {
    if (contains(sidebar.rect, point)) {
      return { target: { kind: 'sidebar', side: sidebar.side }, preview: sidebar.rect };
    }
  }

  if (contains(zones.workbench, point)) {
    const edge = workbenchEdge(point, zones.workbench);
    if (edge) {
      return { target: { kind: 'edge', side: edge }, preview: halfOf(zones.workbench, edge) };
    }

    if (!options.edgesOnly) {
      // Innermost first: nested groups are later in document order, and the one
      // the pointer is actually over is the smallest containing rect.
      const hit = [...zones.groups].reverse().find((group) => contains(group.rect, point));
      if (hit) {
        const side = splitSide(point, hit.rect);
        if (side) {
          return { target: { kind: 'split', groupId: hit.groupId, side }, preview: halfOf(hit.rect, side) };
        }
        return { target: { kind: 'tab', groupId: hit.groupId }, preview: hit.rect };
      }
    }
  }

  if (options.allowFloat === false) return null;
  return floatAt(point, zones, options);
}

/** A window-sized rectangle under the pointer, in both coordinate systems. */
function floatAt(
  point: { x: number; y: number },
  zones: DropZones,
  options: { floatSize?: { width: number; height: number } },
): DropResolution {
  const size = options.floatSize ?? { width: 460, height: 380 };
  return {
    target: {
      kind: 'window',
      rect: {
        x: point.x - zones.workbench.x - size.width / 2,
        y: point.y - zones.workbench.y - 16,
        width: size.width,
        height: size.height,
      },
    },
    preview: {
      x: point.x - size.width / 2,
      y: point.y - 16,
      width: size.width,
      height: size.height,
    },
  };
}

function workbenchEdge(point: { x: number; y: number }, rect: Rect): Side | null {
  if (point.x - rect.x < EDGE_BAND) return 'left';
  if (rect.x + rect.width - point.x < EDGE_BAND) return 'right';
  if (point.y - rect.y < EDGE_BAND) return 'top';
  if (rect.y + rect.height - point.y < EDGE_BAND) return 'bottom';
  return null;
}

function splitSide(point: { x: number; y: number }, rect: Rect): Side | null {
  const rx = (point.x - rect.x) / Math.max(rect.width, 1);
  const ry = (point.y - rect.y) / Math.max(rect.height, 1);
  const distances: Array<[Side, number]> = [
    ['left', rx],
    ['right', 1 - rx],
    ['top', ry],
    ['bottom', 1 - ry],
  ];
  const [side, distance] = distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best));
  return distance < SPLIT_BAND ? side : null;
}

export function halfOf(rect: Rect, side: Side): Rect {
  switch (side) {
    case 'left':
      return { ...rect, width: rect.width / 2 };
    case 'right':
      return { ...rect, x: rect.x + rect.width / 2, width: rect.width / 2 };
    case 'top':
      return { ...rect, height: rect.height / 2 };
    case 'bottom':
      return { ...rect, y: rect.y + rect.height / 2, height: rect.height / 2 };
  }
}

function insertionIndex(edges: number[], x: number): number {
  let index = 0;
  for (const edge of edges) {
    if (x > edge) index += 1;
  }
  return index;
}

function contains(rect: Rect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function rectOf(el: HTMLElement): Rect {
  const box = el.getBoundingClientRect();
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

// ---------------------------------------------------------------------------
// Pointer gestures
// ---------------------------------------------------------------------------

/**
 * Movement before a press counts as a drag rather than as a click.
 *
 * One number for the whole app: a tab, a rail tab and a navigator row are the
 * same gesture from the hand's point of view, and a handle that picked its own
 * value would be the one that feels twitchy.
 */
export const DRAG_THRESHOLD = 5;

export interface PointerDragHandlers {
  onMove(event: PointerEvent, delta: { dx: number; dy: number }): void;
  onEnd?(event: PointerEvent, delta: { dx: number; dy: number }, cancelled: boolean): void;
  /**
   * Pixels of movement before this counts as a drag at all.
   *
   * Needed wherever the same press is also a click, which is everywhere a drag
   * starts from a handle you also press: a navigator row opens a page *and*
   * drags it somewhere, a tab switches to its view *and* moves it. Without one,
   * the hand's own tremor during a click is a drag that lands a drop — see
   * AGENTS → "A press that moves one pixel is still a click".
   *
   * Zero is only right for a handle whose press means nothing on its own, like
   * a splitter or a resize corner.
   */
  threshold?: number;
  /** Runs once the threshold is crossed, for chrome that only a real drag wants. */
  onStart?(): void;
}

/**
 * Runs a pointer drag to completion.
 *
 * Listeners go on `window` rather than the handle: a fast drag outruns the
 * element under the cursor, and a pointer capture on the handle would stop the
 * drop target from ever seeing the pointer. Escape cancels, which matters most
 * for a window drag you started by accident.
 */
export function startPointerDrag(event: React.PointerEvent, handlers: PointerDragHandlers): void {
  const startX = event.clientX;
  const startY = event.clientY;
  const threshold = handlers.threshold ?? 0;

  let live = threshold === 0;
  if (live) {
    document.body.classList.add('is-dragging');
    handlers.onStart?.();
  }

  const move = (native: PointerEvent) => {
    const delta = { dx: native.clientX - startX, dy: native.clientY - startY };
    if (!live) {
      if (Math.hypot(delta.dx, delta.dy) < threshold) return;
      live = true;
      document.body.classList.add('is-dragging');
      handlers.onStart?.();
    }
    handlers.onMove(native, delta);
  };

  const finish = (native: PointerEvent, cancelled: boolean) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('is-dragging');
    // A press that never crossed the threshold was a click, not a cancelled
    // drag — telling the caller otherwise would have it undo something that
    // never started.
    if (live) {
      handlers.onEnd?.(
        native,
        { dx: native.clientX - startX, dy: native.clientY - startY },
        cancelled,
      );
    }
  };

  const up = (native: PointerEvent) => finish(native, false);
  const cancel = (native: PointerEvent) => finish(native, true);

  const onKey = (key: KeyboardEvent) => {
    if (key.key !== 'Escape') return;
    key.preventDefault();
    key.stopPropagation();
    finish(new PointerEvent('pointercancel', { clientX: startX, clientY: startY }), true);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', onKey, true);
}
