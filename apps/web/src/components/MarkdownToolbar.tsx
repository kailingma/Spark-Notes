import type { SparkEditor } from '@spark/editor';

/**
 * The mobile markdown keyboard row.
 *
 * Phone keyboards bury backticks, brackets and asterisks two layers deep, which
 * is enough friction to stop people writing markdown on a phone at all. This row
 * puts the characters that actually matter one tap away, above the keyboard.
 *
 * Buttons use `onMouseDown`/`onTouchStart` with `preventDefault` so the editor
 * never loses focus — losing focus would dismiss the keyboard on every tap.
 */

interface Key {
  label: string;
  title: string;
  wide?: boolean;
  apply: (editor: SparkEditor) => void;
}

const KEYS: Key[] = [
  { label: '#', title: 'Heading', apply: (e) => e.setHeading(2) },
  { label: '☑', title: 'Task', apply: (e) => e.toggleTask() },
  { label: '–', title: 'Bullet', apply: (e) => e.insertSnippet('- |') },
  { label: 'B', title: 'Bold', apply: (e) => e.toggleWrap('**') },
  { label: 'I', title: 'Italic', apply: (e) => e.toggleWrap('*') },
  { label: '`', title: 'Code', apply: (e) => e.toggleWrap('`') },
  { label: '```', title: 'Code block', wide: true, apply: (e) => e.insertSnippet('```|\n\n```') },
  { label: '[[ ]]', title: 'Link a page', wide: true, apply: (e) => e.insertSnippet('[[|]]') },
  { label: '[ ]', title: 'Brackets', wide: true, apply: (e) => e.insertSnippet('[|]') },
  { label: '( )', title: 'Parentheses', wide: true, apply: (e) => e.insertSnippet('(|)') },
  { label: '{ }', title: 'Braces', wide: true, apply: (e) => e.insertSnippet('{|}') },
  { label: '>', title: 'Quote', apply: (e) => e.insertSnippet('> |') },
  { label: '==', title: 'Highlight', apply: (e) => e.toggleWrap('==') },
  { label: '—', title: 'Divider', apply: (e) => e.insertSnippet('\n---\n\n|') },
  { label: '↹', title: 'Indent', apply: (e) => e.insertSnippet('  ') },
];

export function MarkdownToolbar({ editor }: { editor: SparkEditor | null }) {
  if (!editor) return null;

  const press = (key: Key) => (event: React.SyntheticEvent) => {
    event.preventDefault();
    key.apply(editor);
  };

  return (
    <div className="md-toolbar" role="toolbar" aria-label="Markdown shortcuts">
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
          {key.label}
        </button>
      ))}
    </div>
  );
}
