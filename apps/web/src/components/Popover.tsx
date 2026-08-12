import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Popovers: the small things that appear beside something rather than over
 * everything.
 *
 * A dialog is a question that stops you (`ActionDialog`); a modal is a place the
 * layout owns (`FloatingWindow`). This is the third thing, and it had been
 * hand-rolled twice before it was worth naming: a panel tethered to a *point* —
 * a button, a row, the caret — that is dismissed by looking away from it. An
 * emoji grid at the cursor, a date picker under a field, a context menu at the
 * pointer and the reading-time readout hanging off the word count are all the
 * same object with different contents.
 *
 * Three decisions make it robust rather than merely present:
 *
 * - **The anchor is a function, not a rectangle.** A popup tethered to a
 *   rectangle measured once is wrong the moment the thing under it scrolls, and
 *   an editor caret moves without anything scrolling at all. Re-reading the
 *   anchor on scroll and resize is also what lets a popup *close itself* when
 *   its anchor goes away: `null` means the row was deleted or the tab was
 *   switched, and a popup pointing at nothing is worse than no popup.
 * - **Placement is measured, then flipped, then clamped.** A caret near the
 *   bottom of the screen wants its picker above it, and near the right edge it
 *   wants to slide left rather than hang off. Deciding from the real size means
 *   the same call site works for a two-row menu and a twelve-row grid.
 * - **They stack.** A menu opening a submenu, or a picker opening from inside a
 *   popover, is one gesture continuing — so an outside click closes everything
 *   the pointer was not inside, and Escape closes one layer at a time.
 */

/** A rectangle in viewport coordinates: what a popup positions itself against. */
export interface AnchorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where the popup prefers to sit relative to its anchor, before flipping. */
export type PopoverSide = 'below' | 'above' | 'before' | 'after';

/** How it lines up along the anchor's other axis. */
export type PopoverAlign = 'start' | 'center' | 'end';

export interface PopoverOptions {
  /**
   * The anchor, re-read on every scroll and resize. Return `null` once the
   * thing it points at is gone; the popup closes rather than floating free.
   */
  anchor: () => AnchorRect | null;
  render: (api: { close: () => void }) => ReactNode;
  /** Accessible name. Popups are labelled, never anonymous. */
  label: string;
  side?: PopoverSide;
  align?: PopoverAlign;
  /** `menu` for a list of actions, `dialog` for anything with fields in it. */
  role?: 'menu' | 'dialog';
  /** Extra class on the frame, for contents that want their own padding. */
  className?: string;
  /** Runs after it closes, however it closed. */
  onClose?: () => void;
}

interface PopoverEntry extends PopoverOptions {
  id: number;
}

interface PopoverApi {
  /** Opens one, and returns the function that closes that one. */
  open: (options: PopoverOptions) => () => void;
  /** Closes every open popup. Used when something bigger takes over. */
  closeAll: () => void;
}

const PopoverContext = createContext<PopoverApi | null>(null);

export function usePopover(): PopoverApi {
  const value = useContext(PopoverContext);
  if (!value) throw new Error('usePopover must be used inside <PopoverProvider>');
  return value;
}

let nextPopoverId = 0;

