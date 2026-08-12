import { useEffect, useState, type ReactNode } from 'react';
import type { SparkEditor } from '@spark/editor';
import {
  BoldIcon,
  CodeBlockIcon,
  DividerIcon,
  HeadingIcon,
  HighlighterIcon,
  IndentIcon,
  InlineCodeIcon,
  ItalicIcon,
  LinkPageIcon,
  ListIcon,
  QuoteIcon,
  TaskIcon,
} from './Icons';
import { useWindows } from '../windows/manager';

/**
 * The mobile markdown keyboard row.
 *
 * Phone keyboards bury backticks, brackets and asterisks two layers deep, which
 * is enough friction to stop people writing markdown on a phone at all. This row
 * puts the characters that actually matter one tap away, above the keyboard.
 *
 * Buttons use `onMouseDown`/`onTouchStart` with `preventDefault` so the editor
 * never loses focus — losing focus would dismiss the keyboard on every tap.
 *
 * Icons rather than the literal character for anything a lucide glyph reads
 * clearly as (bold, italic, a heading, a quote); brackets, parens and braces
 * stay literal because there is no icon for "insert this exact punctuation"
 * that reads faster than the punctuation itself.
 */

interface Key {
  icon?: ReactNode;
  label: string;
  title: string;
  wide?: boolean;
  apply: (editor: SparkEditor) => void;
}

const KEYS: Key[] = [
  { icon: <HeadingIcon />, label: '#', title: 'Heading', apply: (e) => e.setHeading(2) },
  { icon: <TaskIcon />, label: '☑', title: 'Task', apply: (e) => e.toggleTask() },
  { icon: <ListIcon />, label: '–', title: 'Bullet', apply: (e) => e.insertSnippet('- |') },
  { icon: <BoldIcon />, label: 'B', title: 'Bold', apply: (e) => e.toggleWrap('**') },
  { icon: <ItalicIcon />, label: 'I', title: 'Italic', apply: (e) => e.toggleWrap('*') },
  { icon: <InlineCodeIcon />, label: '`', title: 'Code', apply: (e) => e.toggleWrap('`') },
  {
    icon: <CodeBlockIcon />,
    label: '```',
    title: 'Code block',
    wide: true,
    apply: (e) => e.insertSnippet('```|\n\n```'),
  },
  {
    icon: <LinkPageIcon />,
    label: '[[ ]]',
    title: 'Link a page',
    wide: true,
    apply: (e) => e.insertSnippet('[[|]]'),
  },
  { label: '[ ]', title: 'Brackets', wide: true, apply: (e) => e.insertSnippet('[|]') },
  { label: '( )', title: 'Parentheses', wide: true, apply: (e) => e.insertSnippet('(|)') },
  { label: '{ }', title: 'Braces', wide: true, apply: (e) => e.insertSnippet('{|}') },
  { icon: <QuoteIcon />, label: '>', title: 'Quote', apply: (e) => e.insertSnippet('> |') },
  { icon: <HighlighterIcon />, label: '==', title: 'Highlight', apply: (e) => e.toggleWrap('==') },
  { icon: <DividerIcon />, label: '—', title: 'Divider', apply: (e) => e.insertSnippet('\n---\n\n|') },
  { icon: <IndentIcon />, label: '↹', title: 'Indent', apply: (e) => e.insertSnippet('  ') },
];

/**
 * How much of the layout viewport's bottom the on-screen keyboard covers.
 *
 * `visualViewport` shrinks (and, on iOS, scrolls) when the keyboard opens; the
 * layout viewport — what percentages and `100vh` are measured against — does
 * not. The gap between the two bottoms is exactly the keyboard's height, so
 * the toolbar can sit right above it instead of guessing from `env()`, which
 * only ever knows about the home indicator, not a keyboard.
 */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      setInset(Math.max(0, Math.round(covered)));
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return inset;
}

export function MarkdownToolbar() {
  // The editor in the focused tile. Asked for rather than passed down, because
  // on a phone there is only ever one, and on anything wider this row is hidden.
  const { activeEditor: editor } = useWindows();
  const keyboardInset = useKeyboardInset();
  if (!editor) return null;

  const press = (key: Key) => (event: React.SyntheticEvent) => {
    event.preventDefault();
    key.apply(editor);
  };

  return (
    <div
      className="md-toolbar"
      role="toolbar"
      aria-label="Markdown shortcuts"
      // A measured number no class can hold — see `AGENTS.md`'s inline-style
      // exception. Zero (no `visualViewport`, or the keyboard is closed) is
      // the same as not setting it: the toolbar sits in its ordinary place in
      // the flow, `env(safe-area-inset-bottom)` in `app.css` covering the
      // home indicator as it always did.
      style={keyboardInset > 0 ? { transform: `translateY(-${keyboardInset}px)` } : undefined}
    >
      {KEYS.map((key) => (
        <button
          key={key.label}
          className="md-key"
          data-wide={key.wide}
          title={key.title}
          aria-label={key.title}
          onMouseDown={press(key)}
          onTouchStart={press(key)}
        >
          {key.icon ?? key.label}
        </button>
      ))}
    </div>
  );
}
