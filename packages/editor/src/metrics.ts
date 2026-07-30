import { StateEffect } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/**
 * Measured widths of the syntax that hangs into the left margin.
 *
 * Headings and list markers are pulled left by exactly their own width so the
 * text keeps the same left edge whether the markdown is showing or hidden. That
 * width used to be a hand-calibrated constant in `ch`, which was always a few
 * pixels out — `ch` is the width of "0", and none of these faces are monospaced,
 * so a `#` and a space are both something else. A heading therefore twitched
 * sideways the moment you put the cursor in it.
 *
 * Now it is measured from the real rendered face, once per font, and cached.
 * That matters more than it used to: the appearance settings let the reading
 * font change at runtime, and a constant calibrated for one face is wrong for
 * every other one.
 */

/** Dispatched after a measurement changes, so live preview rebuilds against it. */
export const metricsChanged = StateEffect.define<null>();

interface Measurement {
  /** The font state these numbers were taken under. */
  signature: string;
  /** Width of `#…# ` for heading levels 1–6, in px. */
  heading: number[];
  /** Widths of arbitrary prefixes at body size, keyed by the text itself. */
  text: Map<string, number>;
}

let current: Measurement | null = null;

/**
 * Advance of a rendered checkbox, from its own rule in `theme.ts`
 * (`width: 1.05em` + `margin-right: 0.35em`). Expressed in `em` so it stays
 * correct without measuring: it is a number this stylesheet chose, not one the
 * font decides.
 */
const CHECKBOX_EM = 1.4;

/** Used until the first real measurement lands; calibrated against Quattro. */
const FALLBACK_HASH_EM = 0.52;

/** The outdent for an ATX heading of `level`, as a CSS length. */
export function headingHang(level: number): string {
  const px = current?.heading[level - 1];
  return px === undefined ? `${(level + 1) * FALLBACK_HASH_EM}em` : `${px}px`;
}

/** The outdent for a list line whose visible prefix is `prefix`. */
export function textHang(view: EditorView, prefix: string): string {
  const px = measureText(view, prefix);
  // `ch` is a poor approximation of a proportional face, but it is stable and
  // only survives until the first measurement.
  return px === null ? `${prefix.length * 0.5}ch` : `${px}px`;
}

