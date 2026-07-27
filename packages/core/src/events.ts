import type { EventsApi, SparkEvents, Unsubscribe } from '@spark/plugin-sdk';

type AnyHandler = (payload: never) => void;

/**
 * Tiny typed event bus. Handlers that throw are logged and skipped so one bad
 * plugin can never break dispatch for everyone else.
 */
export class EventBus implements EventsApi {
  #handlers = new Map<string, Set<AnyHandler>>();

  on<K extends keyof SparkEvents>(
    event: K,
    fn: (payload: SparkEvents[K]) => void,
  ): Unsubscribe {
    let set = this.#handlers.get(event as string);
    if (!set) {
      set = new Set();
      this.#handlers.set(event as string, set);
    }
    set.add(fn as AnyHandler);
    return () => {
      set!.delete(fn as AnyHandler);
    };
  }

  emit<K extends keyof SparkEvents>(event: K, payload: SparkEvents[K]): void {
    const set = this.#handlers.get(event as string);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as (p: SparkEvents[K]) => void)(payload);
      } catch (err) {
        console.error(`[spark] handler for "${String(event)}" threw`, err);
      }
    }
  }

  /** Drops every handler. Used when tearing down a workspace. */
  clear(): void {
    this.#handlers.clear();
  }
}
