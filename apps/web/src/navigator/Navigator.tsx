import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { isValidPageName, normalizePageName, pageBasename } from '@spark/core';
import { useApp } from '../app-context';
import {
  ChevronIcon,
  ColumnsIcon,
  FolderPlusIcon,
  HistoryIcon,
  ListIcon,
  PlusIcon,
  TreeIcon,
} from '../components/Icons';
import { dailyPageName } from '../lib/modes';
import { startPointerDrag } from '../windows/drag';
import { useWindows } from '../windows/manager';
import { locate } from '../windows/model';
import { VIRTUAL_INDEX } from '../virtual';
import { ColumnsMode, ListMode, TreeMode } from './modes';
import { useRecentPages } from './recents';
import { PageRow } from './rows';
import { ancestorsOf, buildTree, filterPages, type SortMode } from './tree';

/**
 * The navigator.
 *
 * Four sections, each answering a different question, in the order you ask
 * them: *what can I look at* (views), *what am I in the middle of* (recent),
 * *what happened lately* (journal), and *what is there* (the pages browser).
 * The first three are short and fixed; the browser takes whatever is left,
 * which is what stops the rail turning into a list of headings.
 *
 * Those two jobs are also **two halves** of the rail, divided by a seam you can
 * drag: *places you go* on top, *everything there is* underneath. They share one
 * panel rather than being two panels — the seam is the only thing between them,
 * and until you drag it the top half is exactly as tall as its contents, so the
 * rail opens looking like the single list it used to be.
 *
 * Each half closes on its own, and closing the last open one closes the rail
 * itself: a rail showing two collapsed strips is a closed rail with extra steps.
 * Both halves are reopened on the way out, so the header toggle brings back the
 * ordinary arrangement rather than the dead end you left.
 *
 * The browser has three modes, and the choice is real rather than cosmetic —
 * see `modes.tsx`. Columns need width to work, so the switcher only offers them
 * when there is width to give.
 */

type Mode = 'tree' | 'list' | 'columns';

/** The two halves of the rail. */
type Half = 'places' | 'pages';

/** Below this the columns mode is not offered — two columns stop being legible. */
const COLUMNS_MIN_WIDTH = 460;

/** A half never drags below its own header plus a row or two of content. */
const MIN_HALF = 96;

