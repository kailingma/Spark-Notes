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
   * How much happens without being asked about.
   *
   * A different question from the permissions above, which is why it is a
   * different field: those say what Spark may *ever* do, this says what it must
   * check first. See the server's `spark-tools.ts`.
   */
  sparkPermissionMode: 'manual' | 'code' | 'edit' | 'auto';
  /**
   * The model preset in force, by id.
   *
   * Here rather than only on the server because it is a property of how *you*
   * are working right now — one machine on the fast model while another drafts on
   * the slow one is a reasonable thing to want, and it costs a request to change
   * if it lives only in `.spark/spark.json`.
   */
  sparkModeId: string;
  /** Show what the model reasoned, when the model reasons out loud. */
  sparkShowThinking: boolean;
  /** Show the trail of what Spark did while it was answering. */
  sparkShowActions: boolean;
  /** Send the note you are looking at, and any selection in it, with the message. */
  sparkSendsCurrentFile: boolean;
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
  /**
   * The conversation this device last had open, so leaving Spark and coming
   * back — closing the panel, closing the tab, reloading — resumes it instead
   * of starting blank. Empty string means "nothing to resume", not `null`:
   * `loadPreferences` drops a stored value whose type doesn't match the
   * default, and `typeof null` would make every stored id vanish.
   */
  sparkLastChatId: string;
  /**
   * Width of the docked conversation overlay, in px — the number the drag
   * handle on its right edge produces. A width you dragged is a width you
   * mean, and it survives a reload the way the rails' sizes do.
   */
  sparkOverlayWidth: number;
  /**
   * Keep the conversation list (and its projects) open after opening a chat.
   * Unpinned, choosing a chat closes the overlay so the conversation is what
   * you look at; pinned, the list stays up so a browsing session can move
   * from chat to chat without reopening it. Only meaningful when the overlay
   * docks beside the conversation — when the panel is too narrow for that,
   * the list covers everything and choosing a chat always closes it.
   */
  sparkOverlayPinned: boolean;
  /**
   * How the conversation list is ordered: `recent` (the server's natural
   * order), `alpha` (by title), `project` (grouped under their project, with
   * ungrouped chats last), or `date` (grouped Today/Yesterday/This week/
   * Older). A sort somebody picked is a sort they mean, so it persists like
   * the overlay's width does.
   */
  sparkChatSort: 'recent' | 'alpha' | 'project' | 'date';
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
  // Not `auto`: a default that skips every question is not a default anybody
  // chose. `edit` lets the ordinary work happen and still stops at the edits you
  // cannot check by reading the result.
  sparkPermissionMode: 'edit',
  sparkModeId: 'balanced',
  // On, because thinking that arrives is thinking you paid for, and the first
  // time it is useful is the time you did not know to switch it on.
  sparkShowThinking: true,
  sparkShowActions: true,
  sparkSendsCurrentFile: true,
  // On, because an assistant that cannot learn your conventions asks you the
  // same question every week, and everything it writes is a markdown file in
  // your own space that you can read, edit or delete.
  sparkRemembers: true,
  // Off. Running generated code is not something to arrive switched on, even
  // when the server has somewhere safe to run it.
  sparkCanRun: false,
  sparkLastChatId: '',
  // 420px is the narrowest dock that still holds a project's main column and
  // its drawer side by side; it clamps to leave the conversation visible when
  // the panel is tighter than that.
  sparkOverlayWidth: 420,
  // Off. Choosing a chat should be followed by the chat; pinning is something
  // somebody asks for, not the default state of the panel.
  sparkOverlayPinned: false,
  // Recency is what a conversation list is for: the thing you were just doing
  // is at the top. The other two are searches for something, not the default
  // way to read the list.
  sparkChatSort: 'recent',
};

/**
 * The four modes, in the order they appear in the switcher: least to most
 * autonomous, so the row itself says which way is which.
 */
export const PERMISSION_MODES: Array<Preferences['sparkPermissionMode']> = [
  'manual',
  'code',
  'edit',
  'auto',
];

export const PERMISSION_MODE_LABELS: Record<
  Preferences['sparkPermissionMode'],
  { label: string; hint: string }
> = {
  manual: { label: 'Manual', hint: 'Every tool call waits for you.' },
  code: { label: 'Code', hint: 'Running code goes ahead; everything else asks.' },
  edit: { label: 'Edit', hint: 'Reads, writes and runs go ahead; deletes still ask.' },
  auto: { label: 'Auto', hint: 'Nothing asks. Spark works to the end of the job.' },
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
  // The type check above only proves it is a string. A stored value from a
  // future version, or a hand-edited one, must not be sent to the server as a
  // permission mode it does not know.
  if (!PERMISSION_MODES.includes(preferences.sparkPermissionMode)) {
    preferences.sparkPermissionMode = DEFAULT_PREFERENCES.sparkPermissionMode;
  }
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
