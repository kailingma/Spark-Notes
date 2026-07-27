import type { SettingsApi } from '@spark/plugin-sdk';

/**
 * Device-local settings, namespaced per plugin.
 *
 * Deliberately not stored in the space: these are per-device preferences
 * (theme, sync mode, which panel was open) and syncing them through git would
 * only produce conflicts. Anything that belongs to the *notes* goes in the
 * markdown itself.
 */
export class SettingsStore {
  #memory = new Map<string, unknown>();

  constructor(private readonly prefix = 'spark') {}

  scoped(namespace: string): SettingsApi {
    return {
      get: <T>(key: string, fallback: T) => this.get(`${namespace}.${key}`, fallback),
      set: (key: string, value: unknown) => this.set(`${namespace}.${key}`, value),
    };
  }

  get<T>(key: string, fallback: T): T {
    const full = `${this.prefix}:${key}`;
    if (this.#memory.has(full)) return this.#memory.get(full) as T;
    try {
      const raw = globalThis.localStorage?.getItem(full);
      if (raw === null || raw === undefined) return fallback;
      const parsed = JSON.parse(raw) as T;
      this.#memory.set(full, parsed);
      return parsed;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: unknown): void {
    const full = `${this.prefix}:${key}`;
    this.#memory.set(full, value);
    try {
      globalThis.localStorage?.setItem(full, JSON.stringify(value));
    } catch {
      // Private browsing or a full quota — memory-only is a fine fallback.
    }
  }

  remove(key: string): void {
    const full = `${this.prefix}:${key}`;
    this.#memory.delete(full);
    try {
      globalThis.localStorage?.removeItem(full);
    } catch {
      /* ignore */
    }
  }
}