/** The outdent for a task line, where a checkbox stands in for `- [ ]`. */
export function checkboxHang(view: EditorView, indent: string): string {
  const px = indent.length === 0 ? 0 : measureText(view, indent);
  return px === null ? `${CHECKBOX_EM + indent.length * 0.5}ch` : `calc(${px}px + ${CHECKBOX_EM}em)`;
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

function measureText(view: EditorView, text: string): number | null {
  if (text === '') return 0;
  if (current === null) return null;

  const cached = current.text.get(text);
  if (cached !== undefined) return cached;

  const probe = createProbe();
  const { row, span } = measuredRow('', text);
  probe.appendChild(row);
  view.scrollDOM.appendChild(probe);
  const width = span.getBoundingClientRect().width;
  probe.remove();

  // A detached or display:none editor measures as zero. Caching that would
  // freeze the mistake in place, so leave it for the next attempt.
  if (width === 0) return null;
  current.text.set(text, width);
  return width;
}

function createProbe(): HTMLElement {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  // Out of flow and invisible, but still laid out — `display: none` would
  // measure as zero, and `visibility: hidden` would not.
  probe.style.cssText =
    'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;white-space:pre;';
  return probe;
}

/**
 * A row carrying `className` — which is how the heading sizes are applied —
 * with the run to be measured in a span inside it.
 */
function measuredRow(className: string, text: string): { row: HTMLElement; span: HTMLElement } {
  const row = document.createElement('div');
  if (className) row.className = className;
  // The heading rules carry vertical padding; it would not change the span's
  // width, but zeroing it keeps the probe a single flat row.
  row.style.padding = '0';
  const span = document.createElement('span');
  span.textContent = text;
  row.appendChild(span);
  return { row, span };
}

/**
 * Everything about a *title* that changes how wide `# ` renders.
 *
 * The heading widths are measured in `.cm-spark-h*` rows, which are set in
 * `--font-heading` at whatever the `--heading-*` variables say — and none of
 * that appears in the content element's own font. Without these in the
 * signature, a theme or font pack that changes only the title face leaves every
 * heading outdent measured against the face before it, which reads as headings
 * that are indented by the wrong amount and nothing else on the page being wrong.
 */
const HEADING_VARS = [
  '--font-heading',
  '--heading-weight',
  '--heading-style',
  '--heading-stretch',
  '--heading-scale',
  '--heading-variation',
  '--heading-transform',
  '--heading-tracking',
  '--heading-tracking-1',
  '--heading-tracking-2',
];

/**
 * The font state that these measurements depend on. Anything that changes it —
 * the appearance settings, a theme, a webfont finishing its download —
 * invalidates them.
 */
function signatureOf(view: EditorView): string {
  const style = getComputedStyle(view.contentDOM);
  const body = `${style.fontFamily}|${style.fontSize}|${style.letterSpacing}|${style.fontWeight}`;
  // Custom properties inherit, so the content element's computed style is a
  // perfectly good place to read the ones set on `:root`.
  return `${body}|${HEADING_VARS.map((name) => style.getPropertyValue(name)).join('|')}`;
}

function remeasure(view: EditorView): boolean {
  const signature = signatureOf(view);
  if (current?.signature === signature) return false;

  const probe = createProbe();
  const spans = [1, 2, 3, 4, 5, 6].map((level) => {
    const { row, span } = measuredRow(`cm-spark-h${level}`, `${'#'.repeat(level)} `);
    probe.appendChild(row);
    return span;
  });

  view.scrollDOM.appendChild(probe);
  const heading = spans.map((span) => span.getBoundingClientRect().width);
  probe.remove();

  // Not laid out yet — try again on the next update rather than caching zeros.
  if (heading.some((width) => width === 0)) return false;

  current = { signature, heading, text: new Map() };
  return true;
}

/**
 * Keeps the measurements current.
 *
 * The work is deferred to an animation frame for two reasons: the view is not
 * in the document yet when the plugin is constructed, so a measurement there
 * reads zero; and reading layout during an update would force a reflow on every
 * keystroke. Once a measurement lands, a transaction carrying `metricsChanged`
 * tells live preview to rebuild against the new numbers.
 *
 * Two of the three things that invalidate a measurement are outside CodeMirror
 * entirely, so they are listened for rather than waited on:
 *
 * - **A webfont arriving** after first paint changes every width on the page,
 *   and nothing about the editor's own state says so (`loadingdone`).
 * - **The app swapping the typography** — a theme, a font pack, a font mode.
 *   That is a stylesheet write, which CodeMirror has no way to notice at all,
 *   so the app announces it (`spark:typography`, dispatched by `applyTheme`).
 *   Every editor alive has to hear it, not just the focused one, which is why
 *   it is a window event rather than a method on the editor.
 */
export const marginMetrics = ViewPlugin.fromClass(
  class {
    #scheduled = 0;
    #detach: Array<() => void> = [];

    constructor(readonly view: EditorView) {
      this.#schedule();

      const invalidate = () => {
        current = null;
        this.#schedule();
      };

      const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
      if (fonts) {
        fonts.addEventListener('loadingdone', invalidate);
        this.#detach.push(() => fonts.removeEventListener('loadingdone', invalidate));
      }

      window.addEventListener('spark:typography', invalidate);
      this.#detach.push(() => window.removeEventListener('spark:typography', invalidate));
    }

    update(update: ViewUpdate): void {
      if (update.geometryChanged || update.viewportChanged) this.#schedule();
    }

    destroy(): void {
      if (this.#scheduled) cancelAnimationFrame(this.#scheduled);
      for (const detach of this.#detach) detach();
    }

    #schedule(): void {
      if (this.#scheduled) return;
      this.#scheduled = requestAnimationFrame(() => {
        this.#scheduled = 0;
        if (remeasure(this.view)) {
          this.view.dispatch({ effects: metricsChanged.of(null) });
        }
      });
    }
  },
);
