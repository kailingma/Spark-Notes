import type { Task } from '@spark/plugin-sdk';

// ---------------------------------------------------------------------------
// Page names
// ---------------------------------------------------------------------------

/**
 * Normalizes a page name into the canonical form used everywhere: no leading
 * slash, no `.md`, forward slashes, collapsed whitespace.
 */
export function normalizePageName(name: string): string {
  return name
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\.md$/i, '')
    .trim();
}

/** The last path segment — what we show in tabs and headers. */
export function pageBasename(name: string): string {
  const parts = normalizePageName(name).split('/');
  return parts[parts.length - 1] || name;
}

/** The folder a page lives in, or `''` for top-level pages. */
export function pageFolder(name: string): string {
  const parts = normalizePageName(name).split('/');
  parts.pop();
  return parts.join('/');
}

/**
 * Rejects names that would escape the space root or hit reserved characters.
 * The server enforces this too; this copy gives fast feedback in the UI.
 */
export function isValidPageName(name: string): boolean {
  const n = normalizePageName(name);
  if (!n) return false;
  if (n.length > 400) return false;
  if (n.split('/').some((seg) => seg === '.' || seg === '..' || seg === '')) return false;
  // Spaces and dashes are fine in page names; the set below is the characters
  // that break on one filesystem or another.
  return !/[\0<>:"|?*]/.test(n);
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

export interface Frontmatter {
  /** Parsed key/value pairs. Values stay strings or string arrays — we keep the
   * parser deliberately small rather than pulling in a YAML dependency. */
  data: Record<string, string | string[]>;
  /** Document text with the frontmatter block removed. */
  body: string;
  /** Character offset where the body starts in the original text. */
  bodyOffset: number;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(text: string): Frontmatter {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return { data: {}, body: text, bodyOffset: 0 };

  const data: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;

  for (const line of match[1].split(/\r?\n/)) {
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && currentListKey) {
      (data[currentListKey] as string[]).push(unquote(listItem[1]));
      continue;
    }
    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    const value = rawValue.trim();
    if (value === '') {
      data[key] = [];
      currentListKey = key;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((v) => unquote(v.trim()))
        .filter(Boolean);
      currentListKey = null;
    } else {
      data[key] = unquote(value);
      currentListKey = null;
    }
  }

  return { data, body: text.slice(match[0].length), bodyOffset: match[0].length };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Titles and previews
// ---------------------------------------------------------------------------

/**
 * Display title for a page: an explicit frontmatter `title`, else the first
 * H1, else the page's basename.
 */
export function pageTitle(name: string, text: string): string {
  const { data, body } = parseFrontmatter(text);
  if (typeof data.title === 'string' && data.title) return data.title;
  const heading = /^#\s+(.+)$/m.exec(body);
  if (heading) return heading[1].trim();
  return pageBasename(name);
}

/** A one-line plain-text preview, with markdown noise stripped. */
export function pagePreview(text: string, maxLength = 120): string {
  const { body } = parseFrontmatter(text);
  const plain = body
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => alias || target)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~>]/g, '')
    .replace(/^\s*[-*+]\s+(\[[ xX]\]\s*)?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > maxLength ? `${plain.slice(0, maxLength - 1)}…` : plain;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** `[[Page]]` and `[[Page|alias]]`. */
export const WIKILINK_RE = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;

export interface WikiLink {
  target: string;
  alias?: string;
  from: number;
  to: number;
}

export function findWikiLinks(text: string): WikiLink[] {
  const links: WikiLink[] = [];
  const re = new RegExp(WIKILINK_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    links.push({
      target: normalizePageName(match[1]),
      alias: match[2]?.trim(),
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** `- [ ] text`, `* [x] text`, `+ [X] text`, with optional indentation. */
export const TASK_RE = /^(\s*)([-*+])\s+\[([ xX])\]\s?(.*)$/;

const DUE_RE = /(?:📅\s*|due:)(\d{4}-\d{2}-\d{2})/;
const TAG_RE = /(?:^|\s)#([A-Za-z0-9][\w/-]*)/g;

/** Extracts every task line from a page. Fenced code blocks and empty checkboxes are skipped. */
export function parseTasks(page: string, text: string): Task[] {
  const tasks: Task[] = [];
  const lines = text.split('\n');
  let inFence = false;

  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line];

    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = TASK_RE.exec(raw);
    if (!match) continue;

    const [, indent, , checked, rest] = match;
    const tags: string[] = [];
    let tagMatch: RegExpExecArray | null;
    const tagRe = new RegExp(TAG_RE.source, 'g');
    while ((tagMatch = tagRe.exec(rest))) tags.push(tagMatch[1]);

    const dueMatch = DUE_RE.exec(rest);
    const cleaned = rest
      .replace(DUE_RE, '')
      .replace(/\s+/g, ' ')
      .trim();
    // A checkbox with nothing after it (`- [ ]` alone, or a line that only
    // carries a due marker) is a placeholder, not a task — don't surface it.
    if (!cleaned) continue;

    tasks.push({
      id: `${page}:${line}`,
      page,
      line,
      done: checked.toLowerCase() === 'x',
      text: cleaned,
      raw,
      tags,
      due: dueMatch ? Date.parse(`${dueMatch[1]}T00:00:00`) : undefined,
      // Two spaces or one tab per level, matching how most editors indent lists.
      depth: Math.floor(indent.replace(/\t/g, '  ').length / 2),
    });
  }

  return tasks;
}

/** Flips a single task's checkbox in a page's text, by line number. */
export function toggleTaskInText(text: string, line: number, done: boolean): string {
  const lines = text.split('\n');
  const target = lines[line];
  if (target === undefined) return text;
  const match = TASK_RE.exec(target);
  if (!match) return text;
  lines[line] = target.replace(/\[[ xX]\]/, done ? '[x]' : '[ ]');
  return lines.join('\n');
}
