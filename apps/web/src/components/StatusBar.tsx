import { useApp } from '../app-context';
import { useWindows } from '../windows/manager';
import type { SaveState } from './Editor';

interface StatusBarProps {
  /** False on virtual pages, which have nothing to save and nothing to count. */
  showDocumentState: boolean;
  onOpenSync: () => void;
}

/**
 * A single quiet line at the bottom.
 *
 * Everything here is status, not control: whether your work is saved, how much
 * of it there is, and which mode sync is in. Anything that needs a decision
 * lives in a dialog instead.
 */
export function StatusBar({ showDocumentState, onOpenSync }: StatusBarProps) {
  const { sync, config } = useApp();
  // The focused tile speaks for the bar. Which one that is belongs to the
  // workbench, so the bar asks rather than being told by a parent that would
  // have to track it too.
  const { status, layout } = useWindows();
  const { saveState, words } = status;

  // Only the `window` surface is counted. A modal is not an arrangement you
  // might forget you left open — it is in front of you, and it is going away.
  const openWindows = layout.windows.filter((entry) => entry.surface === 'window').length;

  return (
    <div className="statusbar">
      {showDocumentState && (
        <>
          <span>{SAVE_LABEL[saveState]}</span>
          <span>
            {words.toLocaleString()} word{words === 1 ? '' : 's'}
          </span>
        </>
      )}

      <span className="statusbar-spacer" />

      {openWindows > 0 && (
        <span>
          {openWindows} window{openWindows === 1 ? '' : 's'}
        </span>
      )}

      {config.user && <span>{config.user.login}</span>}

      <button onClick={onOpenSync} data-state={syncState(sync)}>
        {syncLabel(sync)}
      </button>
    </div>
  );
}

const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Saved',
  dirty: 'Editing…',
  saving: 'Saving…',
  error: 'Not saved',
};

function syncState(sync: ReturnType<typeof useApp>['sync']): string {
  if (sync.mode === 'online') return 'online';
  return sync.state;
}

function syncLabel(sync: ReturnType<typeof useApp>['sync']): string {
  if (sync.mode === 'online') return 'Online';
  switch (sync.state) {
    case 'syncing':
      return 'Syncing…';
    case 'error':
      return sync.message ? `Sync: ${sync.message}` : 'Sync error';
    default:
      return 'Sync on';
  }
}
