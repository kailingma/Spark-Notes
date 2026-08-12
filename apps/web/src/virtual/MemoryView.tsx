import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../app-context';
import { CloseIcon, PageIcon, SparkIcon, SyncIcon } from '../components/Icons';
import {
  memoryApi,
  type MemoryFile,
  type MemorySnapshot,
} from '../lib/spark-client';
import { useWindows } from '../windows/manager';

/**
 * What Spark knows about you.
 *
 * This screen is the reason the memory is markdown in your own space rather than
 * a private store: an assistant that learns is only worth having if you can see
 * what it has learned, disagree with a line, and delete it. So every section
 * here opens the page behind it, and every line has an X.
 *
 * It is a *window* onto four ordinary pages, not an editor for them. Editing
 * happens in the editor, because there is already an editor and it is better than
 * anything this view would grow into. What this adds is the one thing four tabs
 * cannot: all of it on one screen, in the order that answers the question.
 */
export function MemoryView() {
  const { config, preferences, toast } = useApp();
  const { openPage } = useWindows();

  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setSnapshot(await memoryApi.read());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const consolidate = async () => {
    setBusy(true);
    try {
      const report = await memoryApi.consolidate();
      toast(
        report.ran
          ? report.summary
          : `Nothing to do — ${report.skipped ?? 'the buffer is empty'}.`,
        report.ran ? 'success' : 'info',
      );
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const forget = async (kind: MemoryFile['kind'], text: string) => {
    if (kind === 'buffer') return;
    const removed = await memoryApi.forget(kind, text);
    if (removed > 0) await refresh();
  };

  const total =
    (snapshot?.essentials.bullets.length ?? 0) +
    (snapshot?.conventions.bullets.length ?? 0) +
    (snapshot?.threads.bullets.length ?? 0);

  return (
    <div className="memory">
      <header className="memory-head">
        <span className="spark-mark">
          <SparkIcon />
        </span>
        <div className="memory-title">
          <h1>Memory</h1>
          <p>
            {preferences.sparkRemembers
              ? total === 0
                ? 'Spark has not learned anything yet. It will, as you work.'
                : `${total} thing${total === 1 ? '' : 's'} Spark knows, kept as markdown in memory/.`
              : 'Remembering is switched off in Settings, so nothing new is being learned.'}
          </p>
        </div>

        <span className="header-spacer" />

        <button
          className="button button-sm"
          disabled={busy || !config.ai}
          onClick={() => void consolidate()}
        >
          <SyncIcon size={13} />
          {busy ? 'Consolidating…' : 'Consolidate now'}
        </button>
      </header>

      {snapshot === null ? (
        <p className="nav-empty">Reading memory…</p>
      ) : (
        <div className="memory-body">
          <Section
            file={snapshot.essentials}
            title="Essentials"
            blurb="Facts Spark should never have to be told twice."
            empty="Nothing yet. Tell Spark something about yourself and it will land here."
            onOpen={openPage}
            onForget={forget}
          />
          <Section
            file={snapshot.conventions}
            title="Conventions"
            blurb="How you want your space organised, and how you want Spark to behave. These read as instructions."
            empty="Nothing yet. Correct Spark once and the correction lands here."
            onOpen={openPage}
            onForget={forget}
          />
          <Section
            file={snapshot.threads}
            title="Threads"
            blurb="Open loops. They are ordinary tasks, so they also show up in Tasks — ticking one there closes it here."
            empty="Nothing outstanding."
            onOpen={openPage}
            onForget={forget}
          />

          {snapshot.buffer.bullets.length > 0 && (
            <Section
              file={snapshot.buffer}
              title="Waiting to be sorted"
              blurb={`${snapshot.buffer.bullets.length} raw observation${snapshot.buffer.bullets.length === 1 ? '' : 's'}. The next consolidation will file, merge or discard each one.`}
              empty=""
              onOpen={openPage}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Section({
  file,
  title,
  blurb,
  empty,
  onOpen,
  onForget,
}: {
  file: MemoryFile;
  title: string;
  blurb: string;
  empty: string;
  onOpen: (page: string) => void;
  onForget?: (kind: MemoryFile['kind'], text: string) => void;
}) {
  if (file.bullets.length === 0 && !empty) return null;

  return (
    <section className="memory-section">
      <header>
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label={`Open ${file.page}`}
          title={`Open ${file.page}`}
          onClick={() => onOpen(file.page)}
        >
          <PageIcon />
        </button>
      </header>
      <p className="memory-blurb">{blurb}</p>

      {file.bullets.length === 0 ? (
        <p className="nav-empty">{empty}</p>
      ) : (
        <ul className="memory-list">
          {file.bullets.map((bullet, index) => (
            <li key={index} data-done={bullet.done || undefined}>
              <span className="memory-text">{bullet.text}</span>
              {bullet.due && <span className="memory-due">due {bullet.due}</span>}
              {bullet.learned && <span className="memory-when">{bullet.learned}</span>}
              {onForget && (
                <button
                  className="icon-button"
                  aria-label={`Forget: ${bullet.text}`}
                  title="Forget this"
                  onClick={() => onForget(file.kind, bullet.text)}
                >
                  <CloseIcon />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
