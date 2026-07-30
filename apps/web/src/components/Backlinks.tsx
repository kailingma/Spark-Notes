import { useEffect, useState } from 'react';
import { encodePageName } from '@spark/core';
import { useApp } from '../app-context';

interface Backlink {
  page: string;
  line: number;
  text: string;
}

/**
 * Pages that link here.
 *
 * Sits under the editor rather than in a panel: a backlink is part of reading
 * the page, not a tool you go and open. It stays out of the way entirely when
 * nothing links here, which on most pages is the case.
 */
export function Backlinks({ page, revision }: { page: string; revision: number }) {
  const { openPage } = useApp();
  const [links, setLinks] = useState<Backlink[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLinks([]);

    void (async () => {
      try {
        const res = await fetch(`/api/backlinks/${encodePageName(page)}`);
        if (!res.ok) return;
        const found = (await res.json()) as Backlink[];
        if (!cancelled) setLinks(found);
      } catch {
        // Backlinks are an enhancement; failing to load them is not an error
        // worth interrupting writing for.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [page, revision]);

  if (links.length === 0) return null;

  const byPage = new Map<string, Backlink[]>();
  for (const link of links) {
    const list = byPage.get(link.page);
    if (list) list.push(link);
    else byPage.set(link.page, [link]);
  }

  return (
    <aside className="backlinks">
      <button
        className="backlinks-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {links.length} link{links.length === 1 ? '' : 's'} to this page
      </button>

      {open && (
        <ul className="backlinks-list">
          {[...byPage.entries()].map(([source, entries]) => (
            <li key={source}>
              <button
                className="backlinks-source"
                onClick={() => openPage(source, entries[0]?.line)}
              >
                {source}
              </button>
              {entries.map((entry) => (
                <button
                  className="backlinks-context"
                  key={`${source}:${entry.line}`}
                  onClick={() => openPage(source, entry.line)}
                >
                  {entry.text}
                </button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
