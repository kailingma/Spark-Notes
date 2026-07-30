/**
 * The workbench layout, as data.
 *
 * Every operation here is a pure function from one layout to the next, and the
 * whole thing is plain JSON — which is what makes it restorable across reloads,
 * inspectable in a test, and safe to drive from a plugin. Nothing in this file
 * touches the DOM or React; the renderer reads the result and the drag layer
 * turns pointer positions into `DropTarget`s that come back through here.
 *
 * A view lives on exactly one of four **surfaces**, and they are named because
 * they are deliberately different things:
 *
 * - **`tab`** — a tab in a tile of the split tree. Resizable, always fills the
 *   space, no overlap. This is where documents belong.
 * - **`sidebar`** — one of the fixed rails at the edges. The navigator is the
 *   left one, the Spark chat the right one. A rail is not part of the tile tree
 *   because it should survive every split you make.
 * - **`window`** — a free rectangle above everything, with a z-order. Movable,
 *   resizable, and snappable back into the tree.
 * - **`modal`** — centred, immovable, scrimmed. A *place* rather than a
 *   rectangle you arrange, which is why Settings is one. An action's own
 *   dialog (the sync panel, a prompt) is not a view and is not modelled here;
 *   see `ActionDialog` in the shell.
 *
 * The invariant the whole file protects: `root` always contains at least one
 * group, so there is always somewhere for the next page to open.
 */

import type { Surface } from '@spark/plugin-sdk';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Side = 'left' | 'right' | 'top' | 'bottom';
export type SidebarSide = 'left' | 'right' | 'bottom';
export type Axis = 'row' | 'column';

/**
 * The four surfaces, re-exported from the plugin contract so nothing inside the
 * workbench invents a fifth name for one of them.
 */
export type { Surface };

/** One open instance of a registered view type. */
export interface ViewRef {
  /** Unique per instance; the id a plugin gets back from `windows.open()`. */
  id: string;
  /** Registered view type: `spark.page`, `spark.chat`, or a plugin's own. */
  type: string;
  /** Type-specific parameters. The page view reads `params.page`. */
  params: Record<string, string>;
  /** Set when the opener overrode the definition's title. */
  title?: string;
}

/** A tile holding a stack of tabbed views. */
export interface GroupNode {
  kind: 'group';
  id: string;
  views: ViewRef[];
  /** Index into `views`. Clamped by `normalize`. */
  active: number;
}

/** A row or column of tiles, with fractional sizes summing to 1. */
export interface SplitNode {
  kind: 'split';
  id: string;
  axis: Axis;
  children: LayoutNode[];
  sizes: number[];
}

export type LayoutNode = GroupNode | SplitNode;

export type WindowState = 'normal' | 'maximized' | 'minimized';

/**
 * A view on the `window` or the `modal` surface.
 *
 * The two share a frame and a z-order and nothing else: a window has a
 * rectangle it remembers, a modal is centred and sized by CSS, takes a scrim,
 * makes everything under it inert, and cannot be moved, resized or snapped.
 * `surface` is what everything downstream branches on.
 */
export interface FloatingWindow {
  id: string;
  view: ViewRef;
  rect: Rect;
  /** The rectangle to go back to when un-maximizing. Windows only. */
  restore?: Rect;
  state: WindowState;
  surface: 'window' | 'modal';
  z: number;
}

/** One of the fixed rails. Not part of the tile tree, so splits never move it. */
export interface Sidebar {
  open: boolean;
  /** Width for the side rails, height for the bottom one, in px. */
  size: number;
  views: ViewRef[];
  active: number;
}

export interface Layout {
  root: LayoutNode;
  /** Id of the focused group. */
  focus: string;
  /** Instance id of the focused view, wherever its surface happens to be. */
  focusedView: string | null;
  /** The `window` and `modal` surfaces, which share a z-order. */
  windows: FloatingWindow[];
  sidebars: Record<SidebarSide, Sidebar>;
  /** Monotonic; the next window raised takes this and increments it. */
  nextZ: number;
}

