import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

/**
 * Outline editing: move headings (with their whole section), list items,
 * table rows and top-level paragraphs up or down, and indent/outdent list
 * items and headings.
 *
 * Ported from Silverbullet's `plugs/editor/outline_ops.ts` (MIT) onto this
 * editor's Lezer parse tree. The operations themselves are faithful ports —
 * the cursor arithmetic in `swapRegions` is Silverbullet's verbatim — but
 * every tree access had to change, because Lezer has no `children` arrays and
 * no separator text nodes:
 *
 * - Children are walked with `firstChild`/`nextSibling`, never array indices.
 *   The helpers `typedChildren` and `findParentMatching` stand in for
 *   Silverbullet's `children` arrays and parent pointers.
 * - Silverbullet's "skip separator text nodes" (`if (!s.type) continue`)
 *   disappears: Lezer trees simply have no text children. The one place where
 *   an unwanted *typed* sibling can sit between list items — a `QuoteMark`
 *   inside a `BulletList` in a blockquote — is filtered explicitly in
 *   `combinedListItems` by requiring `name === 'ListItem'`.
 * - `resolveInner`, not `nodeAtPos`: at a node boundary Lezer resolves to the
 *   container, and the drill-down loop in `detectContext` recovers the
 *   preceding typed child (cursor-at-end-of-line).
 *
 * Both a blocked move (item already at the boundary) and "no context here"
 * (cursor in a code block or frontmatter) return `false` from the exported
 * functions, so a key binding falls through without dispatch. The keymap
 * cannot tell them apart, and it does not need to — the only asymmetry is
 * the toast text the shell commands show.
 *
 * Selections: operations act on `state.selection.main`, like Silverbullet's
 * single-cursor model, and the move lands the cursor at its new position,
 * collapsing any range.
 */

type OutlineResult =
  | { text: string; cursor: number; from: number; to: number }
  | 'blocked'
  | null;

interface ListContext {
  type: 'listItem';
  item: SyntaxNode;
  list: SyntaxNode; // BulletList or OrderedList
}

interface HeadingContext {
  type: 'heading';
  level: number;
  // The heading's section: indices into the typed children of the Document.
  sectionStart: number; // inclusive
  sectionEnd: number; // exclusive
  doc: SyntaxNode;
}

interface ParagraphContext {
  type: 'paragraph';
  blockIndex: number; // index into the typed children of the Document
  doc: SyntaxNode;
}

interface TableRowContext {
  type: 'tableRow';
  row: SyntaxNode; // TableRow or TableHeader
  rowIndex: number; // index into the typed children of the Table
  isHeader: boolean;
  table: SyntaxNode;
}

type CursorContext =
  | ListContext
  | HeadingContext
  | ParagraphContext
  | TableRowContext;

/** The typed children of a node, in order. Lezer has no `children` array. */
function typedChildren(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== '') out.push(child);
  }
  return out;
}

