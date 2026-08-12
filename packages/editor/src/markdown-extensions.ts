import { tags as t } from '@lezer/highlight';
import type { Element, MarkdownConfig } from '@lezer/markdown';

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

/** A fence line: three dashes and nothing else. */
const FENCE_RE = /^---[ \t]*$/;
/** `key:` at the start of a line — what a frontmatter line looks like. */
const KEY_RE = /^([A-Za-z0-9_.-]+)([ \t]*:)/;
/** `- value` inside a block list. */
const ITEM_RE = /^([ \t]*-[ \t]+)(.*)$/;
/** Keys whose values are tags, so they can be painted and clicked as tags. */
const TAG_KEYS = new Set(['tags', 'tag', 'keywords', 'topics']);

/**
 * YAML-ish frontmatter, as a real block.
 *
 * Without this the two fences are read as *markdown*, which is wrong in two
 * different ways at once: `---` on the first line is a thematic break, and the
 * closing `---` under the last key is a setext H2 underline — so a note with
 * frontmatter opens with a horizontal rule and a display-sized heading made out
 * of its own metadata. Consuming the block here means neither parser ever sees
 * those lines.
 *
 * The block is only claimed when the line after the opening fence is a `key:`
 * or the closing fence, because `---` at the top of a document is otherwise a
 * perfectly ordinary rule and stealing it would be worse than the bug.
 *
 * It ends at the closing fence, or at a blank line if there is none — a block
 * parser cannot look further ahead than one line, so an unterminated block has
 * to stop *somewhere*, and the blank line before the prose is the boundary a
 * person has already drawn.
 */
export const Frontmatter: MarkdownConfig = {
  defineNodes: [
    { name: 'Frontmatter', block: true },
    { name: 'FrontmatterMark', style: t.processingInstruction },
    { name: 'FrontmatterKey', style: t.propertyName },
    { name: 'FrontmatterValue', style: t.string },
    { name: 'FrontmatterTag', style: t.tagName },
  ],
  parseBlock: [
    {
      name: 'Frontmatter',
      parse(cx, line) {
        if (cx.lineStart !== 0 || !FENCE_RE.test(line.text)) return false;
        const next = cx.peekLine();
        if (!FENCE_RE.test(next) && !KEY_RE.test(next)) return false;

        const children = [cx.elt('FrontmatterMark', 0, line.text.length)];
        /** The key a `- item` list belongs to, which decides how items read. */
        let listKey = '';

        while (cx.nextLine()) {
          const start = cx.lineStart;
          const text = line.text;

          if (FENCE_RE.test(text)) {
            children.push(cx.elt('FrontmatterMark', start, start + text.length));
            cx.nextLine();
            break;
          }
          if (text.trim() === '') break;

          const pair = KEY_RE.exec(text);
          if (pair) {
            listKey = pair[1].toLowerCase();
            children.push(cx.elt('FrontmatterKey', start, start + pair[1].length));
            const value = text.slice(pair[0].length);
            children.push(
              ...valueElements(cx, start + pair[0].length, value, TAG_KEYS.has(listKey)),
            );
            continue;
          }

          const item = ITEM_RE.exec(text);
          if (item) {
            children.push(
              ...valueElements(cx, start + item[1].length, item[2], TAG_KEYS.has(listKey)),
            );
          }
        }

        cx.addElement(cx.elt('Frontmatter', 0, cx.prevLineEnd(), children));
        return true;
      },
      // `---` is a thematic break to every other parser, and that one wins on
      // the first line unless this runs first.
      before: 'HorizontalRule',
    },
  ],
};

/**
 * A frontmatter value, split into tags when the key is a tag key.
 *
 * `tags: [a, b]` and a `- a` list under `tags:` are the two ways people write
 * them, and both should end up as things you can click, so the splitting is
 * done here rather than left for the decoration pass to work out from the key.
 */
function valueElements(
  cx: { elt: (type: string, from: number, to: number) => Element },
  from: number,
  text: string,
  tags: boolean,
): Element[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];
  const offset = from + text.indexOf(trimmed);
  if (!tags) return [cx.elt('FrontmatterValue', offset, offset + trimmed.length)];

  const out: Element[] = [];
  // The brackets of `[a, b]` are punctuation, not part of any tag.
  const inner = /^\[(.*)\]$/.exec(trimmed);
  const body = inner ? inner[1] : trimmed;
  const bodyFrom = offset + (inner ? 1 : 0);

  let at = 0;
  for (const part of body.split(',')) {
    const start = bodyFrom + at + part.indexOf(part.trim());
    const label = part.trim().replace(/^["']|["']$/g, '');
    if (label) out.push(cx.elt('FrontmatterTag', start, start + part.trim().length));
    at += part.length + 1;
  }
  return out;
}

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
    // No style: the highlighted text must read as ordinary text — only the
    // background (`.cm-spark-highlight`, from the live-preview mark) sets it
    // apart. Tagging it `t.special(t.string)` painted it with the syntax
    // colour for strings, which is the colour code strings use.
    { name: 'Highlight' },
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

export const sparkMarkdownExtensions = [Frontmatter, WikiLink, Highlight, Hashtag];
