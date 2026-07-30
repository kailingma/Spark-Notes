import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ViewDefinition } from '@spark/plugin-sdk';
import {
  CloseIcon,
  FloatIcon,
  GripIcon,
  MaximizeIcon,
  MinimizeIcon,
  RestoreIcon,
  SplitIcon,
} from '../components/Icons';
import { collectZones, resolveDrop, rectOf, startPointerDrag } from './drag';
import { useWindows } from './manager';
import {
  activeViewOf,
  type SidebarSide,
  type FloatingWindow,
  type GroupNode,
  type LayoutNode,
  type Rect,
  type SplitNode,
  type ViewRef,
} from './model';
import { NAVIGATOR_VIEW } from './views';

/**
 * The workbench: sidebars around the outside, the tile tree in the middle, and the
 * floating windows above everything.
 *
 * Layout is `position: absolute` percentages rather than a flex tree, because a
 * split has to be resizable to arbitrary fractions and a divider drag has to be
 * arithmetic on those fractions and nothing else. Anything measured from the
 * DOM mid-drag fights the drag.
 */
export function Workbench() {
  const { layout, narrow, classic, drag, setDrag, commitDrag, setWindowRect, modalOpen } =
    useWindows();
  const tilesRef = useRef<HTMLDivElement>(null);

  // Shrinking the browser must not strand a window off the bottom or the right.
  // Refitting on resize is the same rule the drag uses, applied to the other
  // way the two can stop fitting each other.
  useEffect(() => {
    const onResize = () => {
      const bounds = windowBounds();
      for (const entry of layout.windows) {
        const fitted = fitWindow(entry.rect, bounds);
        if (
          fitted.x !== entry.rect.x ||
          fitted.y !== entry.rect.y ||
          fitted.width !== entry.rect.width ||
          fitted.height !== entry.rect.height
        ) {
          setWindowRect(entry.id, fitted);
        }
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [layout.windows, setWindowRect]);

  /**
   * One pointer gesture, one drag session.
   *
   * A floating window's title bar both moves the window and hunts for a snap
   * target, and those have to be the same session: two overlapping ones would
   * each add their own listeners, each clear the drag state on release, and
   * race over which of them got to commit.
   */
  const beginDrag = useCallback<DragStarter>(
    (event, instanceId, options = {}) => {
      // Nothing to drag onto: classic mode has one tile, no tab strip, and no
      // windows, so every drop target a drag could find is unreachable anyway.
      if (narrow || classic) return;
      const root = tilesRef.current;
      if (!root) return;

      const zones = collectZones(root);
      const offset = options.offset ?? { x: 0, y: 0 };
      const fromWindow = options.windowId !== undefined;

      startPointerDrag(event, {
        onMove: (native, delta) => {
          options.onMove?.(delta);
          const point = { x: native.clientX, y: native.clientY };
          const resolution = resolveDrop(point, zones, {
            // A window that lands nowhere stays floating exactly where the
            // pointer left it, so it needs no float target of its own — and it
            // must not be swallowed by every tile it passes over on the way.
            allowFloat: !fromWindow,
            edgesOnly: fromWindow,
          });
          setDrag({
            instanceId,
            windowId: options.windowId,
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
            commitDrag();
          }
        },
      });
    },
    [narrow, classic, setDrag, commitDrag],
  );

  const windows = layout.windows.filter((entry) => entry.surface === 'window');
  const modals = layout.windows.filter((entry) => entry.surface === 'modal');

  return (
    <div className="workbench" data-narrow={narrow || undefined}>
      {/*
       * Everything below a modal is inert, not merely covered. A scrim alone
       * still lets a click land on the editor, and the editor still takes the
       * keyboard — which is how a "modal" ends up with a cursor blinking behind
       * it. `inert` is the browser's own answer: no pointer events, no focus,
       * no tab stops, and it is removed the moment the modal closes.
       */}
      <div className="workbench-layer" inert={modalOpen || undefined}>
        {!narrow && <SidebarRail side="left" />}

        <div className="workbench-centre">
          <div className="workbench-tiles" ref={tilesRef}>
            <NodeView node={layout.root} onDragTab={beginDrag} />
          </div>
          {!narrow && <SidebarRail side="bottom" />}
        </div>

        {!narrow && <SidebarRail side="right" />}

        {narrow && <MobileDrawer />}

        {windows.map((window) => (
          <FloatingFrame key={window.id} window={window} onDragTitle={beginDrag} />
        ))}

        {drag?.preview && <div className="drop-preview" style={rectStyle(drag.preview)} />}
      </div>

      {modals.map((window) => (
        <FloatingFrame key={window.id} window={window} onDragTitle={beginDrag} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The tile tree
// ---------------------------------------------------------------------------

type DragStarter = (
  event: React.PointerEvent,
  instanceId: string,
  options?: {
    windowId?: string;
    /** Pointer position within the thing being dragged, so it doesn't jump. */
    offset?: { x: number; y: number };
    /** Runs on every move — how a floating window follows the pointer. */
    onMove?: (delta: { dx: number; dy: number }) => void;
    onCancel?: () => void;
  },
) => void;

function NodeView({ node, onDragTab }: { node: LayoutNode; onDragTab: DragStarter }) {
  if (node.kind === 'group') return <GroupView group={node} onDragTab={onDragTab} />;
  return <SplitView split={node} onDragTab={onDragTab} />;
}

function SplitView({ split, onDragTab }: { split: SplitNode; onDragTab: DragStarter }) {
  const { resizeSplit } = useWindows();
  const hostRef = useRef<HTMLDivElement>(null);

  // Running offsets so each child knows where it starts, in percent.
  let offset = 0;
  const offsets = split.sizes.map((size) => {
    const start = offset;
    offset += size;
    return start;
  });

  const startResize = (event: React.PointerEvent, index: number) => {
    const host = hostRef.current;
    if (!host) return;
    event.preventDefault();

    const box = rectOf(host);
    const total = split.axis === 'row' ? box.width : box.height;
    const pair = split.sizes[index] + split.sizes[index + 1];
    const startSize = split.sizes[index];

    startPointerDrag(event, {
      onMove: (_native, delta) => {
        const moved = (split.axis === 'row' ? delta.dx : delta.dy) / Math.max(total, 1);
        resizeSplit(split.id, index, Math.min(Math.max(startSize + moved, 0), pair));
      },
    });
  };

  return (
    <div className="split" data-axis={split.axis} ref={hostRef}>
      {split.children.map((child, index) => (
        <div
          key={child.id}
          className="split-pane"
          style={paneStyle(split.axis, offsets[index], split.sizes[index])}
        >
          <NodeView node={child} onDragTab={onDragTab} />
        </div>
      ))}

      {split.children.slice(0, -1).map((child, index) => (
        <div
          key={`divider-${child.id}`}
          className="split-divider"
          data-axis={split.axis}
          role="separator"
          aria-orientation={split.axis === 'row' ? 'vertical' : 'horizontal'}
          style={dividerStyle(split.axis, offsets[index] + split.sizes[index])}
          onPointerDown={(event) => startResize(event, index)}
        />
      ))}
    </div>
  );
}

function GroupView({ group, onDragTab }: { group: GroupNode; onDragTab: DragStarter }) {
  const { layout, focusGroup, narrow, classic } = useWindows();
  const focused = layout.focus === group.id;
  const active = activeViewOf(group);

  return (
    <section
      className="tile"
      data-window-group={group.id}
      data-focused={focused || undefined}
      onPointerDownCapture={() => {
        if (!focused) focusGroup(group.id);
      }}
    >
      {/* One view is not a tab: a strip with a single item in it is a label you
          cannot switch away from. The actions it carried move into a hover
          control instead, so nothing is lost, only the chrome. Classic mode
          gets neither — every control on them arranges something it does not
          have, and the editor area is meant to be nothing but the editor. */}
      {classic ? null : group.views.length > 1 ? (
        <TabStrip group={group} onDragTab={onDragTab} />
      ) : (
        <TileActions group={group} onDragTab={onDragTab} />
      )}
      <div className="tile-body">
        {/* Every tab stays mounted: switching back to a note should not reload
            it, re-run its scroll position, or lose an in-flight Spark reply. */}
        {group.views.map((view) => (
          <div
            key={view.id}
            className="tile-slot"
            data-active={view.id === active?.id || undefined}
            aria-hidden={view.id !== active?.id}
          >
            <ViewHost view={view} />
          </div>
        ))}
        {group.views.length === 0 && !narrow && (
          <p className="tile-empty">Nothing open here.</p>
        )}
      </div>
    </section>
  );
}

/**
 * The controls a single-view tile keeps.
 *
 * Overlaid on the corner and revealed on hover: splitting, floating and closing
 * still have to be reachable, and the view itself is still draggable — the grip
 * is the drag handle a tab would have been.
 */
function TileActions({ group, onDragTab }: { group: GroupNode; onDragTab: DragStarter }) {
  const { titleOf, closeView, moveView, narrow, splitFocused } = useWindows();
  const view = activeViewOf(group);
  if (!view || narrow) return null;

  return (
    <div className="tile-actions" data-window-tabs="">
      <button
        className="icon-button tile-grip"
        data-window-tab=""
        title={`Move ${titleOf(view)}`}
        aria-label={`Move ${titleOf(view)}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const box = event.currentTarget.getBoundingClientRect();
          onDragTab(event, view.id, {
            offset: { x: event.clientX - box.left, y: event.clientY - box.top },
          });
        }}
      >
        <GripIcon />
      </button>
      <button
        className="icon-button"
        title="Split right"
        aria-label="Split right"
        onClick={() => splitFocused('right')}
      >
        <SplitIcon />
      </button>
      <button
        className="icon-button"
        title="Open in a floating window"
        aria-label="Open in a floating window"
        onClick={() => moveView(view.id, { kind: 'window', rect: defaultWindowRect() })}
      >
        <FloatIcon />
      </button>
      <button
        className="icon-button"
        title={`Close ${titleOf(view)}`}
        aria-label={`Close ${titleOf(view)}`}
        onClick={() => closeView(view.id)}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function TabStrip({ group, onDragTab }: { group: GroupNode; onDragTab: DragStarter }) {
  const { titleOf, revealView, closeView, moveView, narrow, splitFocused } = useWindows();
  const active = activeViewOf(group);

  return (
    <div className="tabs" data-window-tabs="" role="tablist">
      <div className="tabs-scroll">
        {group.views.map((view) => (
          <div
            key={view.id}
            className="tab"
            data-window-tab=""
            data-active={view.id === active?.id || undefined}
            role="tab"
            aria-selected={view.id === active?.id}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              revealView(view.id);
              const box = event.currentTarget.getBoundingClientRect();
              onDragTab(event, view.id, {
                offset: { x: event.clientX - box.left, y: event.clientY - box.top },
              });
            }}
            // Middle-click closes, the way it does in every tabbed thing.
            onAuxClick={(event) => {
              if (event.button === 1) closeView(view.id);
            }}
          >
            <span className="tab-title">{titleOf(view)}</span>
            <button
              className="tab-close"
              aria-label={`Close ${titleOf(view)}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => closeView(view.id)}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
      </div>

      {!narrow && (
        <div className="tabs-actions">
          <button
            className="icon-button"
            title="Split right"
            aria-label="Split right"
            onClick={() => splitFocused('right')}
          >
            <SplitIcon />
          </button>
          <button
            className="icon-button"
            title="Open in a floating window"
            aria-label="Open in a floating window"
            disabled={!active}
            onClick={() => active && moveView(active.id, { kind: 'window', rect: defaultWindowRect() })}
          >
            <FloatIcon />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebars
// ---------------------------------------------------------------------------

function SidebarRail({ side }: { side: SidebarSide }) {
  const { layout, setSidebarSize, titleOf, closeView, setSidebarActive, moveView, classic } =
    useWindows();
  const sidebar = layout.sidebars[side];
  if (!sidebar.open || sidebar.views.length === 0) return null;

  const active = sidebar.views[sidebar.active];
  const vertical = side !== 'bottom';

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const start = sidebar.size;
    startPointerDrag(event, {
      onMove: (_native, delta) => {
        const change = side === 'left' ? delta.dx : side === 'right' ? -delta.dx : -delta.dy;
        setSidebarSize(side, start + change);
      },
    });
  };

  return (
    <aside
      className="sidebar"
      data-window-sidebar={side}
      data-side={side}
      style={vertical ? { width: `${sidebar.size}px` } : { height: `${sidebar.size}px` }}
    >
      {sidebar.views.length > 1 && (
        <div className="sidebar-tabs" role="tablist">
          {sidebar.views.map((view, index) => (
            <button
              key={view.id}
              className="sidebar-tab"
              role="tab"
              aria-selected={index === sidebar.active}
              onClick={() => setSidebarActive(side, index)}
            >
              {titleOf(view)}
            </button>
          ))}
        </div>
      )}

      <div className="sidebar-body">{active && <ViewHost view={active} />}</div>

      {active && (
        <div className="sidebar-actions">
          {!classic && (
            <button
              className="icon-button"
              aria-label={`Float ${titleOf(active)}`}
              title="Float this panel"
              onClick={() =>
                moveView(active.id, {
                  kind: 'window',
                  // A panel keeps the width it had in the rail, so floating it
                  // does not also reflow everything inside it.
                  rect: fitWindow({ x: 32, y: 0, width: Math.max(sidebar.size, 320), height: 620 }),
                })
              }
            >
              <FloatIcon />
            </button>
          )}
          {/* The navigator has no close button: hiding it is what the header
              toggle is for, and a closed rail with nothing in it is a dead end. */}
          {active.type !== NAVIGATOR_VIEW && (
            <button
              className="icon-button"
              aria-label={`Close ${titleOf(active)}`}
              onClick={() => closeView(active.id)}
            >
              <CloseIcon />
            </button>
          )}
        </div>
      )}

      <div className="sidebar-resize" data-side={side} onPointerDown={startResize} />
    </aside>
  );
}

/**
 * The navigator on a phone.
 *
 * A rail that takes a third of a small screen is not a navigator, it is an
 * obstruction — so on narrow screens the left rail becomes a drawer over the
 * content, and everything else about it stays the same.
 */
function MobileDrawer() {
  const { layout, toggleSidebar } = useWindows();
  const sidebar = layout.sidebars.left;
  const active = sidebar.views[sidebar.active];
  if (!sidebar.open || !active) return null;

  return (
    <>
      <div className="scrim" onClick={() => toggleSidebar('left')} />
      <aside className="sidebar" data-side="left" data-drawer="true">
        <div className="sidebar-body">
          <ViewHost view={active} />
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// Floating windows
// ---------------------------------------------------------------------------

const RESIZE_HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

function FloatingFrame({
  window: win,
  onDragTitle,
}: {
  window: FloatingWindow;
  onDragTitle: DragStarter;
}) {
  const {
    titleOf,
    closeView,
    raiseWindow,
    setWindowRect,
    setWindowState,
    moveView,
    narrow,
    layout,
    shellView,
  } = useWindows();

  const title = titleOf(win.view);
  // The one branch this component takes everywhere: a modal is centred,
  // immovable and scrimmed; a window is a rectangle you arrange.
  const modal = win.surface === 'modal';
  const maximized = win.state === 'maximized' || narrow;

  /** The rail this view came from, when it is a panel rather than a document. */
  const home = sidebarSideOf(shellView(win.view.type)?.defaultMode);

  // Escape dismisses a modal. Only the topmost one listens, so stacked modals
  // close one at a time rather than all at once.
  const topmost = useMemo(
    () => layout.windows.every((entry) => entry.z <= win.z),
    [layout.windows, win.z],
  );

  useEffect(() => {
    if (!modal || !topmost) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeView(win.view.id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [modal, win.view.id, topmost, closeView]);

  if (win.state === 'minimized') {
    return (
      <button
        className="window-pill"
        style={{ zIndex: 40 + win.z }}
        onClick={() => setWindowState(win.id, 'normal')}
      >
        {title}
      </button>
    );
  }

  const startMove = (event: React.PointerEvent) => {
    // A modal does not move. It belongs to the action that opened it, it is
    // centred because that is where your attention already is, and dragging it
    // aside implies you can work behind it, which you cannot.
    if (event.button !== 0 || maximized || modal) return;
    raiseWindow(win.id);
    const start = win.rect;

    const bounds = windowBounds();
    const follow = ({ dx, dy }: { dx: number; dy: number }) => {
      setWindowRect(win.id, fitWindow({ ...start, x: start.x + dx, y: start.y + dy }, bounds));
    };

    const box = event.currentTarget.getBoundingClientRect();
    onDragTitle(event, win.view.id, {
      windowId: win.id,
      offset: { x: event.clientX - box.left, y: event.clientY - box.top },
      onMove: follow,
      onCancel: () => setWindowRect(win.id, start),
    });
  };

  const startResize = (event: React.PointerEvent, handle: (typeof RESIZE_HANDLES)[number]) => {
    event.preventDefault();
    event.stopPropagation();
    raiseWindow(win.id);
    const start = win.rect;

    startPointerDrag(event, {
      onMove: (_native, { dx, dy }) => {
        let { x, y, width, height } = start;
        if (handle.includes('e')) width = start.width + dx;
        if (handle.includes('s')) height = start.height + dy;
        if (handle.includes('w')) {
          width = start.width - dx;
          x = start.x + dx;
        }
        if (handle.includes('n')) {
          height = start.height - dy;
          y = start.y + dy;
        }
        setWindowRect(win.id, fitWindow({ x, y, width, height }));
      },
    });
  };

  return (
    <>
      {modal && (
        <div className="scrim" data-modal="true" onMouseDown={() => closeView(win.view.id)} />
      )}

      <div
        className="window"
        data-modal={modal || undefined}
        data-maximized={maximized || undefined}
        role="dialog"
        aria-label={title}
        aria-modal={modal || undefined}
        // A modal is sized, centred and stacked entirely by CSS: it has no
        // rectangle of its own to remember, because it cannot be moved, and an
        // inline z-index here would beat the one that puts it above the scrim.
        style={
          modal
            ? undefined
            : maximized
              ? { zIndex: 41 + win.z }
              : { ...rectStyle(win.rect), zIndex: 41 + win.z }
        }
        onPointerDownCapture={() => raiseWindow(win.id)}
      >
        <header
          className="window-bar"
          data-fixed={modal || undefined}
          onPointerDown={startMove}
          onDoubleClick={() =>
            !modal && setWindowState(win.id, win.state === 'maximized' ? 'normal' : 'maximized')
          }
        >
          <span className="window-title">{title}</span>
          <div className="window-actions">
            {!modal && (
              <>
                {/* Back where it belongs: a panel that lives in a rail returns
                    to its rail, and a document returns beside the tile you are
                    reading. Sending the navigator into a tab helps nobody. */}
                <button
                  className="icon-button"
                  aria-label="Sidebar this window"
                  title={home ? 'Return to the panel rail' : 'Sidebar beside the current tile'}
                  onClick={() =>
                    moveView(
                      win.view.id,
                      home
                        ? { kind: 'sidebar', side: home }
                        : { kind: 'split', groupId: layout.focus, side: 'right' },
                    )
                  }
                >
                  <SplitIcon />
                </button>
                <button
                  className="icon-button"
                  aria-label="Minimize"
                  title="Minimize"
                  onClick={() => setWindowState(win.id, 'minimized')}
                >
                  <MinimizeIcon />
                </button>
                <button
                  className="icon-button"
                  aria-label={win.state === 'maximized' ? 'Restore' : 'Maximize'}
                  title={win.state === 'maximized' ? 'Restore' : 'Maximize'}
                  onClick={() => setWindowState(win.id, win.state === 'maximized' ? 'normal' : 'maximized')}
                >
                  {win.state === 'maximized' ? <RestoreIcon /> : <MaximizeIcon />}
                </button>
              </>
            )}
            <button className="icon-button" aria-label="Close" title="Close" onClick={() => closeView(win.view.id)}>
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="window-body">
          <ViewHost view={win.view} />
        </div>

        {!maximized &&
          !modal &&
          RESIZE_HANDLES.map((handle) => (
            <div
              key={handle}
              className="window-resize"
              data-handle={handle}
              onPointerDown={(event) => startResize(event, handle)}
            />
          ))}
      </div>
    </>
  );
}

/**
 * The top of the workbench, in viewport coordinates.
 *
 * Read from the DOM rather than computed from the tokens, because the header's
 * height is `--header-height` plus the safe-area inset and only the browser
 * knows what that came to.
 */
function sidebarSideOf(mode: string | undefined): SidebarSide | null {
  if (mode === 'sidebar-left') return 'left';
  if (mode === 'sidebar-right') return 'right';
  if (mode === 'sidebar-bottom') return 'bottom';
  return null;
}

/**
 * The area a floating window is allowed to occupy.
 *
 * Read from the DOM rather than computed from the tokens, because the header's
 * height is `--header-height` plus the safe-area inset and only the browser
 * knows what that came to.
 */
function windowBounds(): Rect {
  const el = document.querySelector('.workbench');
  if (!el) return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  const box = el.getBoundingClientRect();
  return { x: 0, y: box.top, width: window.innerWidth, height: box.height };
}

const MIN_WINDOW = { width: 280, height: 140 };

/**
 * Keeps a window inside the workbench by *shrinking* it, not by stopping it.
 *
 * Push a window against the top and it gets shorter rather than sliding under
 * the header; the same at every other edge. Clamping the position alone leaves
 * a window that is technically on screen with its content off it, and snapping
 * would move the window somewhere the person did not put it. Shrinking is the
 * only one of the three where what you see is what you asked for.
 */
function fitWindow(rect: Rect, bounds = windowBounds()): Rect {
  let { x, y, width, height } = rect;
  width = Math.min(Math.max(width, MIN_WINDOW.width), Math.max(MIN_WINDOW.width, bounds.width));
  height = Math.min(Math.max(height, MIN_WINDOW.height), Math.max(MIN_WINDOW.height, bounds.height));

  // Over an edge: that side stops and the opposite one stays put, so the window
  // gives up exactly the extent it would have hidden.
  if (y < bounds.y) {
    height = Math.max(MIN_WINDOW.height, height - (bounds.y - y));
    y = bounds.y;
  }
  if (x < bounds.x) {
    width = Math.max(MIN_WINDOW.width, width - (bounds.x - x));
    x = bounds.x;
  }

  const bottom = bounds.y + bounds.height;
  const right = bounds.x + bounds.width;
  // Slide back in if there is room, and only then give up size.
  if (y + height > bottom) {
    y = Math.max(bounds.y, bottom - height);
    height = Math.min(height, bottom - y);
  }
  if (x + width > right) {
    x = Math.max(bounds.x, right - width);
    width = Math.min(width, right - x);
  }

  return { x, y, width, height };
}

function defaultWindowRect(): Rect {
  return fitWindow({
    x: Math.max(24, window.innerWidth / 2 - 340),
    y: 90,
    width: 680,
    height: 560,
  });
}

// ---------------------------------------------------------------------------
// Mounting a view
// ---------------------------------------------------------------------------

/** Renders a shell view, or hosts a plugin's `mount()` in a plain element. */
function ViewHost({ view }: { view: ViewRef }): ReactNode {
  const { shellView, pluginView } = useWindows();

  const shell = shellView(view.type);
  if (shell) return shell.render({ instanceId: view.id, params: view.params });

  const plugin = pluginView(view.type);
  if (plugin) return <PluginViewHost key={view.id} view={view} definition={plugin} />;

  return (
    <p className="tile-empty">
      Nothing is registered as <code>{view.type}</code>. The plugin that provided it may be
      unloaded.
    </p>
  );
}

function PluginViewHost({
  view,
  definition,
}: {
  view: ViewRef;
  definition: ViewDefinition;
}) {
  const { closeView } = useWindows();
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cleanup: void | (() => void);
    try {
      cleanup = definition.mount(host, {
        instanceId: view.id,
        params: view.params,
        close: () => closeView(view.id),
        setTitle: () => {
          // Titles are owned by the layout, which a plugin reaches through
          // `windows.open({ title })`. Renaming after the fact is not wired up
          // yet; the no-op is deliberate rather than an error a plugin has to
          // guard against.
        },
        onLayout: () => () => {},
      });
    } catch (err) {
      console.error(`[spark] view "${definition.id}" failed to mount`, err);
    }

    return () => {
      try {
        cleanup?.();
      } catch (err) {
        console.error(`[spark] view "${definition.id}" failed to unmount`, err);
      }
      host.replaceChildren();
    };
  }, [definition, view.id, view.params, closeView]);

  return <div className="plugin-view" ref={hostRef} />;
}

// ---------------------------------------------------------------------------
// Geometry
//
// The one place inline styles are right. Everything visual is a class in
// `app.css`; these four helpers emit nothing but numbers that live in the
// layout state — a pane's fraction of its split, a window's rectangle — and
// there is no class that could carry a value the user just dragged.
// ---------------------------------------------------------------------------

function paneStyle(axis: 'row' | 'column', offset: number, size: number): React.CSSProperties {
  const start = `${offset * 100}%`;
  const extent = `${size * 100}%`;
  return axis === 'row'
    ? { left: start, width: extent, top: 0, bottom: 0 }
    : { top: start, height: extent, left: 0, right: 0 };
}

function dividerStyle(axis: 'row' | 'column', at: number): React.CSSProperties {
  return axis === 'row' ? { left: `${at * 100}%` } : { top: `${at * 100}%` };
}

function rectStyle(rect: Rect): React.CSSProperties {
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}
