/**
 * Capture modes.
 *
 * The switcher exists to avoid a decision. Instead of asking "where should this
 * go?" the user picks a label — idea, task, note — and Spark decides the file
 * and the markdown. Everything still lands in the daily page as plain markdown,
 * so the labels are a shortcut, never a silo: a task captured here is the same
 * `- [ ]` line you'd have typed by hand, and the Tasks page finds it either way.
 */

export interface CaptureMode {
  id: string;
  label: string;
  /** Single character shown in the switcher. */
  glyph: string;
  placeholder: string;
  /** Formats one captured chunk into markdown lines. */
  format(text: string, now: Date): string;
}

/** `journal/2026-07-27` — the page every capture appends to. */
export function dailyPageName(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `journal/${y}-${m}-${d}`;
}

export function dailyPageHeading(date = new Date()): string {
  return `# ${date.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })}\n`;
}

function timeStamp(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Splits a capture into paragraphs so multi-thought dumps stay readable. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Splits into single lines, for modes that produce one list item per thought. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export const CAPTURE_MODES: CaptureMode[] = [
  {
    id: 'note',
    label: 'Note',
    glyph: '✎',
    placeholder: "What's on your mind?",
    format: (text) => paragraphs(text).join('\n\n'),
  },
  {
    id: 'task',
    label: 'Task',
    glyph: '☑',
    placeholder: 'What needs doing?',
    // Each line becomes its own task — dictating a list should give a list.
    format: (text) =>
      lines(text)
        .map((line) => `- [ ] ${line.replace(/^[-*]\s*(\[[ xX]\]\s*)?/, '')}`)
        .join('\n'),
  },
  {
    id: 'idea',
    label: 'Idea',
    glyph: '✦',
    placeholder: 'What if…',
    format: (text) =>
      lines(text)
        .map((line) => `- ${line.replace(/^[-*]\s*/, '')} #idea`)
        .join('\n'),
  },
  {
    id: 'question',
    label: 'Question',
    glyph: '?',
    placeholder: 'What do you want to find out?',
    format: (text) =>
      lines(text)
        .map((line) => `- ${line.replace(/^[-*]\s*/, '')} #question`)
        .join('\n'),
  },
  {
    id: 'log',
    label: 'Log',
    glyph: '◷',
    placeholder: 'What just happened?',
    format: (text, now) =>
      lines(text)
        .map((line) => `- \`${timeStamp(now)}\` ${line.replace(/^[-*]\s*/, '')}`)
        .join('\n'),
  },
];

export const DEFAULT_MODE = CAPTURE_MODES[0];

export function findMode(id: string): CaptureMode {
  return CAPTURE_MODES.find((mode) => mode.id === id) ?? DEFAULT_MODE;
}

/**
 * Appends a capture to a page's existing text, creating the day's heading when
 * the page is new and keeping exactly one blank line between entries.
 */
export function appendCapture(existing: string, block: string, date = new Date()): string {
  const body = existing.trimEnd();
  if (!body) return `${dailyPageHeading(date)}\n${block}\n`;
  return `${body}\n\n${block}\n`;
}
