import type { PluginDefinition, ThemeScheme, UiApi, WindowsApi } from '@spark/plugin-sdk';
import { AiClient } from './ai.js';
import { EditorBridge } from './editor-bridge.js';
import { EventBus } from './events.js';
import { PluginHost } from './plugins.js';
import { Registry } from './registry.js';
import { SettingsStore } from './settings.js';
import { HttpSpace } from './space.js';
import { SyncController } from './sync.js';
import { TaskIndex } from './tasks.js';

/** What the server tells us about itself at boot. */
export interface ServerConfig {
  /** Human-readable name of the space, shown in the UI. */
  spaceName: string;
  /** True when an AI provider key is present on the server. */
  ai: boolean;
  /** True when the space is a git repo. */
  git: boolean;
  /** True when GitHub OAuth is configured, so "Connect GitHub" can work. */
  githubAuth: boolean;
  /** Connected GitHub user, when there is one. */
  user?: { login: string; name?: string; avatar?: string };
  /** True when an embedding model is named, so `find` can search by meaning. */
  embeddings: boolean;
  /**
   * The code sandbox, when the server has one. Null is the ordinary state.
   *
   * The server decides this, not a preference: whether this machine will execute
   * generated code is a property of the machine, so the UI can only report it.
   */
  sandbox: { runtime: string; describe: string } | null;
  /**
   * A one-line finding from Spark's opt-in background scan, unseen so far —
   * see `apps/server/src/proactive.ts`. `null` when the setting is off, or
   * on but nothing is due, or the last finding has already been shown. The
   * "Ask Spark" button badges on this and clears it on the click that opens
   * the panel.
   */
  proactiveFinding: string | null;
}

/**
 * The half of theming that needs a live shell.
 *
 * Registering a theme goes through the registry and works before anything is on
 * screen; *wearing* one is a question about the document element and the stored
 * appearance, which only the shell knows about. Same split as `WindowsApi`, for
 * the same reason.
 */
export interface ThemeHost {
  active(): string;
  scheme(): ThemeScheme;
  use(themeId: string): void;
}

const DEFAULT_CONFIG: ServerConfig = {
  spaceName: 'Spark',
  ai: false,
  git: false,
  githubAuth: false,
  embeddings: false,
  sandbox: null,
  proactiveFinding: null,
};

/**
 * The composition root. One `Workspace` per running app; everything else —
 * React views, CodeMirror extensions, plugins — reaches through it.
 *
 * Nothing in here imports a UI framework, so the same object graph backs the
 * web app today and a mobile or desktop shell later.
 */
export class Workspace {
  readonly events = new EventBus();
  readonly registry = new Registry();
  readonly settings = new SettingsStore();
  readonly editor = new EditorBridge();
  readonly space: HttpSpace;
  readonly ai: AiClient;
  readonly tasks: TaskIndex;
  readonly sync: SyncController;
  readonly plugins: PluginHost;

  #config: ServerConfig = DEFAULT_CONFIG;
  #ui: UiApi | null = null;
  #windows: WindowsApi | null = null;
  #themes: ThemeHost | null = null;
  #startup: Promise<void> | null = null;

  constructor(apiBase = '/api') {
    this.space = new HttpSpace(`${apiBase}/space`);
    this.ai = new AiClient(`${apiBase}/ai`);
    this.tasks = new TaskIndex(this.space, this.events, `${apiBase}/tasks`);
    this.sync = new SyncController(this.events, `${apiBase}/git`);
    this.plugins = new PluginHost(this);
  }

  get config(): ServerConfig {
    return this.#config;
  }

  /**
   * The app shell installs its own UI implementation here during mount. Until
   * then calls fall back to the console rather than throwing, so a plugin that
   * activates early can't take the app down.
   */
  setUi(ui: UiApi): void {
    this.#ui = ui;
  }

  get ui(): UiApi {
    return this.#ui ?? fallbackUi;
  }

  /**
   * The workbench installs itself here during mount, the same way the shell
   * installs its UI. Registration of view *types* goes through the registry and
   * works before the workbench exists; only opening one needs a live layout, so
   * that is the half that falls back to a no-op.
   */
  setWindows(windows: WindowsApi): void {
    this.#windows = windows;
  }

  get windows(): WindowsApi {
    return this.#windows ?? this.#fallbackWindows;
  }

  #fallbackWindows: WindowsApi = {
    register: (view) => this.registry.registerView('app', view),
    open: (viewId) => {
      console.info(`[spark] no workbench yet; cannot open "${viewId}"`);
      return '';
    },
    close: () => {},
    move: () => {},
    visible: () => [],
  };

  /** Installed by the shell during mount, alongside the UI and the workbench. */
  setThemes(themes: ThemeHost): void {
    this.#themes = themes;
  }

  get themes(): ThemeHost {
    return this.#themes ?? fallbackThemes;
  }

  /**
   * Boots the workspace: server config, then the task index and plugins in
   * parallel. Failures are non-fatal — a broken plugin or an unreachable task
   * scan must still leave you with a working editor.
   *
   * Idempotent, and deliberately so: React StrictMode and hot reloading both
   * run mount effects more than once, and booting twice would load every plugin
   * twice and register duplicate listeners.
   */
  start(builtins: PluginDefinition[] = []): Promise<void> {
    this.#startup ??= this.#start(builtins);
    return this.#startup;
  }

  async #start(builtins: PluginDefinition[]): Promise<void> {
    await this.#loadConfig();

    await Promise.allSettled([
      this.tasks.refresh(),
      this.sync.refresh(),
      (async () => {
        for (const plugin of builtins) await this.plugins.load(plugin, 'builtin');
        await this.plugins.loadFromSpace();
      })(),
    ]);

    // Keep the task index current as pages are saved and deleted.
    this.events.on('page:save', ({ page, text }) => this.tasks.update(page, text));
    this.events.on('page:delete', ({ page }) => this.tasks.remove(page));
  }

  /**
   * Tears the workspace down for good.
   *
   * Only call this when the whole app is going away. It clears the event bus,
   * which means every subscription — including ones other components made — is
   * dropped; calling it from a component's effect cleanup would silently
   * unsubscribe the rest of the app on the next remount.
   */
  async dispose(): Promise<void> {
    this.sync.dispose();
    await this.plugins.unloadAll();
    this.events.clear();
    this.#startup = null;
  }

  /**
   * Re-reads `/api/config`. Called after something server-side changes — an AI
   * key being saved, GitHub being connected — so the app learns about a
   * capability that appeared without needing a reload.
   */
  async refreshConfig(): Promise<ServerConfig> {
    await this.#loadConfig();
    return this.#config;
  }

  async #loadConfig(): Promise<void> {
    try {
      const res = await fetch('/api/config');
      if (res.ok) this.#config = { ...DEFAULT_CONFIG, ...(await res.json()) };
    } catch {
      // Offline at boot: keep defaults so the shell still renders.
    }
    this.ai.setEnabled(this.#config.ai);
  }
}

/**
 * Before the shell is up, a plugin can still ask what is worn — it just gets the
 * honest answer that nothing has been resolved yet, rather than an exception on
 * a line that only wanted to read a name.
 */
const fallbackThemes: ThemeHost = {
  active: () => '',
  scheme: () => 'light',
  use: (themeId) => console.info(`[spark] no shell yet; cannot wear "${themeId}"`),
};

const fallbackUi: UiApi = {
  toast: (message) => console.info(`[spark] ${message}`),
  statusItem: () => ({ set: () => {}, onClick: () => {}, remove: () => {} }),
  panel: () => () => {},
  prompt: async () => null,
  select: async () => null,
  navigate: () => {},
};
