import { useCallback, useEffect, useRef, useState } from 'react';
import { ConflictError, isValidPageName, normalizePageName } from '@spark/core';
import type { SparkEditor } from '@spark/editor';
import { useApp } from '../app-context';
import { EMOJI_SHORTCODES } from './pickers';
import { seedJournalPage } from '../lib/journal-template';
import { forgetCachedPage, readCachedPage, writeCachedPage } from '../lib/page-cache';
import { tagPageName } from '../virtual';
import { filesApi } from '../lib/spark-client';
import { describeUpload, markdownLinkFor, uploadFiles } from '../lib/uploads';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

interface EditorProps {
  page: string;
  autofocus?: boolean;
  onEditor?: (editor: SparkEditor | null) => void;
  onSaveState: (state: SaveState) => void;
  /** Fires with the document text on load and on every change. */
  onText?: (text: string) => void;
  /**
   * A genuine edit — never on load, never on a write landing from elsewhere.
   * `onText` fires for both of those too, which is exactly wrong for a
   * signal meant to promote a preview tab out of preview: a page that was
   * only ever loaded, not typed in, has not stopped being a glance.
   */
  onEdit?: () => void;
}

/**
 * The editor surface.
 *
 * Owns loading, autosaving and conflict detection for one page. Autosave is
 * debounced and also fires on blur and on page hide, so nothing is ever lost to
 * a closed tab — there is no save button because there shouldn't need to be one.
 */
