import { useMemo } from 'react';
import { pageBasename } from '@spark/core';
import { useApp } from '../app-context';
import { HistoryIcon, PlusIcon } from '../components/Icons';
import { journalFolder } from '../lib/dirs';
import { dailyPageName } from '../lib/modes';
import { useWindows } from '../windows/manager';
import { VIRTUAL_INDEX } from '../virtual';
import { PageRow } from './rows';
import { useRecentPages } from './recents';
import { Section, journalLabel } from './section';

/**
 * Places: where you go, as opposed to what there is.
 *
 * This used to be the top half of the navigator, sharing its panel across a
 * seam you could drag. Two things were wrong with that. The rail decided how
 * much room the journal got, and there was no arrangement in which you could
 * have the pages browser without it — or it without the browser, or it in a
 * window while you searched in the rail. And the seam was a bespoke splitter
 * inside a panel, in an app whose whole workbench is already about splitting
 * things: a second, worse mechanism for the same idea.
 *
 * As its own view it is a peer of the navigator. By default they are two tabs
 * in the left rail, and everything the workbench can do to a view — float it,
 * tile it, put it on the right, open a second one — now applies to each of them
 * separately, with no code here that knows any of it happened.
 *
 * The three sections are still in the order you ask the questions: what can I
 * look at, what am I in the middle of, what happened lately. None of them
 * grows, which is the point of it being short.
 */
export function Places({ instanceId }: { instanceId: string }) {
  const { pages, route, workspace } = useApp();
  const { openPage, narrow } = useWindows();

  const currentPage = route.kind === 'page' ? route.page : null;
  const journalDir = journalFolder(workspace);

  const open = (page: string, event: React.MouseEvent) => {
    // Held modifier means "beside what I'm reading", the way it does in an
    // editor. A plain click replaces, which is what you want nine times in ten.
    openPage(page, { mode: event.metaKey || event.ctrlKey ? 'split-right' : 'tab' });
  };

  const journal = useMemo(
    () =>
      pages
        .filter((page) => page.name.startsWith(`${journalDir}/`))
        .sort((a, b) => b.name.localeCompare(a.name))
        .slice(0, 5),
    [pages, journalDir],
  );

  const recent = useRecentPages(narrow ? 3 : 5);

  return (
    <nav className="navigator" data-panel="places" aria-label="Places" data-instance={instanceId}>
      <div className="nav-scroll">
        <Section id="views" title="Views" defaultOpen>
          {VIRTUAL_INDEX.map((view) => (
            <PageRow
              key={view.name}
              label={view.title}
              icon={view.icon}
              current={currentPage === view.name}
              onOpen={(event) => open(view.name, event)}
            />
          ))}
        </Section>

        {recent.length > 0 && (
          <Section id="recent" title="Recent" defaultOpen>
            {recent.map((page) => (
              <PageRow
                key={page}
                label={pageBasename(page)}
                icon={<HistoryIcon />}
                current={currentPage === page}
                title={page}
                onOpen={(event) => open(page, event)}
              />
            ))}
          </Section>
        )}

        <Section
          id="journal"
          title="Journal"
          defaultOpen={!narrow}
          action={
            <button
              className="nav-section-action"
              title="Open today"
              aria-label="Open today's page"
              onClick={(event) => open(dailyPageName(new Date(), journalDir), event)}
            >
              <PlusIcon />
            </button>
          }
        >
          {journal.length === 0 ? (
            <p className="nav-empty">Nothing captured yet.</p>
          ) : (
            journal.map((page) => (
              <PageRow
                key={page.name}
                label={journalLabel(page.name)}
                current={currentPage === page.name}
                title={page.name}
                onOpen={(event) => open(page.name, event)}
              />
            ))
          )}
        </Section>
      </div>
    </nav>
  );
}
