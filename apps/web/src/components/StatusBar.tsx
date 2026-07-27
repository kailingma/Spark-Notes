import { useApp } from '../app-context';
import type { SaveState } from './Editor';

interface StatusBarProps {
  saveState: SaveState;
  words: number;
  onOpenSync: () => void;
}

/**
 * A single quiet line at the bottom.
 *
 * Everything here is status, not control: whether your work is saved, how much
 * of it there is, and which mode sync is in. Anything that needs a decision
 * lives in a dialog instead.
 */
export function StatusBar({ saveState, words, onOpenSync }: StatusBarProps) {
  const { sync, config, route } = useApp();

  return (
    <div className="statusbar">
      <span>{SAVE_LABEL[saveState]}</span>

      {route.kind !== 'tasks' && (
        <span>
          {words.toLocaleString()} word{words === 1 ? '' : 's'}
        </span>
      )}

      <span className="statusbar-spacer" />

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
