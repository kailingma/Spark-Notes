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
      // Alt means "show me the markdown": let the click fall through so the
      // cursor lands on the line and the `[ ]` is revealed for editing.
      if (event.altKey) return;

      // Otherwise toggle on mousedown, so the click never lands in the document
      // and moves the cursor into the marker we're about to replace.
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

/**
 * The bar that stands in for a fence's opening ```` ```lang ```` line.
 *
 * The language sits on the right with the copy button beside it, out of the
 * way of the code's own left edge. Copying takes the block's contents and
 * nothing else — a copy button that hands you back the backticks you have to
 * delete is worse than no button.
 */
export class CodeFenceWidget extends WidgetType {
  constructor(
    readonly language: string,
    readonly code: string,
  ) {
    super();
  }

  eq(other: CodeFenceWidget): boolean {
    return other.language === this.language && other.code === this.code;
  }

  toDOM(): HTMLElement {
    const bar = document.createElement('span');
    bar.className = 'cm-spark-code-bar';

    const label = document.createElement('span');
    label.className = 'cm-spark-code-lang';
    label.textContent = this.language || 'text';
    bar.appendChild(label);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'cm-spark-code-copy';
    copy.title = 'Copy code';
    copy.setAttribute('aria-label', 'Copy code');
    copy.appendChild(copyIcon());

    copy.addEventListener('mousedown', (event) => {
      // Let ⌥-click through, so the "show me the markdown" gesture works here
      // like it does everywhere else. Otherwise keep the click out of the
      // document, or the cursor lands on the fence and the bar disappears
      // before the click completes.
      if (event.altKey) return;
      event.preventDefault();
      event.stopPropagation();

      void navigator.clipboard
        .writeText(this.code)
        .then(() => {
          copy.dataset.copied = 'true';
          window.setTimeout(() => delete copy.dataset.copied, 1400);
        })
        .catch(() => {
          copy.dataset.copied = 'failed';
          window.setTimeout(() => delete copy.dataset.copied, 1400);
        });
    });

    bar.appendChild(copy);
    return bar;
  }

  /**
   * Events reach the editor, so clicking the bar itself places the cursor on
   * the fence line and reveals it. The button stops its own clicks above.
   */
  ignoreEvent(): boolean {
    return false;
  }
}

function copyIcon(): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  for (const d of [
    'M9 9.5A2.5 2.5 0 0 1 11.5 7h6A2.5 2.5 0 0 1 20 9.5v6a2.5 2.5 0 0 1-2.5 2.5h-6A2.5 2.5 0 0 1 9 15.5Z',
    'M15 7V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H7',
  ]) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
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
