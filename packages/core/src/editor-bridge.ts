import type { EditorApi, EditorSelection, Unsubscribe } from '@spark/plugin-sdk';

/**
 * A stable `EditorApi` handle that outlives any particular editor instance.
 *
 * Plugins capture `spark.editor` once at activation, but the actual editors are
 * mounted and torn down as you move between pages — and since the workbench can
 * tile several of them side by side, there is usually more than one alive at
 * once. The bridge forwards to whichever editor was focused most recently and
 * degrades to harmless no-ops when there is none, so a plugin firing a command
 * on an empty screen can't throw.
 *
 * "Most recently focused" rather than "most recently mounted" is the whole
 * point: with two notes open, `Bold` has to act on the one you are typing in,
 * not on whichever pane React happened to render last.
 */
export class EditorBridge implements EditorApi {
  /** Attached editors, most recently focused last. */
  #stack: EditorApi[] = [];
  #listeners = new Set<(text: string) => void>();

  /** Called by an editor when it mounts. Returns a detach function. */
  attach(delegate: EditorApi): Unsubscribe {
    this.#stack.push(delegate);

    // Re-point every subscription made before this editor existed. Changes are
    // announced whichever pane they happen in: a plugin watching the document
    // wants to know about the edit, not about which tile it landed in.
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
      const index = this.#stack.indexOf(delegate);
      if (index >= 0) this.#stack.splice(index, 1);
    };
  }

  /** Promotes an attached editor to the front. Called when a pane takes focus. */
  activate(delegate: EditorApi): void {
    const index = this.#stack.indexOf(delegate);
    if (index < 0 || index === this.#stack.length - 1) return;
    this.#stack.splice(index, 1);
    this.#stack.push(delegate);
  }

  get #delegate(): EditorApi | null {
    return this.#stack[this.#stack.length - 1] ?? null;
  }

  get attached(): boolean {
    return this.#stack.length > 0;
  }

  /**
   * The live text of a page, if some editor currently has it open.
   *
   * Lets a reader see what is on screen rather than what is on disk — the
   * difference is one autosave debounce, which is exactly the window in which
   * someone asks Spark about the paragraph they just typed.
   */
  textOf(page: string): string | null {
    for (let i = this.#stack.length - 1; i >= 0; i--) {
      const editor = this.#stack[i];
      if (editor.page() === page) return editor.text();
    }
    return null;
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