/** Where a dragged view is about to land. */
export type DropTarget =
  /** Into a tile's tab strip. */
  | { kind: 'tab'; groupId: string; index?: number }
  /** Beside a tile, splitting it. */
  | { kind: 'split'; groupId: string; side: Side }
  /** Against the outer edge of the whole tile area. */
  | { kind: 'edge'; side: Side }
  | { kind: 'sidebar'; side: SidebarSide }
  | { kind: 'window'; rect: Rect };

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

let counter = 0;

/** Short, unique, and stable enough to be a React key or a DOM id. */
export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function newGroup(views: ViewRef[] = []): GroupNode {
  return { kind: 'group', id: newId('g'), views, active: Math.max(0, views.length - 1) };
}

export function newView(type: string, params: Record<string, string> = {}, title?: string): ViewRef {
  return { id: newId('v'), type, params, ...(title ? { title } : {}) };
}

export const DEFAULT_SIDEBAR_SIZE: Record<SidebarSide, number> = {
  left: 264,
  right: 320,
  bottom: 220,
};

export function emptyLayout(): Layout {
  const root = newGroup();
  return {
    root,
    focus: root.id,
    focusedView: null,
    windows: [],
    sidebars: {
      left: { open: false, size: DEFAULT_SIDEBAR_SIZE.left, views: [], active: 0 },
      right: { open: false, size: DEFAULT_SIDEBAR_SIZE.right, views: [], active: 0 },
      bottom: { open: false, size: DEFAULT_SIDEBAR_SIZE.bottom, views: [], active: 0 },
    },
    nextZ: 1,
  };
}

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

export function groupsOf(node: LayoutNode): GroupNode[] {
  return node.kind === 'group' ? [node] : node.children.flatMap(groupsOf);
}

export function findGroup(node: LayoutNode, id: string): GroupNode | null {
  if (node.kind === 'group') return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findGroup(child, id);
    if (found) return found;
  }
  return null;
}

/** The group holding a view instance, plus the view itself. */
export function locateInTiles(
  root: LayoutNode,
  instanceId: string,
): { group: GroupNode; view: ViewRef; index: number } | null {
  for (const group of groupsOf(root)) {
    const index = group.views.findIndex((view) => view.id === instanceId);
    if (index >= 0) return { group, view: group.views[index], index };
  }
  return null;
}

/**
 * Which surface a view instance is on, and the thing holding it.
 *
 * One lookup rather than three, so no caller has to remember that a view might
 * be in the tile tree, in a rail, or in a frame above both.
 */
export function locate(
  layout: Layout,
  instanceId: string,
):
  | { surface: 'tab'; group: GroupNode; view: ViewRef }
  // `window` and `modal` are separate members rather than one with a two-value
  // discriminant, so that ruling one out narrows the result to the other.
  | { surface: 'window'; window: FloatingWindow; view: ViewRef }
  | { surface: 'modal'; window: FloatingWindow; view: ViewRef }
  | { surface: 'sidebar'; side: SidebarSide; view: ViewRef }
  | null {
  const inTiles = locateInTiles(layout.root, instanceId);
  if (inTiles) return { surface: 'tab', group: inTiles.group, view: inTiles.view };

  const window = layout.windows.find((entry) => entry.view.id === instanceId);
  if (window) {
    return window.surface === 'modal'
      ? { surface: 'modal', window, view: window.view }
      : { surface: 'window', window, view: window.view };
  }

  for (const side of SIDEBAR_SIDES) {
    const view = layout.sidebars[side].views.find((entry) => entry.id === instanceId);
    if (view) return { surface: 'sidebar', side, view };
  }
  return null;
}

export const SIDEBAR_SIDES: SidebarSide[] = ['left', 'right', 'bottom'];

/** The active view of a group, if it has one. */
export function activeViewOf(group: GroupNode): ViewRef | null {
  return group.views[group.active] ?? null;
}

