import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  defaultTemplateVars,
  isValidPageName,
  normalizePageName,
  pageBasename,
  parseTemplate,
  renderTemplate,
} from '@spark/core';
import { useApp } from './app-context';
import { Capture } from './components/Capture';
import { CommandPalette } from './components/CommandPalette';
import {
  CaptureIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SidebarCloseIcon,
  SidebarOpenIcon,
  SparkIcon,
  SplitIcon,
  SunIcon,
  SystemThemeIcon,
  TaskIcon,
  UploadIcon,
} from './components/Icons';
import { MarkdownToolbar } from './components/MarkdownToolbar';
import { Dialogs, Toasts } from './components/Overlays';
import { usePopover, type AnchorRect } from './components/Popover';
import { DatePicker, EmojiPicker, isoDate, TemplatePicker } from './components/pickers';
import { StatusBar } from './components/StatusBar';
import { SyncPanel, SyncPrompt } from './components/SyncPanel';
import type { ThemeMode } from './lib/appearance';
import { modKey, useIsNarrow, useIsTouchFirst } from './lib/device';
import { journalFolder, templatesFolder } from './lib/dirs';
import { dailyPageName } from './lib/modes';
import { forgetCachedPage } from './lib/page-cache';
import { sparkApi } from './lib/spark-client';
import { chooseFiles, describeUpload, markdownLinkFor, uploadFiles } from './lib/uploads';
import { SPARK_PAGE, resolveVirtualPage } from './virtual';
import { useWindows } from './windows/manager';
import { Workbench } from './windows/Workbench';
import { SETTINGS_VIEW } from './windows/views';

