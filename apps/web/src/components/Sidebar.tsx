import { useMemo, useState } from 'react';
import { pageBasename, pageFolder } from '@spark/core';
import { useApp } from '../app-context';

/**
 * The page list.
 *
 * Hidden by default — the app is a blank editor first — and grouped by folder
 * so a space that grows a structure still reads at a glance. Sorted by recency
 * inside each group, because the page you want next is nearly always one you
 * touched recently.
 */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { pages, route, openPage, navigate } = useApp();
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const search = query.trim().toLowerCase();
    const matched = search
      ? pages.filter((page) => page.name.toLowerCase().includes(search))
      : pages;

    const byFolder = new Map<string, typeof matched>();
    for (const page of matched) {
      const folder = pageFolder(page.name);
      const list = byFolder.get(folder);
      if (list) list.push(page);
      else byFolder.set(folder, [page]);
    }

    // Top-level pages first, then folders alphabetically.
    return [...byFolder.entries()].sort(([a], [b]) => {
      if (a === '') return -1;
      if (b === '') return 1;
      return a.localeCompare(b);
    });
  }, [pages, query]);

  const currentPage = route.kind === 'page' ? route.page : null;

  const go = (name: string) => {
    openPage(name);
    onNavigate?.();
  };

  return (
    <nav className="sidebar" aria-label="Pages">
      <input
        className="sidebar-search"
        value={query}
        placeholder="Filter pages"
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Filter pages"
      />

      <ul className="sidebar-list">
        <li>
          <button
            className="sidebar-item"
            aria-current={route.kind === 'tasks' ? 'page' : undefined}
            onClick={() => {
              navigate({ kind: 'tasks' });
              onNavigate?.();
            }}
          >
            Tasks
          </button>
        </li>

        {groups.map(([folder, folderPages]) => (
          <li key={folder || '(root)'}>
            {folder && <div className="sidebar-section">{folder}</div>}
            <ul className="sidebar-sublist">
              {folderPages.map((page) => (
                <li key={page.name}>
                  <button
                    className="sidebar-item"
                    aria-current={page.name === currentPage ? 'page' : undefined}
                    onClick={() => go(page.name)}
                    title={page.name}
                  >
                    {pageBasename(page.name)}
                    <small>{relativeTime(page.modified)}</small>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}

        {groups.length === 0 && (
          <li>
            <p className="palette-empty">
              {pages.length === 0 ? 'No pages yet.' : 'Nothing matches that.'}
            </p>
          </li>
        )}
      </ul>
    </nav>
  );
}

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['minute', 60],
    ['hour', 3600],
    ['day', 86_400],
    ['week', 604_800],
    ['month', 2_592_000],
    ['year', 31_536_000],
  ];

  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  let chosen: [Intl.RelativeTimeFormatUnit, number] = units[0];
  for (const unit of units) {
    if (seconds >= unit[1]) chosen = unit;
  }
  return format.format(-Math.round(seconds / chosen[1]), chosen[0]);
}
