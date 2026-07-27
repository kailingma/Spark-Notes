import { useEffect, useState } from 'react';

/**
 * Device shape detection.
 *
 * "Mobile" here means *this session is thumb-first* rather than *this is a
 * phone*: a narrow window on a desktop with a keyboard is not the same thing as
 * a phone, and getting that wrong would put the capture prompt in front of
 * someone who just resized their browser. So the signals are combined — a
 * coarse pointer and no hover, plus a narrow viewport.
 */

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Narrow viewport — drives layout (sidebar becomes a drawer, toolbar appears). */
export function useIsNarrow(): boolean {
  return useMediaQuery('(max-width: 720px)');
}

/** Touch-first device — drives interaction (capture-first launch, larger targets). */
export function useIsTouchFirst(): boolean {
  const coarse = useMediaQuery('(pointer: coarse)');
  const noHover = useMediaQuery('(hover: none)');
  const narrow = useIsNarrow();
  return (coarse || noHover) && narrow;
}

/** True on macOS and iOS, so shortcut hints show ⌘ rather than Ctrl. */
export const isApplePlatform =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '');

export const modKey = isApplePlatform ? '⌘' : 'Ctrl';
