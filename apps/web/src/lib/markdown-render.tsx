import type { ReactNode } from 'react';

/**
 * Markdown to React, for reading rather than editing.
 *
 * Deliberately small and deliberately not CodeMirror: the editor's live preview
 * exists to keep the source visible while you write in it, which is the wrong
 * shape entirely for a reply you are only going to read. This handles the
 * subset a written answer actually uses — headings, paragraphs, lists, tasks,
 * quotes, fenced and inline code, links, emphasis — and passes anything else
 * through as text rather than pretending to be a full parser.
 *
 * It never renders raw HTML. Everything becomes React elements, so a reply that
 * happens to contain a `<script>` is a paragraph containing that text.
 */

export function renderMarkdown(source: string): ReactNode {
  const lines = source.split('\n');
  const blocks: ReactNode[] = [];

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(<p key={blocks.length}>{inline(paragraph.join(' '))}</p>);
    paragraph = [];
  };

  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, index) => <li key={index}>{listItem(item)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };

  const flushQuote = () => {
    if (quote.length === 0) return;
    blocks.push(<blockquote key={blocks.length}>{inline(quote.join(' '))}</blockquote>);
    quote = [];
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code: consumed whole, so nothing inside it is interpreted.
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      flushAll();
      const marker = fence[1];
      const language = fence[2].trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push(
        <pre key={blocks.length} data-language={language || undefined}>
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length, 6);
      const Tag = `h${level === 1 ? 2 : level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      // A reply is not a document: its top heading sits inside the page's own
      // hierarchy, so everything shifts down one level.
      blocks.push(<Tag key={blocks.length}>{inline(heading[2])}</Tag>);
      continue;
    }

    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flushAll();
      blocks.push(<hr key={blocks.length} />);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      flushQuote();
      const isOrdered = ordered !== null;
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push((bullet ?? ordered)![1]);
      continue;
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  flushAll();
  return blocks;
}

/** A list item, with `- [ ]` rendered as the checkbox it means. */
function listItem(text: string): ReactNode {
  const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
  if (!task) return inline(text);
  return (
    <span className="md-task" data-done={task[1] !== ' ' || undefined}>
      <input type="checkbox" checked={task[1] !== ' '} readOnly tabIndex={-1} />
      {inline(task[2])}
    </span>
  );
}

/**
 * Inline spans.
 *
 * Code first and non-recursively, so backticks win: `**not bold**` inside code
 * has to stay literal, and that is only true if nothing looks inside a code
 * span afterwards.
 */
const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(==[^=\n]+==)|(\[\[[^\]]+\]\])|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>]+)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const token = match[0];

    if (token.startsWith('`')) {
      out.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('==')) {
      out.push(<mark key={key++}>{token.slice(2, -2)}</mark>);
    } else if (token.startsWith('[[')) {
      out.push(
        <span className="md-wikilink" key={key++}>
          {token.slice(2, -2)}
        </span>,
      );
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      out.push(
        link ? (
          <a key={key++} href={link[2]} target="_blank" rel="noopener noreferrer">
            {link[1]}
          </a>
        ) : (
          token
        ),
      );
    } else if (token.startsWith('http')) {
      out.push(
        <a key={key++} href={token} target="_blank" rel="noopener noreferrer">
          {token}
        </a>,
      );
    } else {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }

    last = index + token.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}
