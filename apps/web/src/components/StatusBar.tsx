import { useRef } from 'react';
import type { SparkEditor } from '@spark/editor';
import { useApp } from '../app-context';
import { useWindows } from '../windows/manager';
import { anchorElement, usePopover } from './Popover';
import { DocumentStatsPanel, measureText } from './pickers';
import type { SaveState } from './Editor';

interface StatusBarProps {
  onOpenSync: () => void;
}

/**
 * A single quiet line at the bottom.
 *
 * Almost everything here is status, not control: whether your work is saved,
 * how much of it there is, and which mode sync is in. Anything that needs a
 * decision lives in a dialog instead.
 *
 * The word count is the one exception, and it earns it by being the only number
 * on screen that has five more behind it. Pressing it opens the rest — reading
 * time, characters, sentences, paragraphs — beside the number itself rather
 * than in a panel somewhere else, which is what the popover system exists for.
 *
 * The readings **persist across views**. Moving from a note to Tasks, to
 * Settings, to a Spark chat used to blank them, so the count you were watching
 * disappeared exactly when you looked away from the note in order to check
 * something about it. They stay, dimmed, and say which page they are about. The
 * save state is the one thing genuinely dropped when focus leaves a document:
 * "Saved" beside a page you are not looking at is not a reassurance.
 */
export function StatusBar({ onOpenSync }: StatusBarProps) {
  const { sync, config } = useApp();
  // The focused tile speaks for the bar. Which one that is belongs to the
  // workbench, so the bar asks rather than being told by a parent that would
  // have to track it too.
  const { status, layout, activeEditor } = useWindows();
  const { saveState, words, stale, page } = status;
  const popover = usePopover();
  const countRef = useRef<HTMLButtonElement>(null);

  const openWindows = layout.windows.filter((entry) => entry.surface === 'window').length;

  /**
   * The document is read here, when you ask, rather than carried in the status.
   *
   * Putting the text in shared state meant copying the whole note into React on
   * every keystroke — and an effect that fires on every commit is how React's
   * nested-update guard gets tripped. The bar needs one number; the other five
   * are one method call away at the moment they are wanted.
   */
  const showStats = () => {
    if (page === null) return;
    const text = readText(activeEditor);
    popover.open({
      label: `Statistics for ${page}`,
      side: 'above',
      align: 'start',
      anchor: anchorElement(countRef.current),
      render: () => <DocumentStatsPanel page={page} stats={measureText(text)} />,
    });
  };

  return (
    <div className="statusbar">
      {!stale && <span>{SAVE_LABEL[saveState]}</span>}

      {page !== null && (
        <button
          ref={countRef}
          className="statusbar-count"
          data-stale={stale || undefined}
          title={
            stale
              ? `${words.toLocaleString()} words in ${page} — the last page you were reading`
              : 'Reading time, characters, sentences'
          }
          onClick={showStats}
        >
          {words.toLocaleString()} word{words === 1 ? '' : 's'}
        </button>
      )}

      <span className="statusbar-spacer" />

      {/* Only the `window` surface is counted. A modal is not an arrangement
          you might forget you left open — it is in front of you, and it is
          going away. */}
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

/**
 * The last focused editor's text.
 *
 * Guarded because the editor the readings describe can have been torn down
 * since — closing the tab a stale count came from is an ordinary thing to do,
 * and an empty panel is a better answer than a thrown error in the status bar.
 */
function readText(editor: SparkEditor | null): string {
  try {
    return editor?.text() ?? '';
  } catch {
    return '';
  }
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
