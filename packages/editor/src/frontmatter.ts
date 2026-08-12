import type { Text } from '@codemirror/state';

/**
 * The frontmatter block, read straight off the document.
 *
 * The parser in `markdown-extensions.ts` gives the block real syntax nodes, and
 * that is what the decoration pass styles. This exists for the one thing the
 * tree cannot answer: a *setting* that applies to the whole page. Live preview
 * only walks the visible ranges, so a banner declared at the top of a long note
 * would be invisible to a heading two screens down — the value has to be read
 * from the document rather than from whatever happens to be on screen.
 *
 * Deliberately scalar-only and deliberately small: the keys that change how the
 * page is *drawn* are all single values. Lists (tags) are already nodes.
 */

/** Frontmatter never runs on for pages; past this it is prose, not metadata. */
const MAX_LINES = 80;

export interface PageSettings {
  /** `banner: path` — an image drawn behind every H1 on the page. */
  banner?: string;
  /** `title: text` — what the page is called, whatever the file is called. */
  title?: string;
}

export function pageSettings(doc: Text): PageSettings {
  if (doc.lines < 2 || doc.line(1).text.trimEnd() !== '---') return {};

  const settings: PageSettings = {};
  const last = Math.min(doc.lines, MAX_LINES);

  for (let n = 2; n <= last; n++) {
    const text = doc.line(n).text;
    if (text.trimEnd() === '---' || text.trim() === '') break;

    const pair = /^([A-Za-z0-9_.-]+)[ \t]*:[ \t]*(.*)$/.exec(text);
    if (!pair) continue;
    const value = unquote(pair[2].trim());
    if (!value) continue;
    if (pair[1].toLowerCase() === 'banner') settings.banner = value;
    if (pair[1].toLowerCase() === 'title') settings.title = value;
  }

  return settings;
}

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted ? quoted[2] : value;
}