export function Navigator({ instanceId }: { instanceId: string }) {
  const { pages, folders, workspace, route, refreshPages, refreshFolders, toast } = useApp();
  const { openPage, narrow, layout, toggleSidebar, closeView } = useWindows();

  const hostRef = useRef<HTMLElement>(null);
  const halvesRef = useRef<HTMLDivElement>(null);
  const placesRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  const [query, setQuery] = useState('');

  const [mode, setMode] = usePersisted<Mode>('nav.mode', 'tree');
  const [sort, setSort] = usePersisted<SortMode>('nav.sort', 'recent');
  const [placesOpen, setPlacesOpen] = usePersisted('nav.half.places', true);
  const [pagesOpen, setPagesOpen] = usePersisted('nav.half.pages', true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(workspace.settings.get<string[]>('nav.expanded', [])),
  );

  // `null` is "as tall as its contents", which is where the seam starts.
  const [placesHeight, setPlacesHeight] = useState<number | null>(() =>
    workspace.settings.get<number | null>('nav.placesHeight', null),
  );

  const currentPage = route.kind === 'page' ? route.page : null;

  // On a phone the rail is a drawer you opened to go somewhere; a mode switcher,
  // a sort control and four collapsible sections are all in the way of that.
  const wide = width >= COLUMNS_MIN_WIDTH && !narrow;
  const effectiveMode: Mode = narrow ? 'list' : mode === 'columns' && !wide ? 'tree' : mode;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const toggleFolder = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(path)) next.add(path);
        workspace.settings.set('nav.expanded', [...next]);
        return next;
      });
    },
    [workspace],
  );

  // Whichever page you are on should be visible without hunting for it.
  useEffect(() => {
    if (!currentPage) return;
    const ancestors = ancestorsOf(currentPage);
    if (ancestors.length === 0) return;
    setExpanded((current) => {
      if (ancestors.every((path) => current.has(path))) return current;
      return new Set([...current, ...ancestors]);
    });
  }, [currentPage]);

  const open = useCallback(
    (page: string, event: React.MouseEvent) => {
      // Held modifier means "beside what I'm reading", the way it does in an
      // editor. A plain click replaces, which is what you want nine times in ten.
      const mode = event.metaKey || event.ctrlKey ? 'split-right' : 'tab';
      openPage(page, { mode });
    },
    [openPage],
  );

  /**
   * Creating things.
   *
   * A page is created for real, with a heading, rather than navigated to: a
   * page you asked for should exist — be listed, be linkable — before you have
   * typed anything into it. A folder is a real directory, so an empty one is a
   * thing you can make and come back to.
   */
  const newPage = useCallback(
    async (folder: string) => {
      const asked = await workspace.ui.prompt(folder ? `New page in ${folder}` : 'New page', '');
      if (!asked) return;

      const name = normalizePageName(folder ? `${folder}/${asked}` : asked);
      if (!isValidPageName(name)) {
        toast('That name has characters that will not work on disk.', 'error');
        return;
      }

      try {
        if (await workspace.space.exists(name)) {
          openPage(name);
          return;
        }
        await workspace.space.write(name, `# ${pageBasename(name)}\n\n`, '');
        await Promise.all([refreshPages(), refreshFolders()]);
        openPage(name, { line: 1 });
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    [workspace, openPage, refreshPages, refreshFolders, toast],
  );

  const newFolder = useCallback(async () => {
    const asked = await workspace.ui.prompt('New folder', '');
    if (!asked) return;
    try {
      const created = await workspace.space.createFolder(asked);
      await refreshFolders();
      setExpanded((current) => new Set([...current, ...ancestorsOf(`${created}/x`)]));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, [workspace, refreshFolders, toast]);

  /**
   * Closing a half, and closing the last one.
   *
   * Two halves closed is not a navigator with nothing in it, it is a panel you
   * shut — so it becomes exactly that, by the same route the header toggle
   * takes. Both halves are set open first, so what comes back when you reopen
   * the rail is the ordinary two-part navigator; a rail that reopened onto two
   * collapsed strips would be a dead end you had to work out how to leave.
   *
   * A floated navigator closes its window instead, for the same reason and with
   * the same result: the toggle reopens it in its rail, whole.
   */
  const toggleHalf = useCallback(
    (half: Half) => {
      const next = half === 'places' ? !placesOpen : !pagesOpen;
      const other = half === 'places' ? pagesOpen : placesOpen;

      if (!next && !other) {
        setPlacesOpen(true);
        setPagesOpen(true);
        const home = locate(layout, instanceId);
        if (home?.surface === 'sidebar') toggleSidebar(home.side);
        else closeView(instanceId);
        return;
      }

      if (half === 'places') setPlacesOpen(next);
      else setPagesOpen(next);
    },
    [
      placesOpen,
      pagesOpen,
      setPlacesOpen,
      setPagesOpen,
      layout,
      instanceId,
      toggleSidebar,
      closeView,
    ],
  );

  /**
   * Dragging the seam.
   *
   * The height is measured from the DOM at drag start rather than read from
   * state, because until the first drag there is no number to read — the top
   * half is as tall as its contents. Written to settings once, on release: a
   * `settings.set` reaches `localStorage`, and a pointermove does not need to.
   */
  const startSeamDrag = useCallback(
    (event: React.PointerEvent) => {
      const host = halvesRef.current;
      const places = placesRef.current;
      if (!host || !places) return;
      event.preventDefault();

      const before = placesHeight;
      const start = places.getBoundingClientRect().height;
      const total = host.getBoundingClientRect().height;
      let last = start;

      startPointerDrag(event, {
        onMove: (_native, delta) => {
          const most = Math.max(MIN_HALF, total - MIN_HALF);
          last = Math.round(Math.min(Math.max(start + delta.dy, MIN_HALF), most));
          setPlacesHeight(last);
        },
        onEnd: (_native, _delta, cancelled) => {
          if (cancelled) {
            setPlacesHeight(before);
            return;
          }
          workspace.settings.set('nav.placesHeight', last);
        },
      });
    },
    [placesHeight, workspace],
  );

  /** Back to sharing the panel: the top half returns to the height of its rows. */
  const resetSeam = useCallback(() => {
    setPlacesHeight(null);
    workspace.settings.set('nav.placesHeight', null);
  }, [workspace]);

  const filtered = useMemo(() => filterPages(pages, query), [pages, query]);
  const tree = useMemo(() => buildTree(filtered, folders, sort), [filtered, folders, sort]);
  const searching = query.trim().length > 0;

  const journal = useMemo(
    () =>
      pages
        .filter((page) => page.name.startsWith('journal/'))
        .sort((a, b) => b.name.localeCompare(a.name))
        .slice(0, 5),
    [pages],
  );

  const recent = useRecentPages(narrow ? 3 : 5);

  // Both closed cannot be reached through `toggleHalf`, but hand-edited storage
  // could say so, and a rail with nothing in it has no way back. Read as open.
  const bothClosed = !placesOpen && !pagesOpen;
  const showPlaces = placesOpen || bothClosed;
  const showPages = pagesOpen || bothClosed;
  const split = showPlaces && showPages;

  // The short sections keep their room while you search, because the halves are
  // now sized against each other: a list that empties itself as you type would
  // drag the seam around under the pointer. On a phone there is one scroller and
  // no seam, so there the results still take the space back.
  const shortcuts = !(narrow && searching);

  const places = (
    <>
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

      {recent.length > 0 && shortcuts && (
        <Section id="recent" title="Recent" defaultOpen>
          {recent.map((page) => (
            <PageRow
              key={page}
              label={pageBasename(page)}
              detail={undefined}
              icon={<HistoryIcon />}
              current={currentPage === page}
              title={page}
              onOpen={(event) => open(page, event)}
            />
          ))}
        </Section>
      )}

      {shortcuts && (
        <Section
          id="journal"
          title="Journal"
          defaultOpen={!narrow}
          action={
            <button
              className="nav-section-action"
              title="Open today"
              aria-label="Open today's page"
              onClick={(event) => open(dailyPageName(), event)}
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
      )}
    </>
  );

  const browserActions = (
    <div className="nav-modes" role="group" aria-label="Pages">
      {!narrow && (
        <>
          <ModeButton current={effectiveMode} value="tree" label="Tree" onPick={setMode}>
            <TreeIcon />
          </ModeButton>
          <ModeButton current={effectiveMode} value="list" label="List" onPick={setMode}>
            <ListIcon />
          </ModeButton>
          {wide && (
            <ModeButton current={effectiveMode} value="columns" label="Columns" onPick={setMode}>
              <ColumnsIcon />
            </ModeButton>
          )}
          <button
            className="nav-section-action"
            title={sort === 'recent' ? 'Sorted by recency' : 'Sorted by name'}
            aria-label="Change sorting"
            onClick={() => setSort(sort === 'recent' ? 'name' : 'recent')}
          >
            {sort === 'recent' ? 'Recent' : 'A–Z'}
          </button>
        </>
      )}
      <button
        className="nav-section-action"
        title="New folder"
        aria-label="New folder"
        onClick={() => void newFolder()}
      >
        <FolderPlusIcon />
      </button>
      <button
        className="nav-section-action"
        title="New page"
        aria-label="New page"
        onClick={() => void newPage('')}
      >
        <PlusIcon />
      </button>
    </div>
  );

  // A search result is a list of pages, not a shape of the space, so it ignores
  // the mode entirely and shows the matches.
  const browser =
    searching || effectiveMode === 'list' ? (
      <ListMode pages={filtered} currentPage={currentPage} onOpen={open} />
    ) : effectiveMode === 'columns' ? (
      <ColumnsMode
        root={tree}
        currentPage={currentPage}
        onOpen={open}
        onAddPage={(folder) => void newPage(folder)}
      />
    ) : (
      <TreeMode
        root={tree}
        currentPage={currentPage}
        onOpen={open}
        onAddPage={(folder) => void newPage(folder)}
        expanded={expanded}
        onToggle={toggleFolder}
      />
    );

  const search = (
    <div className="nav-search">
      <input
        className="nav-search-input"
        value={query}
        placeholder="Find a page"
        aria-label="Find a page"
        onChange={(event) => setQuery(event.target.value)}
      />
    </div>
  );

  const pagesTitle = searching ? `Results (${filtered.length})` : 'Pages';

  // The drawer is one scroll, top to bottom. Halves you can close and a seam you
  // can drag are arrangements, and a drawer is not somewhere you arrange things.
  if (narrow) {
    return (
      <nav className="navigator" ref={hostRef} aria-label="Navigator">
        {search}
        <div className="nav-scroll">
          {places}
          <Section id="pages" title={pagesTitle} defaultOpen grow action={browserActions}>
            {browser}
          </Section>
        </div>
      </nav>
    );
  }

  return (
    <nav className="navigator" ref={hostRef} aria-label="Navigator">
      <div className="nav-halves" data-split={split || undefined} ref={halvesRef}>
        <NavHalf
          id="places"
          title="Places"
          open={showPlaces}
          onToggle={() => toggleHalf('places')}
          ref={placesRef}
          // Only while both are showing: a lone half takes the whole rail, and
          // a remembered height would hold it short for no reason.
          style={split && placesHeight !== null ? { height: `${placesHeight}px` } : undefined}
        >
          {places}
        </NavHalf>

        {/* The seam, and the only thing between the two halves. */}
        {split && (
          <div
            className="nav-seam"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the navigator halves"
            title="Drag to resize; double-click to even it out"
            onPointerDown={startSeamDrag}
            onDoubleClick={resetSeam}
          />
        )}

        <NavHalf
          id="pages"
          title={pagesTitle}
          open={showPages}
          onToggle={() => toggleHalf('pages')}
          action={browserActions}
        >
          {search}
          <div className="nav-browser">{browser}</div>
        </NavHalf>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------

/**
 * One half of the rail.
 *
 * Closed, it keeps its header and nothing else — a strip you can read the name
 * of and press to get the half back. The header carries the half's own controls
 * (the mode switcher, for the pages half), which is why the toggle is a button
 * beside them rather than the whole row.
 */
function NavHalf({
  id,
  title,
  open,
  onToggle,
  action,
  children,
  style,
  ref,
}: {
  id: Half;
  title: string;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
  style?: React.CSSProperties;
  ref?: React.Ref<HTMLElement>;
}) {
  return (
    <section className="nav-half" data-half={id} data-open={open || undefined} style={style} ref={ref}>
      <div className="nav-half-head">
        <button
          className="nav-half-toggle"
          aria-expanded={open}
          title={`${open ? 'Hide' : 'Show'} ${id}`}
          onClick={onToggle}
        >
          <span className="nav-row-twisty">
            <ChevronIcon />
          </span>
          {title}
        </button>
        {open && action}
      </div>
      {open && <div className="nav-half-body">{children}</div>}
    </section>
  );
}

function ModeButton({
  current,
  value,
  label,
  onPick,
  children,
}: {
  current: Mode;
  value: Mode;
  label: string;
  onPick: (mode: Mode) => void;
  children: ReactNode;
}) {
  return (
    <button
      className="nav-mode"
      aria-pressed={current === value}
      title={label}
      aria-label={`Browse as ${label.toLowerCase()}`}
      onClick={() => onPick(value)}
    >
      {children}
    </button>
  );
}

function Section({
  id,
  title,
  children,
  action,
  defaultOpen = true,
  grow = false,
}: {
  id: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
  defaultOpen?: boolean;
  grow?: boolean;
}) {
  const [open, setOpen] = usePersisted(`nav.section.${id}`, defaultOpen);

  return (
    <section className="nav-section" data-open={open || undefined} data-grow={grow || undefined}>
      <div className="nav-section-head">
        <button
          className="nav-section-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="nav-row-twisty">
            <ChevronIcon />
          </span>
          {title}
        </button>
        {open && action}
      </div>
      {open && <div className="nav-section-body">{children}</div>}
    </section>
  );
}

/** Component state that outlives the session, without a store per preference. */
function usePersisted<T>(key: string, fallback: T): [T, (value: T) => void] {
  const { workspace } = useApp();
  const [value, setValue] = useState<T>(() => workspace.settings.get<T>(key, fallback));

  const update = useCallback(
    (next: T) => {
      setValue(next);
      workspace.settings.set(key, next);
    },
    [workspace, key],
  );

  return [value, update];
}

/** `journal/2026-07-28` reads as a date, not as a filename. */
function journalLabel(name: string): string {
  const match = /^journal\/(\d{4})-(\d{2})-(\d{2})$/.exec(name);
  if (!match) return pageBasename(name);

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'Today';

  const yesterday = new Date(today.getTime() - 86_400_000);
  if (sameDay(date, yesterday)) return 'Yesterday';

  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
