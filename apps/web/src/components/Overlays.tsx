import { useEffect, useState } from 'react';
import { useApp } from '../app-context';

/** Transient messages. Errors linger; everything else gets out of the way. */
export function Toasts() {
  const { toasts, dismissToast } = useApp();
  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="toast"
          data-kind={toast.kind}
          onClick={() => dismissToast(toast.id)}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}

/**
 * The modal behind `spark.ui.prompt()` and `spark.ui.select()`.
 *
 * Plugins get a real dialog instead of `window.prompt`, which is blocking,
 * unstyleable, and silently disabled in some browsers.
 */
export function Dialogs() {
  const { dialog, resolveDialog } = useApp();
  const [value, setValue] = useState('');

  useEffect(() => {
    setValue(dialog?.kind === 'prompt' ? dialog.initial : '');
  }, [dialog]);

  if (!dialog) return null;

  return (
    <div className="overlay" onMouseDown={() => resolveDialog(null)}>
      <div
        className="dialog"
        role="dialog"
        aria-label={dialog.message}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2>{dialog.message}</h2>

        {dialog.kind === 'prompt' ? (
          <>
            <input
              className="field"
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') resolveDialog(value);
                if (event.key === 'Escape') resolveDialog(null);
              }}
              aria-label={dialog.message}
            />
            <div className="dialog-actions">
              <button className="button" data-variant="ghost" onClick={() => resolveDialog(null)}>
                Cancel
              </button>
              <button
                className="button"
                data-variant="primary"
                onClick={() => resolveDialog(value)}
              >
                OK
              </button>
            </div>
          </>
        ) : (
          <ul className="palette-list">
            {dialog.options.map((option) => (
              <li key={option}>
                <button className="palette-item" onClick={() => resolveDialog(option)}>
                  {option}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
