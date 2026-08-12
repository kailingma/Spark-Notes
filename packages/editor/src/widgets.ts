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
    /**
     * True when the selection covers the marker's range.
     *
     * The selection highlight is drawn *behind* this widget, so a checked
     * box's opaque fill would otherwise sit as a gap in the middle of a
     * highlighted line. The live preview pass re-runs on every selection
     * change, so this is recomputed per build and `eq()` sees it — moving the
     * caret across the box re-renders it into (or out of) the highlight.
     */
    readonly selected = false,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return (
      other.checked === this.checked &&
      other.from === this.from &&
      other.selected === this.selected
    );
  }

  toDOM(view: EditorView): HTMLElement {
    // A wrapper rather than listening on the input itself: `.cm-spark-checkbox-hit`
    // grows the *clickable* area past the visible box (see theme.ts) via an
    // absolutely-positioned pseudo-element, which a fat finger needs without the
    // rendered square changing size. Absolute positioning keeps the extra area out
    // of flow entirely, so it cannot perturb the line's height metrics the way a
    // margin on the box itself would (see AGENTS.md: never `margin` on `.cm-line`).
    const wrap = document.createElement('span');
    wrap.className = 'cm-spark-checkbox-hit';
    if (this.selected) wrap.dataset.selected = '';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'cm-spark-checkbox';
    input.checked = this.checked;
    input.setAttribute('aria-label', this.checked ? 'Completed task' : 'Open task');
    wrap.appendChild(input);

    wrap.addEventListener('mousedown', (event) => {
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

    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * A centered dot standing in for a plain list item's `-`, `*` or `+`.
 *
 * The raw character sits on the text baseline, which reads as a small hyphen
 * rather than a bullet. A real list gets a mark centered on the line instead —
 * the same shape regardless of which of the three characters was typed, since
 * none of them means anything different. It reveals back to the literal
 * character the moment the cursor is on it, same as every other quiet marker.
 */
export class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-spark-bullet';
    return span;
  }

  /** Events reach the editor, so clicking the dot places the cursor and reveals it. */
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
    /** `|300` or `|300x200` in the alt text: width, or width and height. */
    readonly width?: number,
    readonly height?: number,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.width === this.width &&
      other.height === this.height
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-spark-image';

    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    // The `width`/`height` attributes size the image in CSS pixels. When only
    // the width is given the height follows the intrinsic ratio; when both are
    // given they are honoured exactly, like Obsidian does. `.cm-spark-image
    // img`'s `max-width: 100%` still clamps an oversized choice to the column.
    if (this.width) img.width = this.width;
    if (this.height) img.height = this.height;
    // Not `lazy`: a lazy image inside a widget has no height until it scrolls
    // into view, which is exactly when CodeMirror is measuring the line it is
    // in. The picture then arrives and pushes everything below it down against
    // a height map that still says the line is one row tall — which is what
    // makes a click land several lines above where it was aimed.
    img.loading = 'eager';
    img.addEventListener('load', () => {
      // The line just changed height by however tall the picture turned out to
      // be, and nothing in the document changed to tell CodeMirror so.
      view.requestMeasure();
    });
    // A broken image should degrade to its alt text, not a browser icon.
    img.addEventListener('error', () => {
      wrap.classList.add('cm-spark-image-broken');
      wrap.textContent = this.alt || this.src;
      view.requestMeasure();
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
