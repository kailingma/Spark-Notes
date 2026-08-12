import { useEffect, useState } from 'react';
import { useApp } from '../app-context';
import { isVirtualPage } from '../virtual';

/**
 * The pages you were last in.
 *
 * Fed by `page:open` rather than by the navigation call, so it records what you
 * actually landed on — including arrivals through a `[[link]]`, a backlink, a
 * task, or a plugin — instead of only the ones that went through one function.
 *
 * Virtual pages (Tasks, Tags, Spark, Memory, Settings) are never recorded.
 * They already have their own permanent row in "Views" — the whole reason
 * Recent exists is to surface the *notes* you were just reading, and a list
 * that fills up with the same handful of app screens crowds out the thing it
 * is for.
 */

const KEY = 'app.recent';
const LIMIT = 12;

export function useRecentPages(limit = 5): string[] {
  const { workspace, route } = useApp();
  const [recent, setRecent] = useState<string[]>(() =>
    workspace.settings.get<string[]>(KEY, []),
  );

  // The page you are on counts, even though its `page:open` fired before this
  // was listening — the navigator is usually opened after the first page loads,
  // and a Recent list that omits the note in front of you looks broken.
  useEffect(() => {
    if (route.kind !== 'page' || isVirtualPage(route.page)) return;
    setRecent((current) =>
      current[0] === route.page ? current : record(workspace, route.page),
    );
  }, [workspace, route]);

  useEffect(() => {
    return workspace.events.on('page:open', ({ page }) => {
      if (isVirtualPage(page)) return;
      if (workspace.settings.get<string[]>(KEY, [])[0] === page) return;
      setRecent(record(workspace, page));
    });
  }, [workspace]);

  return recent.slice(0, limit);
}

/**
 * Moves a page to the front of the stored list and returns the result.
 *
 * Written outside any `setState` updater on purpose: React invokes an updater
 * more than once, so writing to storage from inside one writes twice.
 */
function record(workspace: ReturnType<typeof useApp>['workspace'], page: string): string[] {
  const current = workspace.settings.get<string[]>(KEY, []);
  const next = [page, ...current.filter((entry) => entry !== page)].slice(0, LIMIT);
  workspace.settings.set(KEY, next);
  return next;
}
