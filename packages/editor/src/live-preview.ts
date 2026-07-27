import { syntaxTree } from '@codemirror/language';
import { Facet, type EditorState, type Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { InlineDecorator } from '@spark/plugin-sdk';
import { CheckboxWidget, ImageWidget, PluginWidget, RuleWidget } from './widgets.js';

/**
 * Live preview: markdown that styles itself and gets out of the way.
 *
 * The rule is uniform — a syntax marker is hidden unless the selection touches
 * the element it belongs to. Put the cursor inside `**bold**` and the asterisks
 * come back so you can edit them; move away and they vanish again. Because the
 * hiding is driven by the real parse tree rather than regexes over text, a `*`
 * inside a code fence is left alone, and the document itself is never rewritten
 * — what you save is exactly the markdown you typed.
 */

export interface LivePreviewConfig {
  /** Called when a `[[wiki link]]` is clicked. */
  onWikiLink?: (target: string) => void;
  /** Called when a regular link is clicked. */
  onLink?: (url: string) => void;
  /** Inline widget renderers contributed by plugins. */
  decorators?: () => InlineDecorator[];
  /** Name of the page being edited, passed through to plugin decorators. */
  page?: () => string | null;
}

export const livePreviewConfig = Facet.define<LivePreviewConfig, LivePreviewConfig>({
  combine: (values) => Object.assign({}, ...values) as LivePreviewConfig,
});

// ---------------------------------------------------------------------------
// Decoration primitives
// ---------------------------------------------------------------------------

const hidden = Decoration.replace({});

const lineClass = (cls: string) => Decoration.line({ class: cls });
const markClass = (cls: string) => Decoration.mark({ class: cls });

const HEADING_LINE = [1, 2, 3, 4, 5, 6].map((n) => lineClass(`cm-spark-h${n}`));
const QUOTE_LINE = lineClass('cm-spark-quote');
const CODE_LINE = lineClass('cm-spark-code');
const FRONTMATTER_LINE = lineClass('cm-spark-frontmatter');
const TABLE_LINE = lineClass('cm-spark-table');

const LINK_MARK = markClass('cm-spark-link');
const WIKILINK_MARK = markClass('cm-spark-wikilink');
const TAG_MARK = markClass('cm-spark-tag');
const HIGHLIGHT_MARK = markClass('cm-spark-highlight');
const DONE_TASK_MARK = markClass('cm-spark-task-done');

/** Marker node names whose visibility follows their parent element. */
const ELEMENT_MARKS = new Set([
  'EmphasisMark',
  'StrikethroughMark',
  'HighlightMark',
  'WikiLinkMark',
  'SubscriptMark',
  'SuperscriptMark',
]);

// ---------------------------------------------------------------------------
// Selection tests
// ---------------------------------------------------------------------------

/** True when any selection range overlaps `[from, to]`, endpoints included. */
function touches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

/** True when the selection is anywhere on the line containing `pos`. */
function onLine(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return touches(state, line.from, line.to);
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface Collected {
  decorations: Range<Decoration>[];
  /** Ranges already replaced by the tree pass, so plugins can't overlap them. */
  replaced: Array<[number, number]>;
}

function buildDecorations(view: EditorView): DecorationSet {
  const { state } = view;
  const config = state.facet(livePreviewConfig);
  const out: Collected = { decorations: [], replaced: [] };

  for (const { from, to } of view.visibleRanges) {
    decorateFrontmatter(state, from, to, out);
    decorateTree(view, from, to, out);
    decoratePlugins(view, from, to, config, out);
  }

  // `sort: true` lets us emit decorations in tree order and still satisfy
  // CodeMirror's requirement that the set be position-ordered.
  return Decoration.set(out.decorations, true);
}

function hide(out: Collected, from: number, to: number): void {
  if (to <= from) return;
  out.decorations.push(hidden.range(from, to));
  out.replaced.push([from, to]);
}

function replaceWith(
  out: Collected,
  from: number,
  to: number,
  decoration: Decoration,
): void {
  if (to < from) return;
  out.decorations.push(decoration.range(from, to));
  out.replaced.push([from, to]);
}

/**
 * Frontmatter isn't part of the markdown grammar, so it's matched directly.
 * It stays readable but visually recedes — it's metadata, not prose.
 */
function decorateFrontmatter(
  state: EditorState,
  from: number,
  to: number,
  out: Collected,
): void {
  if (!state.doc.sliceString(0, 4).startsWith('---\n')) return;

  let end = -1;
  for (let n = 2; n <= state.doc.lines; n++) {
    if (state.doc.line(n).text.trimEnd() === '---') {
      end = state.doc.line(n).to;
      break;
    }
  }
  if (end < 0) return;

  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (line.from > end) break;
    if (line.to < from || line.from > to) continue;
    out.decorations.push(FRONTMATTER_LINE.range(line.from));
  }
}

function decorateTree(
  view: EditorView,
  rangeFrom: number,
  rangeTo: number,
  out: Collected,
): void {
  const { state } = view;

  syntaxTree(state).iterate({
    from: rangeFrom,
    to: rangeTo,
    enter: (node) => {
      const name = node.name;

      // --- Headings -------------------------------------------------------
      const atx = /^ATXHeading(\d)$/.exec(name);
      if (atx) {
        const level = Number(atx[1]);
        out.decorations.push(
          HEADING_LINE[level - 1].range(state.doc.lineAt(node.from).from),
        );
        return;
      }

      if (name === 'HeaderMark') {
        const parent = node.node.parent?.name ?? '';
        // Setext underlines stay put: hiding them would collapse the line to
        // nothing and make the heading impossible to unmake.
        if (!parent.startsWith('ATXHeading')) return;
        if (onLine(state, node.from)) return;
        // Swallow the space after `##` too, so the text starts at the margin.
        const after = state.doc.sliceString(node.to, node.to + 1);
        hide(out, node.from, after === ' ' ? node.to + 1 : node.to);
        return;
      }

      // --- Inline emphasis ------------------------------------------------
      if (ELEMENT_MARKS.has(name)) {
        const parent = node.node.parent;
        if (parent && !touches(state, parent.from, parent.to)) {
          hide(out, node.from, node.to);
        }
        return;
      }

      if (name === 'Highlight') {
        out.decorations.push(HIGHLIGHT_MARK.range(node.from, node.to));
        return;
      }

      if (name === 'Hashtag') {
        out.decorations.push(TAG_MARK.range(node.from, node.to));
        return;
      }

      // --- Code -----------------------------------------------------------
      if (name === 'InlineCode') {
        return;
      }

      if (name === 'CodeMark') {
        const parent = node.node.parent;
        // Fence markers stay visible — you need them to change the language,
        // and a code block already reads as a block from its background.
        if (parent?.name !== 'InlineCode') return;
        if (touches(state, parent.from, parent.to)) return;
        hide(out, node.from, node.to);
        return;
      }

      if (name === 'FencedCode' || name === 'CodeBlock') {
        const start = Math.max(node.from, rangeFrom);
        const stop = Math.min(node.to, rangeTo);
        for (
          let n = state.doc.lineAt(start).number;
          n <= state.doc.lineAt(stop).number;
          n++
        ) {
          out.decorations.push(CODE_LINE.range(state.doc.line(n).from));
        }
        return;
      }

      // --- Blockquote -----------------------------------------------------
      if (name === 'Blockquote') {
        const start = Math.max(node.from, rangeFrom);
        const stop = Math.min(node.to, rangeTo);
        for (
          let n = state.doc.lineAt(start).number;
          n <= state.doc.lineAt(stop).number;
          n++
        ) {
          out.decorations.push(QUOTE_LINE.range(state.doc.line(n).from));
        }
        return;
      }

      if (name === 'QuoteMark') {
        if (onLine(state, node.from)) return;
        const after = state.doc.sliceString(node.to, node.to + 1);
        hide(out, node.from, after === ' ' ? node.to + 1 : node.to);
        return;
      }

      // --- Tasks ----------------------------------------------------------
      if (name === 'TaskMarker') {
        const checked = state.doc.sliceString(node.from, node.to).toLowerCase() === '[x]';
        replaceWith(
          out,
          node.from,
          node.to,
          Decoration.replace({
            widget: new CheckboxWidget(checked, node.from, node.to),
          }),
        );
        if (checked) {
          // Strike through the rest of the line so done work reads as done.
          const line = state.doc.lineAt(node.from);
          if (node.to < line.to) {
            out.decorations.push(DONE_TASK_MARK.range(node.to, line.to));
          }
        }
        return;
      }

      // --- Rules ----------------------------------------------------------
      if (name === 'HorizontalRule') {
        if (onLine(state, node.from)) return;
        replaceWith(
          out,
          node.from,
          node.to,
          Decoration.replace({ widget: new RuleWidget() }),
        );
        return false;
      }

      // --- Images ---------------------------------------------------------
      if (name === 'Image') {
        if (touches(state, node.from, node.to)) return;
        const source = state.doc.sliceString(node.from, node.to);
        const match = /^!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?/.exec(source);
        if (!match?.[2]) return;
        replaceWith(
          out,
          node.from,
          node.to,
          Decoration.replace({ widget: new ImageWidget(match[2], match[1]) }),
        );
        return false;
      }

      // --- Links ----------------------------------------------------------
      if (name === 'Link') {
        out.decorations.push(LINK_MARK.range(node.from, node.to));
        return;
      }

      if (name === 'LinkMark' || name === 'URL' || name === 'LinkTitle') {
        const parent = node.node.parent;
        if (!parent || (parent.name !== 'Link' && parent.name !== 'Image')) return;
        if (touches(state, parent.from, parent.to)) return;
        hide(out, node.from, node.to);
        return;
      }

      if (name === 'WikiLink') {
        out.decorations.push(WIKILINK_MARK.range(node.from, node.to));
        return;
      }

      if (name === 'WikiLinkTarget') {
        // With an alias present, the target itself is plumbing — hide it and
        // show only the words the author chose.
        const parent = node.node.parent;
        if (!parent || touches(state, parent.from, parent.to)) return;
        const hasAlias = parent.node.getChild('WikiLinkAlias');
        if (hasAlias) hide(out, node.from, node.to);
        return;
      }

      // --- Tables ---------------------------------------------------------
      if (name === 'Table') {
        const start = Math.max(node.from, rangeFrom);
        const stop = Math.min(node.to, rangeTo);
        for (
          let n = state.doc.lineAt(start).number;
          n <= state.doc.lineAt(stop).number;
          n++
        ) {
          out.decorations.push(TABLE_LINE.range(state.doc.line(n).from));
        }
        return;
      }

      return;
    },
  });
}

/** Runs plugin-registered inline decorators over the visible lines. */
function decoratePlugins(
  view: EditorView,
  rangeFrom: number,
  rangeTo: number,
  config: LivePreviewConfig,
  out: Collected,
): void {
  const decorators = config.decorators?.() ?? [];
  if (decorators.length === 0) return;

  const { state } = view;
  const firstLine = state.doc.lineAt(rangeFrom).number;
  const lastLine = state.doc.lineAt(rangeTo).number;

  for (const decorator of decorators) {
    for (let n = firstLine; n <= lastLine; n++) {
      const line = state.doc.line(n);
      // Each decorator gets a fresh regex so a stale `lastIndex` from a
      // previous pass can't make matches disappear.
      const re = new RegExp(
        decorator.pattern.source,
        decorator.pattern.flags.includes('g')
          ? decorator.pattern.flags
          : `${decorator.pattern.flags}g`,
      );

      let match: RegExpExecArray | null;
      while ((match = re.exec(line.text))) {
        if (match[0] === '') {
          re.lastIndex++;
          continue;
        }
        const from = line.from + match.index;
        const to = from + match[0].length;

        if (decorator.revealOnCursor !== false && touches(state, from, to)) continue;
        if (out.replaced.some(([a, b]) => from < b && to > a)) continue;

        const captured = match;
        replaceWith(
          out,
          from,
          to,
          Decoration.replace({
            widget: new PluginWidget(`${decorator.pattern.source}:${match[0]}`, () => {
              try {
                return decorator.render(captured, {
                  page: config.page?.() ?? null,
                  from,
                  to,
                  replace: (text) =>
                    view.dispatch({ changes: { from, to, insert: text } }),
                });
              } catch (err) {
                console.error('[spark] inline decorator threw', err);
                return null;
              }
            }),
          }),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      // Selection changes matter as much as edits here: moving the cursor is
      // what reveals and re-hides syntax.
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(event, view) {
        const target = event.target as HTMLElement;
        if (!(event.metaKey || event.ctrlKey) && !target.closest('.cm-spark-wikilink')) {
          return false;
        }

        const pos = view.posAtDOM(target);
        const config = view.state.facet(livePreviewConfig);
        const tree = syntaxTree(view.state);

        let node = tree.resolveInner(pos, 1);
        while (node.parent) {
          if (node.name === 'WikiLink') {
            const targetNode = node.getChild('WikiLinkTarget');
            if (targetNode && config.onWikiLink) {
              event.preventDefault();
              config.onWikiLink(
                view.state.doc.sliceString(targetNode.from, targetNode.to).trim(),
              );
              return true;
            }
            return false;
          }
          if (node.name === 'Link') {
            const url = node.getChild('URL');
            if (url && config.onLink) {
              event.preventDefault();
              config.onLink(view.state.doc.sliceString(url.from, url.to).trim());
              return true;
            }
            return false;
          }
          node = node.parent;
        }
        return false;
      },
    },
  },
);
