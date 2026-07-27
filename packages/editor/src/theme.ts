import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
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

  '.cm-scroller': {
    fontFamily: 'var(--font-editor)',
    lineHeight: 'var(--editor-line-height)',
    overflowY: 'auto',
    // Room to breathe at the bottom so the last line is never pinned to the
    // edge of the screen while typing.
    paddingBottom: '40vh',
  },

  '.cm-content': {
    padding: '0',
    maxWidth: 'var(--editor-measure)',
    margin: '0 auto',
    width: '100%',
    caretColor: 'var(--accent)',
  },

  '.cm-line': { padding: '0 2px' },

  '.cm-cursor, .cm-dropCursor': {
    borderLeft: '2px solid var(--accent)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--selection)',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--selection-match)' },

  '.cm-gutters': { display: 'none' },

  '.cm-placeholder': {
    color: 'var(--text-faintest)',
    fontStyle: 'normal',
  },

  // --- Headings ------------------------------------------------------------
  '.cm-spark-h1': {
    fontSize: '1.7em',
    fontWeight: '700',
    lineHeight: '1.25',
    letterSpacing: '-0.02em',
    margin: '0.9em 0 0.15em',
  },
  '.cm-spark-h2': {
    fontSize: '1.38em',
    fontWeight: '700',
    lineHeight: '1.3',
    letterSpacing: '-0.015em',
    margin: '0.85em 0 0.1em',
  },
  '.cm-spark-h3': { fontSize: '1.16em', fontWeight: '700', margin: '0.8em 0 0.05em' },
  '.cm-spark-h4': { fontSize: '1.04em', fontWeight: '700', margin: '0.75em 0 0' },
  '.cm-spark-h5': { fontWeight: '700', margin: '0.7em 0 0' },
  '.cm-spark-h6': { fontWeight: '700', color: 'var(--text-faint)', margin: '0.7em 0 0' },

  // --- Blocks --------------------------------------------------------------
  '.cm-spark-quote': {
    borderLeft: '3px solid var(--rule-strong)',
    paddingLeft: '0.85em',
    color: 'var(--text-muted)',
    fontStyle: 'italic',
  },

  '.cm-spark-code': {
    backgroundColor: 'var(--code-bg)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.92em',
  },

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

  // --- Inline --------------------------------------------------------------
  '.cm-spark-link': {
    color: 'var(--accent)',
    textDecoration: 'none',
    cursor: 'pointer',
  },
  '.cm-spark-wikilink': {
    color: 'var(--accent)',
    textDecoration: 'none',
    cursor: 'pointer',
    borderBottom: '1px solid var(--accent-faint)',
  },
  '.cm-spark-tag': {
    color: 'var(--tag)',
    fontSize: '0.92em',
  },
  '.cm-spark-highlight': {
    backgroundColor: 'var(--highlight-bg)',
    borderRadius: '2px',
    padding: '0.05em 0.15em',
  },
  '.cm-spark-task-done': {
    color: 'var(--text-faint)',
    textDecoration: 'line-through',
    textDecorationColor: 'var(--text-faintest)',
  },

  // --- Widgets -------------------------------------------------------------
  '.cm-spark-checkbox': {
    appearance: 'none',
    width: '1.05em',
    height: '1.05em',
    margin: '0 0.35em 0 0',
    verticalAlign: '-0.15em',
    border: '1.5px solid var(--rule-strong)',
    borderRadius: '4px',
    cursor: 'pointer',
    position: 'relative',
    transition: 'background-color 120ms ease, border-color 120ms ease',
  },
  '.cm-spark-checkbox:hover': { borderColor: 'var(--accent)' },
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

  '.cm-spark-rule': {
    display: 'inline-block',
    width: '100%',
    verticalAlign: 'middle',
  },
  '.cm-spark-rule hr': {
    border: 'none',
    borderTop: '1px solid var(--rule)',
    margin: '0.6em 0',
  },

  '.cm-spark-image img': {
    maxWidth: '100%',
    borderRadius: '8px',
    display: 'block',
    margin: '0.35em 0',
  },
  '.cm-spark-image-broken': {
    color: 'var(--text-faint)',
    fontSize: '0.9em',
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
  { tag: t.list, color: 'var(--text-faint)' },
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
