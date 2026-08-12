import type { Workspace } from '@spark/core';
import { defaultTemplateVars, parseTemplate, pickJournalTemplate, renderTemplate } from '@spark/core';
import { journalFolder, templatesFolder } from './dirs';

/**
 * What a brand-new journal page should start as, if any `journal: true`
 * template (see `packages/core/src/templates.ts`) matches today.
 *
 * Empty string for anything that isn't a journal page, or when nothing
 * applies — the ordinary blank start every other new page gets. Nothing is
 * written to disk here: this only says what the editor should *show*, the
 * same way a quick capture's first line does. Whether it becomes a real file
 * still depends on the person doing something with it — see `Editor.tsx`'s
 * `loadPage`, the one caller.
 */
export async function seedJournalPage(workspace: Workspace, name: string): Promise<string> {
  const journal = journalFolder(workspace);
  if (!name.startsWith(`${journal}/`)) return '';

  const dir = templatesFolder(workspace);
  let candidates;
  try {
    candidates = (await workspace.space.list()).filter((meta) => meta.name.startsWith(`${dir}/`));
  } catch {
    return '';
  }
  if (candidates.length === 0) return '';

  const templates = await Promise.all(
    candidates.map(async (meta) => {
      try {
        const { text } = await workspace.space.read(meta.name);
        return parseTemplate(meta.name, text);
      } catch {
        // A template that vanished between the list and the read is simply
        // not a candidate — not a reason to fail every other one.
        return null;
      }
    }),
  );

  const chosen = pickJournalTemplate(
    templates.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    new Date(),
  );
  if (!chosen) return '';

  return renderTemplate(chosen.body, defaultTemplateVars(new Date(), name));
}
