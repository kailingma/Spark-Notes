import { useCallback, useState, type ReactNode } from 'react';
import { pageBasename } from '@spark/core';
import { useApp } from '../app-context';
import { ChevronIcon } from '../components/Icons';

/**
 * The pieces the navigator and Places both use.
 *
 * They were one component until Places became a panel of its own, and the
 * collapsible section is the part that genuinely belongs to both — a rail full
 * of headings that open and close is the shape, whichever panel it is in.
 */

export function Section({
  id,
  title,
  children,
  action,
  defaultOpen = true,
  grow = false,
}: {
  id: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
  defaultOpen?: boolean;
  grow?: boolean;
}) {
  const [open, setOpen] = usePersisted(`nav.section.${id}`, defaultOpen);

  return (
    <section className="nav-section" data-open={open || undefined} data-grow={grow || undefined}>
      <div className="nav-section-head">
        <button className="nav-section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="nav-row-twisty">
            <ChevronIcon />
          </span>
          {title}
        </button>
        {open && action}
      </div>
      {open && <div className="nav-section-body">{children}</div>}
    </section>
  );
}

/** Component state that outlives the session, without a store per preference. */
export function usePersisted<T>(key: string, fallback: T): [T, (value: T) => void] {
  const { workspace } = useApp();
  const [value, setValue] = useState<T>(() => workspace.settings.get<T>(key, fallback));

  const update = useCallback(
    (next: T) => {
      setValue(next);
      workspace.settings.set(key, next);
    },
    [workspace, key],
  );

  return [value, update];
}

/**
 * `journal/2026-07-28` reads as a date, not as a filename.
 *
 * Matched on the leaf being a bare date rather than on the folder being
 * literally named `journal` — the folder is a setting (`lib/dirs.ts`), and a
 * page whose last segment is a date is what a daily page *is*, whatever its
 * folder happens to be called this week.
 */
export function journalLabel(name: string): string {
  const match = /\/?(\d{4})-(\d{2})-(\d{2})$/.exec(name);
  if (!match) return pageBasename(name);

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'Today';

  const yesterday = new Date(today.getTime() - 86_400_000);
  if (sameDay(date, yesterday)) return 'Yesterday';

  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
