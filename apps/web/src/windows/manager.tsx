import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { normalizePageName } from '@spark/core';
import type { SparkEditor } from '@spark/editor';
import type { OpenView, ViewDefinition, WindowMode, WindowsApi } from '@spark/plugin-sdk';
import { useApp } from '../app-context';
import { useIsNarrow } from '../lib/device';
import { dailyPageName } from '../lib/modes';
import { SPARK_PAGE, resolveVirtualPage } from '../virtual';
import {
  NAVIGATOR_VIEW,
  PAGE_VIEW,
  SETTINGS_VIEW,
  SHELL_VIEWS,
  type ShellView,
} from './views';
import {
  activeViewOf,
  allViews,
  closeView as closeViewIn,
  emptyLayout,
  findGroup,
  focusGroup as focusGroupIn,
  locate,
  moveView as moveViewIn,
  newView,
  openBeside,
  openWindow,
  openInSidebar,
  openInGroup,
  raiseWindow,
  replaceInGroup,
  resizeSplit,
  revealView,
  setSidebarActive,
  setSidebarOpen,
  setSidebarSize,
  setWindowRect,
  setWindowState,
  siblingGroups,
  visibleViews,
  type SidebarSide,
  type DropTarget,
  type Layout,
  type Rect,
  type ViewRef,
  type WindowState,
} from './model';

/**
 * The workbench, as React sees it.
 *
 * State lives here; the renderer under `Workbench.tsx` is a function of it, and
 * so is the `WindowsApi` handed to plugins. Keeping the two on the same data
 * means a plugin opening a panel and a person dragging a tab go through exactly
 * the same operations, which is the only way the plugin surface stays honest.
 */

/** A drag in progress, and where it would land if released now. */
export interface DragSession {
  instanceId: string;
  /** Set when the thing being dragged is a floating window rather than a tab. */
  windowId?: string;
  pointer: { x: number; y: number };
  preview: Rect | null;
  target: DropTarget | null;
}

/** What the header and the status bar show about the focused document. */
export interface DocumentStatus {
  page: string | null;
  /** True when the focused page is a view rather than a file. */
  virtual: boolean;
  saveState: 'saved' | 'dirty' | 'saving' | 'error';
  words: number;
}

/** What the Spark chat is allowed to know about the rest of the workbench. */
export interface WorkbenchContextSummary {
  /** Names of every page open somewhere on screen, minus the asker's own tile. */
  openPages: string[];
  /** The one note directly beside the chat, when there is exactly one. */
  neighbour: string | null;
}

interface WindowsContextValue {
  layout: Layout;
  narrow: boolean;
  /**
   * True when the workbench is reduced to one tab and its rails.
   *
   * Read by the renderer as well as by the placement rules: there is no point
   * offering a split button, a tab strip or a drag handle for arrangements that
   * cannot exist, and hiding them is how the mode explains itself.
   */
  classic: boolean;

  /** Opens a page — a real note or a virtual one — somewhere sensible. */
  openPage: (page: string, options?: { mode?: WindowMode; line?: number }) => void;
  openView: (type: string, options?: { mode?: WindowMode; params?: Record<string, string>; title?: string }) => string;
  closeView: (instanceId: string) => void;
  moveView: (instanceId: string, target: DropTarget) => void;
  revealView: (instanceId: string) => void;
  focusGroup: (groupId: string) => void;
  focusView: (instanceId: string) => void;

  /** Splits the focused tile, putting a copy of what it shows beside it. */
  splitFocused: (side: 'right' | 'bottom') => void;

  /**
   * Opens a page *next to* a view rather than on top of it. What the Spark
   * chat wants when it puts a note on screen: replacing itself with the page it
   * just wrote would be an odd way to show you your own note.
   */
  openPageBeside: (instanceId: string, page: string) => void;

  raiseWindow: (windowId: string) => void;
  setWindowRect: (windowId: string, rect: Rect) => void;
  setWindowState: (windowId: string, state: WindowState) => void;

  toggleSidebar: (side: SidebarSide) => void;
  /** The header button: show the navigator, wherever it currently lives. */
  toggleNavigator: () => void;
  setSidebarSize: (side: SidebarSide, size: number) => void;
  setSidebarActive: (side: SidebarSide, index: number) => void;

  resizeSplit: (splitId: string, index: number, fraction: number) => void;

  drag: DragSession | null;
  setDrag: (session: DragSession | null) => void;
  commitDrag: () => void;

