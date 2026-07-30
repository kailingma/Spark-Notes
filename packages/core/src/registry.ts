import type {
  Command,
  FontPackDefinition,
  InlineDecorator,
  SlashCommand,
  ThemeDefinition,
  Unsubscribe,
  ViewDefinition,
} from '@spark/plugin-sdk';

/** An entry plus the plugin that contributed it, so unloading can clean up. */
interface Owned<T> {
  owner: string;
  value: T;
}

/**
 * Everything plugins (and the app's own built-ins) contribute to the UI:
 * commands, slash completions, inline markdown widgets and window views.
 *
 * The registry is observable so React views and the CodeMirror extensions can
 * re-render the moment a plugin loads or unloads.
 */
export class Registry {
  #commands: Owned<Command>[] = [];
  #slash: Owned<SlashCommand>[] = [];
  #decorators: Owned<InlineDecorator>[] = [];
  #views: Owned<ViewDefinition>[] = [];
  #themes: Owned<ThemeDefinition>[] = [];
  #fontPacks: Owned<FontPackDefinition>[] = [];
  #listeners = new Set<() => void>();
  #version = 0;

  /** Bumped on every change — a cheap `useSyncExternalStore` snapshot. */
  get version(): number {
    return this.#version;
  }

  subscribe(fn: () => void): Unsubscribe {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  registerCommand(owner: string, command: Command): Unsubscribe {
    return this.#add(this.#commands, owner, command);
  }

  registerSlash(owner: string, command: SlashCommand): Unsubscribe {
    return this.#add(this.#slash, owner, command);
  }

  registerDecorator(owner: string, decorator: InlineDecorator): Unsubscribe {
    return this.#add(this.#decorators, owner, decorator);
  }

  /**
   * A view type the workbench can open in a tab, a floating window or a dock.
   *
   * The definition mounts into a plain element rather than returning a
   * framework's node, so a plugin loaded from a `.js` file in the space has the
   * same reach as anything the shell ships.
   */
  registerView(owner: string, view: ViewDefinition): Unsubscribe {
    return this.#add(this.#views, owner, view);
  }

  /**
   * A palette. Registering the same id twice replaces the first, so a space
   * plugin can iterate on a theme by saving the file rather than by inventing
   * `my-theme-2` — and so reloading `_plugins/` cannot leave two of them behind.
   */
  registerTheme(owner: string, theme: ThemeDefinition): Unsubscribe {
    return this.#addUnique(this.#themes, owner, theme, theme.id);
  }

  /** A set of faces and the roles they play. Same replacement rule as themes. */
  registerFontPack(owner: string, pack: FontPackDefinition): Unsubscribe {
    return this.#addUnique(this.#fontPacks, owner, pack, pack.id);
  }

  themes(): ThemeDefinition[] {
    return this.#themes.map((entry) => entry.value);
  }

  theme(id: string): ThemeDefinition | undefined {
    return this.#themes.find((entry) => entry.value.id === id)?.value;
  }

  fontPacks(): FontPackDefinition[] {
    return this.#fontPacks.map((entry) => entry.value);
  }

  fontPack(id: string): FontPackDefinition | undefined {
    return this.#fontPacks.find((entry) => entry.value.id === id)?.value;
  }

  commands(): Command[] {
    return this.#commands.map((entry) => entry.value);
  }

  /** Commands that pass their own `available()` check, for the palette. */
  availableCommands(): Command[] {
    return this.commands().filter((command) => {
      try {
        return command.available?.() ?? true;
      } catch {
        return false;
      }
    });
  }

  command(id: string): Command | undefined {
    return this.#commands.find((entry) => entry.value.id === id)?.value;
  }

  slashCommands(): SlashCommand[] {
    return this.#slash.map((entry) => entry.value);
  }

  decorators(): InlineDecorator[] {
    return this.#decorators.map((entry) => entry.value);
  }

  views(): ViewDefinition[] {
    return this.#views.map((entry) => entry.value);
  }

  view(id: string): ViewDefinition | undefined {
    return this.#views.find((entry) => entry.value.id === id)?.value;
  }

  /** Drops everything contributed by a plugin. */
  removeOwner(owner: string): void {
    const count = () =>
      this.#commands.length +
      this.#slash.length +
      this.#decorators.length +
      this.#views.length +
      this.#themes.length +
      this.#fontPacks.length;
    const before = count();
    this.#commands = this.#commands.filter((entry) => entry.owner !== owner);
    this.#slash = this.#slash.filter((entry) => entry.owner !== owner);
    this.#decorators = this.#decorators.filter((entry) => entry.owner !== owner);
    this.#views = this.#views.filter((entry) => entry.owner !== owner);
    this.#themes = this.#themes.filter((entry) => entry.owner !== owner);
    this.#fontPacks = this.#fontPacks.filter((entry) => entry.owner !== owner);
    if (before !== count()) this.#notify();
  }

  #add<T>(list: Owned<T>[], owner: string, value: T): Unsubscribe {
    const entry = { owner, value };
    list.push(entry);
    this.#notify();
    return () => {
      const index = list.indexOf(entry);
      if (index >= 0) {
        list.splice(index, 1);
        this.#notify();
      }
    };
  }

  /**
   * Like `#add`, but keyed: an entry with the same id takes the old one's
   * place instead of joining it in the list.
   *
   * Only themes and font packs work this way, because they are *chosen by id*
   * and a duplicate would be a second entry the settings panel lists and the
   * resolver never reaches. Commands deliberately do not: two plugins each
   * contributing `Bold` is a conflict worth seeing, not one worth hiding.
   */
  #addUnique<T>(list: Owned<T>[], owner: string, value: T, id: string): Unsubscribe {
    const entry = { owner, value };
    const existing = list.findIndex((other) => (other.value as { id: string }).id === id);
    if (existing >= 0) list[existing] = entry;
    else list.push(entry);
    this.#notify();
    return () => {
      // Only if it is still ours — a later registration of the same id owns the
      // slot now, and removing it would drop a live theme.
      const index = list.indexOf(entry);
      if (index >= 0) {
        list.splice(index, 1);
        this.#notify();
      }
    };
  }

  #notify(): void {
    this.#version++;
    for (const fn of this.#listeners) fn();
  }
}
