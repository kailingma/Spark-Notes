import { EditorView, WidgetType } from '@codemirror/view';

/**
 * A real checkbox rendered in place of `[ ]` / `[x]`.
 *
 * Always rendered, even when the cursor is on the line: the marker is a control
 * rather than prose, and hiding it while editing the task text would make the
 * line jump. Clicking it rewrites the source, which keeps the markdown file the
 * single source of truth.
 */
export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly to: number,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.from === this.from;
  }

  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'cm-spark-checkbox';
    input.checked = this.checked;
    input.setAttribute('aria-label', this.checked ? 'Completed task' : 'Open task');

    input.addEventListener('mousedown', (event) => {
      // Toggle on mousedown so the click never lands in the document and moves
      // the cursor into the marker we're about to replace.
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        changes: {
          from: this.from,
          to: this.to,
          insert: this.checked ? '[ ]' : '[x]',
        },
      });
    });

    return input;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** Renders `---` as an actual rule. */
export class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-spark-rule';
    wrap.appendChild(document.createElement('hr'));
    return wrap;
  }
}

/** Inline image preview for `![alt](src)`. */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-spark-image';

    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.loading = 'lazy';
    // A broken image should degrade to its alt text, not a browser icon.
    img.addEventListener('error', () => {
      wrap.classList.add('cm-spark-image-broken');
      wrap.textContent = this.alt || this.src;
    });

    wrap.appendChild(img);
    return wrap;
  }
}

/**
 * Wraps an element produced by a plugin's inline decorator.
 *
 * Plugins hand back plain DOM, so they never need to know about CodeMirror's
 * widget lifecycle.
 */
export class PluginWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly build: () => HTMLElement | null,
  ) {
    super();
  }

  eq(other: PluginWidget): boolean {
    return other.key === this.key;
  }

  toDOM(): HTMLElement {
    const el = this.build();
    if (el) return el;
    const empty = document.createElement('span');
    empty.className = 'cm-spark-plugin-widget';
    return empty;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
