import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Workspace, type ServerConfig } from '@spark/core';
import type { PageMeta, SyncStatus, Task, ToastKind, UiApi } from '@spark/plugin-sdk';
import { builtinPlugins } from './builtins';
import {
  applyAppearance,
  loadAppearance,
  saveAppearance,
  type Appearance,
} from './lib/appearance';
import { activeScheme, applyTheme } from './lib/theme';
import {
  applyPreferences,
  loadPreferences,
  savePreferences,
  type Preferences,
} from './lib/preferences';
import { forgetCachedPage, readCachedList, writeCachedList } from './lib/page-cache';
import { useRoute, type Route } from './lib/router';

/**
 * How long a save to an already-known page waits before the space is re-listed.
 *
 * Long enough that a burst of autosaves costs one request rather than one each,
 * short enough that a word count or a modified time is never visibly stale.
 */
const LIST_REFRESH_DELAY = 1500;

/**
 * The one React-facing seam over the framework-agnostic `Workspace`.
 *
 * Everything stateful the shell needs — route, page list, tasks, sync status,
 * toasts, modal prompts — lives here, so components stay presentational and a
 * future mobile or desktop shell can reuse `@spark/core` without touching any
 * of this.
 */

export interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface PendingPrompt {
  kind: 'prompt';
  message: string;
  initial: string;
  resolve: (value: string | null) => void;
}

interface PendingSelect {
  kind: 'select';
  message: string;
  options: string[];
  resolve: (value: string | null) => void;
}

export type PendingDialog = PendingPrompt | PendingSelect;

interface AppContextValue {
  workspace: Workspace;
  ready: boolean;
  config: ServerConfig;
  /** Re-reads `/api/config` after something server-side changes, e.g. an AI key. */
  refreshConfig: () => Promise<void>;

  appearance: Appearance;
  /** Merges a change into the appearance and applies it immediately. */
  setAppearance: (patch: Partial<Appearance>) => void;

  preferences: Preferences;
  /** Merges a change into the preferences and applies it immediately. */
  setPreferences: (patch: Partial<Preferences>) => void;

  route: Route;
  navigate: (route: Route, replace?: boolean) => void;
  /**
   * Opens a page, optionally putting the cursor on a zero-based line.
   *
   * The workbench installs the real implementation during mount, because where
   * a page should go is a question about tiles and windows. Until then, and in
   * any shell that has no workbench, this falls back to plain navigation.
   */
  openPage: (page: string, line?: number) => void;
  /** Called by the workbench to take over `openPage`. Returns a disposer. */
  setPageOpener: (open: (page: string, line?: number) => void) => () => void;
  /**
   * Line the next editor load should jump to, consumed once. A ref rather than
   * state: it is a one-shot instruction to the editor, not something anything
   * renders from.
   */
  pendingLine: { current: { page: string; line: number } | null };

  pages: PageMeta[];
  refreshPages: () => Promise<void>;

  /** Every folder in the space, including the empty ones. */
  folders: string[];
  refreshFolders: () => Promise<void>;

  tasks: Task[];
  refreshTasks: () => Promise<void>;

  sync: SyncStatus;
  gitDirty: boolean;

  toasts: Toast[];
  toast: (message: string, kind?: ToastKind) => void;
  dismissToast: (id: number) => void;

  dialog: PendingDialog | null;
  resolveDialog: (value: string | null) => void;

