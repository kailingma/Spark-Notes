import { useCallback, useEffect, useRef, useState } from 'react';
import { ConflictError, isValidPageName, normalizePageName } from '@spark/core';
import type { SparkEditor } from '@spark/editor';
import { useApp } from '../app-context';

/** How long typing pauses before a save fires. */
const AUTOSAVE_MS = 600;

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

interface EditorProps {
  page: string;
  autofocus?: boolean;
  onEditor: (editor: SparkEditor | null) => void;
  onSaveState: (state: SaveState) => void;
}

/**
 * The editor surface.
 *
 * Owns loading, autosaving and conflict detection for one page. Autosave is
 * debounced and also fires on blur and on page hide, so nothing is ever lost to
 * a closed tab — there is no save button because there shouldn't need to be one.
 */
export function Editor({ page, autofocus, onEditor, onSaveState }: EditorProps) {
  const { workspace, toast, openPage, pages } = useApp();
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<SparkEditor | null>(null);

  // Kept in a ref so `[[` completion always sees the current page list without
  // rebuilding the editor (which would drop the cursor) on every list change.
  const pageNamesRef = useRef<string[]>([]);
  pageNamesRef.current = pages.map((meta) => meta.name);

  const saveTimer = useRef<number | null>(null);
  const pendingText = useRef<string | null>(null);
  // The revision this editor last saw for the open page. Held here rather than
  // read from the shared space client so a write by another component can't be
  // mistaken for one this editor knew about.
  const loadedRev = useRef<string | null>(null);
  const currentPage = useRef(page);
  currentPage.current = page;

  const [conflict, setConflict] = useState<{ theirs: string; mine: string } | null>(null);

  // -- saving ---------------------------------------------------------------

  const flush = useCallback(
    async (force = false) => {
      const text = pendingText.current;
      const target = currentPage.current;
      if (text === null) return;
      pendingText.current = null;

      onSaveState('saving');
      try {
        // `null` tells the server to take the write regardless — used only when
        // the user has explicitly resolved a conflict.
        const meta = await workspace.space.write(target, text, force ? null : loadedRev.current);
        loadedRev.current = meta.rev;
        workspace.events.emit('page:save', { page: target, text });
        onSaveState('saved');
      } catch (err) {
        if (err instanceof ConflictError) {
          // Somebody — another tab, another device, a git pull — wrote this
          // page while it was open. Never silently pick a winner.
          setConflict({ theirs: err.serverText, mine: err.localText });
          onSaveState('error');
          return;
        }
        onSaveState('error');
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    [workspace, onSaveState, toast],
  );

  const scheduleSave = useCallback(
    (text: string) => {
      pendingText.current = text;
      onSaveState('dirty');
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
    },
    [flush, onSaveState],
  );

  // -- loading a page into the editor ---------------------------------------

  const loadPage = useCallback(
    async (name: string, isCancelled: () => boolean) => {
      let text = '';
      let rev: string | null = null;
      try {
        const page = await workspace.space.read(name);
        text = page.text;
        rev = page.rev;
      } catch {
        // A page that doesn't exist yet is simply an empty one. An empty base
        // revision says "create it"; writing to it creates the file, and
        // navigating away without typing leaves no trace.
        text = '';
        rev = '';
      }
      if (isCancelled() || !editorRef.current) return;

      loadedRev.current = rev;
      editorRef.current.setPage(name, text);
      workspace.tasks.update(name, text);
      workspace.events.emit('page:open', { page: name });
      onSaveState('saved');
      if (autofocus) editorRef.current.focus();
    },
    [workspace, onSaveState, autofocus],
  );

  // -- mount ----------------------------------------------------------------

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let detach: (() => void) | null = null;

    // CodeMirror is the largest thing Spark ships and it isn't needed to paint
    // the shell — or at all, if you land on the capture screen or the task
    // list. Loading it here keeps the first paint small and makes the mobile
    // capture path free of it entirely.
    void (async () => {
      const { SparkEditor } = await import('@spark/editor');
      if (disposed) return;

      const editor = new SparkEditor({
        parent: host,
        page: currentPage.current,
        doc: '',
        placeholder: 'Start writing…',
        autofocus,
        onChange: scheduleSave,
        onSave: () => void flush(),

        onWikiLink: (target) => {
          const name = normalizePageName(target);
          if (isValidPageName(name)) openPage(name);
        },
        onLink: (url) => {
          if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
          else if (isValidPageName(url)) openPage(normalizePageName(url));
        },

        slashCommands: () => workspace.registry.slashCommands(),
        runSlash: (command) => {
          if (command.snippet) editorRef.current?.insertSnippet(command.snippet);
          else void command.run?.(workspace.editor);
        },
        decorators: () => workspace.registry.decorators(),
        pages: () => pageNamesRef.current,
      });

      editorRef.current = editor;
      detach = workspace.editor.attach(editor);
      onEditor(editor);

      // The page effect below may have already run and found no editor, so the
      // first load happens here.
      await loadPage(currentPage.current, () => disposed);
    })();

    return () => {
      disposed = true;
      detach?.();
      editorRef.current?.destroy();
      editorRef.current = null;
      onEditor(null);
    };
    // Built once and reused across pages — `setPage` swaps the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- page switching -------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    // Don't carry unsaved work from the previous page into the next one.
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    void flush();
    setConflict(null);

    // Before the editor finishes loading there is nothing to load into; the
    // mount effect performs the first load itself.
    if (editorRef.current) void loadPage(page, () => cancelled);

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, loadPage]);

  // -- staying in step with writes from elsewhere ---------------------------

  /**
   * Another part of the app can write to the page this editor has open — most
   * commonly a quick capture appending to today's page while it sits behind the
   * capture screen. Without this the editor would keep showing the stale
   * document and the next keystroke would collide with the file on disk.
   *
   * Local edits always win: if there is unsaved text pending, the incoming
   * write is left alone and the normal conflict flow handles it.
   */
  useEffect(() => {
    const off = workspace.events.on('page:save', ({ page: saved, text }) => {
      if (saved !== currentPage.current) return;
      if (pendingText.current !== null) return;
      const editor = editorRef.current;
      if (!editor || editor.text() === text) return;

      // Re-read rather than trusting the event's text alone: the revision has
      // to come with it, or the next keystroke would write against a stale one.
      void workspace.space
        .read(saved)
        .then((page) => {
          if (saved !== currentPage.current || pendingText.current !== null) return;
          loadedRev.current = page.rev;
          editorRef.current?.setPage(saved, page.text);
          onSaveState('saved');
        })
        .catch(() => {
          /* the page vanished; the next navigation will sort it out */
        });
    });
    return off;
  }, [workspace, onSaveState]);

  // -- durability -----------------------------------------------------------

  useEffect(() => {
    const saveNow = () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      void flush();
    };

    // `visibilitychange` is the reliable one on mobile — `beforeunload` often
    // never fires when an app is swiped away.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') saveNow();
    };

    window.addEventListener('blur', saveNow);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', saveNow);

    return () => {
      window.removeEventListener('blur', saveNow);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', saveNow);
      saveNow();
    };
  }, [flush]);

  // -- conflict resolution --------------------------------------------------

  const keepMine = useCallback(() => {
    if (!conflict) return;
    pendingText.current = conflict.mine;
    setConflict(null);
    void flush(true);
  }, [conflict, flush]);

  const takeTheirs = useCallback(() => {
    if (!conflict) return;
    editorRef.current?.setText(conflict.theirs);
    setConflict(null);
    void workspace.space.read(page).then(() => onSaveState('saved'));
  }, [conflict, page, workspace, onSaveState]);

  const keepBoth = useCallback(() => {
    if (!conflict) return;
    const merged = [
      conflict.mine.trimEnd(),
      '',
      '---',
      '',
      '<!-- version saved elsewhere while this page was open -->',
      '',
      conflict.theirs.trimEnd(),
      '',
    ].join('\n');
    editorRef.current?.setText(merged);
    pendingText.current = merged;
    setConflict(null);
    void flush(true);
  }, [conflict, flush]);

  return (
    <>
      {conflict && (
        <div className="banner" data-kind="warning" role="alert">
          <p>
            <strong>{page}</strong> was changed somewhere else while you were editing.
          </p>
          <div className="banner-actions">
            <button className="button" data-variant="ghost" onClick={takeTheirs}>
              Use theirs
            </button>
            <button className="button" data-variant="ghost" onClick={keepBoth}>
              Keep both
            </button>
            <button className="button" data-variant="primary" onClick={keepMine}>
              Keep mine
            </button>
          </div>
        </div>
      )}
      <div className="editor-host" ref={hostRef} />
    </>
  );
}