/** Walks up from `node` to the first ancestor satisfying `match`. */
function findParentMatching(
  node: SyntaxNode,
  match: (n: SyntaxNode) => boolean,
): SyntaxNode | null {
  let cur = node.parent;
  while (cur) {
    if (match(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

/**
 * The index of `node` within `children`, comparing by source position.
 *
 * Lezer creates a *fresh object instance for every traversal* — the node
 * returned by `resolveInner` and the nodes walked via `firstChild`/
 * `nextSibling` are different objects for the same tree position, so
 * `Array.prototype.indexOf` (reference equality) never matches. Positions
 * are unique among a node's children, so `from`/`to` identify the node
 * unambiguously within its siblings.
 */
function indexOfNode(children: SyntaxNode[], node: SyntaxNode): number {
  for (let i = 0; i < children.length; i++) {
    if (children[i].from === node.from && children[i].to === node.to) return i;
  }
  return -1;
}

/**
 * Classifies the cursor position as a list item, heading, table row or
 * top-level paragraph. `resolveInner(cursor, 1)` at a node boundary returns
 * the *container* (Document, BulletList, ListItem…); the drill-down recovers
 * the preceding typed child whose `.to` equals the cursor, so an end-of-line
 * cursor resolves into the line that ends there. Positions with no outline
 * context — code blocks, frontmatter, past the end of the document — return
 * null: none of our four node kinds is reachable from them.
 */
function detectContext(tree: ReturnType<typeof syntaxTree>, cursor: number): CursorContext | null {
  if (cursor >= tree.length) return null;
  let node: SyntaxNode = tree.resolveInner(cursor, 1);

  // End-of-line drill-down, repeated until we reach a leaf or a node whose
  // end is not this cursor (there is nothing typed ending exactly here).
  for (;;) {
    let found: SyntaxNode | null = null;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name !== '' && child.to === cursor) {
        found = child;
      }
    }
    if (!found) break;
    node = found;
  }

  // List item. If resolution landed on the list container itself (a cursor on
  // the whitespace between items resolves to the BulletList), there is no item
  // under the cursor: don't walk up, return null.
  const listItem =
    node.name === 'ListItem'
      ? node
      : node.name === 'BulletList' || node.name === 'OrderedList'
        ? null
        : findParentMatching(node, (n) => n.name === 'ListItem');
  if (listItem) {
    const list = listItem.parent;
    if (list && (list.name === 'BulletList' || list.name === 'OrderedList')) {
      return { type: 'listItem', item: listItem, list };
    }
  }

  // Heading, with its whole section (subtitles and body) at the Document level.
  const heading = node.name.startsWith('ATXHeading')
    ? node
    : findParentMatching(node, (n) => n.name.startsWith('ATXHeading'));
  if (heading && heading.name.startsWith('ATXHeading')) {
    const level = parseInt(heading.name.replace('ATXHeading', ''), 10);
    const doc = heading.parent;
    if (doc?.name === 'Document') {
      const children = typedChildren(doc);
      const sectionStart = indexOfNode(children, heading);
      if (sectionStart >= 0) {
        let sectionEnd = children.length;
        for (let i = sectionStart + 1; i < children.length; i++) {
          if (children[i].name.startsWith('ATXHeading')) {
            const childLevel = parseInt(children[i].name.replace('ATXHeading', ''), 10);
            if (childLevel <= level) {
              sectionEnd = i;
              break;
            }
          }
        }
        return { type: 'heading', level, sectionStart, sectionEnd, doc };
      }
    }
  }

  // Table row or header.
  const tableRow =
    node.name === 'TableRow' || node.name === 'TableHeader'
      ? node
      : findParentMatching(
          node,
          (n) => n.name === 'TableRow' || n.name === 'TableHeader',
        );
  if (tableRow && (tableRow.name === 'TableRow' || tableRow.name === 'TableHeader')) {
    const table = tableRow.parent;
    if (table?.name === 'Table') {
      const children = typedChildren(table);
      return {
        type: 'tableRow',
        row: tableRow,
        rowIndex: indexOfNode(children, tableRow),
        isHeader: tableRow.name === 'TableHeader',
        table,
      };
    }
  }

  // Top-level paragraph.
  const para = node.name === 'Paragraph'
    ? node
    : findParentMatching(node, (n) => n.name === 'Paragraph');
  if (para && para.name === 'Paragraph' && para.parent?.name === 'Document') {
    const children = typedChildren(para.parent);
    const blockIndex = indexOfNode(children, para);
    if (blockIndex >= 0) {
      return { type: 'paragraph', blockIndex, doc: para.parent };
    }
  }

  return null;
}

/**
 * CommonMark starts a new BulletList whenever the marker character changes
 * (`- a` followed by `* c`), even with no blank line between them. Outline
 * operations treat runs of adjacent BulletLists as one logical list so items
 * can move across the marker boundary. Any other typed sibling — an ordered
 * list, a paragraph — breaks the run.
 */
function adjacentBulletListGroup(list: SyntaxNode): SyntaxNode[] {
  if (list.name !== 'BulletList') return [list];
  const parent = list.parent;
  if (!parent) return [list];
  const siblings = typedChildren(parent);
  const idx = indexOfNode(siblings, list);
  if (idx < 0) return [list];

  const group: SyntaxNode[] = [list];
  for (let i = idx - 1; i >= 0; i--) {
    if (siblings[i].name === 'BulletList') group.unshift(siblings[i]);
    else break;
  }
  for (let i = idx + 1; i < siblings.length; i++) {
    if (siblings[i].name === 'BulletList') group.push(siblings[i]);
    else break;
  }
  return group;
}

/**
 * All ListItem nodes of a list and its adjacent BulletList siblings, in
 * document order. Filtered by name: inside a blockquote a `QuoteMark` sits
 * interleaved between ListItems in the same BulletList, and counting it would
 * corrupt the index arithmetic.
 */
function combinedListItems(list: SyntaxNode): SyntaxNode[] {
  const items: SyntaxNode[] = [];
  for (const l of adjacentBulletListGroup(list)) {
    for (const c of typedChildren(l)) {
      if (c.name === 'ListItem') items.push(c);
    }
  }
  return items;
}

/**
 * Swaps two non-overlapping text regions, preserving the separator between
 * them (for list items and table rows that is exactly the newline). The
 * cursor is adjusted to ride the region it was in: with `direction: 'up'` it
 * ends at `firstFrom`, with `'down'` after the swapped-in first region.
 */
function swapRegions(
  text: string,
  cursor: number,
  currFrom: number,
  direction: 'up' | 'down',
  firstFrom: number,
  firstTo: number,
  secondFrom: number,
  secondTo: number,
): OutlineResult {
  const firstContent = text.slice(firstFrom, firstTo);
  const separator = text.slice(firstTo, secondFrom);
  const secondContent = text.slice(secondFrom, secondTo);
  const newText =
    text.slice(0, firstFrom) +
    secondContent +
    separator +
    firstContent +
    text.slice(secondTo);
  const offsetInCurr = cursor - currFrom;
  const newCursor =
    direction === 'up'
      ? firstFrom + offsetInCurr
      : firstFrom + secondContent.length + separator.length + offsetInCurr;
  return { text: newText, cursor: newCursor, from: firstFrom, to: secondTo };
}

/** Renumbers ordered-list markers sequentially within `[listFrom, listTo)`. */
function renumberOrderedList(
  text: string,
  listFrom: number,
  listTo: number,
): string {
  const listText = text.slice(listFrom, listTo);
  let num = 1;
  const renumbered = listText.replace(/^(\s*)(\d+)\./gm, (_match, indent) => {
    return `${indent}${num++}.`;
  });
  return text.slice(0, listFrom) + renumbered + text.slice(listTo);
}

/** Applies a computed outline result as one change, or reports it blocked. */
function applyResult(view: EditorView, result: OutlineResult): boolean {
  if (result === null || result === 'blocked') return false;
  const { text, cursor, from, to } = result;
  // `text` is the whole new document; `from`/`to` are offsets into the *old*
  // document. The changed span is the new content between the unchanged
  // prefix (length `from`) and the unchanged suffix (length
  // `original.length - to`) — slicing the new text at `to` directly would
  // read the wrong offset whenever the op changes length, which indenting
  // a list item does.
  const original = view.state.doc.toString();
  const insert = text.slice(from, text.length - (original.length - to));
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: cursor },
    userEvent: 'input',
  });
  return true;
}