export function Editor({ page, autofocus, onEditor, onSaveState, onText, onEdit }: EditorProps) {
  const { workspace, toast, openPage, pages, pendingLine, preferences } = useApp();
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<SparkEditor | null>(null);

  // Held in a ref so the mount effect, which runs once, always calls the
  // current one. Passing them as dependencies would rebuild the editor and drop
  // the cursor every time the parent re-rendered.
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;

  // Read through a ref for the same reason: the save timer is armed from a
  // callback that must not be rebuilt, and the delay should take effect from
  // the next keystroke rather than on a remount.
  const autosaveDelay = useRef(preferences.autosaveDelay);
  autosaveDelay.current = preferences.autosaveDelay;

  // `autofocus` is "this tile has focus", so it changes every time you click
  // into another tile or into Spark — and a dependency here reaches `loadPage`,
  // which reaches the page effect, which reloads the page and calls `setPage`.
  // That replaces the whole editor state: the caret jumps to the top of the
  // document and every decoration is rebuilt from scratch, so the markdown
  // flashes back to its raw form for a frame. It is read at the moment a load
  // lands, which is also when the answer should be current.
  const autofocusRef = useRef(autofocus);
  autofocusRef.current = autofocus;

  const behaviourRef = useRef({
    continueLists: preferences.continueLists,
    autoPairs: preferences.autoPairs,
    spellcheck: preferences.spellcheck,
  });
  behaviourRef.current = {
    continueLists: preferences.continueLists,
    autoPairs: preferences.autoPairs,
    spellcheck: preferences.spellcheck,
  };

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

  /**
   * The in-flight load, and the in-flight save.
   *
   * Both exist to stop this editor writing against a revision it has already
   * superseded, which is the one way a single tab manufactures a conflict with
   * nobody but itself:
   *
   * - A save that starts while the previous one is still in the air would send
   *   the revision from *before* that write, and the server would rightly
   *   reject it. Autosave fires on a timer, so any save slower than the delay
   *   used to do exactly this.
   * - A save that starts before the first read has returned would send the
   *   revision from the local cache, which is only a guess.
   *
   * Chaining them means the revision is always the one the last completed
   * exchange produced.
   */
  const loading = useRef<Promise<unknown> | null>(null);
  const saving = useRef<Promise<void> | null>(null);

  const [conflict, setConflict] = useState<{ theirs: string; mine: string } | null>(null);

  // -- saving ---------------------------------------------------------------

  const writeNow = useCallback(
    async (force: boolean) => {
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
        writeCachedPage(target, text, meta.rev);
        workspace.events.emit('page:save', { page: target, text, rev: meta.rev });
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

  /** Queues a write behind whatever read or write is already in the air. */
  const flush = useCallback(
    (force = false): Promise<void> => {
      // Read before publishing this one. Waiting on `saving.current` from
      // *inside* the chain would be waiting on the chain itself, because it is
      // reassigned below before any of this body runs.
      const previous = saving.current;

      const queued = (async () => {
        // A failed load or a failed earlier write must not wedge the queue —
        // each save carries its own revision and its own error handling.
        await Promise.resolve(loading.current).catch(() => {});
        await Promise.resolve(previous).catch(() => {});
        await writeNow(force);
      })();

      saving.current = queued;
      void queued.finally(() => {
        if (saving.current === queued) saving.current = null;
      });
      return queued;
    },
    [writeNow],
  );

  const scheduleSave = useCallback(
    (text: string) => {
      pendingText.current = text;
      onTextRef.current?.(text);
      onEditRef.current?.();
      onSaveState('dirty');
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(), autosaveDelay.current);
    },
    [flush, onSaveState],
  );

  // -- loading a page into the editor ---------------------------------------

  const loadPage = useCallback(
    (name: string, isCancelled: () => boolean): Promise<void> => {
      /** Puts text on screen, jumps to any pending line, and tells the app. */
      const show = (text: string, rev: string | null, settled: boolean) => {
        const editor = editorRef.current;
        if (!editor) return;

        // `null` means "not confirmed by the server yet". `flush` waits on the
        // load before writing anything, so a cached revision is never the one a
        // write is made against — it is only what is painted.
        if (settled) loadedRev.current = rev;
        editor.setPage(name, text);
        onTextRef.current?.(text);

        // Arriving from a task or a backlink means arriving at a *line*, not
        // just a page. Consume the request so a later reload doesn't jump again.
        const jump = pendingLine.current;
        if (jump && jump.page === name) {
          pendingLine.current = null;
          editor.goToLine(jump.line);
        }
        workspace.tasks.update(name, text);
        onSaveState('saved');
        if (autofocusRef.current) editor.focus();
      };

      // What we already have, drawn straight away. A page you read a minute ago
      // should not wait on a round trip to appear.
      const cached = readCachedPage(name);
      if (cached && !isCancelled()) show(cached.text, null, false);

      const load = (async () => {
        let text = '';
        let rev = '';
        try {
          const page = await workspace.space.read(name);
          text = page.text;
          rev = page.rev;
          writeCachedPage(name, page.text, page.rev);
        } catch {
          // A page that doesn't exist yet is simply an empty one — unless it
          // is a fresh journal page and some template opted itself in for the
          // day, in which case "empty" is that template, rendered. The base
          // revision is still `''`: nothing is written until the person does
          // something with what's now on screen, same as an empty page.
          forgetCachedPage(name);
          text = await seedJournalPage(workspace, name);
        }
        if (isCancelled() || !editorRef.current) return;

        // Anything typed against the cached text is the newer truth; leave it
        // alone and let the ordinary conflict flow handle the disagreement.
        if (pendingText.current !== null) {
          loadedRev.current = rev;
          return;
        }

        // Same text as the cache already showed: adopt the revision and leave
        // the document — and the cursor sitting in it — completely alone.
        if (cached && cached.text === text) {
          loadedRev.current = rev;
          return;
        }

        show(text, rev, true);
      })();

      loading.current = load;
      void load.finally(() => {
        if (loading.current === load) loading.current = null;
      });

      workspace.events.emit('page:open', { page: name });
      return load;
    },
    [workspace, onSaveState, pendingLine],
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
        autofocus: autofocusRef.current,
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
        // A tag is a link to its own virtual page.
        onTag: (tag) => openPage(tagPageName(tag)),

        slashCommands: () => workspace.registry.slashCommands(),
        runSlash: (command) => {
          if (command.snippet) editorRef.current?.insertSnippet(command.snippet);
          else void command.run?.(workspace.editor);
        },
        decorators: () => workspace.registry.decorators(),
        pages: () => pageNamesRef.current,
        emoji: () => EMOJI_SHORTCODES,
        behaviour: behaviourRef.current,
        // `files/` paths in the document are relative to the space, not to the
        // URL the app is at — without this, `![](files/scan.png)` resolves
        // against `/p/whatever` and 404s.
        resolveAsset: (src) => (src.startsWith('files/') ? filesApi.url(src) : src),
        // A file dropped on the note goes through the same upload path as the
        // picker, and the markdown link lands where it was dropped. `insert`
        // clamps the position, so the drop survives any edit that happened
        // while the upload was in flight.
        onDropFiles: (files, pos) => {
          void (async () => {
            const outcome = await uploadFiles(files);
            const links = outcome.stored.map(markdownLinkFor).join('\n');
            if (links) editorRef.current?.insert(links, pos);
            const said = describeUpload(outcome);
            toast(said.message, said.ok ? 'success' : 'error');
          })();
        },
      });

      editorRef.current = editor;
      detach = workspace.editor.attach(editor);
      onEditor?.(editor);

      // Dev-only handle for debugging and browser-driven tests. Stripped from
      // production builds by the constant-folded `import.meta.env.DEV`.
      if (import.meta.env.DEV) {
        (window as unknown as { __spark?: unknown }).__spark = editor;
      }

      // The page effect below may have already run and found no editor, so the
      // first load happens here.
      await loadPage(currentPage.current, () => disposed);
    })();

    return () => {
      disposed = true;
      detach?.();
      editorRef.current?.destroy();
      editorRef.current = null;
      onEditor?.(null);
    };
    // Built once and reused across pages — `setPage` swaps the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Typing behaviours are reconfigured in place rather than by rebuilding the
  // editor, so changing one in Settings does not cost you the cursor.
  useEffect(() => {
    editorRef.current?.setBehaviour(behaviourRef.current);
  }, [preferences.continueLists, preferences.autoPairs, preferences.spellcheck]);

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
    const off = workspace.events.on('page:save', ({ page: saved, text, rev }) => {
      if (saved !== currentPage.current) return;
      if (pendingText.current !== null) return;
      const editor = editorRef.current;
      if (!editor) return;

      // Matching text is *not* a reason to skip the revision. An editor showing
      // the same characters as the write that just landed still holds the
      // revision from before it, and the next keystroke would be rejected with
      // a conflict it had no way to see coming — the one that turns up with a
      // single tab open and nobody else editing anything.
      if (rev) loadedRev.current = rev;
      if (editor.text() === text) return;

      if (rev !== undefined) {
        editor.setPage(saved, text);
        onSaveState('saved');
        return;
      }

      // No revision on the event (an older plugin, say): re-read, because the
      // text alone would leave this editor writing against a stale one.
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
    // Re-read for the revision, not the text: adopting their version without
    // adopting the revision that came with it leaves the very next keystroke
    // conflicting all over again, against a fight the user just finished.
    void workspace.space
      .read(page)
      .then((fresh) => {
        loadedRev.current = fresh.rev;
        writeCachedPage(page, fresh.text, fresh.rev);
        onSaveState('saved');
      })
      .catch(() => onSaveState('error'));
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
      <div
        className="editor-host"
        ref={hostRef}
        // The bridge forwards `spark.editor` to the editor focused most
        // recently. With two notes tiled side by side, that is the only thing
        // that makes "Bold" act on the one you are typing in.
        onFocusCapture={() => {
          if (editorRef.current) workspace.editor.activate(editorRef.current);
        }}
      />
    </>
  );
}
