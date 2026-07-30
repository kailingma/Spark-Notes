import {
  EditorSelection,
  type ChangeSpec,
  type StateCommand,
} from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * The editing gestures that make markdown feel like a word processor rather
 * than a text file: wrapping, list continuation, indentation.
 */

const LIST_RE = /^(\s*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/;

/**
 * Wraps the selection in `before`/`after`, or unwraps when it is already
 * wrapped. With an empty selection it inserts the pair and places the cursor
 * between them, so `⌘B` then typing produces bold text.
 */
export function toggleWrap(view: EditorView, before: string, after = before): void {
  const { state } = view;

  view.dispatch(
    state.changeByRange((range) => {
      const outerFrom = range.from - before.length;
      const outerTo = range.to + after.length;

      const alreadyWrapped =
        outerFrom >= 0 &&
        outerTo <= state.doc.length &&
        state.doc.sliceString(outerFrom, range.from) === before &&
        state.doc.sliceString(range.to, outerTo) === after;

      if (alreadyWrapped) {
        return {
          changes: [
            { from: outerFrom, to: range.from },
            { from: range.to, to: outerTo },
          ],
          range: EditorSelection.range(outerFrom, range.to - before.length),
        };
      }

      const selected = state.sliceDoc(range.from, range.to);
      // Selection already contains the markers — strip them instead of nesting.
      if (
        selected.length >= before.length + after.length &&
        selected.startsWith(before) &&
        selected.endsWith(after)
      ) {
        const inner = selected.slice(before.length, selected.length - after.length);
        return {
          changes: { from: range.from, to: range.to, insert: inner },
          range: EditorSelection.range(range.from, range.from + inner.length),
        };
      }

      return {
        changes: { from: range.from, to: range.to, insert: before + selected + after },
        range: range.empty
          ? EditorSelection.cursor(range.from + before.length)
          : EditorSelection.range(
              range.from + before.length,
              range.to + before.length,
            ),
      };
    }),
  );
  view.focus();
}

/** Inserts text at the cursor, replacing any selection. */
export function insertText(view: EditorView, text: string): void {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => ({
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.cursor(range.from + text.length),
    })),
  );
  view.focus();
}

/**
 * Inserts a snippet where `|` marks the final cursor position.
 * `insertSnippet(view, '`|`')` gives you backticks with the cursor inside.
 */
export function insertSnippet(view: EditorView, snippet: string): void {
  const caret = snippet.indexOf('|');
  const text = caret >= 0 ? snippet.replace('|', '') : snippet;
  const { state } = view;

  view.dispatch(
    state.changeByRange((range) => ({
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.cursor(
        range.from + (caret >= 0 ? caret : text.length),
      ),
    })),
  );
  view.focus();
}

/** Applies `#`-prefixes to every line the selection touches. */
export function setHeadingLevel(view: EditorView, level: number): void {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();

  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);

      const line = state.doc.line(n);
      const existing = /^(#{1,6})\s+/.exec(line.text);
      const prefix = level > 0 ? `${'#'.repeat(level)} ` : '';
      // Asking for the level a line already has removes it — the key becomes
      // a toggle rather than a one-way trip.
      const insert = existing && existing[1].length === level ? '' : prefix;

      changes.push({
        from: line.from,
        to: line.from + (existing?.[0].length ?? 0),
        insert,
      });
    }
  }

  if (changes.length > 0) view.dispatch({ changes });
  view.focus();
}

/** Turns the current line into a task, or back into a plain list item. */
export function toggleTaskLine(view: EditorView): void {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();

  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);

      const line = state.doc.line(n);
      const match = LIST_RE.exec(line.text);

      if (match?.[4]) {
        // Already a task: drop the checkbox, keep the bullet.
        const at = line.from + match[1].length + match[2].length + match[3].length;
        changes.push({ from: at, to: at + match[4].length, insert: '' });
      } else if (match) {
        const at = line.from + match[1].length + match[2].length + match[3].length;
        changes.push({ from: at, to: at, insert: '[ ] ' });
      } else {
        const indent = /^\s*/.exec(line.text)?.[0] ?? '';
        changes.push({
          from: line.from + indent.length,
          to: line.from + indent.length,
          insert: '- [ ] ',
        });
      }
    }
  }

  if (changes.length > 0) view.dispatch({ changes });
  view.focus();
}

/**
 * Enter inside a list continues it. Pressing Enter on an empty item ends the
 * list instead of adding another blank bullet — the behaviour every writing app
 * has trained people to expect.
 */
export const continueList: StateCommand = ({ state, dispatch }) => {
  let handled = false;

  const transaction = state.changeByRange((range) => {
    if (!range.empty) return { range };

    const line = state.doc.lineAt(range.from);
    const match = LIST_RE.exec(line.text);
    if (!match) return { range };

    const [, indent, marker, spacing, task, content] = match;

    // Only continue when the cursor is at or past the end of the marker;
    // pressing Enter inside the indent should just split the line.
    const contentStart =
      line.from + indent.length + marker.length + spacing.length + (task?.length ?? 0);
    if (range.from < contentStart) return { range };

    handled = true;

    if (content.trim() === '') {
      // Enter on an empty item walks *out* one level at a time — nested list,
      // parent list, then plain text. Collapsing straight to an empty line
      // would throw away the nesting you just built with a single keystroke.
      const indentWidth = indent.replace(/\t/g, '  ').length;
      if (indentWidth > 0) {
        const outdented = indent.replace(/\t/g, '  ').slice(2);
        const rebuilt = `${outdented}${marker}${spacing}${task ? '[ ] ' : ''}`;
        return {
          changes: { from: line.from, to: line.to, insert: rebuilt },
          range: EditorSelection.cursor(line.from + rebuilt.length),
        };
      }

      // At the outer level there is nothing left to outdent to: end the list.
      return {
        changes: { from: line.from, to: line.to, insert: '' },
        range: EditorSelection.cursor(line.from),
      };
    }

    const nextMarker = /^\d+[.)]$/.test(marker)
      ? `${Number.parseInt(marker, 10) + 1}${marker.slice(-1)}`
      : marker;
    const insert = `\n${indent}${nextMarker}${spacing}${task ? '[ ] ' : ''}`;

    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    };
  });

  if (!handled) return false;
  dispatch(state.update(transaction, { scrollIntoView: true, userEvent: 'input' }));
  return true;
};

/** Tab / Shift-Tab indent and outdent list items by two spaces. */
export function indentListItems(view: EditorView, outdent = false): boolean {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  let touchedList = false;

  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);

      const line = state.doc.line(n);
      if (!LIST_RE.test(line.text)) continue;
      touchedList = true;

      if (outdent) {
        const lead = /^[ \t]{1,2}/.exec(line.text);
        if (lead) changes.push({ from: line.from, to: line.from + lead[0].length });
      } else {
        changes.push({ from: line.from, to: line.from, insert: '  ' });
      }
    }
  }

  if (!touchedList) return false;
  if (changes.length > 0) view.dispatch({ changes, userEvent: 'input.indent' });
  return true;
}
