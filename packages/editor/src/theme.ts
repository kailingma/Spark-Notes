import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Prec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

/**
 * Editor styling.
 *
 * Every colour is a CSS custom property owned by the app shell, so light and
 * dark mode — and any future theme — are a matter of swapping variables rather
 * than rebuilding CodeMirror extensions.
 */
export const sparkTheme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'transparent',
    height: '100%',
    fontSize: 'var(--editor-font-size)',
  },
  '&.cm-focused': { outline: 'none' },

  // The editor grows with its content and lets the app's page column do the
  // scrolling, so the backlinks block can sit after the document as part of
  // the same scrollable page.
  '.cm-scroller': {
    fontFamily: 'var(--font-editor)',
    lineHeight: 'var(--editor-line-height)',
  },


  '.cm-content': {
    padding: '0 var(--gutter)',
    // Keeps a short page clickable well below its last line, so you can click
    // into empty space to keep writing.
    minHeight: '55vh',
    maxWidth: 'calc(var(--editor-measure) + var(--gutter) * 2)',
    margin: '0 auto',
    width: '100%',
    caretColor: 'var(--accent)',
  },

  '.cm-line': { padding: '0 2px' },

  // Wrapped rows of a list item hang under the item's text instead of
  // returning to the margin. `--hang` is set per line by the live-preview pass.
  '.cm-spark-hang': {
    paddingLeft: 'calc(var(--hang) + 2px)',
    textIndent: 'calc(var(--hang) * -1)',
  },

  '.cm-cursor, .cm-dropCursor': {
    borderLeft: '2px solid var(--accent)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection)',
  },

  '.cm-gutters': { display: 'none' },

  '.cm-placeholder': {
    color: 'var(--text-faintest)',
    fontStyle: 'normal',
  },

  // --- Headings ------------------------------------------------------------
  //
  // Spacing here is padding, never margin. CodeMirror measures each line as a
  // block to build its height map, and collapsing margins make those numbers
  // disagree with the real layout — which shows up as arrow keys skipping
  // lines and clicks landing on the wrong row.
  //
  // `--font-heading` is normally the reading face itself. In serif mode it is a
  // display face instead, so a title looks like a title rather than like more
  // body text set larger.
  //
  // The other seven `--heading-*` variables are how a font pack makes a title
  // expressive — wider, slanted, tracked in, set larger, or drawn with a
  // variable font's own axes. They all default to what the app has always done
  // (see `tokens.css`), so the four rules below are unchanged unless something
  // has actually asked for a change. `--heading-scale` multiplies the size,
  // which is what lets a display face have the presence it was drawn for
  // without the body text moving underneath it.
  '.cm-spark-h1': {
    fontFamily: 'var(--font-heading)',
    fontSize: 'calc(1.7em * var(--heading-scale))',
    fontWeight: 'var(--heading-weight)',
    fontStyle: 'var(--heading-style)',
    fontStretch: 'var(--heading-stretch)',
    fontVariationSettings: 'var(--heading-variation)',
    textTransform: 'var(--heading-transform)',
    lineHeight: '1.25',
    letterSpacing: 'var(--heading-tracking-1)',
    padding: '0.9em 2px 0.15em',
  },
  '.cm-spark-h2': {
    fontFamily: 'var(--font-heading)',
    fontSize: 'calc(1.38em * var(--heading-scale))',
    fontWeight: 'var(--heading-weight)',
    fontStyle: 'var(--heading-style)',
    fontStretch: 'var(--heading-stretch)',
    fontVariationSettings: 'var(--heading-variation)',
    textTransform: 'var(--heading-transform)',
    lineHeight: '1.3',
    letterSpacing: 'var(--heading-tracking-2)',
    padding: '0.85em 2px 0.1em',
  },
  '.cm-spark-h3': {
    fontFamily: 'var(--font-heading)',
    fontSize: 'calc(1.16em * var(--heading-scale))',
    fontWeight: 'var(--heading-weight)',
    fontStyle: 'var(--heading-style)',
    fontStretch: 'var(--heading-stretch)',
    fontVariationSettings: 'var(--heading-variation)',
    textTransform: 'var(--heading-transform)',
    letterSpacing: 'var(--heading-tracking)',
    padding: '0.8em 2px 0.05em',
  },
  '.cm-spark-h4': {
    fontFamily: 'var(--font-heading)',
    fontSize: 'calc(1.04em * var(--heading-scale))',
    fontWeight: 'var(--heading-weight)',
    fontStyle: 'var(--heading-style)',
    fontStretch: 'var(--heading-stretch)',
    fontVariationSettings: 'var(--heading-variation)',
    textTransform: 'var(--heading-transform)',
    letterSpacing: 'var(--heading-tracking)',
    padding: '0.75em 2px 0',
  },
  // The last two stay in the reading face at body size. A level-five heading is
  // a label inside a document, and a display face at 1em is just a wrong font.
  '.cm-spark-h5': { fontWeight: '700', padding: '0.7em 2px 0' },
  '.cm-spark-h6': {
    fontWeight: '700',
    color: 'var(--text-faint)',
    padding: '0.7em 2px 0',
  },

  // --- Blocks --------------------------------------------------------------
  '.cm-spark-quote': {
    borderLeft: '3px solid var(--rule-strong)',
    paddingLeft: '0.85em',
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },

  // Code is always monospaced, whatever the reading face is set to — column
  // alignment is part of what the code means.
  '.cm-spark-code': {
    backgroundColor: 'var(--code-bg)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.92em',
    padding: '0 0.8em',
  },
  // The fences are gone, so the block's first and last rows have to look like
  // the top and bottom of something.
  '.cm-spark-code-open': {
    borderTopLeftRadius: 'var(--radius)',
    borderTopRightRadius: 'var(--radius)',
    paddingTop: '0.15em',
  },
  '.cm-spark-code-close': {
    borderBottomLeftRadius: 'var(--radius)',
    borderBottomRightRadius: 'var(--radius)',
    paddingBottom: '0.45em',
  },

  '.cm-spark-code-bar': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '0.5em',
    width: '100%',
    height: '1.6em',
    verticalAlign: 'top',
  },
  '.cm-spark-code-lang': {
    fontFamily: 'var(--font-ui)',
    fontSize: '0.72em',
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-faintest)',
    userSelect: 'none',
  },
  '.cm-spark-code-copy': {
    display: 'inline-grid',
    placeItems: 'center',
    width: '1.7em',
    height: '1.7em',
    padding: '0',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    background: 'none',
    color: 'var(--text-faintest)',
    cursor: 'pointer',
    transition: 'color var(--fast) var(--ease), background var(--fast) var(--ease)',
  },
  '.cm-spark-code-copy:hover': {
    color: 'var(--text-muted)',
    backgroundColor: 'var(--surface-sunken)',
  },
  '.cm-spark-code-copy svg': {
    width: '0.95em',
    height: '0.95em',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.7',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  },
  // Confirmation without a layout change: the icon stays put and turns green.
  '.cm-spark-code-copy[data-copied="true"]': { color: 'var(--success)' },
  '.cm-spark-code-copy[data-copied="failed"]': { color: 'var(--danger)' },

  '.cm-spark-frontmatter': {
    color: 'var(--text-faint)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.85em',
    backgroundColor: 'var(--code-bg)',
  },

  '.cm-spark-table': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.9em',
  },

  // Heading marks hang into the left margin while they're showing, so the
  // heading text keeps the same left edge as body text.
  '.cm-spark-head-hang': {
    textIndent: 'calc(var(--hang) * -1)',
  },

  // --- Inline --------------------------------------------------------------
  //
  // A link to somewhere else in the space reads as an object you can pick up —
  // a soft rounded chip. A link out to the web is still prose, so it keeps the
  // familiar underline. The difference tells you where a click will take you
  // before you make it.
  '.cm-spark-link': {
    color: 'var(--accent)',
    textDecoration: 'underline',
    textDecorationThickness: '1px',
    textUnderlineOffset: '2px',
    textDecorationColor: 'var(--accent-faint)',
    cursor: 'pointer',
  },
  '.cm-spark-wikilink': {
    color: 'var(--accent)',
    backgroundColor: 'var(--accent-soft)',
    borderRadius: '4px',
    padding: '0.08em 0.32em',
    textDecoration: 'none',
    cursor: 'pointer',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
  },
  '.cm-spark-wikilink:hover': {
    backgroundColor: 'var(--accent-faint)',
  },
  '.cm-spark-tag': {
    color: 'var(--tag)',
    backgroundColor: 'var(--tag-soft)',
    borderRadius: '4px',
    padding: '0.08em 0.32em',
    fontSize: '0.92em',
    cursor: 'pointer',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
  },
  '.cm-spark-tag:hover': {
    filter: 'brightness(0.94)',
  },
  // Inline code as a chip: tinted box, hairline outline, tight radius. It reads
  // as something you would type rather than as a differently-coloured word.
  '.cm-spark-inline-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.88em',
    color: 'var(--code-text)',
    backgroundColor: 'var(--code-inline-bg)',
    border: '1px solid var(--code-inline-border)',
    borderRadius: '4px',
    padding: '0.12em 0.34em',
    boxDecorationBreak: 'clone',
    WebkitBoxDecorationBreak: 'clone',
  },
  '.cm-spark-highlight': {
    backgroundColor: 'var(--highlight-bg)',
    borderRadius: '2px',
    padding: '0.05em 0.15em',
  },
  // A wikilink, a tag or a URL landing under a highlight or an active search
  // match sets its own `color` (accent, or the tag colour), which overrides
  // the body text these backgrounds were actually chosen against. Checked by
  // computing WCAG contrast for every built-in theme: `--text` on
  // `--highlight-bg` passes AA in all twelve, but `--accent`/`--tag` on the
  // same background fails in most of them — as low as 2.5:1 — because
  // nothing pairs those colours on purpose. Forcing the safe, already-verified
  // body colour here is cheaper than re-picking every theme's accent to also
  // work as a highlight foreground, and covers both nesting orders a mark
  // decoration can produce.
  '.cm-spark-highlight .cm-spark-wikilink, .cm-spark-wikilink .cm-spark-highlight,\n   .cm-spark-highlight .cm-spark-tag, .cm-spark-tag .cm-spark-highlight,\n   .cm-spark-highlight .cm-spark-link, .cm-spark-link .cm-spark-highlight,\n   .cm-searchMatch .cm-spark-wikilink, .cm-spark-wikilink .cm-searchMatch,\n   .cm-searchMatch .cm-spark-tag, .cm-spark-tag .cm-searchMatch,\n   .cm-searchMatch .cm-spark-link, .cm-spark-link .cm-searchMatch': {
    color: 'var(--text)',
  },
  '.cm-spark-task-done': {
    color: 'var(--text-faint)',
    textDecoration: 'line-through',
    textDecorationColor: 'var(--text-faintest)',
  },

  // --- Widgets -------------------------------------------------------------
  // The tap target is bigger than the box: `::before` is absolutely positioned,
  // so it extends the clickable area into the surrounding whitespace without
  // taking any layout space of its own — the visible checkbox stays exactly
  // 1.05em. `verticalAlign` moved here from `.cm-spark-checkbox` because this
  // span, not the input, is now the inline-level box the line aligns.
  '.cm-spark-checkbox-hit': {
    position: 'relative',
    display: 'inline-block',
    verticalAlign: '-0.15em',
    // The line's negative text-indent (the `--hang` outdent) is inherited, and
    // text-indent applies to the inline-block's own first line — which dragged
    // the checkbox left by the whole hang and sat every checkbox on the page
    // at the far-left margin, indented or not. The widget's own advance is
    // what positions the box; the line's indent must not reach inside it.
    textIndent: '0',
    cursor: 'pointer',
  },
  '.cm-spark-checkbox-hit::before': {
    content: '""',
    position: 'absolute',
    top: '-0.4em',
    bottom: '-0.4em',
    left: '-0.3em',
    right: '-0.3em',
  },
  '.cm-spark-checkbox': {
    appearance: 'none',
    width: '1.05em',
    height: '1.05em',
    margin: '0 0.35em 0 0',
    border: '1.5px solid var(--rule-strong)',
    borderRadius: '4px',
    cursor: 'pointer',
    position: 'relative',
    transition: 'background-color 120ms ease, border-color 120ms ease',
  },
  '.cm-spark-checkbox:hover': { borderColor: 'var(--accent)' },
  // A checkbox covered by the selection paints itself with the selection's own
  // colour: the highlight is drawn *behind* the widget, so without this an
  // opaque checked box would sit as a gap in the middle of a highlighted line.
  // The checkmark stays, so a checked task still reads as checked mid-select.
  '.cm-spark-checkbox-hit[data-selected] .cm-spark-checkbox': {
    backgroundColor: 'var(--selection)',
    borderColor: 'var(--selection)',
  },
  '.cm-spark-checkbox:checked': {
    backgroundColor: 'var(--accent)',
    borderColor: 'var(--accent)',
  },
  '.cm-spark-checkbox:checked::after': {
    content: '""',
    position: 'absolute',
    left: '0.3em',
    top: '0.1em',
    width: '0.25em',
    height: '0.5em',
    border: 'solid var(--accent-contrast)',
    borderWidth: '0 2px 2px 0',
    transform: 'rotate(45deg)',
  },

  // A plain bullet's `-`/`*`/`+`, replaced by `BulletWidget`. `width` here is
  // `BULLET_EM` in `metrics.ts` — change one and the other goes stale.
  '.cm-spark-bullet': {
    display: 'inline-block',
    width: '1.1em',
    height: '1em',
    // `top` put the dot at the top of the whole line box, which is taller
    // than the text itself once line-height is 1.5+ — it read as sitting
    // above the word next to it rather than beside it. `middle` is relative
    // to the baseline instead, which is what actually centers it on the text.
    verticalAlign: 'middle',
    position: 'relative',
    cursor: 'text',
  },
  '.cm-spark-bullet::before': {
    content: '""',
    position: 'absolute',
    left: '0.36em',
    top: '50%',
    width: '0.32em',
    height: '0.32em',
    borderRadius: '50%',
    backgroundColor: 'var(--text-faint)',
    transform: 'translateY(-50%)',
  },

  '.cm-spark-rule': {
    display: 'inline-block',
    width: '100%',
    verticalAlign: 'middle',
  },
  '.cm-spark-rule hr': {
    border: 'none',
    borderTop: '1px solid var(--rule)',
    margin: '0',
  },

  '.cm-spark-image img': {
    maxWidth: '100%',
    borderRadius: '8px',
    display: 'block',
  },
  '.cm-spark-image-broken': {
    color: 'var(--text-faint)',
    fontSize: '0.9em',
  },

  // --- Find ----------------------------------------------------------------
  //
  // Only the matches. The bar itself is drawn by the shell over the *view*, not
  // by CodeMirror inside the document — see `SparkEditor.setFind` and
  // `FindBar` — so there is no `.cm-panel` here to style.
  '.cm-searchMatch': {
    backgroundColor: 'var(--search-match)',
    borderRadius: '2px',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--search-match-active)',
  },

  // --- Autocomplete --------------------------------------------------------
  '.cm-tooltip': {
    border: '1px solid var(--rule)',
    backgroundColor: 'var(--surface-raised)',
    borderRadius: '10px',
    boxShadow: 'var(--shadow-md)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-ui)',
    fontSize: '0.875rem',
    maxHeight: '16em',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '0.4em 0.7em',
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.5em',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--text)',
  },
  '.cm-completionDetail': {
    marginLeft: 'auto',
    color: 'var(--text-faint)',
    fontStyle: 'normal',
    fontSize: '0.85em',
  },
});

