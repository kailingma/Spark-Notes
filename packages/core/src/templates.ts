import { parseFrontmatter } from './markdown.js';

/**
 * Page templates.
 *
 * A template is an ordinary page, living under a folder (`_templates/` by
 * default, but the folder name is a setting — see `apps/web/src/lib/dirs.ts`
 * — not a constant, so it can be renamed the way the journal folder can).
 * What makes a page a *template* rather than a note is entirely in how it is
 * used: its body is text with `{{variable}}` placeholders, filled in at the
 * moment it is inserted or applied, never before.
 *
 * Kept here rather than in `apps/web` because both the editor's own
 * `:slash-command`-style insertion and the journal's own "seed a new day from
 * whichever template fits" need the exact same substitution and
 * day-matching logic, and a second copy of either is a second place to get
 * it wrong.
 */

export interface TemplateVars {
  /** `July 30, 2026`. */
  date: string;
  /** `2026-07-30`, the same shape journal page names use. */
  isoDate: string;
  /** `14:32`, 24-hour, no seconds — nobody templates to the second. */
  time: string;
  /** `Wednesday`. */
  weekday: string;
  /** The page the template is landing on, when there is one. */
  page: string;
}

/** The variables every template gets, computed at the moment it is used — never earlier. */
export function defaultTemplateVars(now: Date, page = ''): TemplateVars {
  return {
    date: now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
    isoDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    weekday: now.toLocaleDateString(undefined, { weekday: 'long' }),
    page,
  };
}

/**
 * Fills in `{{variable}}` placeholders. Unknown ones are left exactly as
 * written rather than blanked — a typo in a template should be visible and
 * fixable, not silently swallowed into an empty string that looks like the
 * template just has a gap in it.
 */
export function renderTemplate(body: string, vars: TemplateVars): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key as keyof TemplateVars]) : match,
  );
}

const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

/**
 * Whether a template's own `days` frontmatter allows it to apply on `date`.
 *
 * `days` may be a single word (`monday`, `weekday`, `weekend`) or a list
 * (`[monday, friday]`, or a dash list — `parseFrontmatter` turns either into
 * a `string[]`). No `days` key at all means "no restriction, applies any
 * day" — a template that never mentions the day is a plain default, not one
 * that matches nothing.
 */
export function templateMatchesDay(days: string | string[] | undefined, date: Date): boolean {
  if (days === undefined) return true;
  const tokens = (Array.isArray(days) ? days : [days]).map((token) => token.trim().toLowerCase());
  if (tokens.length === 0) return true;

  const day = date.getDay();
  const isWeekend = day === 0 || day === 6;

  return tokens.some((token) => {
    if (token === 'weekday') return !isWeekend;
    if (token === 'weekend') return isWeekend;
    const name = WEEKDAY_NAMES[day];
    return name === token || name.startsWith(token);
  });
}

export interface TemplateMeta {
  /** The full page name, e.g. `_templates/Daily`. */
  name: string;
  /** The last path segment — what a picker shows. */
  title: string;
  /** Set when the template's frontmatter opts it in for automatic journal use. */
  journal: boolean;
  /** Raw `days` frontmatter, for `templateMatchesDay`. */
  days?: string | string[];
}

/** A template page, parsed once. */
export interface Template extends TemplateMeta {
  /** The body with frontmatter stripped — what actually gets rendered and inserted. */
  body: string;
}

/** Reads a template's frontmatter and body out of the raw page text. */
export function parseTemplate(name: string, text: string): Template {
  const { data, body } = parseFrontmatter(text);
  return {
    name,
    title: name.slice(name.lastIndexOf('/') + 1),
    journal: data.journal === 'true',
    days: data.days,
    body: body.replace(/^\s*\n/, ''),
  };
}

/**
 * Which template, if any, a new journal page should be seeded from.
 *
 * Among the templates opted in with `journal: true`, one with an explicit
 * `days` match for `date` wins over one with no `days` key at all — a
 * Monday-specific template should be picked over a generic daily default on
 * a Monday, not the other way round because it happened to sort first.
 * Ties within the same specificity are broken by name, so the choice is
 * deterministic rather than depending on directory listing order.
 */
export function pickJournalTemplate(templates: Template[], date: Date): Template | null {
  const eligible = templates
    .filter((template) => template.journal && templateMatchesDay(template.days, date))
    .sort((a, b) => {
      const aSpecific = a.days !== undefined;
      const bSpecific = b.days !== undefined;
      if (aSpecific !== bSpecific) return aSpecific ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  return eligible[0] ?? null;
}
