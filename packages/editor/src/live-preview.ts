import { syntaxTree } from '@codemirror/language';
import { Facet, type EditorState, type Range } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import type { InlineDecorator } from '@spark/plugin-sdk';
import { checkboxHang, headingHang, metricsChanged, textHang } from './metrics.js';
import { CheckboxWidget, CodeFenceWidget, ImageWidget, PluginWidget, RuleWidget } from './widgets.js';

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
  /** Called when a `#tag` is clicked. */
  onTag?: (tag: string) => void;
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

const QUOTE_LINE = lineClass('cm-spark-quote');
const CODE_LINE = lineClass('cm-spark-code');
const CODE_OPEN_LINE = lineClass('cm-spark-code-open');
const CODE_CLOSE_LINE = lineClass('cm-spark-code-close');
const FRONTMATTER_LINE = lineClass('cm-spark-frontmatter');
const TABLE_LINE = lineClass('cm-spark-table');

const INLINE_CODE_MARK = markClass('cm-spark-inline-code');
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
    decorateHangingIndent(view, from, to, out);
    decorateTree(view, from, to, out);
    decoratePlugins(view, from, to, config, out);
  }

  // `sort: true` lets us emit decorations in tree order and still satisfy
  // CodeMirror's requirement that the set be position-ordered.
  return Decoration.set(out.decorations, true);
}

/**
 * The subset of the decoration set that replaces text, as an atomic range set.
 * Line and mark decorations are excluded — only replacements move the cursor.
 */
function atomicOf(decorations: DecorationSet): DecorationSet {
  const ranges: Array<Range<Decoration>> = [];
  const iter = decorations.iter();
  while (iter.value) {
    // `point` is true for replace and widget decorations, false for the rest.
    if (iter.from < iter.to && iter.value.spec.widget === undefined && iter.value.point) {
      ranges.push(iter.value.range(iter.from, iter.to));
    }
    iter.next();
  }
  return Decoration.set(ranges, true);
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

/** `  - [ ] text` → indent, marker, spacing, optional checkbox. */
const LIST_LINE_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s*)?/;

/**
 * A line that is only hashes — `#`, `##` — with nothing after them, not even a
 * space. The parser calls this an empty ATX heading; live preview treats it as
 * a heading that has not been committed to yet. See the `ATXHeading` branch.
 */
const PENDING_TAG_RE = /^\s*#{1,6}$/;

/**
 * Hanging indent for list items.
 *
 * Without it a wrapped list line returns to the far-left margin, so the second
 * row of a long bullet reads as a new paragraph and nested lists lose their
 * shape entirely. Each list line gets a negative text-indent plus matching
 * padding, which pushes every wrapped row under the item's text.
 *
 * The width is whatever the prefix actually renders as — measured once per
 * font, not guessed in `ch`. It has to follow the *visible* prefix, so a task
 * hangs by the width of its checkbox while the marker is hidden and by the
 * width of `- [ ] ` once the cursor reveals it.
 */
function decorateHangingIndent(
  view: EditorView,
  from: number,
  to: number,
  out: Collected,
): void {
  const { state } = view;
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;

  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    const match = LIST_LINE_RE.exec(line.text);
    if (!match) continue;

    const [prefix, indent, , , task] = match;
    const showsCheckbox = task !== undefined && !taskMarkerRevealed(state, line.from, match);

    out.decorations.push(
      Decoration.line({
        class: 'cm-spark-hang',
        attributes: {
          style: `--hang:${
            showsCheckbox
              ? // The `- ` is hidden and the `[ ]` is a widget, so all that is
                // left in front of the text is the indent and the checkbox.
                checkboxHang(view, indent)
              : textHang(view, prefix)
          }`,
        },
      }).range(line.from),
    );
  }
}

/**
 * True when the selection is on the `[ ]` of a task, which puts the raw marker
 * back so it can be edited. Anywhere else on the line keeps the checkbox: the
 * marker is a control, and swapping it for text while you write the task would
 * make the line jump under the cursor.
 */