/** What the theme button says it is on, in words rather than an enum member. */
const THEME_LABEL: Record<ThemeMode, string> = {
  system: 'Theme: following the system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

/**
 * The shell.
 *
 * A header, the workbench, a status bar, and the overlays that belong to the
 * whole app rather than to any one view. Everything that used to be "the page
 * on screen" now lives in the workbench, so this file is back to what it should
 * be: chrome, commands and keys.
 */
export function App() {
  const {
    workspace,
    ready,
    route,
    toast,
    refreshPages,
    appearance,
    setAppearance,
    preferences,
    pages,
    config,
  } = useApp();

  const {
    openPage,
    openView,
    layout,
    toggleNavigator,
    openPlaces,
    splitFocused,
    status,
    focusedPageTitle,
    classic,
    openFind,
    activeEditor,
    resetWorkbench,
  } = useWindows();

  const popover = usePopover();
  const narrow = useIsNarrow();
  const touchFirst = useIsTouchFirst();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

  // On a phone the app opens straight into capture; on a desktop it opens into
  // the editor. Same app, different first move.
  const [captureOpen, setCaptureOpen] = useState(false);
  const decidedLaunch = useRef(false);

  useEffect(() => {
    if (!ready || decidedLaunch.current) return;
    decidedLaunch.current = true;
    // Only on a bare launch — a link straight to a page is a request to read it.
    if (touchFirst && preferences.captureOnLaunch && route.kind === 'home') setCaptureOpen(true);
  }, [ready, touchFirst, route.kind, preferences.captureOnLaunch]);

  // -- theme ----------------------------------------------------------------
  //
  // The header button cycles; the settings panel picks. Both write through the
  // same `setAppearance`, which owns the document element.

  const theme = appearance.theme;

  const cycleTheme = useCallback(() => {
    setAppearance({
      theme: theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system',
    });
  }, [theme, setAppearance]);

  // -- what the header is about ---------------------------------------------
  //
  // The focused document, which the workbench reports. With two notes tiled the
  // header names the one you are typing in, and there is no second title bar to
  // disagree with it because each tile labels itself on its own tab.
  //
  // `status.page` is null only when the workbench holds no page at all, and the
  // header goes blank for it. The fallback below is for the page *actions*,
  // which are also reachable from the palette: with nothing open, "rename" and
  // "delete" mean today's journal, the page a keystroke would land in.

  // Both folders are settings, not constants — see `lib/dirs.ts` — read once
  // per render rather than at every call site that used to hardcode `journal`.
  const journal = journalFolder(workspace);
  const templates = templatesFolder(workspace);

  const page = status.page ?? dailyPageName(new Date(), journal);
  const virtual = useMemo(() => resolveVirtualPage(page), [page]);

  // The title bar names the focused page, virtual or not — Spark, Tasks, a
  // tag — because that is what the person is looking at. `status.page` stays
  // about the last *document* for the status bar's readings; the header's
  // subject is the focus, and the two diverge exactly when a virtual page is
  // in front of you.
  const titlePage = focusedPageTitle;
  const titleIsVirtual = titlePage !== null && resolveVirtualPage(titlePage) !== null;
  const titleNamesStatus = titlePage !== null && titlePage === page;

  // -- page actions ---------------------------------------------------------

  const newPage = useCallback(async () => {
    const name = await workspace.ui.prompt('New page', '');
    if (!name) return;

    const clean = normalizePageName(name);
    if (!isValidPageName(clean)) {
      toast('That page name has characters that will not work on disk.', 'error');
      return;
    }

    if (resolveVirtualPage(clean)) {
      toast(`"${clean}" is a built-in view, so it can't be a page.`, 'error');
      return;
    }

    try {
      // Create it for real, with a heading, rather than just navigating to a
      // name. A page you asked for should exist — appear in the list, be
      // linkable — before you have typed anything into it. Use `''` as the
      // base revision so an existing page is never overwritten.
      if (await workspace.space.exists(clean)) {
        toast(`"${clean}" already exists — opening it.`, 'info');
        openPage(clean);
        return;
      }

      await workspace.space.write(clean, `# ${pageBasename(clean)}\n\n`, '');
      await refreshPages();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      return;
    }

    // Land under the title rather than on it. The heading is already written;
    // what you came here to do is type the next line.
    openPage(clean, { line: 1 });
  }, [workspace, openPage, refreshPages, toast]);

  const renamePage = useCallback(async () => {
    // What the header names is what renaming renames: the focused page when
    // it is a real note, the last document otherwise. A virtual page is
    // refused before the prompt — renaming a view is not renaming anything.
    const target =
      titlePage !== null && resolveVirtualPage(titlePage) === null ? titlePage : page;
    const next = await workspace.ui.prompt('Rename page', target);
    if (!next) return;
    const clean = normalizePageName(next);
    if (!isValidPageName(clean) || clean === target) return;
    try {
      await workspace.space.rename(target, clean);
      // The old name's cached text is now a page that does not exist.
      forgetCachedPage(target);
      await refreshPages();
      openPage(clean);
      toast('Renamed.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [workspace, page, titlePage, refreshPages, openPage, toast]);

  const deletePage = useCallback(async () => {
    const confirmed = await workspace.ui.select(`Delete “${page}”?`, ['Delete', 'Cancel']);
    if (confirmed !== 'Delete') return;
    try {
      await workspace.space.delete(page);
      workspace.events.emit('page:delete', { page });
      await refreshPages();
      openPage(dailyPageName(new Date(), journal));
      toast('Deleted.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [workspace, page, refreshPages, openPage, toast, journal]);

  /**
   * Putting files in the space.
   *
   * The upload lands in `files/` whatever happens; linking it into the note is
   * the part that depends on where you were. With an editor focused the links
   * go in at the cursor, because uploading a screenshot while writing is one
   * action and having to then find the file and type a link is the app making
   * you do its filing. With no editor focused — from the navigator, from the
   * palette on the Tasks page — the file is simply stored and said so.
   */
  const uploadHere = useCallback(async () => {
    const chosen = await chooseFiles();
    if (chosen.length === 0) return;

    const outcome = await uploadFiles(chosen);
    await refreshPages();

    if (outcome.stored.length > 0 && activeEditor) {
      activeEditor.replaceSelection(outcome.stored.map(markdownLinkFor).join('\n'));
    }

    const said = describeUpload(outcome);
    toast(said.message, said.ok ? 'success' : 'error');
  }, [activeEditor, refreshPages, toast]);

  /**
   * The caret, as something a popup can hang off.
   *
   * Null when there is no editor or the caret is scrolled out of the rendered
   * range, in which case there is genuinely nowhere to put the thing and the
   * caller says so rather than guessing the middle of the screen.
   */
  const caretAnchor = useCallback(
    (): AnchorRect | null => activeEditor?.caretRect() ?? null,
    [activeEditor],
  );

  /**
   * Two pickers that appear at the cursor.
   *
   * They are the reason the popover system is a system: an emoji grid and a
   * calendar have nothing in common except *where they are* and *how they go
   * away*, which is exactly the part that is fiddly and exactly the part that
   * had been written twice before it was worth naming. Both insert and close;
   * neither knows how it was positioned.
   */
  const pickEmoji = useCallback(() => {
    if (!activeEditor) {
      toast('Put the cursor in a note first.', 'info');
      return;
    }
    popover.open({
      label: 'Insert an emoji',
      side: 'below',
      align: 'start',
      className: 'popover-picker',
      anchor: caretAnchor,
      render: ({ close }) => (
        <EmojiPicker
          onPick={(emoji) => {
            close();
            activeEditor.replaceSelection(emoji);
            activeEditor.focus();
          }}
        />
      ),
    });
  }, [activeEditor, popover, caretAnchor, toast]);

  /**
   * Pages under the templates folder — see `lib/dirs.ts` — as candidates for
   * `pickTemplate` below. Just names and titles; the body is only read once
   * something is actually picked, which is what keeps opening the picker
   * itself free of a round trip per template.
   */
  const templateCandidates = useMemo(
    () =>
      pages
        .filter((entry) => entry.name.startsWith(`${templates}/`))
        .map((entry) => ({ name: entry.name, title: pageBasename(entry.name) }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [pages, templates],
  );

  /**
   * Insert a template at the cursor, anywhere — the same picker whether it
   * was reached from the command palette or typed as `/template`, because
   * both are "I want to insert one of these", not two different features
   * that happen to look alike.
   */
  const pickTemplate = useCallback(() => {
    if (!activeEditor) {
      toast('Put the cursor in a note first.', 'info');
      return;
    }
    if (templateCandidates.length === 0) {
      toast(`No templates yet — add a page under ${templates}/.`, 'info');
      return;
    }
    popover.open({
      label: 'Insert a template',
      side: 'below',
      align: 'start',
      className: 'popover-picker',
      anchor: caretAnchor,
      render: ({ close }) => (
        <TemplatePicker
          templates={templateCandidates}
          onPick={(name) => {
            close();
            void (async () => {
              try {
                const { text } = await workspace.space.read(name);
                const template = parseTemplate(name, text);
                const vars = defaultTemplateVars(new Date(), status.page ?? '');
                activeEditor.replaceSelection(renderTemplate(template.body, vars));
                activeEditor.focus();
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'error');
              }
            })();
          }}
        />
      ),
    });
  }, [activeEditor, popover, caretAnchor, toast, templateCandidates, templates, workspace, status.page]);

  const pickDate = useCallback(() => {
    if (!activeEditor) {
      toast('Put the cursor in a note first.', 'info');
      return;
    }
    popover.open({
      label: 'Insert a date',
      side: 'below',
      align: 'start',
      className: 'popover-picker',
      anchor: caretAnchor,
      render: ({ close }) => (
        <DatePicker
          onPick={(date) => {
            close();
            activeEditor.replaceSelection(isoDate(date));
            activeEditor.focus();
          }}
        />
      ),
    });
  }, [activeEditor, popover, caretAnchor, toast]);

  // -- app commands, registered like any plugin's ---------------------------

  useEffect(() => {
    const registry = workspace.registry;
    const off = [
      registry.registerCommand('app', {
        id: 'app.capture',
        name: 'Quick capture',
        category: 'Spark',
        key: 'Mod-Shift-c',
        run: () => setCaptureOpen(true),
      }),
      registry.registerCommand('app', {
        id: 'app.tasks',
        name: 'Open tasks',
        category: 'Spark',
        key: 'Mod-Shift-t',
        run: () => void openPage('Tasks'),
      }),
      registry.registerCommand('app', {
        id: 'app.tags',
        name: 'Browse tags',
        category: 'Spark',
        run: () => void openPage('Tags'),
      }),
      registry.registerCommand('app', {
        id: 'app.today',
        name: "Open today's page",
        category: 'Spark',
        run: () => void openPage(dailyPageName(new Date(), journalFolder(workspace))),
      }),
      registry.registerCommand('app', {
        id: 'app.newPage',
        name: 'New page',
        category: 'Spark',
        key: 'Mod-Shift-n',
        run: () => void newPage(),
      }),
      registry.registerCommand('app', {
        id: 'app.renamePage',
        name: 'Rename page',
        category: 'Spark',
        // A virtual page is a view, not a file: renaming it would rename
        // nothing. The header shows the focused page now, so the check is
        // against *that*, not against the last document.
        available: () => resolveVirtualPage(titlePage ?? '') === null,
        run: () => void renamePage(),
      }),
      registry.registerCommand('app', {
        id: 'app.deletePage',
        name: 'Delete page',
        category: 'Spark',
        available: () => virtual === null,
        run: () => void deletePage(),
      }),
      registry.registerCommand('app', {
        id: 'app.upload',
        name: 'Upload files',
        category: 'Spark',
        run: () => void uploadHere(),
      }),
      registry.registerCommand('app', {
        id: 'app.emoji',
        name: 'Insert emoji',
        category: 'Format',
        available: () => virtual === null,
        run: pickEmoji,
      }),
      registry.registerCommand('app', {
        id: 'app.date',
        name: 'Insert a date',
        category: 'Format',
        available: () => virtual === null,
        run: pickDate,
      }),
      registry.registerCommand('app', {
        id: 'app.template',
        name: 'Use template',
        category: 'Format',
        available: () => virtual === null,
        run: pickTemplate,
      }),
      registry.registerCommand('app', {
        id: 'app.theme',
        name: 'Switch theme',
        category: 'Spark',
        run: cycleTheme,
      }),

      // Find belongs to a view, not to the app — but its key does not, because
      // every command key in Spark is dispatched in exactly one place. See
      // AGENTS → "Keybindings must be dispatched in exactly one place".
      registry.registerCommand('app', {
        id: 'app.find',
        name: 'Find in this page',
        category: 'Spark',
        key: 'Mod-f',
        run: openFind,
      }),

      // The pickers are also slash commands, because the moment you want an
      // emoji or a date is while you are typing, not while you are reaching for
      // a menu. `/date` used to insert today's date blind; it now offers the
      // calendar, and `/today` is what stayed for the blind one.
      registry.registerSlash('app', {
        name: 'emoji',
        description: 'Pick an emoji',
        run: pickEmoji,
      }),
      registry.registerSlash('app', {
        name: 'calendar',
        description: 'Pick a date',
        run: pickDate,
      }),
      registry.registerSlash('app', {
        name: 'template',
        description: 'Insert a template',
        run: pickTemplate,
      }),
      registry.registerCommand('app', {
        id: 'app.settings',
        name: 'Settings',
        category: 'Spark',
        key: 'Mod-,',
        run: () => {
          openView(SETTINGS_VIEW, { mode: 'modal' });
        },
      }),
      registry.registerCommand('app', {
        id: 'app.sync',
        name: 'Sync settings',
        category: 'Spark',
        run: () => setSyncOpen(true),
      }),

      // -- the workbench ---------------------------------------------------
      registry.registerCommand('app', {
        id: 'window.navigator',
        name: 'Toggle navigator',
        category: 'Window',
        key: 'Mod-\\',
        run: toggleNavigator,
      }),
      registry.registerCommand('app', {
        id: 'window.places',
        name: 'Show places',
        category: 'Window',
        run: openPlaces,
      }),
      // Opening the same page twice is now something you can ask for, so there
      // has to be a way to ask that is not a drag.
      registry.registerCommand('app', {
        id: 'window.duplicate',
        name: 'Open another copy of this page',
        category: 'Window',
        available: () => !classic,
        run: () => void openPage(page, { duplicate: true, mode: 'split-right' }),
      }),
      registry.registerCommand('app', {
        id: 'window.spark',
        name: 'Ask Spark',
        category: 'Window',
        key: 'Mod-Shift-a',
        // `openPage` always sends Spark to the right rail, so no mode is
        // requested here.
        run: () => void openPage(SPARK_PAGE),
      }),

      // The arranging commands only exist where there is something to arrange.
      // A palette entry that silently does nothing is worse than a missing one.
      ...(classic
        ? []
        : [
            registry.registerCommand('app', {
              id: 'window.splitRight',
              name: 'Split right',
              category: 'Window',
              run: () => splitFocused('right'),
            }),
            registry.registerCommand('app', {
              id: 'window.splitDown',
              name: 'Split down',
              category: 'Window',
              run: () => splitFocused('bottom'),
            }),
            registry.registerCommand('app', {
              id: 'window.float',
              name: 'Open this page in a window',
              category: 'Window',
              run: () => void openPage(page, { mode: 'window' }),
            }),
          ]),

      // The layout persists across reloads now — see `WORKBENCH_LAYOUT_KEY`
      // in `manager.tsx` — so this is the explicit door back to a known
      // state that reloading used to be by accident.
      registry.registerCommand('app', {
        id: 'window.resetLayout',
        name: 'Reset workbench',
        category: 'Window',
        available: () => !classic,
        run: resetWorkbench,
      }),
    ];
    return () => off.forEach((dispose) => dispose());
  }, [
    workspace,
    openPage,
    openView,
    newPage,
    renamePage,
    deletePage,
    cycleTheme,
    virtual,
    toggleNavigator,
    openPlaces,
    splitFocused,
    openFind,
    uploadHere,
    pickEmoji,
    pickDate,
    pickTemplate,
    page,
    classic,
    resetWorkbench,
  ]);

  // -- global shortcuts -----------------------------------------------------

  // Command keys are dispatched here and only here. The editor keeps its own
  // text-editing keys (bold, lists, headings), but anything a command declares
  // is bound once, globally, so it works on the Tasks page too — and so a key
  // can never fire twice, once in CodeMirror and once in the app.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPaletteOpen(false);
        setSyncOpen(false);
        // Capture closes from here as well as from its own textarea, so the
        // key works when focus is on the mode switcher or the save button.
        setCaptureOpen(false);
        return;
      }

      // CodeMirror handled it first and said so; don't act on it again.
      if (event.defaultPrevented) return;

      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;

      if (event.key.toLowerCase() === 'k' && !event.shiftKey) {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }

      const pressed = describeKeyEvent(event);
      const command = workspace.registry
        .availableCommands()
        .find((entry) => entry.key && normalizeKey(entry.key) === pressed);

      if (command) {
        event.preventDefault();
        void Promise.resolve(command.run()).catch((err: unknown) =>
          toast(err instanceof Error ? err.message : String(err), 'error'),
        );
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [workspace, toast]);

  // -- render ---------------------------------------------------------------

  const title =
    titlePage === null ? null : (resolveVirtualPage(titlePage)?.title ?? pageBasename(titlePage));
  const navigatorOpen = layout.sidebars.left.open;

  return (
    <div className="app">
      <header className="header">
        <button
          className="icon-button"
          onClick={toggleNavigator}
          aria-label="Toggle navigator"
          aria-pressed={navigatorOpen}
          title="Toggle navigator"
        >
          {navigatorOpen ? <SidebarCloseIcon /> : <SidebarOpenIcon />}
        </button>

        <span className="header-spacer" />

        {/* Nothing open, nothing to name. The title is the focused page's, so
            with no page it would otherwise sit there naming a note that is not
            on screen and offering to rename it. A virtual page gets the same
            treatment as the empty case on the button: naming it is fine,
            offering to rename it is a lie, because renaming a view renames
            nothing. */}
        {title !== null && (
          <button
            className="header-title"
            data-dirty={
              titleNamesStatus &&
              !titleIsVirtual &&
              (status.saveState === 'dirty' || status.saveState === 'saving')
            }
            onClick={() => void renamePage()}
            disabled={titleIsVirtual}
            title={titleIsVirtual ? title : `${titlePage} — click to rename`}
          >
            {title}
          </button>
        )}

        <span className="header-spacer" />

        <button
          className="icon-button"
          onClick={() => void newPage()}
          aria-label="New page"
          title="New page"
        >
          <PlusIcon />
        </button>
        {/* Capture is the phone's launch surface, but the thought you need to
            get down before it goes is not a property of the device you are
            holding. It is one button at every width, and one key. */}
        <button
          className="icon-button"
          onClick={() => setCaptureOpen(true)}
          aria-label="Quick capture"
          title={`Quick capture — ${modKey}⇧C`}
        >
          <CaptureIcon />
        </button>
        {!narrow && (
          <button
            className="icon-button"
            onClick={() => void uploadHere()}
            aria-label="Upload files"
            title="Upload files into files/"
          >
            <UploadIcon />
          </button>
        )}
        <button
          className="icon-button"
          data-proactive={config.proactiveFinding ? true : undefined}
          onClick={() => {
            openPage(SPARK_PAGE);
            // Seen, not read — acknowledging is "the badge was noticed",
            // independent of whether they act on it. See `proactive.ts`.
            if (config.proactiveFinding) void sparkApi.acknowledgeProactive();
          }}
          aria-label={config.proactiveFinding ? `Ask Spark — ${config.proactiveFinding}` : 'Ask Spark'}
          title={config.proactiveFinding ?? 'Ask Spark'}
        >
          <SparkIcon />
        </button>
        <button
          className="icon-button"
          onClick={() => openPage('Tasks')}
          aria-label="Tasks"
          title="Tasks"
        >
          <TaskIcon />
        </button>
        {!narrow && !classic && (
          <button
            className="icon-button"
            onClick={() => splitFocused('right')}
            aria-label="Split right"
            title="Split right"
          >
            <SplitIcon />
          </button>
        )}
        <button
          className="icon-button"
          onClick={() => setPaletteOpen(true)}
          aria-label="Search pages and commands"
          title="Search"
        >
          <SearchIcon />
        </button>
        <button
          className="icon-button"
          onClick={() => openView(SETTINGS_VIEW, { mode: 'modal' })}
          aria-label="Settings"
          title="Settings"
        >
          <SettingsIcon />
        </button>
        <button
          className="icon-button"
          onClick={cycleTheme}
          aria-label={THEME_LABEL[theme]}
          title={THEME_LABEL[theme]}
        >
          {theme === 'dark' ? <MoonIcon /> : theme === 'light' ? <SunIcon /> : <SystemThemeIcon />}
        </button>
      </header>

      <SyncPrompt onOpen={() => setSyncOpen(true)} />

      <Workbench />

      {narrow && !virtual && <MarkdownToolbar />}

      <StatusBar onOpenSync={() => setSyncOpen(true)} />

      {captureOpen && <Capture onClose={() => setCaptureOpen(false)} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {syncOpen && <SyncPanel onClose={() => setSyncOpen(false)} />}

      <Dialogs />
      <Toasts />
    </div>
  );
}

/**
 * Canonical form of a CodeMirror-style binding (`Mod-Shift-t`) so a declared
 * key and a pressed key can be compared without caring about order or case.
 */
function normalizeKey(key: string): string {
  const parts = key.split('-');
  const main = parts.pop() ?? '';
  const mods = new Set(parts.map((part) => part.toLowerCase()));
  return [
    mods.has('mod') || mods.has('cmd') || mods.has('ctrl') ? 'mod' : '',
    mods.has('shift') ? 'shift' : '',
    mods.has('alt') ? 'alt' : '',
    main.toLowerCase(),
  ]
    .filter(Boolean)
    .join('-');
}

function describeKeyEvent(event: KeyboardEvent): string {
  return [
    event.metaKey || event.ctrlKey ? 'mod' : '',
    event.shiftKey ? 'shift' : '',
    event.altKey ? 'alt' : '',
    event.key.toLowerCase(),
  ]
    .filter(Boolean)
    .join('-');
}
