import { useEffect, useState } from 'react';
import { useApp } from '../app-context';
import { ActionDialog } from './ActionDialog';

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
 * The action dialogs behind `spark.ui.prompt()` and `spark.ui.select()`.
 *
 * Plugins get a real dialog instead of `window.prompt`, which is blocking,
 * unstyleable, and silently disabled in some browsers. Both are *questions*
 * raised by something you did, not places you went — see `ActionDialog`, which
 * owns everything they have in common with the sync panel.
 */
export function Dialogs() {
  const { dialog, resolveDialog } = useApp();
  const [value, setValue] = useState('');

  useEffect(() => {
    setValue(dialog?.kind === 'prompt' ? dialog.initial : '');
  }, [dialog]);

  if (!dialog) return null;

  if (dialog.kind === 'select') {
    return (
      <ActionDialog title={dialog.message} onClose={() => resolveDialog(null)}>
        <ul className="palette-list">
          {dialog.options.map((option) => (
            <li key={option}>
              <button className="palette-item" onClick={() => resolveDialog(option)}>
                {option}
              </button>
            </li>
          ))}
        </ul>
      </ActionDialog>
    );
  }

  return (
    <ActionDialog
      title={dialog.message}
      onClose={() => resolveDialog(null)}
      actions={
        <>
          <button className="button" data-variant="ghost" onClick={() => resolveDialog(null)}>
            Cancel
          </button>
          <button className="button" data-variant="primary" onClick={() => resolveDialog(value)}>
            OK
          </button>
        </>
      }
    >
      <input
        className="field"
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') resolveDialog(value);
        }}
        aria-label={dialog.message}
      />
    </ActionDialog>
  );
}
