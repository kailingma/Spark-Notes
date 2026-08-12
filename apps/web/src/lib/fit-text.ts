import { useEffect, useState, type RefObject } from 'react';

/**
 * The longest of several phrasings that fits on one line.
 *
 * Placeholder text is the one string in a UI whose container width is unknown
 * when it is written. Spark's panel is a rail you drag, a tile you split, or a
 * phone, and "Ask about your notes, or ask for a change" wraps to two lines in
 * the first of those — which pushes the composer taller, shifts the whole
 * transcript, and reads as a bug rather than as a hint.
 *
 * Ellipsis is not the answer either. A placeholder is read once, and
 * "Ask about your notes, or ask f…" is worse than a shorter sentence that is
 * whole. So the caller supplies the same invitation at several lengths, longest
 * first, and this picks the longest one that actually fits.
 *
 * Measured with a canvas rather than by rendering and reading a width back. A
 * hidden probe element costs a layout per candidate per resize and can inherit
 * the wrong font from wherever it is mounted; `measureText` against the
 * element's own computed font is one call and cannot be wrong about the face.
 */
export function useFittedText(
  ref: RefObject<HTMLElement | null>,
  candidates: string[],
  /** Space taken by anything else drawn inside the box, in pixels. */
  reserve = 0,
): string {
  const [fitted, setFitted] = useState(() => candidates[candidates.length - 1] ?? '');

  // Callers rebuild the array on every render, so the effect keys on the
  // content rather than on the identity, or this would remeasure forever. The
  // separator is a newline because a placeholder cannot contain one; a space
  // would split every candidate into its own words.
  const key = candidates.join('\n');

  useEffect(() => {
    const el = ref.current;
    const options = key.split('\n').filter(Boolean);
    if (!el || options.length === 0) return;

    const measure = () => {
      const style = window.getComputedStyle(el);
      const context = scratch().getContext('2d');
      if (!context) {
        setFitted(options[options.length - 1]);
        return;
      }
      context.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily]
        .filter(Boolean)
        .join(' ');

      const available =
        el.clientWidth -
        parseFloat(style.paddingLeft || '0') -
        parseFloat(style.paddingRight || '0') -
        reserve;

      // Longest first, so the first that fits is the best that fits. The last is
      // the floor: if even that overflows there is nothing better to say, and an
      // empty placeholder is worse than one that clips.
      const found = options.find((text) => context.measureText(text).width <= available);
      setFitted(found ?? options[options.length - 1]);
    };

    measure();

    // The panel is resized by dragging its edge, so this is not a window-resize
    // question and a `window` listener would miss most of it.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // Fonts land after first paint, and every measurement taken before they do
    // is against the fallback face.
    void document.fonts?.ready.then(measure).catch(() => {});

    return () => observer.disconnect();
  }, [ref, key, reserve]);

  return fitted;
}

/** One canvas for the life of the page; making one per measurement is a leak. */
let shared: HTMLCanvasElement | null = null;

function scratch(): HTMLCanvasElement {
  return (shared ??= document.createElement('canvas'));
}
