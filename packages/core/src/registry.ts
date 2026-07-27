import type {
  Command,
  InlineDecorator,
  SlashCommand,
  Unsubscribe,
} from '@spark/plugin-sdk';

/** An entry plus the plugin that contributed it, so unloading can clean up. */
interface Owned<T> {
  owner: string;
  value: T;
}

/**
 * Everything plugins (and the app's own built-ins) contribute to the UI:
 * commands, slash completions and inline markdown widgets.
 *
 * The registry is observable so React views and the CodeMirror extensions can
 * re-render the moment a plugin loads or unloads.
 */
export class Registry {
  #commands: Owned<Command>[] = [];
  #slash: Owned<SlashCommand>[] = [];
  #decorators: Owned<InlineDecorator>[] = [];
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

  /** Drops everything contributed by a plugin. */
  removeOwner(owner: string): void {
    const before =
      this.#commands.length + this.#slash.length + this.#decorators.length;
    this.#commands = this.#commands.filter((entry) => entry.owner !== owner);
    this.#slash = this.#slash.filter((entry) => entry.owner !== owner);
    this.#decorators = this.#decorators.filter((entry) => entry.owner !== owner);
    const after =
      this.#commands.length + this.#slash.length + this.#decorators.length;
    if (before !== after) this.#notify();
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

  #notify(): void {
    this.#version++;
    for (const fn of this.#listeners) fn();
  }
}