/**
 * Swaps a list item with its adjacent sibling — across an adjacent BulletList
 * boundary if the marker changed — renumbering the list when it is ordered.
 * Returns null at the ends of the run.
 */
function moveListItem(
  text: string,
  cursor: number,
  ctx: ListContext,
  direction: 'up' | 'down',
): OutlineResult {
  const { item, list } = ctx;
  const items = combinedListItems(list);
  const itemPos = indexOfNode(items, item);

  if (direction === 'up' && itemPos <= 0) return null;
  if (direction === 'down' && itemPos >= items.length - 1) return null;

  const otherItem = items[direction === 'up' ? itemPos - 1 : itemPos + 1];
  const first = direction === 'up' ? otherItem : item;
  const second = direction === 'up' ? item : otherItem;

  const result = swapRegions(
    text,
    cursor,
    item.from,
    direction,
    first.from,
    first.to,
    second.from,
    second.to,
  );
  if (result === null || result === 'blocked') return result;

  if (list.name === 'OrderedList') {
    // The swap preserves the list's extent, so the original offsets still
    // cover it in the new text.
    return {
      ...result,
      text: renumberOrderedList(result.text, list.from, list.to),
    };
  }
  return result;
}

/** Start of the line containing `pos`. */
function lineStartPos(text: string, pos: number): number {
  let start = pos;
  while (start > 0 && text[start - 1] !== '\n') start--;
  return start;
}

