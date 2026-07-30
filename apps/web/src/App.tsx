import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isValidPageName, normalizePageName, pageBasename } from '@spark/core';
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
} from './components/Icons';
import { MarkdownToolbar } from './components/MarkdownToolbar';
import { Dialogs, Toasts } from './components/Overlays';
import { StatusBar } from './components/StatusBar';
import { SyncPanel, SyncPrompt } from './components/SyncPanel';
import type { ThemeMode } from './lib/appearance';
import { modKey, useIsNarrow, useIsTouchFirst } from './lib/device';
import { dailyPageName } from './lib/modes';
import { forgetCachedPage } from './lib/page-cache';
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
  } = useApp();

  const { openPage, openView, layout, toggleNavigator, splitFocused, status, classic } =
    useWindows();

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

  const page = status.page ?? dailyPageName();
  const virtual = useMemo(() => resolveVirtualPage(page), [page]);

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
    if (virtual) return;
    const next = await workspace.ui.prompt('Rename page', page);
    if (!next) return;
    const clean = normalizePageName(next);
    if (!isValidPageName(clean) || clean === page) return;
    try {
      await workspace.space.rename(page, clean);
      // The old name's cached text is now a page that does not exist.
      forgetCachedPage(page);
      await refreshPages();
      openPage(clean);
      toast('Renamed.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [workspace, page, virtual, refreshPages, openPage, toast]);

  const deletePage = useCallback(async () => {
    const confirmed = await workspace.ui.select(`Delete “${page}”?`, ['Delete', 'Cancel']);
    if (confirmed !== 'Delete') return;
    try {
      await workspace.space.delete(page);
      workspace.events.emit('page:delete', { page });
      await refreshPages();
      openPage(dailyPageName());
      toast('Deleted.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [workspace, page, refreshPages, openPage, toast]);

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
        run: () => openPage('Tasks'),
      }),
      registry.registerCommand('app', {
        id: 'app.tags',
        name: 'Browse tags',
        category: 'Spark',
        run: () => openPage('Tags'),
      }),
      registry.registerCommand('app', {
        id: 'app.today',
        name: "Open today's page",
        category: 'Spark',
        run: () => openPage(dailyPageName()),
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
        available: () => virtual === null,
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
        id: 'app.theme',
        name: 'Switch theme',
        category: 'Spark',
        run: cycleTheme,
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
        id: 'window.spark',
        name: classic ? 'Ask Spark' : 'Ask Spark beside this page',
        category: 'Window',
        key: 'Mod-Shift-a',
        // Classic mode sends Spark to the right rail; `openPage` knows that, so
        // the split it would otherwise ask for is simply not requested.
        run: () => openPage(SPARK_PAGE, classic ? {} : { mode: 'split-right' }),
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
              run: () => openPage(page, { mode: 'window' }),
            }),
          ]),
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
    splitFocused,
    page,
    classic,
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

  const title = virtual ? virtual.title : pageBasename(page);
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

        <button
          className="header-title"
          data-dirty={!virtual && (status.saveState === 'dirty' || status.saveState === 'saving')}
          onClick={() => void renamePage()}
          title={virtual ? virtual.title : `${page} — click to rename`}
        >
          {title}
        </button>

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
            onClick={() => openPage(SPARK_PAGE, classic ? {} : { mode: 'split-right' })}
            aria-label="Ask Spark"
            title={classic ? 'Ask Spark, in the side panel' : 'Ask Spark, beside this page'}
          >
            <SparkIcon />
          </button>
        )}
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

      <StatusBar showDocumentState={!virtual} onOpenSync={() => setSyncOpen(true)} />

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
