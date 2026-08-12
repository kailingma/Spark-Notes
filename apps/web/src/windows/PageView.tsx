import { useEffect, useMemo, useState } from 'react';
import type { SparkEditor } from '@spark/editor';
import { useApp } from '../app-context';
import { Backlinks } from '../components/Backlinks';
import { Editor, type SaveState } from '../components/Editor';
import { FindBar } from '../components/FindBar';
import { useIsTouchFirst } from '../lib/device';
import { useScrollMemory } from '../lib/scroll-memory';
import { resolveVirtualPage } from '../virtual';
import { ViewInstance } from './instance';
import { useWindows } from './manager';

/**
 * A page in a tile.
 *
 * The universal document host: a real note gets an editor, a virtual page gets
 * its view, and both get the backlinks that flow after them. Several of these
 * can be alive at once — that is the point of tiling — so everything here is
 * per-instance, and only the focused one is allowed to speak for the status bar.
 */
export function PageView({ instanceId, page }: { instanceId: string; page: string }) {
  const { workspace, preferences } = useApp();
  const { layout, setStatus, focusView, setActiveEditor, narrow, find, closeFind, promoteView } =
    useWindows();
  const touchFirst = useIsTouchFirst();

  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [words, setWords] = useState(0);
  const [backlinkRevision, setBacklinkRevision] = useState(0);
  const [editor, setEditor] = useState<SparkEditor | null>(null);

  const virtual = useMemo(() => resolveVirtualPage(page), [page]);
  const focused = layout.focusedView === instanceId;

  // Keyed by the page rather than by this instance: the instance is destroyed by
  // the very moves this survives — dragging into a split, floating, docking —
  // and what you want back is your place in the *note*. See `scroll-memory`.
  const scroll = useScrollMemory<HTMLDivElement>(page || null);

  useEffect(
    () =>
      workspace.events.on('page:save', ({ page: saved }) => {
        if (saved === page) setBacklinkRevision((revision) => revision + 1);
      }),
    [workspace, page],
  );

  // The status bar shows one document's state, and it should be the one you are
  // typing in. Reporting only while focused means an unfocused tile saving in
  // the background never overwrites what the bar says about this one.
  //
  // A virtual page reports nothing at all: it has no save state and no words,
  // and the bar keeps the last real document's readings rather than blanking —
  // `stale` is worked out by the manager from what has focus.
  //
  // Only the word count travels, not the document. Copying the whole text into
  // shared state on every keystroke made this effect fire on every commit, and
  // an effect that sets state on every commit is how React's nested-update
  // guard gets tripped. Everything else the statistics popover shows is
  // measured from the editor at the moment it is opened.
  useEffect(() => {
    if (!focused || virtual) return;
    setStatus({ page, virtual: false, saveState, words });
    setActiveEditor(editor);
  }, [focused, virtual, page, saveState, words, editor, setStatus, setActiveEditor]);

  return (
    <ViewInstance id={instanceId}>
      <div
        className="page-view"
        // Focus follows the caret, not just the tab bar: clicking into a note is
        // how you say which one you mean.
        onFocusCapture={() => focusView(instanceId)}
        // A pointer press is also what promotes a preview tab out of preview:
        // it is a real click landing on the page, never the programmatic
        // `.focus()` a freshly opened preview gets — that fires no pointer
        // event at all, so it can never be mistaken for this.
        onPointerDownCapture={() => {
          focusView(instanceId);
          promoteView(instanceId);
        }}
      >
        {/* Over the view, not over the note. It is a sibling of the scroller
            rather than a child of it, which is the whole difference between a
            find bar that stays in the corner and one that scrolls away with the
            third paragraph. */}
        {find.instanceId === instanceId && !virtual && (
          <FindBar
            editor={editor}
            nonce={find.nonce}
            initialQuery={find.query || undefined}
            onClose={closeFind}
          />
        )}

        <div className="page-scroll" ref={scroll.ref} onScroll={scroll.onScroll}>
          {virtual ? (
            virtual.render()
          ) : (
            <Editor
              page={page}
              autofocus={focused && !touchFirst}
              onEditor={setEditor}
              onSaveState={setSaveState}
              onText={(next) => setWords(countWords(next))}
              onEdit={() => promoteView(instanceId)}
            />
          )}

          {!virtual && words === 0 && !narrow && preferences.showHints && (
            <p className="empty-hint">
              <kbd>⌘K</kbd> to search · <kbd>/</kbd> for commands · just start typing
            </p>
          )}

          {/* Backlinks flow after the page rather than floating above it, so
              they scroll away with the content like a footer. */}
          {preferences.showBacklinks && (
            <Backlinks page={virtual?.name ?? page} revision={backlinkRevision} />
          )}
        </div>
      </div>
    </ViewInstance>
  );
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