  /** True while a modal is up, which makes everything under it inert. */
  modalOpen: boolean;

  /** Definition behind a view type, from the shell or from a plugin. */
  shellView: (type: string) => ShellView | null;
  pluginView: (type: string) => ViewDefinition | null;
  titleOf: (view: ViewRef) => string;

  status: DocumentStatus;
  setStatus: (status: Partial<DocumentStatus>) => void;

  /**
   * The editor in the focused tile, for the chrome that acts on it — the mobile
   * markdown row, which needs the concrete editor rather than the plugin-facing
   * bridge. Null when the focused view is not a note.
   */
  activeEditor: SparkEditor | null;
  setActiveEditor: (editor: SparkEditor | null) => void;

  /** Pages visible elsewhere, for a view that wants to know its surroundings. */
  contextFor: (instanceId: string) => WorkbenchContextSummary;
}

const WindowsContext = createContext<WindowsContextValue | null>(null);

export function useWindows(): WindowsContextValue {
  const value = useContext(WindowsContext);
  if (!value) throw new Error('useWindows must be used inside <WindowsProvider>');
  return value;
}

export function WindowsProvider({ children }: { children: ReactNode }) {
  const { workspace, route, navigate, registryVersion, pendingLine, setPageOpener, appearance } =
    useApp();
  const narrow = useIsNarrow();
  const classic = appearance.layout === 'classic';

  const [layout, setLayout] = useState<Layout>(() => restoreLayout(route));
  const [drag, setDrag] = useState<DragSession | null>(null);
  const [status, setStatusState] = useState<DocumentStatus>({
    page: null,
    virtual: false,
    saveState: 'saved',
    words: 0,
  });
  const [activeEditor, setActiveEditor] = useState<SparkEditor | null>(null);

  // Every action reads the latest layout through this rather than closing over
  // it, so the `WindowsApi` a plugin captured at activation never acts on a
  // layout from three drags ago.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const apply = useCallback((fn: (layout: Layout) => Layout) => {
    setLayout((current) => fn(current));
  }, []);

  // -- view resolution ------------------------------------------------------

  const shellView = useCallback((type: string) => SHELL_VIEWS[type] ?? null, []);

  const pluginView = useCallback(
    (type: string) => workspace.registry.view(type) ?? null,
    // Re-made when plugins change so a view that appears mid-session resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace, registryVersion],
  );

  const titleOf = useCallback(
    (view: ViewRef): string => {
      if (view.title) return view.title;
      const shell = SHELL_VIEWS[view.type];
      if (shell) return shell.titleFor?.(view.params) ?? shell.title;
      return workspace.registry.view(view.type)?.title ?? view.type;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [workspace, registryVersion],
  );

  // -- opening --------------------------------------------------------------

  const openView = useCallback<WindowsContextValue['openView']>(
    (type, options = {}) => {
      const definition = SHELL_VIEWS[type];
      const plugin = workspace.registry.view(type);
      if (!definition && !plugin) {
        console.warn(`[spark] no view registered as "${type}"`);
        return '';
      }

      const params = options.params ?? {};
      const mode = options.mode ?? defaultModeFor(type, definition, narrow, classic);

      // One instance unless the view says otherwise, matched on its parameters:
      // asking for Settings twice should raise the one you have, not stack two.
      const multiple = definition?.multiple ?? plugin?.multiple ?? false;
      if (!multiple) {
        const existing = allViews(layoutRef.current).find(
          (view) => view.type === type && sameParams(view.params, params),
        );
        if (existing) {
          apply((current) => revealView(current, existing.id));
          return existing.id;
        }
      }

      const view = newView(type, params, options.title);
      const size = definition?.size ?? plugin?.size ?? { width: 720, height: 560 };
      apply((current) => place(current, view, mode, size, narrow, classic));
      return view.id;
    },
    // Deliberately *not* keyed on `registryVersion`, even though the body reads
    // the registry: the lookup happens when the view is opened, so a plugin
    // that registered a second ago is already visible to it. Keying on it would
    // change this function's identity on every registration — and since the app
    // registers its commands in an effect that depends on this function, and
    // registering bumps the version, that is an infinite loop.
    [workspace, apply, narrow, classic],
  );

  const openPage = useCallback<WindowsContextValue['openPage']>(
    (rawName, options = {}) => {
      const name = normalizePageName(rawName);
      const virtual = resolveVirtualPage(name);

      // A few virtual pages are panels rather than documents. Settings is one:
      // it is a thing you do *to* the app, so it sits above the workbench
      // instead of taking a tab from the note you were reading.
      if (virtual?.presentation === 'modal') {
        openView(SETTINGS_VIEW, { mode: 'modal' });
        return;
      }

      const canonical = virtual?.name ?? name;
      if (options.line !== undefined) {
        pendingLine.current = { page: canonical, line: options.line };
      }

      // Classic mode's one exception to "everything replaces the editor": Spark
      // is the assistant, not a document, and asking it about the note you are
      // reading only works if the note is still on screen. So it goes to the
      // right rail — the sidebar the mode keeps.
      const mode = classic && canonical === SPARK_PAGE ? 'sidebar-right' : options.mode;
      openView(PAGE_VIEW, { mode, params: { page: canonical } });
    },
    [openView, pendingLine, classic],
  );

  const splitFocused = useCallback(
    (side: 'right' | 'bottom') => {
      // Nothing to split into: classic mode has one tile by construction.
      if (classic) return;
      apply((current) => {
        const group = findGroup(current.root, current.focus);
        const active = group ? activeViewOf(group) : null;
        const view = active
          ? newView(active.type, active.params, active.title)
          : newView(PAGE_VIEW, { page: SPARK_PAGE });
        return openBeside(current, current.focus, view, side);
      });
    },
    [apply, classic],
  );

  const openPageBeside = useCallback(
    (instanceId: string, rawName: string) => {
      const name = normalizePageName(rawName);
      const current = layoutRef.current;

      // Already on screen: raising it beats opening a second copy.
      const existing = allViews(current).find(
        (view) => view.type === PAGE_VIEW && view.params.page === name,
      );
      if (existing) {
        apply((layout) => revealView(layout, existing.id));
        return;
      }

      const found = locate(current, instanceId);
      const view = newView(PAGE_VIEW, { page: name });

      // Classic mode: the note Spark just wrote takes the editor area, and
      // Spark itself stays in its rail rather than being replaced by it.
      if (classic) {
        apply((layout) => replaceInGroup(layout, layout.focus, view));
        return;
      }

      if (found?.surface !== 'tab' || narrow) {
        apply((layout) => openInGroup(layout, layout.focus, view));
        return;
      }

      // A neighbour, if there is one; otherwise make one.
      const neighbour = siblingGroups(current.root, found.group.id)[0];
      apply((layout) =>
        neighbour
          ? openInGroup(layout, neighbour.id, view)
          : openBeside(layout, found.group.id, view, 'right'),
      );
    },
    [apply, narrow, classic],
  );

  // -- mutation helpers -----------------------------------------------------

  const actions = useMemo(
    () => ({
      closeView: (id: string) => apply((current) => closeViewIn(current, id)),
      moveView: (id: string, target: DropTarget) =>
        apply((current) => moveViewIn(current, id, target)),
      revealView: (id: string) => apply((current) => revealView(current, id)),
      focusGroup: (id: string) => apply((current) => focusGroupIn(current, id)),
      focusView: (id: string) =>
        apply((current) => {
          const found = locate(current, id);
          if (found?.surface === 'tab') {
            return { ...focusGroupIn(current, found.group.id), focusedView: id };
          }
          if (found?.surface === 'window') {
            return { ...raiseWindow(current, found.window.id), focusedView: id };
          }
          return { ...current, focusedView: id };
        }),
      raiseWindow: (id: string) => apply((current) => raiseWindow(current, id)),
      setWindowRect: (id: string, rect: Rect) =>
        apply((current) => setWindowRect(current, id, rect)),
      setWindowState: (id: string, state: WindowState) =>
        apply((current) => setWindowState(current, id, state)),
      toggleSidebar: (side: SidebarSide) =>
        apply((current) => setSidebarOpen(current, side, !current.sidebars[side].open)),
      setSidebarSize: (side: SidebarSide, size: number) =>
        apply((current) => setSidebarSize(current, side, size)),
      setSidebarActive: (side: SidebarSide, index: number) =>
        apply((current) => setSidebarActive(current, side, index)),
      resizeSplit: (splitId: string, index: number, fraction: number) =>
        apply((current) => resizeSplit(current, splitId, index, fraction)),
    }),
    [apply],
  );

  /**
   * One button, three states.
   *
   * The navigator can be in its rail, closed, or in a window, and "toggle" has to mean
   * something sensible in all three. Floating counts as shown, so the press
   * that follows puts it back in its rail; from there the next press hides it,
   * which is the behaviour the button has always had. Floating it again is one
   * click away in the rail itself, so nothing is lost by bringing it home.
   */
  const toggleNavigator = useCallback(() => {
    apply((current) => {
      const existing = allViews(current).find((view) => view.type === NAVIGATOR_VIEW);
      if (!existing) return openInSidebar(current, 'left', newView(NAVIGATOR_VIEW));

      const found = locate(current, existing.id);
      if (found?.surface === 'window') {
        return moveViewIn(current, existing.id, { kind: 'sidebar', side: 'left' });
      }
      return setSidebarOpen(current, 'left', !current.sidebars.left.open);
    });
  }, [apply]);

  const commitDrag = useCallback(() => {
    setDrag((session) => {
      if (session?.target) {
        apply((current) => moveViewIn(current, session.instanceId, session.target!));
      }
      return null;
    });
  }, [apply]);

  // -- the navigator, and the first page ------------------------------------

  useEffect(() => {
    // The navigator is a sidebar view like any other, so it can be closed,
    // resized, or joined by a plugin's panel in the same rail.
    setLayout((current) => {
      if (allViews(current).some((view) => view.type === NAVIGATOR_VIEW)) return current;
      const withNavigator = openInSidebar(current, 'left', newView(NAVIGATOR_VIEW));
      // Restoring a layout that had it closed must not reopen it.
      return { ...withNavigator, sidebars: { ...withNavigator.sidebars, left: { ...withNavigator.sidebars.left, open: current.sidebars.left.open } } };
    });
  }, []);

  /**
   * Switching between classic and the full workbench resets the workspace.
   *
   * Not a nicety: the two modes disagree about what can exist. Leaving three
   * tiles and a floating window on screen after turning classic on would leave
   * arrangements the mode has no controls for — no tab strip to reach the
   * hidden tabs with, no title bar to close the window from. So the switch
   * lands you where a reload would: one tile, the page you were reading, the
   * rails you had open, and nothing floating.
   */
  const layoutMode = appearance.layout;
  const appliedMode = useRef(layoutMode);

  useEffect(() => {
    if (appliedMode.current === layoutMode) return;
    appliedMode.current = layoutMode;
    setLayout((current) => resetLayout(current));
  }, [layoutMode]);

  // Everything that navigates — a `[[link]]`, a backlink, a task, a plugin —
  // goes through `useApp().openPage`, and from here on that means "put it
  // somewhere in the workbench" rather than "change the URL".
  useEffect(
    () => setPageOpener((page, line) => openPage(page, line === undefined ? {} : { line })),
    [setPageOpener, openPage],
  );

  // -- routing --------------------------------------------------------------

  /**
   * The URL is a bookmark, not a source of truth.
   *
   * It cannot be the source of truth once tiles exist: two notes side by side
   * are one address, and letting the address decide what is on screen means
   * focusing the second tile reloads the first. So the layout owns what is
   * open, the URL is written from whatever has focus, and it is only *read*
   * twice — at startup, and when the back button changes it under us.
   */
  const syncedPage = useRef<string | null>(null);

  const focusedPage = useMemo(() => {
    const group = findGroup(layout.root, layout.focus);
    const active = group ? activeViewOf(group) : null;
    return active?.type === PAGE_VIEW ? (active.params.page ?? null) : null;
  }, [layout]);

  useEffect(() => {
    if (!focusedPage || focusedPage === syncedPage.current) return;
    syncedPage.current = focusedPage;
    // Replace, never push: moving between tiles is not history.
    navigate({ kind: 'page', page: focusedPage }, true);
  }, [focusedPage, navigate]);

  useEffect(() => {
    // Only a real back or forward reaches here with a page we did not write.
    if (route.kind !== 'page' || route.page === syncedPage.current) return;
    syncedPage.current = route.page;
    openPage(route.page);
  }, [route, openPage]);

  // -- the plugin-facing API ------------------------------------------------

  const contextFor = useCallback(
    (instanceId: string): WorkbenchContextSummary => {
      const current = layoutRef.current;
      const found = locate(current, instanceId);
      const ownGroup = found?.surface === 'tab' ? found.group.id : null;

      const pageNameOf = (view: ViewRef | null) =>
        view && view.type === PAGE_VIEW ? (view.params.page ?? null) : null;

      const neighbours = ownGroup
        ? siblingGroups(current.root, ownGroup)
            .map((group) => pageNameOf(activeViewOf(group)))
            .filter((name): name is string => name !== null)
        : [];

      const openPages = visibleViews(current)
        .filter((view) => view.id !== instanceId)
        .map((view) => pageNameOf(view))
        .filter((name): name is string => name !== null);

      return {
        openPages: [...new Set(openPages)],
        // Exactly one, or none: "the note beside this one" stops meaning
        // anything as soon as there are two of them.
        neighbour: neighbours.length === 1 ? neighbours[0] : null,
      };
    },
    [],
  );

  useEffect(() => {
    const api: WindowsApi = {
      register: (view) => workspace.registry.registerView('plugin', view),
      open: (viewId, options) =>
        openView(viewId, {
          mode: options?.mode,
          params: options?.params,
          title: options?.title,
        }),
      close: (instanceId) => actions.closeView(instanceId),
      move: (instanceId, mode) => {
        apply((current) => {
          const found = locate(current, instanceId);
          if (!found) return current;
          // Classic mode honours the rails and nothing else: every other target
          // names an arrangement the mode does not have.
          const resolved = classic ? classicMode(mode) : mode;
          if (classic && resolved === 'tab') return revealView(current, instanceId);
          return moveViewIn(current, instanceId, targetForMode(resolved, current, narrow));
        });
      },
      visible: (): OpenView[] => {
        const current = layoutRef.current;
        return visibleViews(current).map((view) => ({
          instanceId: view.id,
          type: view.type,
          title: view.title ?? SHELL_VIEWS[view.type]?.title ?? view.type,
          params: view.params,
          surface: locate(current, view.id)?.surface ?? 'tab',
          focused: current.focusedView === view.id,
        }));
      },
    };
    workspace.setWindows(api);
  }, [workspace, openView, actions, apply, narrow, classic]);

  const setStatus = useCallback((patch: Partial<DocumentStatus>) => {
    setStatusState((current) => ({ ...current, ...patch }));
  }, []);

  const value: WindowsContextValue = {
    layout,
    narrow,
    classic,
    openPage,
    openView,
    splitFocused,
    openPageBeside,
    toggleNavigator,
    drag,
    setDrag,
    commitDrag,
    modalOpen: layout.windows.some((entry) => entry.surface === 'modal'),
    shellView,
    pluginView,
    titleOf,
    status,
    setStatus,
    activeEditor,
    setActiveEditor,
    contextFor,
    ...actions,
  };

  return <WindowsContext.Provider value={value}>{children}</WindowsContext.Provider>;
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * The mode a view opens in when nobody said.
 *
 * Rails and modals are properties of what the view *is*, not of how it was
 * asked for, so they are decided here rather than at every call site. On a
 * narrow screen everything becomes a tab, because a floating window on a phone
 * is a worse full-screen sheet — and classic mode says the same thing for the
 * same reason, on every screen.
 */
function defaultModeFor(
  type: string,
  definition: ShellView | undefined,
  narrow: boolean,
  classic: boolean,
): WindowMode {
  if (narrow) return type === NAVIGATOR_VIEW ? 'sidebar-left' : 'tab';
  const mode = definition?.defaultMode ?? 'tab';
  return classic ? classicMode(mode) : mode;
}

/**
 * What a mode means when there are no tabs, splits or windows to mean it with.
 *
 * Classic mode keeps three of the four surfaces and drops one: `sidebar` and
 * `modal` are unchanged, and everything that would have arranged the editor
 * area — a split, a window, a second tab — becomes the editor area. That is the
 * whole promise of the mode, so it is enforced in one function rather than
 * guarded at each of the dozen call sites that could open something.
 */
function classicMode(mode: WindowMode): WindowMode {
  if (mode === 'modal') return 'modal';
  if (mode === 'sidebar-left' || mode === 'sidebar-right' || mode === 'sidebar-bottom') return mode;
  return 'tab';
}

function place(
  layout: Layout,
  view: ViewRef,
  mode: WindowMode,
  size: { width: number; height: number },
  narrow: boolean,
  classic: boolean,
): Layout {
  // In classic mode a page takes the editor area rather than joining it: with
  // no tab strip, a second tab would be a document you cannot get back to.
  if (classic) {
    const resolved = classicMode(mode);
    if (resolved === 'tab') return replaceInGroup(layout, layout.focus, view);
    return place(layout, view, resolved, size, narrow, false);
  }

  if (narrow && mode !== 'sidebar-left' && mode !== 'modal') {
    return openInGroup(layout, layout.focus, view);
  }

  switch (mode) {
    case 'split-right':
      return openBeside(layout, layout.focus, view, 'right');
    case 'split-left':
      return openBeside(layout, layout.focus, view, 'left');
    case 'split-down':
      return openBeside(layout, layout.focus, view, 'bottom');
    case 'split-up':
      return openBeside(layout, layout.focus, view, 'top');
    case 'window':
      return openWindow(layout, view, centredRect(size), 'window');
    case 'modal':
      return openWindow(layout, view, centredRect(size), 'modal');
    case 'sidebar-left':
      return openInSidebar(layout, 'left', view);
    case 'sidebar-right':
      return openInSidebar(layout, 'right', view);
    case 'sidebar-bottom':
      return openInSidebar(layout, 'bottom', view);
    case 'tab':
    default:
      return openInGroup(layout, layout.focus, view);
  }
}

function targetForMode(mode: WindowMode, layout: Layout, narrow: boolean): DropTarget {
  switch (mode) {
    case 'split-right':
      return { kind: 'split', groupId: layout.focus, side: 'right' };
    case 'split-left':
      return { kind: 'split', groupId: layout.focus, side: 'left' };
    case 'split-down':
      return { kind: 'split', groupId: layout.focus, side: 'bottom' };
    case 'split-up':
      return { kind: 'split', groupId: layout.focus, side: 'top' };
    case 'sidebar-left':
      return { kind: 'sidebar', side: 'left' };
    case 'sidebar-right':
      return { kind: 'sidebar', side: 'right' };
    case 'sidebar-bottom':
      return { kind: 'sidebar', side: 'bottom' };
    case 'window':
    case 'modal':
      return narrow
        ? { kind: 'tab', groupId: layout.focus }
        : { kind: 'window', rect: centredRect({ width: 720, height: 560 }) };
    case 'tab':
    default:
      return { kind: 'tab', groupId: layout.focus };
  }
}

/** Centred in the viewport, and never bigger than it. */
function centredRect(size: { width: number; height: number }): Rect {
  const width = Math.min(size.width, window.innerWidth - 48);
  const height = Math.min(size.height, window.innerHeight - 96);
  return {
    x: Math.max(12, (window.innerWidth - width) / 2),
    y: Math.max(12, (window.innerHeight - height) / 2 - 12),
    width,
    height,
  };
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * The layout a reload lands you in: one tile, one page, nothing floating.
 *
 * Deliberately not restored. A workbench full of tiles and windows is a working
 * arrangement, not a document — it belongs to the session that built it, and
 * coming back to a screen you assembled an hour ago and no longer remember is
 * worse than coming back to the page you asked for. Reloading is also what
 * people reach for when something looks wrong, and it should therefore be the
 * thing that puts it back to a known state.
 *
 * The URL decides which page; a bare launch gets today's journal, which is
 * usually empty and so is the blank editor the app opens into, with somewhere
 * real for anything typed into it to land.
 */
function restoreLayout(route: ReturnType<typeof useApp>['route']): Layout {
  const base = emptyLayout();
  const page = route.kind === 'page' ? route.page : dailyPageName();
  return openInGroup(base, base.focus, newView(PAGE_VIEW, { page }));
}

/**
 * The layout a reload would have given you, without the reload.
 *
 * Keeps the page you were reading and the rails you had open — those are what
 * you would come back to anyway — and drops every tile, tab and floating
 * window, which is the part the mode switch invalidates. Modals survive the
 * cut: a modal isn't part of the tile/window arrangement either mode has
 * opinions about, and switching layout mode from inside one (Settings, say)
 * shouldn't close it out from under you.
 */
function resetLayout(current: Layout): Layout {
  const group = findGroup(current.root, current.focus);
  const active = group ? activeViewOf(group) : null;
  const kept = active
    ? newView(active.type, active.params, active.title)
    : newView(PAGE_VIEW, { page: dailyPageName() });

  const base = emptyLayout();
  const modals = current.windows.filter((window) => window.surface === 'modal');
  return {
    ...openInGroup(base, base.focus, kept),
    sidebars: current.sidebars,
    windows: modals,
    nextZ: current.nextZ,
  };
}

function sameParams(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
