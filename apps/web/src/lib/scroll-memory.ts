import { useCallback, useEffect, useRef } from 'react';

/**
 * Keeping your place.
 *
 * Switching tabs already kept it, because an inactive tab stays mounted. Nothing
 * else did: dragging a note into a split, floating it, sending it back to a
 * tile, or opening a different page and coming back all tore the scroller down
 * and rebuilt it at the top. Losing your place in a long note is a small thing
 * that happens constantly, and "I was three screens down" is not something the
 * DOM remembers for you.
 *
 * Two decisions:
 *
 * - **Keyed by what is being read, not by which box is reading it.** A view
 *   instance is destroyed by the very move this exists to survive, so the key
 *   is the page (or the view type, for a panel). That also means the same note
 *   opened in a second tile starts where you left it, which is what you want:
 *   you are returning to the note, not to the tile.
 * - **In memory, not in `localStorage`.** A scroll offset is a fact about this
 *   session, like the layout is — see AGENTS, "The layout is not restored". It
 *   is also measured in pixels against a font size and a window width that a
 *   reload is free to change.
 */

const positions = new Map<string, number>();

/** Bounded so a long session over hundreds of notes cannot grow without limit. */
const LIMIT = 200;

export function rememberScroll(key: string, offset: number): void {
  // Re-inserting moves the key to the end of the iteration order, which makes
  // the eviction below least-recently-used rather than arbitrary.
  positions.delete(key);
  positions.set(key, offset);
  if (positions.size > LIMIT) {
    const oldest = positions.keys().next();
    if (!oldest.done) positions.delete(oldest.value);
  }
}

export function recallScroll(key: string): number {
  return positions.get(key) ?? 0;
}

export function forgetScroll(key: string): void {
  positions.delete(key);
}

/**
 * Attaches the memory to a scroller.
 *
 * Returns the ref to put on the scrolling element. Restoration is deferred to
 * an animation frame because the content is not there yet on the first paint —
 * an editor is loaded asynchronously and a virtual view fetches — so setting
 * `scrollTop` immediately sets it against a box with no height, which silently
 * clamps to zero.
 */
export function useScrollMemory<T extends HTMLElement>(key: string | null) {
  const ref = useRef<T>(null);

  // Read by the cleanup, which must save the position for the key that was in
  // effect while it was scrolling rather than the one that replaced it.
  const keyRef = useRef(key);

  useEffect(() => {
    const el = ref.current;
    const previous = keyRef.current;
    keyRef.current = key;

    // Changing page inside a live scroller: the outgoing page's offset would
    // otherwise be lost, because the cleanup below only runs on unmount.
    if (el && previous && previous !== key) rememberScroll(previous, el.scrollTop);
    if (!el || !key) return;

    const wanted = recallScroll(key);
    let frames = 0;
    let raf = 0;

    // Retried for a few frames: the target is only reachable once the content
    // has laid out, and how many frames that takes is not knowable from here.
    const restore = () => {
      if (!ref.current) return;
      ref.current.scrollTop = wanted;
      frames += 1;
      if (frames < 6 && Math.abs(ref.current.scrollTop - wanted) > 1) {
        raf = requestAnimationFrame(restore);
      }
    };
    if (wanted > 0) raf = requestAnimationFrame(restore);

    return () => {
      cancelAnimationFrame(raf);
      if (ref.current) rememberScroll(key, ref.current.scrollTop);
    };
  }, [key]);

  // Saved as it happens as well as on the way out, because a tab that is closed
  // while hidden never runs a scroll handler again.
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el && keyRef.current) rememberScroll(keyRef.current, el.scrollTop);
  }, []);

  return { ref, onScroll };
}
