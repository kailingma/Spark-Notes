import { useMemo, useRef, useState, type ReactNode } from 'react';
import { GripIcon } from './Icons';
import { startPointerDrag } from '../windows/drag';

/**
 * The things that hang off a popover.
 *
 * They are here rather than beside their call sites because they are the same
 * kind of object — a small panel tethered to a point — and keeping them together
 * is what stops the next one being invented from scratch. None of them knows how
 * it is positioned; `Popover` owns that.
 */

// ---------------------------------------------------------------------------
// Emoji
// ---------------------------------------------------------------------------

/**
 * A curated set rather than the full Unicode table.
 *
 * The complete list is ~1,800 glyphs and needs a data file, a fuzzy index and a
 * virtualised grid to be usable. What people actually reach for in notes is a
 * couple of hundred, and a short list you can scan beats a long one you have to
 * search. Anything missing is still one paste away, which is the honest
 * fallback.
 */
const EMOJI: Array<{ group: string; items: Array<[string, string]> }> = [
  {
    group: 'Faces',
    items: [
      ['😀', 'grinning happy'], ['😄', 'smile happy'], ['😅', 'sweat relief'],
      ['😂', 'laugh tears joy'], ['🙂', 'slight smile'], ['😉', 'wink'],
      ['😊', 'blush warm'], ['😍', 'love heart eyes'], ['🤔', 'thinking hmm'],
      ['🤨', 'sceptical doubt'], ['😐', 'neutral flat'], ['🙄', 'eyeroll'],
      ['😴', 'sleep tired'], ['😭', 'cry sad'], ['😤', 'frustrated steam'],
      ['🤯', 'mind blown'], ['🥳', 'party celebrate'], ['😎', 'cool sunglasses'],
      ['🤝', 'handshake deal'], ['🙏', 'thanks please'],
    ],
  },
  {
    group: 'Work',
    items: [
      ['✅', 'done tick check'], ['❌', 'no cross fail'], ['⚠️', 'warning careful'],
      ['🚧', 'wip blocked'], ['📌', 'pin important'], ['📍', 'location here'],
      ['🔖', 'bookmark'], ['🏷️', 'tag label'], ['📝', 'note write'],
      ['📄', 'page document'], ['📁', 'folder'], ['🗂️', 'files archive'],
      ['📊', 'chart data'], ['📈', 'growth up'], ['📉', 'decline down'],
      ['🗓️', 'calendar date'], ['⏰', 'alarm deadline'], ['⏳', 'waiting pending'],
      ['🔗', 'link'], ['🔍', 'search find'],
    ],
  },
  {
    group: 'Signals',
    items: [
      ['💡', 'idea insight'], ['🔥', 'hot urgent'], ['⭐', 'star favourite'],
      ['❗', 'important'], ['❓', 'question unknown'], ['💭', 'thought maybe'],
      ['🎯', 'goal target'], ['🚀', 'ship launch'], ['🧠', 'brain thinking'],
      ['🧩', 'piece puzzle'], ['🔒', 'locked private'], ['🔓', 'open public'],
      ['♻️', 'refactor recycle'], ['🐛', 'bug'], ['🧪', 'test experiment'],
      ['⚙️', 'settings config'], ['🛠️', 'tools fix'], ['📦', 'package release'],
      ['💬', 'comment discuss'], ['📢', 'announce'],
    ],
  },
  {
    group: 'Life',
    items: [
      ['☕', 'coffee break'], ['🍽️', 'food meal'], ['🏃', 'run exercise'],
      ['🛌', 'rest sleep'], ['🎵', 'music'], ['📚', 'reading books'],
      ['✈️', 'travel flight'], ['🏠', 'home house'], ['🌱', 'growth plant'],
      ['🌧️', 'rain weather'], ['☀️', 'sun weather'], ['🌙', 'night moon'],
      ['❤️', 'love heart'], ['🎉', 'celebrate'], ['🎁', 'gift'],
      ['💰', 'money cost'], ['🧾', 'receipt expense'], ['🩺', 'health doctor'],
      ['🐈', 'cat'], ['🐕', 'dog'],
    ],
  },
];