  /** Bumped whenever plugins register or unregister anything. */
  registryVersion: number;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

let toastId = 0;

export function AppProvider({ children }: { children: ReactNode }) {
  // One workspace for the lifetime of the app.
  const workspace = useMemo(() => new Workspace(), []);

  const [ready, setReady] = useState(false);
  const [config, setConfig] = useState<ServerConfig>(workspace.config);

  // Seeded from the last session so the navigator, the palette and `[[`
  // completion have something in them in the first frame. The real lists land a
  // moment later and replace these; the point is that nothing starts empty and
  // then visibly fills in.
  const [pages, setPages] = useState<PageMeta[]>(() => readCachedList<PageMeta>('pages') ?? []);
  const [folders, setFolders] = useState<string[]>(() => readCachedList<string>('folders') ?? []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sync, setSync] = useState<SyncStatus>({ mode: 'online' });
  const [gitDirty, setGitDirty] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [registryVersion, setRegistryVersion] = useState(0);

  // Read once, from local storage, before the first paint: the theme and the
  // reading size have to be right in the first frame or the app flashes.
  const [appearance, setAppearanceState] = useState<Appearance>(() => {
    const initial = loadAppearance(workspace.settings);
    applyAppearance(initial);
    return initial;
  });

  const [preferences, setPreferencesState] = useState<Preferences>(() => {
    const initial = loadPreferences(workspace.settings);
    applyPreferences(initial);
    return initial;
  });

  const [route, navigate] = useRoute();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // -- toasts ---------------------------------------------------------------

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = ++toastId;
      setToasts((current) => [...current, { id, message, kind }]);
      // Errors stay long enough to actually be read.
      window.setTimeout(() => dismissToast(id), kind === 'error' ? 7000 : 3200);
    },
    [dismissToast],
  );

  // -- appearance -----------------------------------------------------------

  const setAppearance = useCallback(
    (patch: Partial<Appearance>) => {
      setAppearanceState((current) => {
        const next = { ...current, ...patch };
        applyAppearance(next);
        saveAppearance(workspace.settings, next);
        return next;
      });
    },
    [workspace],
  );

  const setPreferences = useCallback(
    (patch: Partial<Preferences>) => {
      setPreferencesState((current) => {
        const next = { ...current, ...patch };
        applyPreferences(next);
        savePreferences(workspace.settings, next);
        return next;
      });
    },
    [workspace],
  );

  // -- theming --------------------------------------------------------------
  //
  // The palette is a generated stylesheet rather than a set of attributes, so it
  // is rebuilt whenever the appearance changes *or* the registry does — a theme
  // arrives with its plugin, which is well after the first paint.
  //
  // An insertion effect, which is the one React runs before layout effects and
  // before the browser has measured anything: this is a stylesheet write, which
  // is exactly what the hook is for, and doing it in an ordinary effect would
  // paint one frame of the old palette every time you changed theme. It only
  // reads the registry, so it cannot loop the way a callback keyed on
  // `registryVersion` would.
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;

  useInsertionEffect(() => {
    applyTheme({
      themes: workspace.registry.themes(),
      packs: workspace.registry.fontPacks(),
      appearance,
    });
  }, [workspace, appearance, registryVersion]);

  // -- modal prompts --------------------------------------------------------

  const resolveDialog = useCallback(
    (value: string | null) => {
      dialog?.resolve(value);
      setDialog(null);
    },
    [dialog],
  );

  // -- data -----------------------------------------------------------------

  const refreshPages = useCallback(async () => {
    try {
      const listed = await workspace.space.list();
      setPages(listed);
      writeCachedList('pages', listed);
    } catch (err) {
      console.error('[spark] could not list pages', err);
    }
  }, [workspace]);

  const refreshFolders = useCallback(async () => {
    try {
      const listed = await workspace.space.folders();
      setFolders(listed);
      writeCachedList('folders', listed);
    } catch {
      // An older server has no folder endpoint; the tree still builds from the
      // folders implied by page names, which is what it always did.
    }
  }, [workspace]);

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await workspace.tasks.refresh());
    } catch (err) {
      console.error('[spark] could not scan tasks', err);
    }
  }, [workspace]);

  const refreshConfig = useCallback(async () => {
    setConfig(await workspace.refreshConfig());
  }, [workspace]);

  const pendingLine = useRef<{ page: string; line: number } | null>(null);

  // Installed by the workbench. A ref rather than state because it changes once,
  // during mount, and every caller should see the new one without re-rendering.
  const pageOpener = useRef<((page: string, line?: number) => void) | null>(null);

  const setPageOpener = useCallback((open: (page: string, line?: number) => void) => {
    pageOpener.current = open;
    return () => {
      if (pageOpener.current === open) pageOpener.current = null;
    };
  }, []);

  const openPage = useCallback((page: string, line?: number) => {
    if (pageOpener.current) {
      pageOpener.current(page, line);
      return;
    }
    pendingLine.current = line === undefined ? null : { page, line };
    navigateRef.current({ kind: 'page', page });
  }, []);

  // -- boot -----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    // The UI implementation is installed before start() so a plugin that
    // toasts during activation reaches the real UI, not the console fallback.
    const ui: UiApi = {
      toast: (message, kind) => toast(message, kind),
      navigate: (page) => navigateRef.current({ kind: 'page', page }),
      statusItem: () => ({ set: () => {}, onClick: () => {}, remove: () => {} }),
      panel: () => () => {},
      prompt: (message, initial = '') =>
        new Promise<string | null>((resolve) => {
          setDialog({ kind: 'prompt', message, initial, resolve });
        }),
      select: <T extends string>(message: string, options: T[]) =>
        new Promise<T | null>((resolve) => {
          setDialog({
            kind: 'select',
            message,
            options,
            resolve: resolve as (value: string | null) => void,
          });
        }),
    };
    workspace.setUi(ui);

    // The half of theming that needs the shell. Installed before `start()` so a
    // plugin can put its own theme on during activation, and reading through a
    // ref so `active()` is never a render-old answer.
    workspace.setThemes({
      active: () => appearanceRef.current.themeId,
      scheme: () => activeScheme(appearanceRef.current.theme),
      use: (themeId) => {
        // Refused rather than applied: storing an id nothing has registered
        // would leave the app on its default palette with no way to tell from
        // the settings panel that anything had happened.
        if (!workspace.registry.theme(themeId)) {
          console.warn(`[spark] no theme "${themeId}" is registered`);
          return;
        }
        setAppearance({ themeId });
      },
    });

    const offTasks = workspace.events.on('tasks:change', ({ tasks: next }) => {
      if (!cancelled) setTasks(next);
    });
    const offSync = workspace.events.on('sync:change', ({ status }) => {
      if (!cancelled) setSync(status);
    });
    const offRegistry = workspace.registry.subscribe(() => {
      if (!cancelled) setRegistryVersion((n) => n + 1);
    });

    void (async () => {
      await workspace.start(builtinPlugins);
      if (cancelled) return;
      setConfig(workspace.config);
      setGitDirty((workspace.sync.git?.dirty ?? 0) > 0);
      await Promise.all([refreshPages(), refreshFolders()]);
      if (!cancelled) setReady(true);
    })();

    // Only this effect's own subscriptions are removed. The workspace itself
    // outlives the effect — disposing it here would clear the shared event bus
    // and silently unsubscribe every other component on the next remount.
    return () => {
      cancelled = true;
      offTasks();
      offSync();
      offRegistry();
    };
  }, [workspace, toast, refreshPages, refreshFolders, setAppearance]);

  /**
   * Keep the page list current after saves and deletes.
   *
   * A save to a page that is *already* in the list changes nothing anybody is
   * looking at except a modified time, so it is coalesced: autosave fires every
   * few hundred milliseconds while you type, and re-listing the whole space
   * twice per keystroke-burst is two requests competing with the write that
   * actually matters. A page that is new, or gone, refreshes at once — that one
   * is a change to what is on screen.
   *
   * Folders come along for the ride, because writing `notes/idea` creates a
   * folder that was not there before.
   */
  const pageNames = useRef(new Set<string>());
  pageNames.current = new Set(pages.map((meta) => meta.name));

  useEffect(() => {
    let timer: number | null = null;

    const refreshNow = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      void refreshPages();
      void refreshFolders();
    };

    const onSave = ({ page }: { page: string }) => {
      if (!pageNames.current.has(page)) {
        refreshNow();
        return;
      }
      if (timer !== null) return;
      timer = window.setTimeout(refreshNow, LIST_REFRESH_DELAY);
    };

    const offSave = workspace.events.on('page:save', onSave);
    const offDelete = workspace.events.on('page:delete', ({ page }) => {
      forgetCachedPage(page);
      refreshNow();
    });

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      offSave();
      offDelete();
    };
  }, [workspace, refreshPages, refreshFolders]);

  // The OAuth popup posts back when GitHub returns; pick the new user up.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data !== 'spark:auth') return;
      void (async () => {
        const res = await fetch('/api/config');
        if (res.ok) setConfig((await res.json()) as ServerConfig);
        await workspace.sync.refresh();
        toast('GitHub connected.', 'success');
      })();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [workspace, toast]);

  const value: AppContextValue = {
    workspace,
    ready,
    config,
    refreshConfig,
    appearance,
    setAppearance,
    preferences,
    setPreferences,
    route,
    navigate,
    openPage,
    setPageOpener,
    pendingLine,
    pages,
    refreshPages,
    folders,
    refreshFolders,
    tasks,
    refreshTasks,
    sync,
    gitDirty,
    toasts,
    toast,
    dismissToast,
    dialog,
    resolveDialog,
    registryVersion,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