/**
 * The selection `drawSelection` draws, at the specificity it actually wins at.
 *
 * The base theme's focused selection rule — `&light.cm-focused > .cm-scroller
 * > .cm-selectionLayer .cm-selectionBackground` — is five classes deep, so a
 * plain `.cm-selectionBackground` override loses on specificity, and the
 * focused selection painted a fixed light colour even in dark mode, where the
 * text it sat under is also light. The editor is classed light by default
 * because this theme follows CSS variables rather than declaring a scheme, so
 * whichever base variant matches, restating the rule at its own specificity —
 * with the editor's own scope class standing in for the scheme class — makes
 * the token win. `Prec.highest` puts it after the base theme in the stylesheet,
 * which is what breaks the tie at equal specificity.
 */
export const sparkSelection = Prec.highest(
  EditorView.theme({
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: 'var(--selection)',
    },
  }),
);

/** Token colours. Kept deliberately quiet — structure reads through weight. */
export const sparkHighlightStyle = HighlightStyle.define([
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-faint)' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--text-faint)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)', color: 'var(--code-text)' },
  { tag: t.processingInstruction, color: 'var(--text-faintest)' },
  { tag: t.contentSeparator, color: 'var(--text-faintest)' },
  //
  // There is deliberately no rule for `t.list`. The grammar tags a list as
  // `"BulletList/..."` — every descendant, not the marker — and `Task` carries
  // the same tag on the whole line, so colouring it greys the *text* of every
  // bullet and every task on the page. A page of tasks then reads as a page of
  // disabled controls. The markers are already quiet: `ListMark` is a
  // processing instruction, one line up.
  { tag: t.quote, color: 'var(--text-muted)' },
  { tag: t.tagName, color: 'var(--tag)' },

  // Fenced code contents.
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: t.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.labelName], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-property)' },
  { tag: t.operator, color: 'var(--syn-operator)' },
]);

export const sparkHighlighting = syntaxHighlighting(sparkHighlightStyle);
