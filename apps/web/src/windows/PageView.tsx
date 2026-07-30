import { useEffect, useMemo, useState } from 'react';
import type { SparkEditor } from '@spark/editor';
import { useApp } from '../app-context';
import { Backlinks } from '../components/Backlinks';
import { Editor, type SaveState } from '../components/Editor';
import { useIsTouchFirst } from '../lib/device';
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
  const { layout, setStatus, focusView, setActiveEditor, narrow } = useWindows();
  const touchFirst = useIsTouchFirst();

  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [words, setWords] = useState(0);
  const [backlinkRevision, setBacklinkRevision] = useState(0);
  const [editor, setEditor] = useState<SparkEditor | null>(null);

  const virtual = useMemo(() => resolveVirtualPage(page), [page]);
  const focused = layout.focusedView === instanceId;

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
  useEffect(() => {
    if (!focused) return;
    setStatus({ page, virtual: virtual !== null, saveState, words });
    setActiveEditor(editor);
  }, [focused, page, virtual, saveState, words, editor, setStatus, setActiveEditor]);

  return (
    <ViewInstance id={instanceId}>
      <div
        className="page-view"
        // Focus follows the caret, not just the tab bar: clicking into a note is
        // how you say which one you mean.
        onFocusCapture={() => focusView(instanceId)}
        onPointerDownCapture={() => focusView(instanceId)}
      >
        <div className="page-scroll">
          {virtual ? (
            virtual.render()
          ) : (
            <Editor
              page={page}
              autofocus={focused && !touchFirst}
              onEditor={setEditor}
              onSaveState={setSaveState}
              onText={(text) => setWords(countWords(text))}
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
