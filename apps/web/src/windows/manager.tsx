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
import { journalFolder } from '../lib/dirs';
import { dailyPageName } from '../lib/modes';
import { SPARK_PAGE, resolveVirtualPage } from '../virtual';
import { collectZones, resolveDrop, startPointerDrag } from './drag';
import {
  NAVIGATOR_VIEW,
  PAGE_VIEW,
  PLACES_VIEW,
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
  openAt,
  openBeside,
  openWindow,
  openInSidebar,
  openInGroup,
  openTabPreview,
  promoteView as promoteViewIn,
  raiseWindow,
  replaceInGroup,
  resizeSplit,
  restorePersistedLayout,
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

/**
 * What is being dragged.
 *
 * Two kinds, because a drop does not always move something that already exists:
 * dragging a row out of the navigator has to be able to make a tab, a split or
 * a window out of a page that is not open at all. Both kinds land through the
 * same `DropTarget`, so there is exactly one set of placement rules.
 */
export type DragPayload =
  | {
      kind: 'view';
      instanceId: string;
      /** Set when the thing being dragged is a floating window rather than a tab. */
      windowId?: string;
    }
  | { kind: 'page'; page: string };

/** A drag in progress, and where it would land if released now. */
export interface DragSession {
  payload: DragPayload;
  pointer: { x: number; y: number };
  preview: Rect | null;
  target: DropTarget | null;
  /** What the pointer is over, for the label under the cursor. */
  label: string;
}

/**
 * What the header and the status bar show about the focused document.
 *
 * `stale` is the whole reason this is one object rather than four pieces of
 * state. Moving from a note to the Tasks page, to Settings, to Spark used to
 * blank the word count, so the number you were watching disappeared exactly
 * when you looked away from the note to check something about it. The values
 * now persist and are *marked* as being about the last document instead —
 * a reading kept is more useful than a reading erased, as long as it says so.
 */
export interface DocumentStatus {
  page: string | null;
  /** True when the focused page is a view rather than a file. */
  virtual: boolean;
  saveState: 'saved' | 'dirty' | 'saving' | 'error';
  words: number;
  /** True when what is focused is not the document these numbers describe. */
  stale: boolean;
}

/** Which view has the find bar up, and a nonce so pressing Find again refocuses it. */
export interface FindState {
  instanceId: string | null;
  nonce: number;
  /**
   * The query the find bar should start with — set by the navigator when a
   * content search result is opened, so the phrase that found the page keeps
   * doing its job inside it. Empty for a plain ⌘F, which just reopens the bar.
   */
  query: string;
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

  /**
   * The manual recovery path — one tile, the page you were reading, nothing
   * floating — for when the persisted arrangement is the thing that looks
   * wrong. See `WORKBENCH_LAYOUT_KEY`'s doc comment.
   */
  resetWorkbench: () => void;

  /** Opens a page — a real note or a virtual one — somewhere sensible. */
  openPage: (
    page: string,
    options?: { mode?: WindowMode; line?: number; duplicate?: boolean },
  ) => string;
  openView: (
    type: string,
    options?: {
      mode?: WindowMode;
      params?: Record<string, string>;
      title?: string;
      /**
       * Open a second copy even though one is already on screen.
       *
       * The default is to reveal what you have: clicking a file in the
       * navigator twice should take you to it, not stack two of it. Asking for
       * a duplicate is always a deliberate gesture — dragging the row into a
       * tab strip, or the "open another" command — so it is a flag here rather
       * than a property of the view.
       */
      duplicate?: boolean;
    },
  ) => string;
  closeView: (instanceId: string) => void;
  moveView: (instanceId: string, target: DropTarget) => void;
  revealView: (instanceId: string) => void;
  focusGroup: (groupId: string) => void;
  focusView: (instanceId: string) => void;
  /**
   * Turns a preview tab into an ordinary one. Called on a real edit and on a
   * genuine pointer-driven interaction with the page — never on the
   * programmatic focus a freshly opened preview gets, which would promote it
   * the instant it appeared. See `GroupNode.preview`.
   */
  promoteView: (instanceId: string) => void;

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
  /** Shows the Places panel, which shares the navigator's rail. */
  openPlaces: () => void;
  setSidebarSize: (side: SidebarSide, size: number) => void;
  setSidebarActive: (side: SidebarSide, index: number) => void;

  resizeSplit: (splitId: string, index: number, fraction: number) => void;

  drag: DragSession | null;
  setDrag: (session: DragSession | null) => void;
  commitDrag: () => void;
  /**
   * Begins a drag of anything droppable.
   *
   * Here rather than in `Workbench` because the navigator drags pages into the
   * workbench and is not a parent of it — it is a *view inside* it, so a prop
   * could never reach it. One entry point also means a row, a tab and a window
   * title bar all resolve their drop the same way, which is the only reason
   * dropping a page onto a tab strip works without the navigator knowing what a
   * tab strip is.
   */
  startDrag: (
    event: React.PointerEvent,
    payload: DragPayload,
    options?: {
      /** Pointer position within the thing being dragged, so it doesn't jump. */
      offset?: { x: number; y: number };
      /** Runs on every move — how a floating window follows the pointer. */
      onMove?: (delta: { dx: number; dy: number }) => void;
      onCancel?: () => void;
      /** Movement before it counts as a drag. Non-zero where a press is also a click. */
      threshold?: number;
      /** What to show under the cursor while it is in the air. */
      label?: string;
    },
  ) => void;

  /** The find bar, which belongs to a view rather than to the app. */
  find: FindState;
  /**
   * Opens it on the focused view, or refocuses the one already open.
   *
   * `query` seeds the field when the caller is *arriving with a search* — the
   * navigator, opening a page a content hit found — and `instanceId` names the
   * view directly for exactly that caller, because the layout update from the
   * `openPage` right before it hasn't rendered yet.
   */
  openFind: (query?: string, instanceId?: string) => void;
  closeFind: () => void;

  /** True while a modal is up, which makes everything under it inert. */
  modalOpen: boolean;

  /** Definition behind a view type, from the shell or from a plugin. */
  shellView: (type: string) => ShellView | null;
  pluginView: (type: string) => ViewDefinition | null;
  titleOf: (view: ViewRef) => string;

  /**
   * The page the focused view shows — a real note or a virtual one — for the
   * header to name.
   *
   * `null` when nothing is focused, or when the focused view is not a page at
   * all (the navigator, Places). This is what the title bar is *about*, and it
   * is deliberately separate from `status.page`, which is what the status bar
   * shows: the readings keep belonging to the last *document* even when the
   * focused thing is Spark, while the title bar follows the focus.
   */
  focusedPageTitle: string | null;

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

/**
 * Where the tiled arrangement itself persists — deliberately reversing what
 * `restoreLayout`'s doc comment used to describe as settled: "a workbench
 * full of tiles is a working arrangement, not a document, and belongs to
 * the session that built it." That was true until it wasn't asked for
 * anymore — every reload was quietly throwing away real, deliberately
 * built layouts, and "reload to get back to a known state" is also served
 * by the explicit `window.resetLayout` command now, so the automatic
 * discard is no longer the only way to get that back. Device-local (this
 * is a fact about *this screen*, not a note) via the same `SettingsApi`
 * `Preferences` already uses, but its own key rather than folded into that
 * one object — a deeply nested tile tree doesn't fit `loadPreferences`'
 * flat, type-checked-field-by-field merge, so `restorePersistedLayout` in
 * `model.ts` does its own, structural validation instead.
 */
const WORKBENCH_LAYOUT_KEY = 'app.workbenchLayout';

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

  const [layout, setLayout] = useState<Layout>(() => {
    const fresh = restoreLayout(route, journalFolder(workspace));
    // Classic mode has no tab strip, no split, no window bar to reach any
    // of it from — restoring a tiled arrangement into it would strand tabs
    // nothing in the chrome can get back to. See `WORKBENCH_LAYOUT_KEY`'s
    // doc comment for why anything is restored at all.
    if (classic) return fresh;
    const stored = workspace.settings.get<unknown>(WORKBENCH_LAYOUT_KEY, null);
    return stored ? restorePersistedLayout(stored, fresh) : fresh;
  });
  const [drag, setDrag] = useState<DragSession | null>(null);
  const [status, setStatusState] = useState<DocumentStatus>({
    page: null,
    virtual: false,
    saveState: 'saved',
    words: 0,
    stale: true,
  });
  const [find, setFind] = useState<FindState>({ instanceId: null, nonce: 0, query: '' });
  const [activeEditor, setActiveEditor] = useState<SparkEditor | null>(null);

  // Every action reads the latest layout through this rather than closing over
  // it, so the `WindowsApi` a plugin captured at activation never acts on a
  // layout from three drags ago.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Persisted debounced, not on every change: a split resize drives a state
  // update per pointermove for live visual feedback, and writing to
  // `SettingsApi` (backed by `localStorage`) that often would be real,
  // pointless work on every frame of a drag. 400ms after the layout settles
  // is soon enough that a crash or a tab close a moment later loses nothing
  // a person would notice. Classic mode never writes here — it has nothing
  // of its own to remember, and would otherwise overwrite a tiled
  // arrangement saved before the mode switch with its own single tile.
  useEffect(() => {
    if (classic) return;
    const timer = setTimeout(() => {
      workspace.settings.set(WORKBENCH_LAYOUT_KEY, layout);
    }, 400);
    return () => clearTimeout(timer);
  }, [layout, classic, workspace]);

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

  /**
   * The page the focused view is about, for the header title.
   *
   * Settings is a virtual page that happens to be a shell view rather than a
   * `PAGE_VIEW` — it opens as its own type — so it is named here rather than
   * only being reachable through page params. When the focused view is not a
   * page, the focused *group's* active view stands in: closing the tab you
   * were reading hands the title to the tab that took its place, and the
   * header should not go blank between two notes.
   */
  const focusedPageTitle = useMemo(() => {
    const focused = allViews(layout).find((entry) => entry.id === layout.focusedView);
    if (focused?.type === PAGE_VIEW) return focused.params.page ?? null;
    if (focused?.type === SETTINGS_VIEW) return 'Settings';
    const group = findGroup(layout.root, layout.focus);
    const active = group ? activeViewOf(group) : null;
    return active?.type === PAGE_VIEW ? (active.params.page ?? null) : null;
  }, [layout]);

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

      /**
       * Reveal what you have, unless a duplicate was asked for.
       *
       * Anything can now exist more than once — two Spark chats, a note beside
       * itself, a second navigator — because the alternative was a workbench
       * that could not be arranged the way its own drag and drop implied. What
       * stays fixed is that *clicking* something already open takes you to it:
       * a second copy is only ever made by a gesture that means "another one",
       * which is `duplicate` here and a drag into a tab strip everywhere else.
       *
       * `alwaysSingle` is the exception, and it is about identity rather than
       * arrangement: two Settings modals are two copies of one thing you are
       * doing to the app.
       */
      const alwaysSingle = definition?.single ?? false;
      // A plugin declaring `multiple` is saying its view is a *document*, not a
      // singleton panel — every open is a new one, the way a second note is.
      const alwaysNew = plugin?.multiple ?? false;
      if (alwaysSingle || (!options.duplicate && !alwaysNew)) {
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
        return '';
      }

      const canonical = virtual?.name ?? name;
      if (options.line !== undefined) {
        pendingLine.current = { page: canonical, line: options.line };
      }

      // Spark is the assistant, not a document: it opens in the right rail,
      // the way it always has, so asking it about the note you are reading
      // never costs you the note — and from the rail it drags, floats and
      // docks like every other panel, standard window controls included (see
      // `FloatingFrame` in `Workbench.tsx`, which no longer withholds them).
      const mode = canonical === SPARK_PAGE ? 'sidebar-right' : options.mode;
      return openView(PAGE_VIEW, {
        mode,
        params: { page: canonical },
        duplicate: options.duplicate,
      });
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
      promoteView: (id: string) => apply((current) => promoteViewIn(current, id)),
    }),
    [apply],
  );

  /**
   * One button, four states.
   *
   * The navigator can be in its rail, closed, in a window, or — since anything
   * can be dragged anywhere — sitting in a tab strip beside a note. "Toggle" has
   * to mean something sensible in all four:
   *
   * - **In the rail:** hide the rail, or show it again. The original behaviour.
   * - **Floating:** bring it home to the rail. Floating counts as shown, so the
   *   press after that hides it, and floating it again is one click away.
   * - **In a tab or a different rail:** *open a second one* in the left rail.
   *   This is the bug the button used to have. It found the navigator wherever
   *   it was, decided it was "shown", and toggled the left rail — a rail that
   *   had nothing in it, so the button opened an empty strip and then closed it
   *   again, and the navigator you were looking for never appeared. A view you
   *   deliberately dragged into a tab is somewhere you put it; the answer is
   *   another navigator, not confiscating that one.
   */
  const toggleNavigator = useCallback(() => {
    apply((current) => {
      const existing = allViews(current).find((view) => view.type === NAVIGATOR_VIEW);
      if (!existing) return openInSidebar(current, 'left', newView(NAVIGATOR_VIEW));

      const found = locate(current, existing.id);
      if (found?.surface === 'window') {
        return moveViewIn(current, existing.id, { kind: 'sidebar', side: 'left' });
      }
      if (found?.surface === 'sidebar' && found.side === 'left') {
        return setSidebarOpen(current, 'left', !current.sidebars.left.open);
      }
      return openInSidebar(current, 'left', newView(NAVIGATOR_VIEW));
    });
  }, [apply]);

  /** Places shares the navigator's rail, so showing it is the same move. */
  const openPlaces = useCallback(() => {
    apply((current) => {
      const existing = allViews(current).find((view) => view.type === PLACES_VIEW);
      if (existing) return revealView(current, existing.id);
      return openInSidebar(current, 'left', newView(PLACES_VIEW));
    });
  }, [apply]);

  /**
   * One pointer gesture, one drag session.
   *
   * A floating window's title bar both moves the window and hunts for a snap
   * target, and those have to be the same session: two overlapping ones would
   * each add their own listeners, each clear the drag state on release, and
   * race over which of them got to commit.
   */
  const startDrag = useCallback<WindowsContextValue['startDrag']>(
    (event, payload, options = {}) => {
      // Nothing to drag onto: classic mode has one tile, no tab strip and no
      // windows, so every drop target a drag could find is unreachable anyway.
      if (narrow || classic) return;
      const root = document.querySelector<HTMLElement>('.workbench-tiles');
      if (!root) return;

      const zones = collectZones(root);
      const offset = options.offset ?? { x: 0, y: 0 };
      const fromWindow = payload.kind === 'view' && payload.windowId !== undefined;

      startPointerDrag(event, {
        threshold: options.threshold,
        onMove: (native, delta) => {
          options.onMove?.(delta);
          const point = { x: native.clientX, y: native.clientY };

          /**
           * A view can claim a drop for itself.
           *
           * The navigator does, for pages: dropping a row onto a folder means
           * *move it there*, and without this the pointer would also be over the
           * left rail, so the workbench would helpfully open the page in the
           * rail at the same time. Only page payloads are claimed, so dragging a
           * tab into a rail still docks it the way it always has.
           */
          const claimed =
            payload.kind === 'page' &&
            document.elementFromPoint(point.x, point.y)?.closest('[data-nav-drop]') != null;

          const resolution = claimed
            ? null
            : resolveDrop(point, zones, {
                // A window that lands nowhere stays floating exactly where the
                // pointer left it, so it needs no float target of its own — and
                // it must not be swallowed by every tile it passes over.
                allowFloat: !fromWindow,
                edgesOnly: fromWindow,
                // ⌥ suppresses snapping, which is the only way to leave
                // something floating over the middle of the editor area.
                forceFloat: native.altKey,
              });

          setDrag({
            payload,
            label: options.label ?? '',
            pointer: { x: point.x - offset.x, y: point.y - offset.y },
            preview: resolution?.preview ?? null,
            target: resolution?.target ?? null,
          });
        },
        onEnd: (_native, _delta, cancelled) => {
          if (cancelled) {
            options.onCancel?.();
            setDrag(null);
          } else {
            commitDragRef.current();
          }
        },
      });
    },
    [narrow, classic],
  );

  /**
   * Landing the drag.
   *
   * The session is read from a ref and the work happens *outside* any updater.
   * It used to call `apply` from inside `setDrag`'s updater, and React invokes
   * updaters more than once — StrictMode does it deliberately, to surface
   * exactly this. Moving an existing view twice happened to be near enough
   * idempotent to hide the bug; dropping a page from the navigator is not, and
   * one drop produced two tiles. See AGENTS → "`setState` updaters run more
   * than once".
   */
  const dragRef = useRef(drag);
  dragRef.current = drag;

  const commitDrag = useCallback(() => {
    const session = dragRef.current;
    setDrag(null);
    const target = session?.target;
    if (!session || !target) return;

    apply((current) =>
      session.payload.kind === 'view'
        ? moveViewIn(current, session.payload.instanceId, target)
        : // A page dragged out of the navigator is a view that does not exist
          // yet. It lands through exactly the same targets as a move.
          openAt(current, newView(PAGE_VIEW, { page: session.payload.page }), target),
    );
  }, [apply]);

  // `startDrag` is created before this one and has to reach it on release. A ref
  // rather than a dependency, so the drag session in flight is never torn down
  // and rebuilt by a re-render halfway through the gesture.
  const commitDragRef = useRef(commitDrag);
  commitDragRef.current = commitDrag;

  // -- find -----------------------------------------------------------------

  const openFind = useCallback<WindowsContextValue['openFind']>((query, instanceId) => {
    const current = layoutRef.current;
    // The focused view, falling back to whatever the focused tile is showing:
    // pressing Find straight after a reload should not need a click first.
    const group = findGroup(current.root, current.focus);
    const focused =
      instanceId ??
      current.focusedView ??
      (group ? activeViewOf(group)?.id : null) ??
      null;
    setFind((state) => ({
      instanceId: focused,
      nonce: state.nonce + 1,
      // Only a non-empty query seeds the field; a plain ⌘F keeps whatever the
      // bar already holds, and the nonce's select-all still says "type over
      // it" the way it always has.
      query: query?.trim() ?? '',
    }));
  }, []);

  const closeFind = useCallback(() => {
    setFind((state) => ({ instanceId: null, nonce: state.nonce, query: '' }));
  }, []);

  // -- the navigator, and the first page ------------------------------------

  useEffect(() => {
    // The navigator and Places are sidebar views like any other, so either can
    // be closed, resized, floated, or joined by a plugin's panel in the rail.
    //
    // They are two views rather than two halves of one. The halves shared a
    // panel and a seam you dragged between them, which meant *the rail* decided
    // how much room the journal got — and there was no way to put the pages
    // browser on the left and your shortcuts anywhere else, or to have the
    // browser alone. As peers they are tabs in the same rail by default and
    // anything the workbench can do to a view now applies to each of them.
    setLayout((current) => {
      const present = new Set(allViews(current).map((view) => view.type));
      let next = current;
      if (!present.has(PLACES_VIEW)) next = openInSidebar(next, 'left', newView(PLACES_VIEW));
      if (!present.has(NAVIGATOR_VIEW)) next = openInSidebar(next, 'left', newView(NAVIGATOR_VIEW));
      if (next === current) return current;

      // Restoring a layout that had the rail closed must not reopen it, and the
      // navigator is the tab you land on — Places is the shorter list you
      // glance at, not the one you browse in.
      return {
        ...next,
        sidebars: {
          ...next.sidebars,
          left: { ...next.sidebars.left, open: current.sidebars.left.open },
        },
      };
    });
  }, []);

  /**
   * Switching between classic and the full workbench resets the workspace.
   *
   * Not a nicety: the two modes disagree about what can exist. Leaving three
   * tiles and a floating window on screen after turning classic on would leave
   * arrangements the mode has no controls for — no tab strip to reach the
   * hidden tabs with, no title bar to close the window from. So the switch
   * lands you on one tile, the page you were reading, the rails you had
   * open, and nothing floating — `resetLayout`'s ordinary shape.
   */
  const layoutMode = appearance.layout;
  const appliedMode = useRef(layoutMode);

  useEffect(() => {
    if (appliedMode.current === layoutMode) return;
    appliedMode.current = layoutMode;
    setLayout((current) => resetLayout(current, journalFolder(workspace)));
  }, [layoutMode, workspace]);

  /**
   * The recovery path reload used to give you for free — see
   * `WORKBENCH_LAYOUT_KEY`'s doc comment. An explicit action rather than an
   * automatic side effect of reloading, because now reloading is supposed to
   * put you back exactly where you were; "something looks wrong, get me to
   * a known state" still needs a door, just not that one anymore.
   */
  const resetWorkbench = useCallback(() => {
    setLayout((current) => resetLayout(current, journalFolder(workspace)));
  }, [workspace]);

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

  /**
   * Closing the last page takes its address with it.
   *
   * The URL is written from what is open, so an empty workbench cannot keep
   * pointing at the note you just closed: reloading would reopen it, and
   * sharing the address would hand someone a page you are no longer reading.
   * Only *pages* count — a workbench holding nothing but Settings has no
   * document, and `/` is the honest address for that.
   */
  const anyPageOpen = useMemo(
    () => allViews(layout).some((view) => view.type === PAGE_VIEW),
    [layout],
  );

  useEffect(() => {
    if (anyPageOpen) return;
    syncedPage.current = null;
    navigate({ kind: 'home' }, true);
  }, [anyPageOpen, navigate]);

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

      // Docked in a tab, "beside" is a sibling group in the split tree — but
      // Spark's default home is the right rail (`openPage` special-cases
      // `SPARK_PAGE` to `sidebar-right`), which isn't part of that tree at
      // all, so it has no sibling group to look up. There, "beside you"
      // means whatever tile in the main area is currently focused: the note
      // you were reading the moment you opened Spark. `layout.focus` still
      // names that tile even while Spark has focus in the rail — opening or
      // revealing a sidebar view only ever touches `focusedView`, never
      // `focus` (see `openInSidebar`/`revealView` in `model.ts`).
      const focusedGroup = found?.surface === 'sidebar' ? findGroup(current.root, current.focus) : null;
      const neighbourNames = ownGroup
        ? siblingGroups(current.root, ownGroup).map((group) => pageNameOf(activeViewOf(group)))
        : focusedGroup
          ? [pageNameOf(activeViewOf(focusedGroup))]
          : [];
      const neighbours = neighbourNames.filter((name): name is string => name !== null);

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

  /**
   * Reporting the same thing twice is not a state change.
   *
   * The bail-out is load-bearing rather than an optimisation. A tile reports its
   * status from an effect, and an effect that sets state on every commit keeps
   * React's nested-update counter climbing — fifty commits later it throws
   * "Maximum update depth exceeded", which surfaces as the editor dying
   * mid-sentence during fast typing. Returning the same object when nothing
   * moved lets the counter reset, and it is also just true.
   */
  const setStatus = useCallback((patch: Partial<DocumentStatus>) => {
    setStatusState((current) => {
      const changed = (Object.keys(patch) as Array<keyof DocumentStatus>).some(
        (key) => current[key] !== patch[key],
      );
      return changed ? { ...current, ...patch } : current;
    });
  }, []);

  /**
   * The status bar keeps the last document's readings.
   *
   * Applies to the whole bar, not just the word count: moving from a note to
   * Tasks, to Settings, to a Spark chat used to blank everything, so the numbers
   * vanished exactly when you looked away from the note in order to check
   * something about it. They stay, marked `stale`, and the bar dims them and
   * says which page they are about. Only the save state is genuinely dropped —
   * "Saved" next to a page you are not looking at is not a reassurance, it is a
   * lie waiting to be misread.
   *
   * Deriving `stale` here rather than in `PageView` is what makes it hold for
   * every view: a plugin's panel taking focus is not a document either, and it
   * does not have to know that this exists.
   */
  const focusedIsDocument = useMemo(() => {
    const view = allViews(layout).find((entry) => entry.id === layout.focusedView);
    if (!view || view.type !== PAGE_VIEW) return false;
    return resolveVirtualPage(view.params.page ?? '') === null;
  }, [layout]);

  useEffect(() => {
    setStatusState((current) =>
      current.stale === !focusedIsDocument ? current : { ...current, stale: !focusedIsDocument },
    );
  }, [focusedIsDocument]);

  /**
   * ...but only while there is still a document to keep them about.
   *
   * "The last page you were reading" is a useful thing to say while that page
   * is one tab away. Once the workbench is empty it is a caption on nothing:
   * the header would still name a note that is not on screen and cannot be
   * brought back by clicking it. Everything the readings describe is gone, so
   * they go too, and the header and the bar have nothing to say.
   */
  useEffect(() => {
    if (anyPageOpen) return;
    setStatusState((current) =>
      current.page === null
        ? current
        : { ...current, page: null, virtual: false, saveState: 'saved', words: 0 },
    );
  }, [anyPageOpen]);

  const value: WindowsContextValue = {
    layout,
    narrow,
    classic,
    resetWorkbench,
    openPage,
    openView,
    splitFocused,
    openPageBeside,
    toggleNavigator,
    openPlaces,
    drag,
    setDrag,
    commitDrag,
    startDrag,
    find,
    openFind,
    closeFind,
    modalOpen: layout.windows.some((entry) => entry.surface === 'modal'),
    shellView,
    pluginView,
    titleOf,
    focusedPageTitle,
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
      // The ordinary "open a page" gesture gets the preview treatment: it
      // replaces whatever the group's own preview tab was showing rather than
      // piling up beside it. Nothing else in this switch goes through here —
      // a split, a window, a rail are all a person committing to a specific
      // arrangement, not a glance.
      return openTabPreview(layout, layout.focus, view);
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
 * The *fallback* layout — one tile, one page, nothing floating — used when
 * there is nothing to restore: classic mode (which can't express tiles or
 * windows at all), a first launch, or a stored layout `restorePersistedLayout`
 * couldn't make sense of. The ordinary case restores the tiled arrangement
 * from `WORKBENCH_LAYOUT_KEY` instead — see its own doc comment for why that
 * changed from the deliberately-reset behaviour this function used to be
 * named for.
 *
 * The URL decides which page for this fallback; a bare launch gets today's
 * journal, which is usually empty and so is the blank editor the app opens
 * into, with somewhere real for anything typed into it to land.
 */
function restoreLayout(route: ReturnType<typeof useApp>['route'], journal: string): Layout {
  const base = emptyLayout();
  const page = route.kind === 'page' ? route.page : dailyPageName(new Date(), journal);
  return openInGroup(base, base.focus, newView(PAGE_VIEW, { page }));
}

/**
 * The layout an old-style reload used to give you, produced on demand
 * instead: keeps the page you were reading and the rails you had open —
 * those are what you would come back to anyway — and drops every tile, tab
 * and floating window. Modals survive the cut: a modal isn't part of the
 * tile/window arrangement either mode has opinions about, and switching
 * layout mode from inside one (Settings, say) shouldn't close it out from
 * under you.
 *
 * Two callers, one meaning: the classic-mode switch effect below, where
 * dropping tiles is forced (classic can't express them), and the
 * `window.resetLayout` command, where it's the recovery path a person
 * reaches for on purpose — the thing "just reload" used to do automatically
 * before layouts persisted at all.
 */
function resetLayout(current: Layout, journal: string): Layout {
  const group = findGroup(current.root, current.focus);
  const active = group ? activeViewOf(group) : null;
  const kept = active
    ? newView(active.type, active.params, active.title)
    : newView(PAGE_VIEW, { page: dailyPageName(new Date(), journal) });

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