/**
 * A list's indent width: 2 for bullets, marker length + 1 for ordered (`1.`
 * → 3). Only the first item's marker decides; the number of digits is the
 * widest thing a renumber can produce.
 */
function listIndentWidth(text: string, list: SyntaxNode): number {
  if (list.name === 'BulletList') return 2;
  const firstItem = typedChildren(list).find((c) => c.name === 'ListItem');
  const mark = firstItem?.getChild('ListMark');
  if (mark) return text.slice(mark.from, mark.to).length + 1;
  return 3;
}

/**
 * Adds one indent level to a list item and every line under it, cursor
 * riding along. An item with a preceding sibling (any BulletList in the
 * adjacent group), or the first item of an already-nested list, can indent;
 * otherwise it is blocked.
 */
function indentListItem(
  text: string,
  cursor: number,
  ctx: ListContext,
): OutlineResult {
  const { item, list } = ctx;
  const items = combinedListItems(list);
  const itemPos = indexOfNode(items, item);

  const isNested = list.parent?.name === 'ListItem';
  if (itemPos <= 0 && !isNested) return null;

  const indentWidth = listIndentWidth(text, list);
  const indentStr = ' '.repeat(indentWidth);

  const lineFrom = lineStartPos(text, item.from);
  const lineTo = item.to;
  const itemLines = text.slice(lineFrom, lineTo);

  const indented = itemLines
    .split('\n')
    .map((line) => (line ? indentStr + line : line))
    .join('\n');

  const newText = text.slice(0, lineFrom) + indented + text.slice(lineTo);

  const linesBeforeCursor = text.slice(lineFrom, cursor).split('\n').length;
  return {
    text: newText,
    cursor: cursor + linesBeforeCursor * indentWidth,
    from: lineFrom,
    to: lineTo,
  };
}

/**
 * Removes one indent level. Requires the item line to start with at least
 * two spaces (the bullet indent), so a plain top-level item reports blocked
 * rather than mangling itself.
 */
function outdentListItem(
  text: string,
  cursor: number,
  ctx: ListContext,
): OutlineResult {
  const { item, list } = ctx;

  const lineFrom = lineStartPos(text, item.from);
  const lineTo = item.to;
  const itemLines = text.slice(lineFrom, lineTo);

  if (!itemLines.startsWith('  ')) return null;

  const indentWidth = listIndentWidth(text, list);

  const outdented = itemLines
    .split('\n')
    .map((line) => {
      if (line.startsWith(' '.repeat(indentWidth))) {
        return line.substring(indentWidth);
      }
      let removed = 0;
      while (removed < indentWidth && line[removed] === ' ') removed++;
      return line.substring(removed);
    })
    .join('\n');

  const newText = text.slice(0, lineFrom) + outdented + text.slice(lineTo);

  const linesBeforeCursor = text.slice(lineFrom, cursor).split('\n').length;
  return {
    text: newText,
    cursor: cursor - linesBeforeCursor * indentWidth,
    from: lineFrom,
    to: lineTo,
  };
}

/**
 * The end of the last typed child within a section range, excluding the
 * trailing separator newline. Lezer's block nodes exclude the newline from
 * `.to` already, but the *section's* last child may be followed by further
 * Document children — this makes sure the moved region stops exactly at the
 * content, not bleeding into the next section's separator.
 */
function lastTypedChildEnd(children: SyntaxNode[], start: number, end: number): number {
  for (let i = end - 1; i >= start; i--) {
    if (children[i]) return children[i].to;
  }
  return children[start].from;
}

/**
 * Swaps a heading's section — itself, its sub-headings and its body — with
 * the adjacent section at the same level. A higher-level heading between the
 * two blocks the move, because the section would otherwise be torn.
 */
