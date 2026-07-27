import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isValidPageName, normalizePageName, pageBasename } from '@spark/core';
import type { SparkEditor } from '@spark/editor';
import { useApp } from './app-context';
import { Capture } from './components/Capture';
import { CommandPalette } from './components/CommandPalette';
import { Editor, type SaveState } from './components/Editor';
import {
  MenuIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SparkIcon,
  SunIcon,
  TaskIcon,
} from './components/Icons';
import { MarkdownToolbar } from './components/MarkdownToolbar';
import { Dialogs, Toasts } from './components/Overlays';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { SyncPanel, SyncPrompt } from './components/SyncPanel';
import { TasksView } from './components/TasksView';
import { useIsNarrow, useIsTouchFirst } from './lib/device';
import { dailyPageName } from './lib/modes';

type Theme = 'system' | 'light' | 'dark';

export function App() {
  const { workspace, ready, route, navigate, openPage, toast, refreshPages } = useApp();

  const narrow = useIsNarrow();
  const touchFirst = useIsTouchFirst();

  const [editor, setEditor] = useState<SparkEditor | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [words, setWords] = useState(0);

  const [sidebarOpen, setSidebarOpen] = useState(() =>
    workspace.settings.get('app.sidebar', false),
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => workspace.settings.get('app.theme', 'system'));

  // On a phone the app opens straight into capture; on a desktop it opens into
  // the editor. Same app, different first move.
  const [captureOpen, setCaptureOpen] = useState(false);
  const decidedLaunch = useRef(false);

  useEffect(() => {
    if (!ready || decidedLaunch.current) return;
    decidedLaunch.current = true;
    // Only on a bare launch — a link straight to a page is a request to read it.
    if (touchFirst && route.kind === 'home') setCaptureOpen(true);
  }, [ready, touchFirst, route.kind]);

  // -- theme ----------------------------------------------------------------

  useEffect(() => {
    workspace.settings.set('app.theme', theme);
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [workspace, theme]);

  const cycleTheme = useCallback(() => {
    setTheme((current) =>
      current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system',
    );
  }, []);

  // -- current page ---------------------------------------------------------

  // Home is today's page. It's usually empty, which is exactly the blank
  // editor we want to open into — but anything typed lands somewhere real.
  const page = useMemo(
    () => (route.kind === 'page' ? route.page : dailyPageName()),
    [route],
  );

  useEffect(() => {
    const off = workspace.editor.onChange((text) => setWords(countWords(text)));
    setWords(countWords(workspace.editor.text()));
    return off;
  }, [workspace, page]);

  useEffect(() => {
    workspace.settings.set('app.sidebar', sidebarOpen);
  }, [workspace, sidebarOpen]);

  // -- page actions ---------------------------------------------------------

  const newPage = useCallback(async () => {
    const name = await workspace.ui.prompt('New page', '');
    if (!name) return;
    const clean = normalizePageName(name);
    if (!isValidPageName(clean)) {
      toast('That page name has characters that will not work on disk.', 'error');
      return;
    }
    openPage(clean);
  }, [workspace, openPage, toast]);

  const renamePage = useCallback(async () => {
    const next = await workspace.ui.prompt('Rename page', page);
    if (!next) return;
    const clean = normalizePageName(next);
    if (!isValidPageName(clean) || clean === page) return;
    try {
      await workspace.space.rename(page, clean);
      await refreshPages();
      openPage(clean);
      toast('Renamed.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [workspace, page, refreshPages, openPage, toast]);

  const deletePage = useCallback(async () => {
    const confirmed = await workspace.ui.select(`Delete “${page}”?`, ['Delete', 'Cancel']);
    if (confirmed !== 'Delete') return;
    try {
      await workspace.space.delete(page);
      workspace.events.emit('page:delete', { page });
      await refreshPages();
      navigate({ kind: 'home' });
      toast('Deleted.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [workspace, page, refreshPages, navigate, toast]);

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
        run: () => navigate({ kind: 'tasks' }),
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
        run: () => void newPage(),
      }),
      registry.registerCommand('app', {
        id: 'app.renamePage',
        name: 'Rename page',
        category: 'Spark',
        available: () => route.kind !== 'tasks',
        run: () => void renamePage(),
      }),
      registry.registerCommand('app', {
        id: 'app.deletePage',
        name: 'Delete page',
        category: 'Spark',
        available: () => route.kind !== 'tasks',
        run: () => void deletePage(),
      }),
      registry.registerCommand('app', {
        id: 'app.sidebar',
        name: 'Toggle page list',
        category: 'Spark',
        key: 'Mod-\\',
        run: () => setSidebarOpen((open) => !open),
      }),
      registry.registerCommand('app', {
        id: 'app.theme',
        name: 'Switch theme',
        category: 'Spark',
        run: cycleTheme,
      }),
      registry.registerCommand('app', {
        id: 'app.sync',
        name: 'Sync settings',
        category: 'Spark',
        run: () => setSyncOpen(true),
      }),
    ];
    return () => off.forEach((dispose) => dispose());
  }, [workspace, navigate, openPage, newPage, renamePage, deletePage, cycleTheme, route.kind]);

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

  const showSidebar = sidebarOpen;
  const title = route.kind === 'tasks' ? 'Tasks' : pageBasename(page);

  return (
    <div className="app">
      <header className="header">
        <button
          className="icon-button"
          onClick={() => setSidebarOpen((open) => !open)}
          aria-label="Toggle page list"
          aria-pressed={showSidebar}
        >
          <MenuIcon />
        </button>

        <button
          className="header-title"
          data-dirty={saveState === 'dirty' || saveState === 'saving'}
          onClick={() => void renamePage()}
          title={route.kind === 'tasks' ? 'Tasks' : `${page} — click to rename`}
        >
          {title}
        </button>

        <button
          className="icon-button"
          onClick={() => setCaptureOpen(true)}
          aria-label="Quick capture"
        >
          <PlusIcon />
        </button>
        <button
          className="icon-button"
          onClick={() => navigate({ kind: 'tasks' })}
          aria-label="Tasks"
          aria-pressed={route.kind === 'tasks'}
        >
          <TaskIcon />
        </button>
        <button
          className="icon-button"
          onClick={() => setPaletteOpen(true)}
          aria-label="Search pages and commands"
        >
          <SearchIcon />
        </button>
        <button
          className="icon-button"
          onClick={cycleTheme}
          aria-label={`Theme: ${theme}`}
          title={`Theme: ${theme}`}
        >
          {theme === 'dark' ? <MoonIcon /> : theme === 'light' ? <SunIcon /> : <SparkIcon />}
        </button>
      </header>

      <SyncPrompt onOpen={() => setSyncOpen(true)} />

      <div className="app-body">
        {showSidebar && (
          <>
            <Sidebar onNavigate={narrow ? () => setSidebarOpen(false) : undefined} />
            {narrow && <div className="scrim" onClick={() => setSidebarOpen(false)} />}
          </>
        )}

        <main className="main">
          {route.kind === 'tasks' ? (
            <TasksView />
          ) : (
            <Editor
              page={page}
              autofocus={!touchFirst}
              onEditor={setEditor}
              onSaveState={setSaveState}
            />
          )}

          {route.kind !== 'tasks' && words === 0 && !narrow && (
            <p className="empty-hint">
              <kbd>⌘K</kbd> to search · <kbd>/</kbd> for commands · just start typing
            </p>
          )}
        </main>
      </div>

      {narrow && route.kind !== 'tasks' && <MarkdownToolbar editor={editor} />}

      <StatusBar saveState={saveState} words={words} onOpenSync={() => setSyncOpen(true)} />

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

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