/** Everything a person can actually see right now. */
export function visibleViews(layout: Layout): ViewRef[] {
  const out: ViewRef[] = [];
  for (const group of groupsOf(layout.root)) {
    const view = activeViewOf(group);
    if (view) out.push(view);
  }
  for (const window of layout.windows) {
    if (window.state !== 'minimized') out.push(window.view);
  }
  for (const side of SIDEBAR_SIDES) {
    const sidebar = layout.sidebars[side];
    const view = sidebar.views[sidebar.active];
    if (sidebar.open && view) out.push(view);
  }
  return out;
}

/** Every view instance, visible or behind a tab. */
export function allViews(layout: Layout): ViewRef[] {
  return [
    ...groupsOf(layout.root).flatMap((group) => group.views),
    ...layout.windows.map((window) => window.view),
    ...SIDEBAR_SIDES.flatMap((side) => layout.sidebars[side].views),
  ];
}

/**
 * The groups sitting directly beside a given one — its siblings in the nearest
 * split. What "beside" means for the Spark chat: a note in the other half of
 * the same split is the note you are working on, and a note three splits away
 * is not.
 */
export function siblingGroups(root: LayoutNode, groupId: string): GroupNode[] {
  const parent = findParentSplit(root, groupId);
  if (!parent) return [];
  return parent.children
    .filter((child) => !(child.kind === 'group' && child.id === groupId))
    .flatMap(groupsOf);
}

