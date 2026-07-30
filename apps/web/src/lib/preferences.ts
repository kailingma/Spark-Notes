import type { SettingsApi } from '@spark/plugin-sdk';

/**
 * Everything the settings panel can change that isn't appearance.
 *
 * One object with one writer, for the same reason `appearance.ts` is one
 * object: these are read together, written together, and a preference that
 * lives on its own key is a preference nobody remembers to migrate. Appearance
 * stays separate because it has a second reader — the inline script in
 * `index.html` that runs before the bundle — and merging the two would mean
 * duplicating all of this there too.
 *
 * Nothing here is synced. A folder of markdown is the database; how you like
 * your editor is a property of the screen you are sitting at.
 */

export interface Preferences {
  // -- Editing --------------------------------------------------------------
  /** Milliseconds of quiet before an autosave fires. */
  autosaveDelay: number;
  spellcheck: boolean;
  /** Wrap the selection when you type a quote or a bracket around it. */
  autoPairs: boolean;
  /** Continue `- `, `1. ` and `- [ ] ` onto the next line. */
  continueLists: boolean;
  /** Show the `⌘K to search` line on an empty page. */
  showHints: boolean;
  /** Reading width of the editor column, in rem. */
  measure: number;

  // -- Workbench ------------------------------------------------------------
  /** Confirm before closing a tab with unsaved changes. */
  confirmClose: boolean;
  /** Show the backlinks footer under a page. */
  showBacklinks: boolean;

  // -- Capture --------------------------------------------------------------
  /** Open straight into quick capture on a touch device. */
  captureOnLaunch: boolean;
  /** Default mode the capture screen starts in. */
  captureMode: string;

  // -- Spark ----------------------------------------------------------------
  /** Let Spark create and edit pages, not just read them. */
  sparkCanWrite: boolean;
  /** Let Spark delete and rename pages. Off by default, deliberately. */
  sparkCanDestroy: boolean;
  /** Share the note beside the chat, and the names of what else is open. */
  sparkSeesContext: boolean;
  /** Ask before each tool call rather than letting Spark work. */
  sparkConfirmTools: boolean;
  /** How many past exchanges travel with a new message. */
  sparkHistoryDepth: number;
  /**
   * Let Spark keep notes about you in `memory/` between conversations.
   *
   * Its own preference rather than part of `sparkCanWrite`, because it is a
   * different question: writing to your notes is work you asked for, and writing
   * to memory is Spark forming a view about you. Someone can reasonably want
   * either one without the other.
   */
  sparkRemembers: boolean;
  /**
   * Let Spark run code in the server's sandbox.
   *
   * Only half the gate — the server has to have a sandbox at all, which is set
   * in its environment. This toggle is hidden when it does not.
   */
  sparkCanRun: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  autosaveDelay: 600,
  spellcheck: true,
  autoPairs: true,
  continueLists: true,
  showHints: true,
  measure: 46,

  confirmClose: true,
  showBacklinks: true,

  captureOnLaunch: true,
  captureMode: 'note',

  sparkCanWrite: true,
  // Destructive edits are the one thing a person cannot undo by reading the
  // diff afterwards, so this starts off and stays off until someone says
  // otherwise. The server enforces it too; this is not the only gate.
  sparkCanDestroy: false,
  sparkSeesContext: true,
  sparkConfirmTools: false,
  sparkHistoryDepth: 12,
  // On, because an assistant that cannot learn your conventions asks you the
  // same question every week, and everything it writes is a markdown file in
  // your own space that you can read, edit or delete.
  sparkRemembers: true,
  // Off. Running generated code is not something to arrive switched on, even
  // when the server has somewhere safe to run it.
  sparkCanRun: false,
};

export const AUTOSAVE_RANGE = { min: 200, max: 3000, step: 100 } as const;
export const MEASURE_RANGE = { min: 34, max: 80, step: 1 } as const;
export const HISTORY_RANGE = { min: 2, max: 40, step: 1 } as const;

const KEY = 'app.preferences';

export function loadPreferences(settings: SettingsApi): Preferences {
  const stored = settings.get<Partial<Preferences>>(KEY, {});
  const merged: Record<string, unknown> = { ...DEFAULT_PREFERENCES };

  // Field by field rather than a spread: a stored object from an older version
  // can carry `undefined` for a key it didn't have, and spreading would let
  // that win over the default.
  for (const key of Object.keys(DEFAULT_PREFERENCES) as Array<keyof Preferences>) {
    const value = stored[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== typeof DEFAULT_PREFERENCES[key]) continue;
    merged[key] = value;
  }

  const preferences = merged as unknown as Preferences;
  preferences.autosaveDelay = clamp(preferences.autosaveDelay, AUTOSAVE_RANGE);
  preferences.measure = clamp(preferences.measure, MEASURE_RANGE);
  preferences.sparkHistoryDepth = clamp(preferences.sparkHistoryDepth, HISTORY_RANGE);
  return preferences;
}

export function savePreferences(settings: SettingsApi, preferences: Preferences): void {
  settings.set(KEY, preferences);
}

/**
 * Pushes the preferences that have a visual consequence onto `:root`.
 *
 * Only the ones CSS reads; everything else is behaviour and is read where it is
 * used. Kept beside `applyAppearance` in spirit: one writer, one place to look.
 */
export function applyPreferences(preferences: Preferences): void {
  document.documentElement.style.setProperty(
    '--editor-measure',
    `${clamp(preferences.measure, MEASURE_RANGE)}rem`,
  );
}

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(Math.max(value, range.min), range.max);
}