/**
 * The same curated set, flattened for the editor's `:shortcode` completion —
 * see `emojiCompletion` in `@spark/editor`. One list, two presentations: a
 * grid you browse here, a filtered dropdown there.
 */
export const EMOJI_SHORTCODES: Array<{ glyph: string; keywords: string }> = EMOJI.flatMap((group) =>
  group.items.map(([glyph, keywords]) => ({ glyph, keywords })),
);

export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState('');

  // Dragged away from the caret it opened at. A popover is ordinarily placed
  // and left there — "dismissed by looking away from it" — but a grid this
  // size can end up sitting over the very line you're writing, and unlike a
  // two-row menu there's a real reason to want it somewhere else for a
  // while. The offset is a plain CSS transform on top of wherever `Popover`
  // anchored it, not a change to how anchoring works: nothing here fights
  // the measure-flip-clamp placement every other popover still gets.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragStart = useRef({ x: 0, y: 0 });

  const startDrag = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    dragStart.current = offset;
    startPointerDrag(event, {
      onMove: (_native, delta) => {
        setOffset({ x: dragStart.current.x + delta.dx, y: dragStart.current.y + delta.dy });
      },
    });
  };

  const groups = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return EMOJI;
    return EMOJI.map((group) => ({
      group: group.group,
      items: group.items.filter(([glyph, keywords]) => keywords.includes(search) || glyph === search),
    })).filter((group) => group.items.length > 0);
  }, [query]);

  return (
    <div
      className="picker"
      data-picker="emoji"
      style={offset.x || offset.y ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
    >
      <div className="picker-drag-handle" onPointerDown={startDrag} title="Drag to move">
        <GripIcon />
        <span>Emoji</span>
      </div>
      <input
        className="picker-search"
        value={query}
        placeholder="Search"
        aria-label="Search emoji"
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="picker-scroll">
        {groups.length === 0 && <p className="picker-empty">Nothing matches.</p>}
        {groups.map((group) => (
          <section className="picker-group" key={group.group}>
            <h4>{group.group}</h4>
            <div className="picker-grid">
              {group.items.map(([glyph, keywords]) => (
                <button
                  key={glyph}
                  className="picker-emoji"
                  title={keywords}
                  aria-label={keywords}
                  onClick={() => onPick(glyph)}
                >
                  {glyph}
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/**
 * The other half of the emoji picker.
 *
 * They are a pair and they sit side by side: a model preset is labelled with
 * *either* an emoji or one of the app's own glyphs, and which you reach for is a
 * question of taste rather than of capability. Neither one covers the other — an
 * emoji is instantly personal and needs no vocabulary, and a lucide glyph is the
 * only thing that will sit in a row of chrome without looking pasted on.
 *
 * The set is curated in `lib/mode-icons.tsx`, which is also what renders the
 * chosen name back. Keeping the list and the renderer in one module is what stops
 * a picker that can choose an icon nothing can draw.
 */
export function IconPicker({
  names,
  render,
  onPick,
}: {
  names: string[];
  /** How to draw one, so this file needs no opinion about the icon set. */
  render: (name: string) => ReactNode;
  onPick: (name: string) => void;
}) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const search = query.trim().toLowerCase();
    return search ? names.filter((name) => name.toLowerCase().includes(search)) : names;
  }, [names, query]);

  return (
    <div className="picker" data-picker="icon">
      <input
        className="picker-search"
        value={query}
        placeholder="Search"
        aria-label="Search icons"
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="picker-scroll">
        {shown.length === 0 && <p className="picker-empty">Nothing matches.</p>}
        <div className="picker-grid">
          {shown.map((name) => (
            <button
              key={name}
              className="picker-icon"
              title={name}
              aria-label={name}
              onClick={() => onPick(name)}
            >
              {render(name)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A template
// ---------------------------------------------------------------------------

/**
 * Choosing a template to insert.
 *
 * Deliberately plain — a search field over a short list of titles, the same
 * shape as `NotePicker` a few lines down — because a space with more than a
 * handful of templates is the exception, and this is reached often enough
 * (every `/template`, every "Use template") that it should never be more to
 * look at than the thing it's standing between you and.
 */
export function TemplatePicker({
  templates,
  onPick,
}: {
  templates: Array<{ name: string; title: string }>;
  onPick: (name: string) => void;
}) {
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return templates;
    return templates.filter((template) => template.title.toLowerCase().includes(search));
  }, [templates, query]);

  return (
    <div className="picker" data-picker="template">
      <input
        className="picker-search"
        value={query}
        placeholder="Search templates"
        aria-label="Search templates"
        autoFocus
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && shown[0]) {
            event.preventDefault();
            onPick(shown[0].name);
          }
        }}
      />
      <div className="picker-scroll">
        {shown.length === 0 && <p className="picker-empty">Nothing matches.</p>}
        {shown.map((template) => (
          <button key={template.name} className="picker-row" onClick={() => onPick(template.name)}>
            <span className="picker-row-name">{template.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A page
// ---------------------------------------------------------------------------

/**
 * Choosing a note out of the space.
 *
 * Filtered on the *whole* name, folder included, because "journal/2026" is how
 * people think of the thing they are looking for and a matcher that only saw the
 * last segment would make a folder full of dates unsearchable. Ranked so that a
 * match at the start of the last segment wins: typing "spa" should offer
 * "Spark Notes" before "projects/old/spa-redesign".
 *
 * Deliberately not the command palette. That one navigates — it opens what you
 * pick — and this one *returns* a name to whatever asked for it.
 */
export function NotePicker({
  pages,
  exclude,
  onPick,
  emptyLabel = 'No pages match.',
}: {
  pages: Array<{ name: string }>;
  /** Names already chosen, so the list does not offer them twice. */
  exclude?: string[];
  onPick: (name: string) => void;
  emptyLabel?: string;
}) {
  const [query, setQuery] = useState('');
  const skip = useMemo(() => new Set(exclude ?? []), [exclude]);

  const shown = useMemo(() => {
    const search = query.trim().toLowerCase();
    const available = pages.filter((page) => !skip.has(page.name));
    if (!search) return available.slice(0, 60);

    return available
      .map((page) => ({ page, score: scoreName(page.name, search) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.page.name.localeCompare(b.page.name))
      .slice(0, 60)
      .map((entry) => entry.page);
  }, [pages, skip, query]);

  return (
    <div className="picker" data-picker="note">
      <input
        className="picker-search"
        value={query}
        placeholder="Find a note"
        aria-label="Find a note"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Enter takes the top match, which is the whole point of a ranked list.
          if (event.key === 'Enter' && shown[0]) {
            event.preventDefault();
            onPick(shown[0].name);
          }
        }}
      />
      <div className="picker-scroll">
        {shown.length === 0 && <p className="picker-empty">{emptyLabel}</p>}
        {shown.map((page) => (
          <button key={page.name} className="picker-row" onClick={() => onPick(page.name)}>
            <span className="picker-row-name">{lastSegment(page.name)}</span>
            {page.name.includes('/') && (
              <small className="picker-row-where">{page.name.slice(0, page.name.lastIndexOf('/'))}</small>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

/** Zero is no match. Higher is a better one. */
function scoreName(name: string, search: string): number {
  const lower = name.toLowerCase();
  const leaf = lastSegment(lower);
  if (leaf.startsWith(search)) return 3;
  if (leaf.includes(search)) return 2;
  if (lower.includes(search)) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const pad = (n: number) => String(n).padStart(2, '0');

/** The format the rest of the app uses: journal names, memory dates, frontmatter. */
export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A month at a time, Monday first, with today marked.
 *
 * Weeks start on Monday because the journal does, and a picker that disagrees
 * with the page it writes into is a picker you have to re-read every time.
 */
export function DatePicker({
  initial,
  onPick,
}: {
  initial?: Date;
  onPick: (date: Date) => void;
}) {
  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(() => {
    const start = initial ?? today;
    return new Date(start.getFullYear(), start.getMonth(), 1);
  });

  const days = useMemo(() => monthGrid(cursor), [cursor]);
  const month = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const shift = (months: number) =>
    setCursor((current) => new Date(current.getFullYear(), current.getMonth() + months, 1));

  return (
    <div className="picker" data-picker="date">
      <header className="picker-head">
        <button className="picker-step" aria-label="Previous month" onClick={() => shift(-1)}>
          ‹
        </button>
        <span className="picker-month">{month}</span>
        <button className="picker-step" aria-label="Next month" onClick={() => shift(1)}>
          ›
        </button>
      </header>

      <div className="picker-week">
        {WEEKDAYS.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div className="picker-days">
        {days.map((day) => (
          <button
            key={isoDate(day)}
            className="picker-day"
            data-outside={day.getMonth() !== cursor.getMonth() || undefined}
            data-today={isSameDay(day, today) || undefined}
            onClick={() => onPick(day)}
          >
            {day.getDate()}
          </button>
        ))}
      </div>

      <footer className="picker-foot">
        <button className="button" data-variant="ghost" onClick={() => onPick(today)}>
          Today
        </button>
        <button
          className="button"
          data-variant="ghost"
          onClick={() => onPick(new Date(today.getTime() + 86_400_000))}
        >
          Tomorrow
        </button>
      </footer>
    </div>
  );
}

/** Six weeks, always, so the grid does not change height as you page through. */
function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  // `getDay()` is Sunday-first; shift it so Monday is 0.
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);

  return Array.from(
    { length: 42 },
    (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index),
  );
}

function isSameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

// ---------------------------------------------------------------------------
// Document statistics
// ---------------------------------------------------------------------------

/** Middle of the usual 200–250 wpm range for adults reading prose on a screen. */
const WORDS_PER_MINUTE = 225;

export interface DocumentStats {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  sentences: number;
  paragraphs: number;
  readingMinutes: number;
}

export function measureText(text: string): DocumentStats {
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  return {
    words,
    characters: text.length,
    charactersNoSpaces: text.replace(/\s/g, '').length,
    // Deliberately crude: an abbreviation counts as a sentence break. A real
    // segmenter is a dependency, and this number is a sense of scale, not a fact.
    sentences: trimmed ? (trimmed.match(/[.!?]+(\s|$)/g)?.length ?? 0) || 1 : 0,
    paragraphs: trimmed ? trimmed.split(/\n\s*\n/).filter((part) => part.trim()).length : 0,
    readingMinutes: words / WORDS_PER_MINUTE,
  };
}

/**
 * What the word count expands into.
 *
 * The status bar can only hold one number, and the one it holds is the least
 * interesting of the six. Pressing it is the cheapest possible way to ask for
 * the rest, and it is why the popover system had to exist at all.
 */
export function DocumentStatsPanel({ page, stats }: { page: string | null; stats: DocumentStats }) {
  return (
    <div className="stats">
      {page && <p className="stats-page">{page}</p>}
      <dl className="stats-list">
        <Stat label="Words" value={stats.words.toLocaleString()} />
        <Stat label="Reading time" value={readingLabel(stats.readingMinutes)} />
        <Stat label="Characters" value={stats.characters.toLocaleString()} />
        <Stat label="Without spaces" value={stats.charactersNoSpaces.toLocaleString()} />
        <Stat label="Sentences" value={stats.sentences.toLocaleString()} />
        <Stat label="Paragraphs" value={stats.paragraphs.toLocaleString()} />
      </dl>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stats-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** "Under a minute" beats "0 min", and "1 hr 5 min" beats "65 min". */
function readingLabel(minutes: number): string {
  if (minutes <= 0) return '—';
  if (minutes < 1) return 'Under a minute';
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  return `${Math.floor(whole / 60)} hr ${whole % 60} min`;
}
