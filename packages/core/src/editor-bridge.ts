import type { EditorApi, EditorSelection, Unsubscribe } from '@spark/plugin-sdk';

/**
 * A stable `EditorApi` handle that outlives any particular editor instance.
 *
 * Plugins capture `spark.editor` once at activation, but the actual editor is
 * mounted and torn down as you move between pages. The bridge forwards to
 * whichever editor is live and degrades to harmless no-ops when there is none,
 * so a plugin firing a command on an empty screen can't throw.
 */
export class EditorBridge implements EditorApi {
  #delegate: EditorApi | null = null;
  #listeners = new Set<(text: string) => void>();

  /** Called by the editor when it mounts. Returns a detach function. */
  attach(delegate: EditorApi): Unsubscribe {
    this.#delegate = delegate;
    // Re-point every subscription made before this editor existed.
    const off = delegate.onChange((text) => {
      for (const fn of [...this.#listeners]) {
        try {
          fn(text);
        } catch (err) {
          console.error('[spark] editor change handler threw', err);
        }
      }
    });
    return () => {
      off();
      if (this.#delegate === delegate) this.#delegate = null;
    };
  }

  get attached(): boolean {
    return this.#delegate !== null;
  }

  page(): string | null {
    return this.#delegate?.page() ?? null;
  }

  text(): string {
    return this.#delegate?.text() ?? '';
  }

  selection(): EditorSelection {
    return this.#delegate?.selection() ?? { from: 0, to: 0 };
  }

  selectedText(): string {
    return this.#delegate?.selectedText() ?? '';
  }

  replaceSelection(text: string): void {
    this.#delegate?.replaceSelection(text);
  }

  insert(text: string, at?: number): void {
    this.#delegate?.insert(text, at);
  }

  replaceRange(from: number, to: number, text: string): void {
    this.#delegate?.replaceRange(from, to, text);
  }

  setSelection(from: number, to?: number): void {
    this.#delegate?.setSelection(from, to);
  }

  setText(text: string): void {
    this.#delegate?.setText(text);
  }

  focus(): void {
    this.#delegate?.focus();
  }

  toggleWrap(before: string, after?: string): void {
    this.#delegate?.toggleWrap(before, after);
  }

  onChange(fn: (text: string) => void): Unsubscribe {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}
