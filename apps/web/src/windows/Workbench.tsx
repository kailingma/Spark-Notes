import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ViewDefinition } from '@spark/plugin-sdk';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FloatIcon,
  GripIcon,
  MaximizeIcon,
  MinimizeIcon,
  RestoreIcon,
  SplitIcon,
} from '../components/Icons';
import { SparkWatermark } from '../components/SparkLogo';
import { usePersisted } from '../navigator/section';
import { SPARK_PAGE } from '../virtual';
import { DRAG_THRESHOLD, rectOf, startPointerDrag } from './drag';
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
import { NAVIGATOR_VIEW, PAGE_VIEW, PLACES_VIEW } from './views';

/** True for the one view whose own header already carries a grip and a close — see `SparkView`'s `beginHeaderDrag`. */
function isSparkView(view: ViewRef): boolean {
  return view.type === PAGE_VIEW && view.params.page === SPARK_PAGE;
}

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
  const { layout, narrow, drag, startDrag, setWindowRect, modalOpen } = useWindows();
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
   * Dragging a view is the shared gesture with a view-shaped payload.
   *
   * The session itself lives in the manager, because the navigator drags pages
   * in from outside this component's tree — see `startDrag` there.
   *
   * Every handle this reaches — a tab, a rail tab, a tile grip, a title bar —
   * is also something you click, so they all take the movement threshold. It is
   * applied here rather than at each call site because the failure it prevents
   * is silent: without it a click that wobbles a pixel commits a drop on
   * release, and the rail tabs re-order themselves under your finger.
   */
  const beginDrag = useCallback<DragStarter>(
    (event, instanceId, options = {}) => {
      startDrag(
        event,
        { kind: 'view', instanceId, windowId: options.windowId },
        {
          threshold: DRAG_THRESHOLD,
          offset: options.offset,
          onMove: options.onMove,
          onCancel: options.onCancel,
        },
      );
    },
    [startDrag],
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
        {!narrow && <SidebarRail side="left" onDragTab={beginDrag} />}

        <div className="workbench-centre">
          <div className="workbench-tiles" ref={tilesRef}>
            <NodeView node={layout.root} onDragTab={beginDrag} />
          </div>
          {!narrow && <SidebarRail side="bottom" onDragTab={beginDrag} />}
        </div>

        {!narrow && <SidebarRail side="right" onDragTab={beginDrag} />}

        {narrow && <MobileDrawer />}

        {windows.map((window) => (
          <FloatingFrame key={window.id} window={window} onDragTitle={beginDrag} />
        ))}

        {drag?.preview && <div className="drop-preview" style={rectStyle(drag.preview)} />}

        {/* What is in the air. A tab drags its own strip along visually, but a
            page dragged out of the navigator has nothing to show for itself,
            and a drop preview with no cursor label leaves you guessing what you
            are about to drop. */}
        {drag?.label && (
          <div
            className="drag-ghost"
            style={{ left: `${drag.pointer.x}px`, top: `${drag.pointer.y}px` }}
          >
            {drag.label}
          </div>
        )}
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

/** A preview tab left unread and untouched this long becomes an ordinary one. */
const PREVIEW_LINGER_MS = 5000;

function GroupView({ group, onDragTab }: { group: GroupNode; onDragTab: DragStarter }) {
  const { layout, focusGroup, promoteView, narrow, classic } = useWindows();
  const focused = layout.focus === group.id;
  const active = activeViewOf(group);

  // The other way a preview tab is promoted, beside an edit or a click: simply
  // sitting with it open long enough that you were plainly reading it, not
  // glancing at it. Restarts whenever the active tab changes, so switching
  // back to an old preview gives it a fresh clock rather than promoting it on
  // arrival because time had already passed while it sat unread in the
  // background.
  useEffect(() => {
    if (!active || group.preview !== active.id) return;
    const timer = window.setTimeout(() => promoteView(active.id), PREVIEW_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [active, group.preview, promoteView]);

  // One view is ordinarily not a tab at all: a strip with a single item in it
  // is a label you cannot switch away from, and the actions it carried move
  // into a hover control instead. A lone *preview* tab is the exception — it
  // is the one case a single view still needs a label, because the label is
  // what says "this isn't permanent yet".
  const showTabs = !classic && (group.views.length > 1 || group.preview === active?.id);

  return (
    <section
      className="tile"
      data-window-group={group.id}
      data-focused={focused || undefined}
      onPointerDownCapture={() => {
        if (!focused) focusGroup(group.id);
      }}
    >
      {/* Classic mode gets neither: every control on them arranges something
          it does not have, and the editor area is meant to be nothing but the
          editor. */}
      {classic ? null : showTabs ? (
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
        {/* An empty tile used to say "Nothing open here", which is a sentence
            reporting a fact you can already see. The mark says the same thing
            without words, set a hair off the background so it reads as the
            surface rather than as content — see `.spark-watermark`. */}
        {group.views.length === 0 && !narrow && <SparkWatermark />}
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

  // Spark renders its own window controls — grip, split, float and close —
  // in `.spark-window-controls`, in the chat area below its header; see
  // `beginGripDrag` and the cluster in `SparkView.tsx`. The workbench's
  // corner overlay would cover that header, so a second, hover-only handle
  // here on top of it is one affordance too many, and a second close button
  // is worse: two ways to do the same thing, findable at different times.
  const spark = isSparkView(view);

  return (
    <div className="tile-actions" data-window-tabs="">
      {!spark && (
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
      )}
      {/* Split and float are offered to Spark by its own cluster in the chat
          area (`SparkView.tsx`'s `.spark-window-controls`), so the corner
          overlay stays off a header it would cover. See AGENTS → "Panels
          close themselves". */}
      {!spark && (
        <button
          className="icon-button"
          title="Split right"
          aria-label="Split right"
          onClick={() => splitFocused('right')}
        >
          <SplitIcon />
        </button>
      )}
      {!spark && (
        <button
          className="icon-button"
          title="Open in a floating window"
          aria-label="Open in a floating window"
          onClick={() => moveView(view.id, { kind: 'window', rect: defaultWindowRect() })}
        >
          <FloatIcon />
        </button>
      )}
      {!spark && (
        <button
          className="icon-button"
          title={`Close ${titleOf(view)}`}
          aria-label={`Close ${titleOf(view)}`}
          onClick={() => closeView(view.id)}
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}

/** How far a scroll button nudges the strip, in px — a handful of tabs' worth. */
const TAB_SCROLL_STEP = 160;

function TabStrip({ group, onDragTab }: { group: GroupNode; onDragTab: DragStarter }) {
  const { titleOf, revealView, closeView, moveView, narrow, splitFocused } = useWindows();
  const active = activeViewOf(group);
  const spark = active !== null && isSparkView(active);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const updateOverflow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setOverflow({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);

  // Re-measured on scroll, on resize, and whenever a tab is added or removed —
  // the strip's own width or content can change without the element itself
  // resizing, which is what the tab-count dependency is for.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(el);
    el.addEventListener('scroll', updateOverflow, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', updateOverflow);
    };
  }, [updateOverflow, group.views.length]);

  return (
    <div className="tabs" data-window-tabs="" role="tablist">
      {/* Only drawn once there is somewhere to scroll to — a button that does
          nothing is worse than no button. */}
      {overflow.left && (
        <button
          className="icon-button tabs-scroll-btn"
          data-side="left"
          aria-label="Scroll tabs left"
          onClick={() => scrollRef.current?.scrollBy({ left: -TAB_SCROLL_STEP, behavior: 'smooth' })}
        >
          <ChevronLeftIcon />
        </button>
      )}

      <div className="tabs-scroll" ref={scrollRef} data-overflowing={overflow.left || overflow.right || undefined}>
        {group.views.map((view) => (
          <div
            key={view.id}
            className="tab"
            data-window-tab=""
            data-active={view.id === active?.id || undefined}
            // A preview tab is drawn in italic — see `GroupNode.preview` — so
            // it reads as "this is what you're glancing at", not yet a
            // committed part of the tab row.
            data-preview={group.preview === view.id || undefined}
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

      {overflow.right && (
        <button
          className="icon-button tabs-scroll-btn"
          data-side="right"
          aria-label="Scroll tabs right"
          onClick={() => scrollRef.current?.scrollBy({ left: TAB_SCROLL_STEP, behavior: 'smooth' })}
        >
          <ChevronRightIcon />
        </button>
      )}

      {/* Withheld for Spark exactly as in `TileActions`: it offers its own
          split and float in `.spark-window-controls` and never leaves its
          rail through this strip's buttons. */}
      {!narrow && !spark && (
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

/**
 * True for exactly the pairing that stacks by default: the navigator and
 * Places, sharing a rail with nothing else in it. A third view dragged in
 * beside them — a plugin's panel, a second copy of either — falls back to
 * tabs, because stacking only makes sense for two panels that both *want* to
 * be visible together; a heterogeneous rail can't assume that about whatever
 * else has landed in it.
 */
function stackablePair(views: ViewRef[]): boolean {
  return (
    views.length === 2 &&
    views.some((view) => view.type === PLACES_VIEW) &&
    views.some((view) => view.type === NAVIGATOR_VIEW)
  );
}

function SidebarRail({ side, onDragTab }: { side: SidebarSide; onDragTab: DragStarter }) {
  const { layout, setSidebarSize, titleOf, setSidebarActive, moveView, classic } = useWindows();
  const sidebar = layout.sidebars[side];
  if (!sidebar.open || sidebar.views.length === 0) return null;

  const active = sidebar.views[sidebar.active];
  const vertical = side !== 'bottom';
  const stacked = stackablePair(sidebar.views);

  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const start = sidebar.size;
    // A rail may be dragged well past half the workbench — Spark's own
    // transcript is exactly the panel that benefits from more room — but it
    // still has to leave *something* of the tile area, so the cap is a
    // fraction of the viewport rather than the flat 720px ceiling `model.ts`
    // enforces as a sanity bound. Read at drag start, not on every move: the
    // viewport does not change mid-drag, and `model.ts` stays free of DOM
    // access this way.
    const max = 0.85 * (vertical ? window.innerWidth : window.innerHeight);
    startPointerDrag(event, {
      onMove: (_native, delta) => {
        const change = side === 'left' ? delta.dx : side === 'right' ? -delta.dx : -delta.dy;
        setSidebarSize(side, Math.min(start + change, max));
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
      {stacked ? (
        <SidebarStack views={sidebar.views} onDragTab={onDragTab} />
      ) : (
        <>
          {sidebar.views.length > 1 && (
            <div className="sidebar-tabs" role="tablist">
              {sidebar.views.map((view, index) => (
                <button
                  key={view.id}
                  className="sidebar-tab"
                  data-window-tab=""
                  role="tab"
                  aria-selected={index === sidebar.active}
                  // A rail's tabs are tabs, and everything else in the app that
                  // looks like a tab can be dragged somewhere else. Without this the
                  // only way a panel could leave its rail was the float button, so
                  // "put the navigator beside my note" was two moves and a window in
                  // between.
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    setSidebarActive(side, index);
                    const box = event.currentTarget.getBoundingClientRect();
                    onDragTab(event, view.id, {
                      offset: { x: event.clientX - box.left, y: event.clientY - box.top },
                    });
                  }}
                >
                  {titleOf(view)}
                </button>
              ))}
            </div>
          )}

          <div className="sidebar-body">{active && <ViewHost view={active} />}</div>

          {/* Spark carries its own window controls — grip, split, float and
              close — in `.spark-window-controls`, in the chat area below its
              header, and its header is itself a drag handle. A hover overlay
              sitting over that header is not just redundant, it is opaque to
              clicks even at rest: `opacity: 0` does not stop it from
              intercepting the pointer, so Spark's own buttons underneath this
              corner were unreachable until you found the exact pixel that
              reveals it.

              Close is withheld here entirely, for every panel, not only Spark:
              a rail is where you keep a panel open, and the corner's one job is
              floating it out — hiding it is what the header toggle and the
              window's own close are for once it has somewhere else to be. */}
          {active && !isSparkView(active) && !classic && (
            <div className="sidebar-actions">
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
            </div>
          )}
        </>
      )}

      <div className="sidebar-resize" data-side={side} onPointerDown={startResize} />
    </aside>
  );
}

/** Below this many pixels, dragging the seam collapses the panel it's closing in on, rather than leaving a sliver. */
const SEAM_COLLAPSE_MARGIN = 40;
const SEAM_MIN_HEIGHT = 80;
const PLACES_HEIGHT_DEFAULT = 220;

/**
 * The navigator and Places, stacked rather than tabbed.
 *
 * They used to be one panel with a draggable seam, then two tabs sharing a
 * rail where only one showed at a time — a click away from the thing you
 * actually wanted was the cost of splitting them apart. Stacking gets both
 * back on screen at once while keeping them exactly as separate as they were
 * as tabs: each is still its own view, found by `locate()` the same way,
 * closable and floatable on its own, and draggable out of the rail by its own
 * header — nothing here merges them, it only changes how they're laid out
 * while they happen to share a rail.
 *
 * Places goes on top; the navigator takes whatever is left. The seam between
 * them is dragged the same way a split divider is, and `nav.placesHeight`,
 * dead since the panels became peers, is what it now writes to — reviving the
 * one setting the split-up deliberately orphaned, because the split-up never
 * argued the seam itself was wrong, only that *the rail* deciding how much
 * room the journal got was. A person dragging their own seam is not that.
 * Dragged into either panel's own header, it collapses that panel to just its
 * title bar instead of leaving a sliver too thin to read — the same state a
 * click on the title reaches in classic mode, where there is nowhere to drag
 * a panel *to* and the press is free to mean something else.
 */
function SidebarStack({ views, onDragTab }: { views: ViewRef[]; onDragTab: DragStarter }) {
  const { titleOf, moveView, classic } = useWindows();
  const ordered = [...views].sort((a, b) => stackRank(a) - stackRank(b));
  const hostRef = useRef<HTMLDivElement>(null);

  const [placesHeight, setPlacesHeight] = usePersisted('nav.placesHeight', PLACES_HEIGHT_DEFAULT);
  const [placesCollapsed, setPlacesCollapsed] = usePersisted('sidebar.collapsed.places', false);
  const [navCollapsed, setNavCollapsed] = usePersisted('sidebar.collapsed.navigator', false);

  const collapsedOf = (view: ViewRef) => (view.type === PLACES_VIEW ? placesCollapsed : navCollapsed);
  const toggleCollapsed = (view: ViewRef) => {
    if (view.type === PLACES_VIEW) setPlacesCollapsed(!placesCollapsed);
    else setNavCollapsed(!navCollapsed);
  };

  const startSeamDrag = (event: React.PointerEvent) => {
    event.preventDefault();
    const host = hostRef.current;
    if (!host) return;
    const total = host.getBoundingClientRect().height;
    const start = placesHeight;

    startPointerDrag(event, {
      onMove: (_native, delta) => {
        const next = start + delta.dy;
        if (next < SEAM_COLLAPSE_MARGIN) {
          setPlacesCollapsed(true);
          setNavCollapsed(false);
          return;
        }
        if (next > total - SEAM_COLLAPSE_MARGIN) {
          setNavCollapsed(true);
          setPlacesCollapsed(false);
          return;
        }
        setPlacesCollapsed(false);
        setNavCollapsed(false);
        setPlacesHeight(Math.min(Math.max(next, SEAM_MIN_HEIGHT), Math.max(total - SEAM_MIN_HEIGHT, SEAM_MIN_HEIGHT)));
      },
    });
  };

  const [places, navigatorView] = ordered;

  const item = (view: ViewRef, style: React.CSSProperties) => {
    const collapsed = collapsedOf(view);
    return (
      <div
        key={view.id}
        className="sidebar-stack-item"
        data-view={view.type === PLACES_VIEW ? 'places' : 'navigator'}
        data-collapsed={collapsed || undefined}
        style={style}
      >
        <div
          className="sidebar-stack-head"
          title={classic ? undefined : `Move ${titleOf(view)}`}
          // The whole bar is the handle in the ordinary workbench — the tab
          // strip this replaces was too, one row up — so a press anywhere on
          // it starts a drag, except on the buttons it carries. Classic mode
          // has nowhere to drag a panel *to* (no windows, no splits, no other
          // rail to reach), so the same press collapses the panel instead of
          // doing nothing.
          onPointerDown={(event) => {
            if (event.button !== 0 || classic) return;
            const box = event.currentTarget.getBoundingClientRect();
            onDragTab(event, view.id, {
              offset: { x: event.clientX - box.left, y: event.clientY - box.top },
            });
          }}
          onClick={() => classic && toggleCollapsed(view)}
        >
          <span className="sidebar-stack-title">{titleOf(view)}</span>
          {/* Close is withheld here too — see the unstacked rail's own
              `.sidebar-actions` for why: the window button is the way out of
              the rail, and it is enough on its own. */}
          {!classic && (
            <button
              className="icon-button"
              aria-label={`Float ${titleOf(view)}`}
              title="Float this panel"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() =>
                moveView(view.id, {
                  kind: 'window',
                  rect: fitWindow({ x: 32, y: 0, width: 380, height: 620 }),
                })
              }
            >
              <FloatIcon />
            </button>
          )}
        </div>
        {!collapsed && (
          <div className="sidebar-stack-body">
            <ViewHost view={view} />
          </div>
        )}
      </div>
    );
  };

  // A panel that has given way to its neighbour's collapse takes whatever is
  // left; a collapsed one shrinks to its own header; the ordinary case is
  // Places at its dragged height and the navigator filling the rest.
  const placesStyle: React.CSSProperties = placesCollapsed
    ? { flex: 'none' }
    : navCollapsed
      ? { flex: 1, minHeight: 0 }
      : { flex: 'none', height: `${placesHeight}px` };
  const navigatorStyle: React.CSSProperties = navCollapsed ? { flex: 'none' } : { flex: 1, minHeight: 0 };

  return (
    <div className="sidebar-stack" ref={hostRef}>
      {item(places, placesStyle)}

      {!placesCollapsed && !navCollapsed && (
        <div
          className="sidebar-stack-seam"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize Places"
          onPointerDown={startSeamDrag}
        />
      )}

      {item(navigatorView, navigatorStyle)}
    </div>
  );
}

/** Places first, then the navigator — see `SidebarStack`'s docstring. */
function stackRank(view: ViewRef): number {
  return view.type === PLACES_VIEW ? 0 : 1;
}

/**
 * The navigator on a phone.
 *
 * A rail that takes a third of a small screen is not a navigator, it is an
 * obstruction — so on narrow screens the left rail becomes a drawer over the
 * content, and everything else about it stays the same.
 */
function MobileDrawer() {
  const { layout, toggleSidebar, setSidebarActive, titleOf } = useWindows();
  const sidebar = layout.sidebars.left;
  const active = sidebar.views[sidebar.active];
  if (!sidebar.open || !active) return null;

  return (
    <>
      <div className="scrim" onClick={() => toggleSidebar('left')} />
      <aside className="sidebar" data-side="left" data-drawer="true">
        {/* The rail's tabs come to the drawer too. Without them the second
            panel in the rail — Places, normally — would be unreachable on a
            phone, where there is no rail to see it in. */}
        {sidebar.views.length > 1 && (
          <div className="sidebar-tabs" role="tablist">
            {sidebar.views.map((view, index) => (
              <button
                key={view.id}
                className="sidebar-tab"
                role="tab"
                aria-selected={index === sidebar.active}
                onClick={() => setSidebarActive('left', index)}
              >
                {titleOf(view)}
              </button>
            ))}
          </div>
        )}
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
                    reading. Sending the navigator into a tab helps nobody.
                    Spark gets the same button as everyone else now that it is
                    a window like any other — see AGENTS.md → "Spark". */}
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
