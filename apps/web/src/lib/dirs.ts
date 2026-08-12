import type { Workspace } from '@spark/core';

/**
 * The two folders the app treats as structural rather than as notes you
 * wrote — see AGENTS.md → Layout. Both are settings rather than constants,
 * so a space that already has a `daily/` habit or a `Templates/` folder from
 * somewhere else doesn't have to be reorganised to fit this app; the default
 * is only what a brand-new space gets.
 *
 * Stored in `workspace.settings` — device-local, like every other rail and
 * navigator preference — rather than in the space itself: which folder is
 * "the" journal folder is a fact about how *you* use this device's copy of
 * the app to read a space, not a fact the space needs written into it.
 */
export const DEFAULT_JOURNAL_FOLDER = 'journal';
export const DEFAULT_TEMPLATES_FOLDER = '_templates';

const JOURNAL_KEY = 'app.journalFolder';
const TEMPLATES_KEY = 'app.templatesFolder';

function clean(value: string, fallback: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  return trimmed || fallback;
}

export function journalFolder(workspace: Workspace): string {
  return clean(workspace.settings.get(JOURNAL_KEY, DEFAULT_JOURNAL_FOLDER), DEFAULT_JOURNAL_FOLDER);
}

export function setJournalFolder(workspace: Workspace, value: string): void {
  workspace.settings.set(JOURNAL_KEY, clean(value, DEFAULT_JOURNAL_FOLDER));
}

export function templatesFolder(workspace: Workspace): string {
  return clean(workspace.settings.get(TEMPLATES_KEY, DEFAULT_TEMPLATES_FOLDER), DEFAULT_TEMPLATES_FOLDER);
}

export function setTemplatesFolder(workspace: Workspace, value: string): void {
  workspace.settings.set(TEMPLATES_KEY, clean(value, DEFAULT_TEMPLATES_FOLDER));
}
