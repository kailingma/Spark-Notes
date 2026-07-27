import { tags as t } from '@lezer/highlight';
import type { MarkdownConfig } from '@lezer/markdown';

/**
 * Markdown syntax Spark understands beyond CommonMark + GFM.
 *
 * These are parser-level additions rather than regex passes over the text, so
 * they compose correctly with the rest of markdown — a `[[link]]` inside a code
 * fence stays literal, and the live-preview layer gets real syntax nodes to
 * hide and reveal.
 */

const LEFT_BRACKET = 91; // [
const EQUALS = 61; // =
const HASH = 35; // #

/** `[[Page]]` and `[[Page|shown text]]`. */
export const WikiLink: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink', style: t.link },
    { name: 'WikiLinkMark', style: t.processingInstruction },
    { name: 'WikiLinkTarget', style: t.link },
    { name: 'WikiLinkAlias', style: t.link },
  ],
  parseInline: [
    {
      name: 'WikiLink',
      parse(cx, next, pos) {
        if (next !== LEFT_BRACKET || cx.char(pos + 1) !== LEFT_BRACKET) return -1;

        const rest = cx.slice(pos + 2, cx.end);
        const closeAt = rest.indexOf(']]');
        if (closeAt < 0) return -1;

        const inner = rest.slice(0, closeAt);
        // Wiki links never span lines, and a nested `[` means we're looking at
        // something else that happens to start with two brackets.
        if (inner.length === 0 || /[\n[\]]/.test(inner)) return -1;

        const innerStart = pos + 2;
        const innerEnd = innerStart + closeAt;
        const end = innerEnd + 2;

        const children = [cx.elt('WikiLinkMark', pos, innerStart)];
        const pipeAt = inner.indexOf('|');
        if (pipeAt >= 0) {
          children.push(
            cx.elt('WikiLinkTarget', innerStart, innerStart + pipeAt),
            cx.elt('WikiLinkMark', innerStart + pipeAt, innerStart + pipeAt + 1),
            cx.elt('WikiLinkAlias', innerStart + pipeAt + 1, innerEnd),
          );
        } else {
          children.push(cx.elt('WikiLinkTarget', innerStart, innerEnd));
        }
        children.push(cx.elt('WikiLinkMark', innerEnd, end));

        return cx.addElement(cx.elt('WikiLink', pos, end, children));
      },
      // Run before the built-in link parser so `[[` isn't eaten as `[`.
      before: 'Link',
    },
  ],
};

/** `==highlighted==`. */
export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: t.special(t.string) },
    { name: 'HighlightMark', style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      parse(cx, next, pos) {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS) return -1;

        const rest = cx.slice(pos + 2, cx.end);
        const closeAt = rest.indexOf('==');
        if (closeAt <= 0) return -1;
        if (rest.slice(0, closeAt).includes('\n')) return -1;

        const end = pos + 2 + closeAt + 2;
        return cx.addElement(
          cx.elt('Highlight', pos, end, [
            cx.elt('HighlightMark', pos, pos + 2),
            cx.elt('HighlightMark', end - 2, end),
          ]),
        );
      },
    },
  ],
};

/** `#tag` and `#nested/tag`, but never `#` used as a heading. */
export const Hashtag: MarkdownConfig = {
  defineNodes: [{ name: 'Hashtag', style: t.tagName }],
  parseInline: [
    {
      name: 'Hashtag',
      parse(cx, next, pos) {
        if (next !== HASH) return -1;

        // A tag has to follow whitespace or start the inline run, otherwise
        // things like `C#` and URL fragments would light up.
        if (pos > cx.offset) {
          const before = cx.slice(pos - 1, pos);
          if (!/\s/.test(before)) return -1;
        }

        const match = /^#([A-Za-z0-9][\w/-]*)/.exec(cx.slice(pos, cx.end));
        if (!match) return -1;

        const end = pos + match[0].length;
        return cx.addElement(cx.elt('Hashtag', pos, end));
      },
    },
  ],
};

export const sparkMarkdownExtensions = [WikiLink, Highlight, Hashtag];