function moveHeading(
  text: string,
  cursor: number,
  ctx: HeadingContext,
  direction: 'up' | 'down',
): OutlineResult {
  const { level, sectionStart, sectionEnd, doc } = ctx;
  const children = typedChildren(doc);

  // Find the adjacent section at the same level.
  const searchFrom = direction === 'up' ? sectionStart - 1 : sectionEnd;
  const searchTo = direction === 'up' ? -1 : children.length;
  const step = direction === 'up' ? -1 : 1;

  let adjSectionStart = -1;
  for (let i = searchFrom; i !== searchTo; i += step) {
    const child = children[i];
    if (child.name.startsWith('ATXHeading')) {
      const childLevel = parseInt(child.name.replace('ATXHeading', ''), 10);
      if (childLevel === level) {
        adjSectionStart = i;
        break;
      }
      if (childLevel < level) return null;
    }
  }
  if (adjSectionStart < 0) return null;

  // Where the adjacent section ends. For a move up it is bounded by ours;
  // for a move down by the next heading no deeper than ours.
  let adjSectionEnd: number;
  if (direction === 'up') {
    adjSectionEnd = sectionStart;
  } else {
    adjSectionEnd = children.length;
    for (let i = adjSectionStart + 1; i < children.length; i++) {
      const child = children[i];
      if (child.name.startsWith('ATXHeading')) {
        const childLevel = parseInt(child.name.replace('ATXHeading', ''), 10);
        if (childLevel <= level) {
          adjSectionEnd = i;
          break;
        }
      }
    }
  }

  const [firstStart, firstEnd, secondStart, secondEnd] =
    direction === 'up'
      ? [adjSectionStart, adjSectionEnd, sectionStart, sectionEnd]
      : [sectionStart, sectionEnd, adjSectionStart, adjSectionEnd];

  return swapRegions(
    text,
    cursor,
    children[sectionStart].from,
    direction,
    children[firstStart].from,
    lastTypedChildEnd(children, firstStart, firstEnd),
    children[secondStart].from,
    lastTypedChildEnd(children, secondStart, secondEnd),
  );
}

/**
 * Adds or removes one `#` from every heading in the section, clamping at the
 * extremes — an h6 section cannot indent further, an h1 cannot outdent.
 * The cursor rides along with the heading it is inside.
 */
function adjustHeadingLevel(
  text: string,
  cursor: number,
  ctx: HeadingContext,
  delta: 1 | -1,
): OutlineResult {
  const { level, sectionStart, sectionEnd, doc } = ctx;
  if (delta === 1 && level >= 6) return null;
  if (delta === -1 && level <= 1) return null;

  const limitLevel = delta === 1 ? 6 : 1;
  const children = typedChildren(doc);
  const sectionFrom = children[sectionStart].from;
  const sectionTo = children[sectionEnd - 1].to;
  const sectionText = text.slice(sectionFrom, sectionTo);

  let cursorAdjust = 0;
  let newSectionText = '';
  let pos = 0;
  for (let i = sectionStart; i < sectionEnd; i++) {
    const child = children[i];
    if (!child.name.startsWith('ATXHeading')) continue;

    const childLevel = parseInt(child.name.replace('ATXHeading', ''), 10);
    if (childLevel === limitLevel) continue;

    const childFrom = child.from - sectionFrom;
    const childTo = child.to - sectionFrom;

    newSectionText += sectionText.slice(pos, childFrom);
    if (delta === 1) {
      newSectionText += `#${sectionText.slice(childFrom, childTo)}`;
    } else {
      newSectionText += sectionText.slice(childFrom + 1, childTo);
    }
    pos = childTo;

    if (cursor > child.from) cursorAdjust += delta;
  }
  newSectionText += sectionText.slice(pos);

  return {
    text: text.slice(0, sectionFrom) + newSectionText + text.slice(sectionTo),
    cursor: cursor + cursorAdjust,
    from: sectionFrom,
    to: sectionTo,
  };
}

/**
 * Swaps a table data row with the adjacent data row. Header rows are blocked:
 * swapping a header under the delimiter row would make the table lie about
 * which row is the header. Rows are addressed by their index among `TableRow`
 * siblings, skipping the header and the delimiter row.
 */