function findParentSplit(node: LayoutNode, childId: string): SplitNode | null {
  if (node.kind !== 'split') return null;
  for (const child of node.children) {
    if (child.id === childId) return node;
    const found = findParentSplit(child, childId);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tree surgery
// ---------------------------------------------------------------------------

function mapTree(node: LayoutNode, fn: (node: LayoutNode) => LayoutNode): LayoutNode {
  if (node.kind === 'split') {
    const children = node.children.map((child) => mapTree(child, fn));
    return fn({ ...node, children });
  }
  return fn(node);
}

function replaceNode(root: LayoutNode, id: string, replacement: LayoutNode): LayoutNode {
  return mapTree(root, (node) => (node.id === id ? replacement : node));
}

/**
 * Collapses everything the operations above are allowed to leave behind:
 * empty groups, one-child splits, and a split nested inside a split of the same
 * axis (a row inside a row is just a longer row, and flattening it keeps the
 * dividers behaving like one another).
 *
 * Always returns a tree containing at least one group.
 */
export function normalize(node: LayoutNode): LayoutNode {
  if (node.kind === 'group') {
    const active = Math.min(Math.max(node.active, 0), Math.max(node.views.length - 1, 0));
    return active === node.active ? node : { ...node, active };
  }

  const kept: LayoutNode[] = [];
  const sizes: number[] = [];

  node.children.forEach((rawChild, index) => {
    const child = normalize(rawChild);
    const size = node.sizes[index] ?? 1 / node.children.length;

    // An emptied group disappears; its space goes to its neighbours.
    if (child.kind === 'group' && child.views.length === 0) return;

    // A split of the same axis flattens into this one, its children's sizes
    // scaled into the slot it occupied.
    if (child.kind === 'split' && child.axis === node.axis) {
      child.children.forEach((grandchild, gi) => {
        kept.push(grandchild);
        sizes.push(size * (child.sizes[gi] ?? 1 / child.children.length));
      });
      return;
    }

    kept.push(child);
    sizes.push(size);
  });

  if (kept.length === 0) return newGroup();
  if (kept.length === 1) return kept[0];

  const total = sizes.reduce((sum, value) => sum + value, 0) || 1;
  return { ...node, children: kept, sizes: sizes.map((value) => value / total) };
}

/** Wraps `target` in a split, putting `addition` on the given side of it. */
function splitAround(target: LayoutNode, addition: LayoutNode, side: Side): SplitNode {
  const axis: Axis = side === 'left' || side === 'right' ? 'row' : 'column';
  const before = side === 'left' || side === 'top';
  return {
    kind: 'split',
    id: newId('s'),
    axis,
    children: before ? [addition, target] : [target, addition],
    sizes: [0.5, 0.5],
  };
}

/** Re-anchors focus on a group that still exists. */
function settleFocus(layout: Layout, preferred?: string): Layout {
  const groups = groupsOf(layout.root);
  if (preferred && groups.some((group) => group.id === preferred)) {
    return { ...layout, focus: preferred };
  }
  if (groups.some((group) => group.id === layout.focus)) return layout;
  return { ...layout, focus: groups[0]?.id ?? layout.focus };
}

function withRoot(layout: Layout, root: LayoutNode, preferredFocus?: string): Layout {
  return settleFocus({ ...layout, root: normalize(root) }, preferredFocus);
}

// ---------------------------------------------------------------------------
// Opening, closing, focusing
// ---------------------------------------------------------------------------

/** Adds a view as a tab in a group and makes it active. */
export function openInGroup(layout: Layout, groupId: string, view: ViewRef): Layout {
  const root = mapTree(layout.root, (node) =>
    node.kind === 'group' && node.id === groupId
      ? { ...node, views: [...node.views, view], active: node.views.length }
      : node,
  );
  return { ...withRoot(layout, root, groupId), focusedView: view.id };
}

/**
 * Puts a view in a group *instead of* whatever was there.
 *
 * Classic mode's one opening move: with no tab strip there is nowhere for a
 * second view to be reached from, so opening a page has to replace the one
 * before it rather than quietly stack up an unreachable pile behind it.
 */
export function replaceInGroup(layout: Layout, groupId: string, view: ViewRef): Layout {
  const root = mapTree(layout.root, (node) =>
    node.kind === 'group' && node.id === groupId ? { ...node, views: [view], active: 0 } : node,
  );
  return { ...withRoot(layout, root, groupId), focusedView: view.id };
}

/** Splits a group and opens the view in the new half. */
export function openBeside(layout: Layout, groupId: string, view: ViewRef, side: Side): Layout {
  const target = findGroup(layout.root, groupId);
  if (!target) return openInGroup(layout, layout.focus, view);

  const addition = newGroup([view]);
  const root = replaceNode(layout.root, groupId, splitAround(target, addition, side));
  return { ...withRoot(layout, root, addition.id), focusedView: view.id };
}

/** Opens the view against the outer edge of the whole tile area. */
export function openAtEdge(layout: Layout, view: ViewRef, side: Side): Layout {
  const addition = newGroup([view]);
  return {
    ...withRoot(layout, splitAround(layout.root, addition, side), addition.id),
    focusedView: view.id,
  };
}

/** Opens a view in a frame above the tiles — a movable window, or a modal. */
export function openWindow(
  layout: Layout,
  view: ViewRef,
  rect: Rect,
  surface: 'window' | 'modal' = 'window',
): Layout {
  const window: FloatingWindow = {
    id: newId('w'),
    view,
    rect,
    state: 'normal',
    surface,
    z: layout.nextZ,
  };
  return {
    ...layout,
    windows: [...layout.windows, window],
    nextZ: layout.nextZ + 1,
    focusedView: view.id,
  };
}

export function openInSidebar(layout: Layout, side: SidebarSide, view: ViewRef): Layout {
  const sidebar = layout.sidebars[side];
  const existing = sidebar.views.findIndex((entry) => entry.type === view.type);
  const views = existing >= 0 ? sidebar.views : [...sidebar.views, view];
  const active = existing >= 0 ? existing : views.length - 1;
  return {
    ...layout,
    sidebars: { ...layout.sidebars, [side]: { ...sidebar, open: true, views, active } },
    focusedView: views[active].id,
  };
}

/** Brings an already-open view to the front, wherever it lives. */
export function revealView(layout: Layout, instanceId: string): Layout {
  const found = locate(layout, instanceId);
  if (!found) return layout;

  if (found.surface === 'tab') {
    const root = mapTree(layout.root, (node) =>
      node.kind === 'group' && node.id === found.group.id
        ? { ...node, active: node.views.findIndex((view) => view.id === instanceId) }
        : node,
    );
    return { ...withRoot(layout, root, found.group.id), focusedView: instanceId };
  }

  if (found.surface === 'sidebar') {
    const sidebar = layout.sidebars[found.side];
    return {
      ...layout,
      sidebars: {
        ...layout.sidebars,
        [found.side]: {
          ...sidebar,
          open: true,
          active: sidebar.views.findIndex((view) => view.id === instanceId),
        },
      },
      focusedView: instanceId,
    };
  }

  return { ...raiseWindow(layout, found.window.id), focusedView: instanceId };
}

export function closeView(layout: Layout, instanceId: string): Layout {
  const found = locate(layout, instanceId);
  if (!found) return layout;

  if (found.surface === 'window' || found.surface === 'modal') {
    return {
      ...layout,
      windows: layout.windows.filter((window) => window.view.id !== instanceId),
      focusedView: layout.focusedView === instanceId ? null : layout.focusedView,
    };
  }

  if (found.surface === 'tab') {
    const root = mapTree(layout.root, (node) => {
      if (node.kind !== 'group' || node.id !== found.group.id) return node;
      const index = node.views.findIndex((view) => view.id === instanceId);
      const views = node.views.filter((view) => view.id !== instanceId);
      // Land on the tab to the left, which is where the eye already is.
      return {
        ...node,
        views,
        active: Math.max(0, Math.min(node.active, index - 1 >= 0 ? index - 1 : 0)),
      };
    });

    return {
      ...withRoot(layout, root),
      focusedView: layout.focusedView === instanceId ? null : layout.focusedView,
    };
  }

  const sidebar = layout.sidebars[found.side];
  const views = sidebar.views.filter((view) => view.id !== instanceId);
  return {
    ...layout,
    sidebars: {
      ...layout.sidebars,
      [found.side]: {
        ...sidebar,
        views,
        active: Math.min(sidebar.active, Math.max(views.length - 1, 0)),
        open: views.length > 0 && sidebar.open,
      },
    },
    focusedView: layout.focusedView === instanceId ? null : layout.focusedView,
  };
}

export function focusGroup(layout: Layout, groupId: string): Layout {
  const group = findGroup(layout.root, groupId);
  if (!group) return layout;
  return { ...layout, focus: groupId, focusedView: activeViewOf(group)?.id ?? null };
}

export function raiseWindow(layout: Layout, windowId: string): Layout {
  const window = layout.windows.find((entry) => entry.id === windowId);
  if (!window || window.z === layout.nextZ - 1) return layout;
  return {
    ...layout,
    windows: layout.windows.map((entry) =>
      entry.id === windowId ? { ...entry, z: layout.nextZ } : entry,
    ),
    nextZ: layout.nextZ + 1,
  };
}

export function setWindowRect(layout: Layout, windowId: string, rect: Rect): Layout {
  return {
    ...layout,
    windows: layout.windows.map((entry) =>
      entry.id === windowId ? { ...entry, rect } : entry,
    ),
  };
}

export function setWindowState(layout: Layout, windowId: string, state: WindowState): Layout {
  return {
    ...layout,
    windows: layout.windows.map((entry) => {
      if (entry.id !== windowId) return entry;
      if (state === 'maximized' && entry.state !== 'maximized') {
        return { ...entry, state, restore: entry.rect };
      }
      if (state === 'normal' && entry.restore) {
        return { ...entry, state, rect: entry.restore, restore: undefined };
      }
      return { ...entry, state };
    }),
  };
}

// ---------------------------------------------------------------------------
// Moving a view between homes
// ---------------------------------------------------------------------------

/**
 * Detaches a view from wherever it is and re-attaches it at `target`.
 *
 * Detach-then-attach in one step, rather than close plus open, because closing
 * can collapse the very group the target names — dropping a tab onto its own
 * group's edge is a real gesture and has to survive it.
 */
export function moveView(layout: Layout, instanceId: string, target: DropTarget): Layout {
  const found = locate(layout, instanceId);
  if (!found) return layout;
  const view = found.view;

  // A no-op drop: dropping a lone tab back onto its own group.
  if (
    target.kind === 'tab' &&
    found.surface === 'tab' &&
    found.group.id === target.groupId &&
    found.group.views.length === 1
  ) {
    return revealView(layout, instanceId);
  }

  const detached = closeView(layout, instanceId);

  switch (target.kind) {
    case 'tab': {
      // The group may have gone with the last tab that left it.
      const group = findGroup(detached.root, target.groupId);
      if (!group) return openInGroup(detached, detached.focus, view);
      const root = mapTree(detached.root, (node) => {
        if (node.kind !== 'group' || node.id !== target.groupId) return node;
        const index = Math.max(0, Math.min(target.index ?? node.views.length, node.views.length));
        const views = [...node.views.slice(0, index), view, ...node.views.slice(index)];
        return { ...node, views, active: index };
      });
      return { ...withRoot(detached, root, target.groupId), focusedView: view.id };
    }
    case 'split': {
      if (!findGroup(detached.root, target.groupId)) {
        return openAtEdge(detached, view, target.side);
      }
      return openBeside(detached, target.groupId, view, target.side);
    }
    case 'edge':
      return openAtEdge(detached, view, target.side);
    case 'sidebar':
      return openInSidebar(detached, target.side, view);
    case 'window':
      return openWindow(detached, view, target.rect);
  }
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * Drags the divider after `index` in a split.
 *
 * Only the two panes either side of the divider change, which is what makes a
 * drag feel local: the rest of the row stays exactly where it was.
 */
export function resizeSplit(
  layout: Layout,
  splitId: string,
  index: number,
  fraction: number,
): Layout {
  const root = mapTree(layout.root, (node) => {
    if (node.kind !== 'split' || node.id !== splitId) return node;
    const pair = (node.sizes[index] ?? 0) + (node.sizes[index + 1] ?? 0);
    if (pair <= 0) return node;

    const MIN = 0.08;
    const first = Math.min(Math.max(fraction, MIN), pair - MIN);
    const sizes = [...node.sizes];
    sizes[index] = first;
    sizes[index + 1] = pair - first;
    return { ...node, sizes };
  });
  // Deliberately not normalized: a resize never changes the shape, and running
  // the collapse pass here would fight the drag.
  return { ...layout, root };
}

export function setSidebarSize(layout: Layout, side: SidebarSide, size: number): Layout {
  return {
    ...layout,
    sidebars: {
      ...layout.sidebars,
      [side]: { ...layout.sidebars[side], size: Math.max(160, Math.min(720, size)) },
    },
  };
}

export function setSidebarOpen(layout: Layout, side: SidebarSide, open: boolean): Layout {
  return {
    ...layout,
    sidebars: { ...layout.sidebars, [side]: { ...layout.sidebars[side], open } },
  };
}

export function setSidebarActive(layout: Layout, side: SidebarSide, active: number): Layout {
  return {
    ...layout,
    sidebars: { ...layout.sidebars, [side]: { ...layout.sidebars[side], open: true, active } },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Rebuilds a layout from whatever `localStorage` handed back.
 *
 * Anything unrecognised is dropped rather than repaired: a layout is a
 * convenience, and the cost of getting it wrong (a blank workbench, a tab you
 * cannot close) is far worse than the cost of starting fresh. `keepTypes`
 * filters out views whose type no longer exists, which is what happens when a
 * plugin that contributed one is uninstalled.
 */
export function reviveLayout(raw: unknown, keepType: (type: string) => boolean): Layout | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Partial<Layout>;

  const root = reviveNode(source.root, keepType);
  if (!root) return null;

  const base = emptyLayout();
  const sidebars = { ...base.sidebars };
  for (const side of SIDEBAR_SIDES) {
    const sidebar = source.sidebars?.[side];
    if (!sidebar) continue;
    const views = (Array.isArray(sidebar.views) ? sidebar.views : [])
      .map(reviveView)
      .filter((view): view is ViewRef => view !== null && keepType(view.type));
    sidebars[side] = {
      open: Boolean(sidebar.open) && views.length > 0,
      size: typeof sidebar.size === 'number' ? sidebar.size : DEFAULT_SIDEBAR_SIZE[side],
      views,
      active: clampIndex(sidebar.active, views.length),
    };
  }

  const windows = (Array.isArray(source.windows) ? source.windows : [])
    .map((window): FloatingWindow | null => {
      const view = reviveView(window?.view);
      if (!view || !keepType(view.type) || !isRect(window?.rect)) return null;
      // A modal is somewhere you were sent, not somewhere to be put back.
      if (window.surface === 'modal') return null;
      return {
        id: typeof window.id === 'string' ? window.id : newId('w'),
        view,
        rect: window.rect,
        state: window.state === 'minimized' || window.state === 'maximized' ? window.state : 'normal',
        surface: 'window',
        z: typeof window.z === 'number' ? window.z : 1,
      };
    })
    .filter((window): window is FloatingWindow => window !== null);

  const normalized = normalize(root);
  const groups = groupsOf(normalized);

  return {
    root: normalized,
    focus: groups.some((group) => group.id === source.focus) ? source.focus! : groups[0].id,
    focusedView: null,
    windows,
    sidebars,
    nextZ: windows.reduce((max, window) => Math.max(max, window.z), 0) + 1,
  };
}

/** The stored shape, before it has been proved to be one node or the other. */
interface RawNode {
  kind?: unknown;
  id?: unknown;
  views?: unknown;
  active?: unknown;
  axis?: unknown;
  children?: unknown;
  sizes?: unknown;
}

function reviveNode(raw: unknown, keepType: (type: string) => boolean): LayoutNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as RawNode;

  if (node.kind === 'group') {
    const views = (Array.isArray(node.views) ? node.views : ([] as unknown[]))
      .map(reviveView)
      .filter((view): view is ViewRef => view !== null && keepType(view.type));
    return {
      kind: 'group',
      id: typeof node.id === 'string' ? node.id : newId('g'),
      views,
      active: clampIndex(node.active, views.length),
    };
  }

  if (node.kind === 'split' && Array.isArray(node.children)) {
    const children = node.children
      .map((child: unknown) => reviveNode(child, keepType))
      .filter((child): child is LayoutNode => child !== null);
    if (children.length === 0) return null;
    const sizes =
      Array.isArray(node.sizes) && node.sizes.length === children.length
        ? (node.sizes as number[])
        : children.map(() => 1 / children.length);
    return {
      kind: 'split',
      id: typeof node.id === 'string' ? node.id : newId('s'),
      axis: node.axis === 'column' ? 'column' : 'row',
      children,
      sizes,
    };
  }

  return null;
}

function reviveView(raw: unknown): ViewRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const view = raw as Partial<ViewRef>;
  if (typeof view.type !== 'string') return null;
  return {
    id: typeof view.id === 'string' ? view.id : newId('v'),
    type: view.type,
    params: isStringRecord(view.params) ? view.params : {},
    ...(typeof view.title === 'string' ? { title: view.title } : {}),
  };
}

function clampIndex(value: unknown, length: number): number {
  const index = typeof value === 'number' ? value : 0;
  return Math.min(Math.max(index, 0), Math.max(length - 1, 0));
}

function isRect(value: unknown): value is Rect {
  if (!value || typeof value !== 'object') return false;
  const rect = value as Partial<Rect>;
  return (
    typeof rect.x === 'number' &&
    typeof rect.y === 'number' &&
    typeof rect.width === 'number' &&
    typeof rect.height === 'number'
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}
