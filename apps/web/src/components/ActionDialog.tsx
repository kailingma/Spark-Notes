import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A dialog raised by an action — as opposed to a modal *view*.
 *
 * The two look similar and are not the same thing, and confusing them is how a
 * settings panel ends up with a Cancel button or a confirmation prompt ends up
 * bookmarkable. The distinction, kept here so it stays a distinction:
 *
 * | | **modal** (`Settings`) | **dialog** (this) |
 * | --- | --- | --- |
 * | What it is | a view on the `modal` surface | a response to something you did |
 * | Who owns it | the workbench layout | the component that raised it |
 * | Has a page name | yes — `[[Settings]]`, bookmarkable | no |
 * | Lives across | the whole session, until dismissed | the one action, then gone |
 * | Ends with | a close button; changes already applied | a decision, taken or cancelled |
 * | Where it renders | `Workbench.tsx`, from `layout.windows` | here, at the top of the app |
 *
 * So a modal is a *place* — somewhere you went, which hands your place back —
 * and a dialog is a *question*. Sync setup, `spark.ui.prompt()` and
 * `spark.ui.select()` are questions. Settings is a place.
 *
 * Everything shared by every question lives here: the scrim, dismissal on
 * Escape and on a click outside, focus moving into the dialog when it opens and
 * being trapped there while it is up, and the row of actions along the bottom.
 */
export function ActionDialog({
  title,
  onClose,
  children,
  actions,
  labelledBy,
}: {
  title: string;
  /** Cancelling. Called by Escape, by the scrim, and by the close control. */
  onClose: () => void;
  children?: ReactNode;
  /** The decision, as buttons. Least destructive first, primary last. */
  actions?: ReactNode;
  /** Set when the heading is rendered by the caller rather than from `title`. */
  labelledBy?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    // The thing that had focus is almost always what raised this, and it should
    // get it back — otherwise dismissing a dialog drops the caret into nothing.
    const returnTo = document.activeElement as HTMLElement | null;
    focusables(dialog)[0]?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      // A dialog that lets Tab wander out is a dialog you can type behind.
      if (event.key !== 'Tab') return;
      const stops = focusables(dialog);
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      returnTo?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="overlay" data-dialog="action" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        ref={dialogRef}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {!labelledBy && <h2>{title}</h2>}
        {children}
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}