export function PopoverProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<PopoverEntry[]>([]);

  // Read by the dismissal listeners, which are registered once and must not see
  // a stack from three renders ago.
  const stackRef = useRef(stack);
  stackRef.current = stack;

  const close = useCallback((id: number) => {
    setStack((current) => {
      const entry = current.find((item) => item.id === id);
      if (!entry) return current;
      // The callback runs outside the updater: React invokes updaters more than
      // once, and a side effect in here would fire twice. See AGENTS → Traps.
      queueMicrotask(() => entry.onClose?.());
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const open = useCallback(
    (options: PopoverOptions) => {
      const id = ++nextPopoverId;
      setStack((current) => [...current, { ...options, id }]);
      return () => close(id);
    },
    [close],
  );

  const closeAll = useCallback(() => {
    setStack((current) => {
      for (const entry of current) queueMicrotask(() => entry.onClose?.());
      return current.length === 0 ? current : [];
    });
  }, []);

  /**
   * Looking away dismisses.
   *
   * Every layer whose own element did not contain the press goes, which is what
   * makes a menu-inside-a-menu behave: clicking the parent closes the child and
   * keeps the parent, and clicking the page closes both. The listener is on the
   * capture phase so a control that stops propagation cannot leave a popup
   * stranded open.
   */
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      const survivors = stackRef.current.filter((entry) => {
        const el = document.querySelector(`[data-popover-id="${entry.id}"]`);
        return el?.contains(target) ?? false;
      });
      if (survivors.length === stackRef.current.length) return;
      for (const entry of stackRef.current) {
        if (!survivors.includes(entry)) close(entry.id);
      }
    };

    // Escape closes one layer, so backing out of a submenu does not also throw
    // away the menu you opened it from.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const top = stackRef.current[stackRef.current.length - 1];
      if (!top) return;
      event.preventDefault();
      event.stopPropagation();
      close(top.id);
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [close]);

  const api = useMemo<PopoverApi>(() => ({ open, closeAll }), [open, closeAll]);

  return (
    <PopoverContext.Provider value={api}>
      {children}
      {stack.map((entry) => (
        <PopoverFrame key={entry.id} entry={entry} onClose={() => close(entry.id)} />
      ))}
    </PopoverContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// One popup
// ---------------------------------------------------------------------------

/** Distance from the anchor, and from the edge of the screen. */
const GAP = 6;
const MARGIN = 8;

function PopoverFrame({ entry, onClose }: { entry: PopoverEntry; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const side = entry.side ?? 'below';
  const align = entry.align ?? 'start';

  const reposition = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    const anchor = entry.anchor();
    if (!anchor) {
      onClose();
      return;
    }

    const box = el.getBoundingClientRect();
    setPosition(place(anchor, { width: box.width, height: box.height }, side, align));
  }, [entry, side, align, onClose]);

  // Before the browser paints, so nothing is ever seen in the wrong place. The
  // frame renders hidden until it has a position, because measuring it requires
  // it to be in the document and one frame at (0, 0) reads as a glitch.
  useLayoutEffect(() => {
    reposition();
  }, [reposition]);

  useEffect(() => {
    // Capture-phase scroll: a tile's own scroller does not bubble its events,
    // and the anchor is usually inside one.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [reposition]);

  // Everything inside is reachable by keyboard, which means the popup has to
  // take focus when it opens and hand it back when it goes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusable = el?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? el)?.focus({ preventScroll: true });
    return () => previous?.focus?.({ preventScroll: true });
  }, []);

  return (
    <div
      className={entry.className ? `popover ${entry.className}` : 'popover'}
      data-popover-id={entry.id}
      data-placed={position !== null || undefined}
      role={entry.role ?? 'dialog'}
      aria-label={entry.label}
      tabIndex={-1}
      ref={ref}
      // A measured position, which is the same category of inline style as a
      // dragged window rectangle: a number no class can carry. See AGENTS →
      // Conventions.
      style={position ? { left: `${position.left}px`, top: `${position.top}px` } : undefined}
    >
      {entry.render({ close: onClose })}
    </div>
  );
}

/**
 * Preferred side, then the opposite, then whatever fits — and clamped either
 * way, because a popup that is partly off screen is a popup with a button you
 * cannot press.
 */
function place(
  anchor: AnchorRect,
  size: { width: number; height: number },
  side: PopoverSide,
  align: PopoverAlign,
): { left: number; top: number } {
  const view = { width: window.innerWidth, height: window.innerHeight };
  const order: PopoverSide[] = [side, opposite(side), ...OTHER_SIDES[side]];

  for (const candidate of order) {
    const at = offsetFor(anchor, size, candidate, align);
    if (fits(at, size, view)) return at;
  }

  return clamp(offsetFor(anchor, size, side, align), size, view);
}

const OTHER_SIDES: Record<PopoverSide, PopoverSide[]> = {
  below: ['after', 'before'],
  above: ['after', 'before'],
  before: ['below', 'above'],
  after: ['below', 'above'],
};

function opposite(side: PopoverSide): PopoverSide {
  switch (side) {
    case 'below':
      return 'above';
    case 'above':
      return 'below';
    case 'before':
      return 'after';
    case 'after':
      return 'before';
  }
}

function offsetFor(
  anchor: AnchorRect,
  size: { width: number; height: number },
  side: PopoverSide,
  align: PopoverAlign,
): { left: number; top: number } {
  const alongX = alignedStart(anchor.x, anchor.width, size.width, align);
  const alongY = alignedStart(anchor.y, anchor.height, size.height, align);

  switch (side) {
    case 'below':
      return { left: alongX, top: anchor.y + anchor.height + GAP };
    case 'above':
      return { left: alongX, top: anchor.y - GAP - size.height };
    case 'after':
      return { left: anchor.x + anchor.width + GAP, top: alongY };
    case 'before':
      return { left: anchor.x - GAP - size.width, top: alongY };
  }
}

function alignedStart(start: number, extent: number, size: number, align: PopoverAlign): number {
  if (align === 'center') return start + extent / 2 - size / 2;
  if (align === 'end') return start + extent - size;
  return start;
}

function fits(
  at: { left: number; top: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
): boolean {
  return (
    at.left >= MARGIN &&
    at.top >= MARGIN &&
    at.left + size.width <= view.width - MARGIN &&
    at.top + size.height <= view.height - MARGIN
  );
}

function clamp(
  at: { left: number; top: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number } {
  return {
    left: Math.max(MARGIN, Math.min(at.left, view.width - size.width - MARGIN)),
    top: Math.max(MARGIN, Math.min(at.top, view.height - size.height - MARGIN)),
  };
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/**
 * An element, re-measured every time.
 *
 * Held as the element rather than its rectangle so a row that moves — because
 * the list above it grew, or the rail was resized — keeps its popup attached.
 */
export function anchorElement(el: HTMLElement | null): () => AnchorRect | null {
  return () => {
    if (!el || !el.isConnected) return null;
    const box = el.getBoundingClientRect();
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  };
}

/**
 * The pointer, as a zero-sized rectangle. What a context menu wants: it belongs
 * where you pressed, not to the row as a whole.
 */
export function anchorPoint(x: number, y: number): () => AnchorRect | null {
  return () => ({ x, y, width: 0, height: 0 });
}

// ---------------------------------------------------------------------------
// A menu, since most popovers are one
// ---------------------------------------------------------------------------

export type MenuEntry =
  | { kind: 'separator'; id: string }
  | {
      kind?: 'item';
      id: string;
      label: string;
      icon?: ReactNode;
      hint?: string;
      disabled?: boolean;
      /** Destructive actions are coloured and sit at the bottom. */
      danger?: boolean;
      run: () => void | Promise<void>;
    };

/**
 * The contents of an actions popup.
 *
 * Arrow keys move, Enter runs, and running always closes — a menu that stays
 * open after a choice is a panel, and a panel should not have been a menu.
 */
export function PopoverMenu({
  entries,
  close,
}: {
  entries: MenuEntry[];
  close: () => void;
}) {
  const items = entries.filter((entry) => entry.kind !== 'separator');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const run = (entry: Extract<MenuEntry, { kind?: 'item' }>) => {
    if (entry.disabled) return;
    close();
    void Promise.resolve(entry.run()).catch((err: unknown) => {
      console.error('[spark] menu action failed', err);
    });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (items.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((n) => (n + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((n) => (n - 1 + items.length) % items.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = items[active];
      if (entry) run(entry);
    }
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({
      block: 'nearest',
    });
  }, [active]);

  return (
    <div className="menu" ref={listRef} onKeyDown={onKeyDown}>
      {entries.map((entry) =>
        entry.kind === 'separator' ? (
          <div className="menu-separator" key={entry.id} role="separator" />
        ) : (
          <button
            key={entry.id}
            className="menu-item"
            role="menuitem"
            data-active={items.indexOf(entry) === active || undefined}
            data-danger={entry.danger || undefined}
            disabled={entry.disabled}
            onPointerEnter={() => setActive(items.indexOf(entry))}
            onClick={() => run(entry)}
          >
            {entry.icon && <span className="menu-item-icon">{entry.icon}</span>}
            <span className="menu-item-label">{entry.label}</span>
            {entry.hint && <span className="menu-item-hint">{entry.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
