import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Workspace, type ServerConfig } from '@spark/core';
import type { PageMeta, SyncStatus, Task, ToastKind, UiApi } from '@spark/plugin-sdk';
import { builtinPlugins } from './builtins';
import { useRoute, type Route } from './lib/router';

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

  route: Route;
  navigate: (route: Route, replace?: boolean) => void;
  openPage: (page: string) => void;

  pages: PageMeta[];
  refreshPages: () => Promise<void>;

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
  const [pages, setPages] = useState<PageMeta[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [sync, setSync] = useState<SyncStatus>({ mode: 'online' });
  const [gitDirty, setGitDirty] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
  const [registryVersion, setRegistryVersion] = useState(0);

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
      setPages(await workspace.space.list());
    } catch (err) {
      console.error('[spark] could not list pages', err);
    }
  }, [workspace]);

  const refreshTasks = useCallback(async () => {
    try {
      setTasks(await workspace.tasks.refresh());
    } catch (err) {
      console.error('[spark] could not scan tasks', err);
    }
  }, [workspace]);

  const openPage = useCallback((page: string) => {
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
      await refreshPages();
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
  }, [workspace, toast, refreshPages]);

  // Keep the page list current after saves and deletes.
  useEffect(() => {
    const offSave = workspace.events.on('page:save', () => void refreshPages());
    const offDelete = workspace.events.on('page:delete', () => void refreshPages());
    return () => {
      offSave();
      offDelete();
    };
  }, [workspace, refreshPages]);

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
    route,
    navigate,
    openPage,
    pages,
    refreshPages,
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