function moveTableRow(
  text: string,
  cursor: number,
  ctx: TableRowContext,
  direction: 'up' | 'down',
): OutlineResult {
  if (ctx.isHeader) return null;

  const { row, table } = ctx;
  const children = typedChildren(table);

  const rowIndices: number[] = [];
  for (let i = 0; i < children.length; i++) {
    if (children[i].name === 'TableRow') rowIndices.push(i);
  }

  const rowPos = rowIndices.indexOf(ctx.rowIndex);
  if (direction === 'up' && rowPos <= 0) return null;
  if (direction === 'down' && rowPos >= rowIndices.length - 1) return null;

  const otherRow = children[rowIndices[direction === 'up' ? rowPos - 1 : rowPos + 1]];
  const first = direction === 'up' ? otherRow : row;
  const second = direction === 'up' ? row : otherRow;

  return swapRegions(
    text,
    cursor,
    row.from,
    direction,
    first.from,
    first.to,
    second.from,
    second.to,
  );
}

/**
 * Swaps a top-level paragraph with the adjacent block. Any typed Document
 * sibling is fair game — a heading, another paragraph, a list — so a
 * paragraph can be moved out from under a heading it does not belong to.
 */
function moveParagraph(
  text: string,
  cursor: number,
  ctx: ParagraphContext,
  direction: 'up' | 'down',
): OutlineResult {
  const { blockIndex, doc } = ctx;
  const children = typedChildren(doc);
  const currNode = children[blockIndex];

  const step = direction === 'up' ? -1 : 1;
  const adjIdx = blockIndex + step;
  if (adjIdx < 0 || adjIdx >= children.length) return null;

  const adjNode = children[adjIdx];
  const first = direction === 'up' ? adjNode : currNode;
  const second = direction === 'up' ? currNode : adjNode;

  return swapRegions(
    text,
    cursor,
    currNode.from,
    direction,
    first.from,
    first.to,
    second.from,
    second.to,
  );
}

function move(
  view: EditorView,
  direction: 'up' | 'down',
): boolean {
  const state = view.state;
  const text = state.doc.toString();
  const cursor = state.selection.main.head;
  const ctx = detectContext(syntaxTree(state), cursor);
  if (!ctx) return false;

  let result: OutlineResult = null;
  switch (ctx.type) {
    case 'listItem':
      result = moveListItem(text, cursor, ctx, direction);
      break;
    case 'heading':
      result = moveHeading(text, cursor, ctx, direction);
      break;
    case 'paragraph':
      result = moveParagraph(text, cursor, ctx, direction);
      break;
    case 'tableRow':
      result = moveTableRow(text, cursor, ctx, direction);
      break;
  }
  return applyResult(view, result);
}

function adjust(
  view: EditorView,
  delta: 1 | -1,
): boolean {
  const state = view.state;
  const text = state.doc.toString();
  const cursor = state.selection.main.head;
  const ctx = detectContext(syntaxTree(state), cursor);
  if (!ctx) return false;

  let result: OutlineResult = null;
  switch (ctx.type) {
    case 'listItem':
      result =
        delta === 1
          ? indentListItem(text, cursor, ctx)
          : outdentListItem(text, cursor, ctx);
      break;
    case 'heading':
      result = adjustHeadingLevel(text, cursor, ctx, delta);
      break;
    case 'paragraph':
    case 'tableRow':
      // Indenting a paragraph or a table row would mean reindenting its
      // text, which is not what outline indentation is for.
      result = 'blocked';
      break;
  }
  return applyResult(view, result);
}

/** Moves the heading, list item, paragraph or table row at the cursor up. */
export function moveItemUp(view: EditorView): boolean {
  return move(view, 'up');
}

/** Moves the heading, list item, paragraph or table row at the cursor down. */
export function moveItemDown(view: EditorView): boolean {
  return move(view, 'down');
}

/** Indents the list item or heading at the cursor. */
export function indentItem(view: EditorView): boolean {
  return adjust(view, 1);
}

/** Outdents the list item or heading at the cursor. */
export function outdentItem(view: EditorView): boolean {
  return adjust(view, -1);
}