function taskMarkerRevealed(
  state: EditorState,
  lineFrom: number,
  match: RegExpExecArray,
): boolean {
  const [, indent, marker, spacing, task] = match;
  if (task === undefined) return false;
  const markerFrom = lineFrom + indent.length + marker.length + spacing.length;
  return touches(state, markerFrom, markerFrom + 3);
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
        const line = state.doc.lineAt(node.from);

        // A line that is nothing but `#` is a tag someone has started typing,
        // not a title. CommonMark calls it an empty heading and the grammar
        // hands us one either way, but guessing "title" on the first keystroke
        // means jumping to display size and then back down again the moment a
        // letter lands — wrong twice, and it moves the line under the cursor.
        // The space is what commits to a title. Until it arrives the hashes
        // stay body-sized, and a lone `#` is painted as the tag it is about to
        // become, so `#` and `#idea` look like one continuous thing.
        //
        // `false` skips the children, which matters: the `HeaderMark` branch
        // would otherwise hide the only character on the line.
        if (PENDING_TAG_RE.test(line.text)) {
          if (level === 1) out.decorations.push(TAG_MARK.range(node.from, node.to));
          return false;
        }

        // While the `#`s are showing they hang out into the left margin, so the
        // heading text stays on the same edge as body text. Without this, the
        // title jumps sideways the moment you put the cursor in it.
        const revealed = onLine(state, node.from);

        out.decorations.push(
          Decoration.line({
            class: `cm-spark-h${level}${revealed ? ' cm-spark-head-hang' : ''}`,
            ...(revealed ? { attributes: { style: `--hang:${headingHang(level)}` } } : {}),
          }).range(line.from),
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
      //
      // Inline code gets a chip of its own: a tinted box with a hairline
      // outline, so a `flag` in the middle of a sentence reads as a thing you
      // would type rather than as a differently-coloured word.
      if (name === 'InlineCode') {
        out.decorations.push(INLINE_CODE_MARK.range(node.from, node.to));
        return;
      }

      if (name === 'CodeMark') {
        const parent = node.node.parent;
        // Fence markers are dealt with a line at a time by the FencedCode
        // branch, which replaces the whole opening line with the language and
        // copy button. Touching them here as well would produce two overlapping
        // replacements, which CodeMirror refuses outright.
        if (parent?.name !== 'InlineCode') return;
        if (touches(state, parent.from, parent.to)) return;
        hide(out, node.from, node.to);
        return;
      }

      if (name === 'FencedCode' || name === 'CodeBlock') {
        decorateCodeBlock(state, node.node, name === 'FencedCode', rangeFrom, rangeTo, out);
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
        // Unlike a heading's `#`, the `>` is hidden even while you are writing
        // in the quote: the left rule already says it is a quote, and a column
        // of angle brackets down the side of the paragraph is just noise. Put
        // the cursor on the marker itself and it comes back.
        const after = state.doc.sliceString(node.to, node.to + 1);
        const end = after === ' ' ? node.to + 1 : node.to;
        if (touches(state, node.from, end)) return;
        hide(out, node.from, end);
        return;
      }

      // --- Tasks ----------------------------------------------------------
      if (name === 'TaskMarker') {
        const checked = state.doc.sliceString(node.from, node.to).toLowerCase() === '[x]';
        const line = state.doc.lineAt(node.from);

        // Arrowing onto the marker, or ⌥-clicking it, puts the raw `- [ ]`
        // back — the same bargain every other piece of syntax makes. It is
        // scoped to the marker rather than the whole line so that writing the
        // task text doesn't swap the checkbox out from under the cursor.
        if (touches(state, node.from, node.to)) {
          if (checked && node.to < line.to) {
            out.decorations.push(DONE_TASK_MARK.range(node.to, line.to));
          }
          return;
        }

        // The checkbox *is* the bullet. Leaving the `-` in front of it renders
        // "- ☑ thing", which reads as two markers for one item.
        const bullet = /^(\s*)([-*+])(\s+)$/.exec(
          state.doc.sliceString(line.from, node.from),
        );
        if (bullet) {
          hide(out, line.from + bullet[1].length, node.from);
        }

        replaceWith(
          out,
          node.from,
          node.to,
          Decoration.replace({
            widget: new CheckboxWidget(checked, node.from, node.to),
          }),
        );
        // Strike through the rest of the line so done work reads as done.
        if (checked && node.to < line.to) {
          out.decorations.push(DONE_TASK_MARK.range(node.to, line.to));
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

/** A closing fence and nothing else — an unterminated block has no such line. */
const CLOSING_FENCE_RE = /^\s*(```|~~~)\s*$/;

/**
 * A fenced block, rendered as a block.
 *
 * The backticks themselves carry no information once the block is obviously a
 * block, so the opening line becomes a bar with the language on the right and a
 * button that copies the code — just the code, not the fences around it — and
 * the closing line collapses to an empty row that reads as the block's bottom
 * padding. Both come back the moment the cursor is on them, which is the only
 * time you would want to change the language or unmake the fence.
 */
function decorateCodeBlock(
  state: EditorState,
  node: SyntaxNode,
  fenced: boolean,
  rangeFrom: number,
  rangeTo: number,
  out: Collected,
): void {
  const firstLine = state.doc.lineAt(node.from);
  const lastLine = state.doc.lineAt(node.to);

  const start = state.doc.lineAt(Math.max(node.from, rangeFrom)).number;
  const stop = state.doc.lineAt(Math.min(node.to, rangeTo)).number;
  for (let n = start; n <= stop; n++) {
    const line = state.doc.line(n);
    out.decorations.push(CODE_LINE.range(line.from));
    if (n === firstLine.number) out.decorations.push(CODE_OPEN_LINE.range(line.from));
    if (n === lastLine.number) out.decorations.push(CODE_CLOSE_LINE.range(line.from));
  }

  // An indented code block has no fences to hide.
  if (!fenced) return;

  const info = node.getChild('CodeInfo');
  const language = info ? state.doc.sliceString(info.from, info.to).trim() : '';

  const closed = lastLine.number > firstLine.number && CLOSING_FENCE_RE.test(lastLine.text);
  const bodyEnd = closed ? state.doc.line(lastLine.number - 1).to : lastLine.to;
  const body =
    lastLine.number > firstLine.number
      ? state.doc.sliceString(state.doc.line(firstLine.number + 1).from, bodyEnd)
      : '';

  // A block taller than one visible range is entered once per range. Line
  // decorations tolerate that, but emitting the same *replacement* twice is an
  // overlap, which CodeMirror rejects — so each fence is claimed by the single
  // visible range that contains it. Ranges are disjoint, so exactly one does.
  if (within(firstLine.from, rangeFrom, rangeTo) && !onLine(state, firstLine.from)) {
    replaceWith(
      out,
      firstLine.from,
      firstLine.to,
      Decoration.replace({ widget: new CodeFenceWidget(language, body) }),
    );
  }

  if (closed && within(lastLine.from, rangeFrom, rangeTo) && !onLine(state, lastLine.from)) {
    hide(out, lastLine.from, lastLine.to);
  }
}

function within(pos: number, from: number, to: number): boolean {
  return pos >= from && pos <= to;
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
    /** The replaced ranges, exposed so the cursor can step over them. */
    atomic: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
      this.atomic = atomicOf(this.decorations);
    }

    update(update: ViewUpdate): void {
      // Selection changes matter as much as edits here: moving the cursor is
      // what reveals and re-hides syntax.
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        // A font finished loading or the reading face changed, so every
        // margin outdent was computed against widths that no longer hold.
        update.transactions.some((tr) => tr.effects.some((effect) => effect.is(metricsChanged)))
      ) {
        this.decorations = buildDecorations(update.view);
        this.atomic = atomicOf(this.decorations);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    // Hidden syntax is skipped over rather than stepped through. Without this
    // an arrow key lands *inside* a zero-width replaced range, the decoration
    // then reveals to accommodate the cursor, the line reflows, and the next
    // keypress is computed against a layout that no longer exists — which is
    // what makes vertical motion appear to skip lines.
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
    eventHandlers: {
      mousedown(event, view) {
        // Alt is the "leave it alone" modifier: suppress every rendered
        // behaviour so the click just places the cursor, which reveals the
        // markdown underneath for editing. One gesture, whatever you alt-click
        // — a link, a tag, a checkbox, an image.
        if (event.altKey) return false;

        // Resolve from the pointer rather than the element: a link is several
        // DOM nodes, and `posAtDOM` on the wrong one lands outside the node.
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;

        const config = view.state.facet(livePreviewConfig);
        const text = view.state.doc;
        let node = syntaxTree(view.state).resolveInner(pos, 1);

        while (node.parent) {
          if (node.name === 'WikiLink') {
            const target = node.getChild('WikiLinkTarget');
            if (!target || !config.onWikiLink) return false;
            event.preventDefault();
            config.onWikiLink(text.sliceString(target.from, target.to).trim());
            return true;
          }

          if (node.name === 'Link') {
            const url = node.getChild('URL');
            if (!url || !config.onLink) return false;
            event.preventDefault();
            config.onLink(text.sliceString(url.from, url.to).trim());
            return true;
          }

          if (node.name === 'Hashtag') {
            if (!config.onTag) return false;
            event.preventDefault();
            config.onTag(text.sliceString(node.from, node.to).replace(/^#/, '').trim());
            return true;
          }

          node = node.parent;
        }
        return false;
      },
    },
  },
);
