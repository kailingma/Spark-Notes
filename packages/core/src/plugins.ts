import type {
  PluginDefinition,
  SparkApi,
  Unsubscribe,
} from '@spark/plugin-sdk';
import type { Workspace } from './workspace.js';

export interface LoadedPlugin {
  definition: PluginDefinition;
  /** Where it came from — built-ins ship with the app, space plugins are files. */
  origin: 'builtin' | 'space';
  /** Set when activation failed; the plugin stays listed so it's debuggable. */
  error?: string;
}

/** Plugin files live here inside the space, so they travel with your notes. */
export const PLUGIN_DIR = '_plugins';

/**
 * Loads and unloads plugins, and hands each one a capability object scoped to
 * its own id.
 *
 * A plugin is an ordinary ES module. Space plugins are fetched as text and
 * imported from a blob URL, which keeps them in the normal module system (real
 * `import`, real `await`) without the app needing a bundler at runtime. A
 * failed plugin is isolated: it is recorded with its error and everything else
 * still loads.
 */
export class PluginHost {
  #loaded = new Map<string, LoadedPlugin>();
  #disposers = new Map<string, Unsubscribe[]>();
  #blobUrls: string[] = [];

  constructor(private readonly workspace: Workspace) {}

  list(): LoadedPlugin[] {
    return [...this.#loaded.values()];
  }

  /** Activates a plugin definition that's already in memory. */
  async load(
    definition: PluginDefinition,
    origin: 'builtin' | 'space' = 'builtin',
  ): Promise<void> {
    if (this.#loaded.has(definition.id)) await this.unload(definition.id);

    const entry: LoadedPlugin = { definition, origin };
    this.#loaded.set(definition.id, entry);
    this.#disposers.set(definition.id, []);

    try {
      await definition.activate(this.#api(definition.id));
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      console.error(`[spark] plugin "${definition.id}" failed to activate`, err);
    }
  }

  async unload(id: string): Promise<void> {
    const entry = this.#loaded.get(id);
    if (!entry) return;

    for (const dispose of this.#disposers.get(id) ?? []) {
      try {
        dispose();
      } catch (err) {
        console.error(`[spark] cleanup for "${id}" threw`, err);
      }
    }
    this.#disposers.delete(id);
    this.workspace.registry.removeOwner(id);

    try {
      await entry.definition.deactivate?.();
    } catch (err) {
      console.error(`[spark] deactivate for "${id}" threw`, err);
    }
    this.#loaded.delete(id);
  }

  async unloadAll(): Promise<void> {
    for (const id of [...this.#loaded.keys()]) await this.unload(id);
    for (const url of this.#blobUrls) URL.revokeObjectURL(url);
    this.#blobUrls = [];
  }

  /**
   * Scans `_plugins/` in the space and activates every `.js` file it finds.
   * Called at boot and whenever a plugin file is saved.
   */
  async loadFromSpace(): Promise<void> {
    let files: string[];
    try {
      const pages = await this.workspace.space.list();
      files = pages
        .map((page) => page.name)
        .filter((name) => name.startsWith(`${PLUGIN_DIR}/`));
    } catch (err) {
      console.error('[spark] could not list plugins', err);
      return;
    }

    // Plugin sources are stored with a `.js` extension, which the space keeps
    // verbatim rather than treating as markdown.
    await Promise.all(
      files
        .filter((name) => name.endsWith('.js'))
        .map((name) => this.#loadSpacePlugin(name)),
    );
  }

  async #loadSpacePlugin(name: string): Promise<void> {
    try {
      const { text } = await this.workspace.space.read(name);
      const definition = await importPluginModule(text);
      if (!definition?.id || typeof definition.activate !== 'function') {
        throw new Error('default export must be a plugin definition');
      }
      await this.load(definition, 'space');
    } catch (err) {
      const id = `space:${name}`;
      this.#loaded.set(id, {
        definition: { id, name, activate: () => {} },
        origin: 'space',
        error: err instanceof Error ? err.message : String(err),
      });
      console.error(`[spark] plugin "${name}" failed to load`, err);
    }
  }

  /** Builds the capability object a single plugin sees. */
  #api(id: string): SparkApi {
    const workspace = this.workspace;
    const track = (dispose: Unsubscribe): Unsubscribe => {
      this.#disposers.get(id)?.push(dispose);
      return dispose;
    };

    return {
      pluginId: id,
      space: workspace.space,
      editor: workspace.editor,
      ai: workspace.ai,
      ui: workspace.ui,
      commands: {
        register: (command) => track(workspace.registry.registerCommand(id, command)),
      },
      slash: {
        register: (command) => track(workspace.registry.registerSlash(id, command)),
      },
      markdown: {
        inline: (decorator) => track(workspace.registry.registerDecorator(id, decorator)),
      },
      events: {
        on: (event, fn) => track(workspace.events.on(event, fn)),
        emit: (event, payload) => workspace.events.emit(event, payload),
      },
      settings: workspace.settings.scoped(id),
      tasks: () => workspace.tasks.all(),
      onUnload: (fn) => {
        track(fn);
      },
    };
  }
}

/**
 * Turns plugin source into a live module.
 *
 * The SDK is types-only at runtime, so we point its import specifier at a tiny
 * shim the server serves. That lets plugin authors write the same
 * `import { definePlugin } from '@spark/plugin-sdk'` they'd write in a
 * TypeScript project.
 */
export async function importPluginModule(
  source: string,
  sdkUrl = '/plugin-sdk.js',
): Promise<PluginDefinition> {
  // Must be absolute: a blob: URL has an opaque base, so a module inside one
  // cannot resolve a root-relative specifier like "/plugin-sdk.js".
  const absoluteSdkUrl = new URL(sdkUrl, globalThis.location?.origin ?? 'http://localhost').href;

  const rewritten = source.replace(
    /(["'])@spark\/plugin-sdk\1/g,
    JSON.stringify(absoluteSdkUrl),
  );
  const url = URL.createObjectURL(
    new Blob([rewritten], { type: 'text/javascript' }),
  );
  try {
    const module = (await import(/* @vite-ignore */ url)) as {
      default?: PluginDefinition;
    };
    return module.default as PluginDefinition;
  } finally {
    // Safe to revoke once the module graph has been instantiated.
    URL.revokeObjectURL(url);
  }
}
