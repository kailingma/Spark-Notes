import type { PluginDefinition, UiApi } from '@spark/plugin-sdk';
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
}

const DEFAULT_CONFIG: ServerConfig = {
  spaceName: 'Spark',
  ai: false,
  git: false,
  githubAuth: false,
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

const fallbackUi: UiApi = {
  toast: (message) => console.info(`[spark] ${message}`),
  statusItem: () => ({ set: () => {}, onClick: () => {}, remove: () => {} }),
  panel: () => () => {},
  prompt: async () => null,
  select: async () => null,
  navigate: () => {},
};
