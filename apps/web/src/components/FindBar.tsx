import { useCallback, useEffect, useRef, useState } from 'react';
import type { SparkEditor } from '@spark/editor';
import { CloseIcon } from './Icons';

/**
 * Find, and replace.
 *
 * It hovers in the top-right of the **view**, not of the note. CodeMirror's own
 * panel is a child of the content element, and here the tile scrolls the editor
 * rather than the editor scrolling itself — so the built-in bar slid off the top
 * of the screen the moment you scrolled past the first paragraph, which is
 * roughly always. Drawing it here, in `.page-view`, means it is pinned to the
 * pane it belongs to and works the same in a tile, a split, a rail or a floating
 * window without any of them knowing about it.
 *
 * The query lives in React and the matches live in CodeMirror. That split is
 * deliberate: the highlighting, the wrapping and the regexp handling are all
 * `@codemirror/search`'s and would be worse re-implemented, while the *chrome*
 * is the app's and has to match everything else in it.
 */
export function FindBar({
  editor,
  onClose,
  /** Bumped when Find is pressed again while the bar is already open. */
  nonce,
  /**
   * The query to seed the field with — set when the bar is opened *for* a
   * search rather than by one: the navigator opening a page a content hit
   * found carries the phrase along, so it becomes a find within that document.
   */
  initialQuery,
}: {
  editor: SparkEditor | null;
  onClose: () => void;
  nonce: number;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [status, setStatus] = useState({ total: 0, current: 0 });

  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Pressing Find again selects what is in the box.
   *
   * The second press is nearly always "I want to search for something else",
   * and having to clear the field by hand first is the small friction that
   * makes people reach for the browser's own find instead.
   */
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [nonce]);

  // Seed the field only when the bar was opened carrying a query, and only
  // when that query is actually new — a ⌘F on a bar that already has the
  // navigator's phrase in it must not wipe what the person is reading.
  const appliedQuery = useRef('');
  useEffect(() => {
    if (!initialQuery || initialQuery === appliedQuery.current) return;
    appliedQuery.current = initialQuery;
    setQuery(initialQuery);
  }, [initialQuery, nonce]);

  // Pushing the query down and reading the counter back are the same beat: the
  // count is only meaningful for the query that produced it.
  const push = useCallback(
    (next: {
      search: string;
      caseSensitive: boolean;
      wholeWord: boolean;
      regexp: boolean;
      replace: string;
    }) => {
      if (!editor) return;
      editor.setFind(next);
      setStatus(editor.findStatus());
    },
    [editor],
  );

  useEffect(() => {
    push({ search: query, caseSensitive, wholeWord, regexp, replace: replacement });
  }, [push, query, caseSensitive, wholeWord, regexp, replacement]);

  /**
   * A seeded search lands on its first match.
   *
   * The navigator sent this phrase along with the page it found; the person
   * did not type it here. Typing is a different gesture — the query grows one
   * character at a time and the cursor should stay put while it does — but an
   * arrived-with query has an answer already picked, and landing on it is what
   * "search" means. Waits for the query to reach the field *and* the editor:
   * a page that was just opened loads its editor asynchronously, and stepping
   * into an empty document would find nothing and never try again.
   * Declared *after* the push effect above, because effects run in order and
   * findNext must run against the query that just landed, not the old one.
   */
  const landed = useRef(false);
  useEffect(() => {
    if (!initialQuery || landed.current) return;
    if (query !== initialQuery || !editor) return;
    const step = () => {
      if (landed.current || !editor.text().trim()) return;
      landed.current = true;
      editor.findNext();
      setStatus(editor.findStatus());
    };
    const off = editor.onChange(step);
    step();
    return off;
  }, [initialQuery, query, editor]);

  // Clearing the query on the way out, so the highlighting goes with the bar.
  useEffect(() => {
    return () => editor?.setFind({ search: '' });
  }, [editor]);

  const step = (backwards: boolean) => {
    if (!editor || !query) return;
    if (backwards) editor.findPrevious();
    else editor.findNext();
    setStatus(editor.findStatus());
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      // Back to the document, not to nothing: Escape from find means "carry on
      // writing", and leaving focus on a bar that has just gone is a dead end.
      onClose();
      editor?.focus();
    }
  };

  // A query with no matches is the one state worth colouring, because it is the
  // one where nothing on screen changes and it looks as though find is broken.
  const missing = query.length > 0 && status.total === 0;

  return (
    <div className="findbar" role="search" aria-label="Find in this page" onKeyDown={onKeyDown}>
      <div className="findbar-row">
        <input
          ref={inputRef}
          className="findbar-input"
          value={query}
          placeholder="Find"
          aria-label="Find"
          data-missing={missing || undefined}
          onChange={(event) => setQuery(event.target.value)}
        />

        <span className="findbar-count" aria-live="polite">
          {query.length === 0 ? '' : missing ? 'No results' : `${status.current || 1}/${status.total}`}
        </span>

        <div className="findbar-flags" role="group" aria-label="Match options">
          <Flag label="Aa" title="Match case" on={caseSensitive} onToggle={setCaseSensitive} />
          <Flag label="ab" title="Whole word" on={wholeWord} onToggle={setWholeWord} />
          <Flag label=".*" title="Regular expression" on={regexp} onToggle={setRegexp} />
        </div>

        <button
          className="findbar-step"
          title="Previous match — ⇧↵"
          aria-label="Previous match"
          disabled={!query}
          onClick={() => step(true)}
        >
          ↑
        </button>
        <button
          className="findbar-step"
          title="Next match — ↵"
          aria-label="Next match"
          disabled={!query}
          onClick={() => step(false)}
        >
          ↓
        </button>
        <button
          className="findbar-step"
          title={replacing ? 'Hide replace' : 'Replace'}
          aria-label={replacing ? 'Hide replace' : 'Replace'}
          aria-pressed={replacing}
          onClick={() => setReplacing((on) => !on)}
        >
          ⇄
        </button>
        <button className="findbar-close" title="Close find" aria-label="Close find" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      {replacing && (
        <div className="findbar-row">
          <input
            className="findbar-input"
            value={replacement}
            placeholder="Replace with"
            aria-label="Replace with"
            onChange={(event) => setReplacement(event.target.value)}
          />
          <button
            className="button"
            data-variant="ghost"
            disabled={!query || status.total === 0}
            onClick={() => {
              editor?.replaceNext();
              if (editor) setStatus(editor.findStatus());
            }}
          >
            Replace
          </button>
          <button
            className="button"
            data-variant="ghost"
            disabled={!query || status.total === 0}
            onClick={() => {
              editor?.replaceAll();
              if (editor) setStatus(editor.findStatus());
            }}
          >
            All
          </button>
        </div>
      )}
    </div>
  );
}

function Flag({
  label,
  title,
  on,
  onToggle,
}: {
  label: string;
  title: string;
  on: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <button
      className="findbar-flag"
      aria-pressed={on}
      title={title}
      aria-label={title}
      onClick={() => onToggle(!on)}
    >
      {label}
    </button>
  );
}
