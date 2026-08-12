import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isValidPageName, normalizePageName, pageBasename, pageFolder } from '@spark/core';
import { useApp } from '../app-context';
import {
  ColumnsIcon,
  CopyIcon,
  CutIcon,
  FloatIcon,
  FolderPlusIcon,
  ListIcon,
  PasteIcon,
  PageIcon,
  PenIcon,
  PlusIcon,
  SearchIcon,
  SplitIcon,
  TrashIcon,
  TreeIcon,
  UploadIcon,
} from '../components/Icons';
import {
  PopoverMenu,
  anchorPoint,
  usePopover,
  type MenuEntry,
} from '../components/Popover';
import { modKey } from '../lib/device';
import { chooseFiles, describeUpload, uploadFiles } from '../lib/uploads';
import { DRAG_THRESHOLD } from '../windows/drag';
import { useWindows } from '../windows/manager';
import { locate } from '../windows/model';
import { PLACES_VIEW } from '../windows/views';
import { ColumnsMode, ListMode, TreeMode } from './modes';
import {
  copyEntry,
  deleteEntry,
  describeClipboard,
  moveEntry,
  pagesOf,
  pasteInto,
  renameEntry,
  setClipboard,
  useClipboard,
  useNavigatorOperations,
  type Entry,
} from './operations';
import { type RowActions } from './rows';
import { usePersisted } from './section';
import { ancestorsOf, buildTree, filterPages, type SortMode } from './tree';

/**
 * The navigator: everything there is, and what you can do to it.
 *
 * It used to be four sections in one rail — the three "places you go" lists
 * plus the pages browser — split across a seam you could drag. The places are
 * their own panel now (`Places.tsx`), which leaves this doing one job: a search
 * field and a browser under it, in whichever of the three shapes suits what you
 * are looking for.
 *
 * The three modes are a real choice rather than a skin — see `modes.tsx`.
 * Columns need width to work, so the switcher only offers them when there is
 * width to give, and a search result ignores the mode entirely: once you have
 * typed a query you are looking for a page, not for where it lives.
 *
 * What is new here beyond the split is that the rows *do* things. Rename, move,
 * duplicate, delete and a cut/copy/paste clipboard, reachable by right-click;
 * dragging a row into the workbench to open it in a tab, a split or a window;
 * and dragging one onto a folder to move it there. Before this, the only verb
 * the navigator had was "open", and everything else meant going to Finder.
 */

type Mode = 'tree' | 'list' | 'columns';

/** Below this the columns mode is not offered — two columns stop being legible. */
const COLUMNS_MIN_WIDTH = 460;

/** One chunk `/api/search` found, mirroring `retrieval.ts`'s `Hit`. */
interface SearchHit {
  page: string;
  line: number;
  text: string;
  heading?: string;
  score: number;
  found: Array<'text' | 'meaning'>;
}

/** Nobody types a one-character query expecting a content scan of the whole space. */
const MIN_CONTENT_QUERY = 2;
const CONTENT_SEARCH_DEBOUNCE = 200;

export function Navigator({ instanceId }: { instanceId: string }) {
  const { pages, folders, workspace, route, refreshPages, refreshFolders, toast } = useApp();
  const { openPage, openFind, narrow, layout, startDrag, drag, openPlaces } = useWindows();
  const popover = usePopover();
  const clipboard = useClipboard();

  const hostRef = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  const [query, setQuery] = useState('');
  const [contentHits, setContentHits] = useState<SearchHit[]>([]);

  // A fast, global, content-aware search alongside the instant filename
  // filter below — `filterPages` only ever matched a page's name, so a word
  // that's only in a page's body was invisible to search entirely.
  // Debounced and cancellable per keystroke: `find()` on the server chunks
  // and scores the whole space on every call, which is cheap once but not
  // something to run on every single character of a fast typist.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CONTENT_QUERY) {
      setContentHits([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}&limit=8`, { signal: controller.signal })
        .then((res) => (res.ok ? (res.json() as Promise<{ hits: SearchHit[] }>) : null))
        .then((result) => {
          if (result) setContentHits(result.hits);
        })
        .catch(() => {
          // Aborted by the next keystroke, or the request failed — either
          // way the filename matches above still answer the search.
        });
    }, CONTENT_SEARCH_DEBOUNCE);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const [mode, setMode] = usePersisted<Mode>('nav.mode', 'tree');
  const [sort, setSort] = usePersisted<SortMode>('nav.sort', 'recent');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(workspace.settings.get<string[]>('nav.expanded', [])),
  );

  const currentPage = route.kind === 'page' ? route.page : null;

  // On a phone the rail is a drawer you opened to go somewhere; a mode switcher
  // and a sort control are both in the way of that.
  const wide = width >= COLUMNS_MIN_WIDTH && !narrow;
  const effectiveMode: Mode = narrow ? 'list' : mode === 'columns' && !wide ? 'tree' : mode;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const refresh = useCallback(async () => {
    await Promise.all([refreshPages(), refreshFolders()]);
  }, [refreshPages, refreshFolders]);

  const run = useNavigatorOperations(workspace, pages, refresh, toast);

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
   * A content hit is a page *and* a place: it opens the page at the chunk's
   * line, and the phrase that found it becomes a find within that document —
   * highlighting every match and letting you step through them. A title match
   * has nowhere to point; a content match pointing nowhere is half a search.
   */
  const openContentHit = useCallback(
    (hit: SearchHit, event: React.MouseEvent) => {
      const mode = event.metaKey || event.ctrlKey ? 'split-right' : 'tab';
      const id = openPage(hit.page, { mode, line: hit.line });
      if (id) openFind(query.trim(), id);
    },
    [openPage, openFind, query],
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
        await refresh();
        openPage(name, { line: 1 });
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    [workspace, openPage, refresh, toast],
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

  /** Puts files in `files/`, from the rail rather than only from a chat. */
  const upload = useCallback(async () => {
    const chosen = await chooseFiles();
    if (chosen.length === 0) return;
    const outcome = await uploadFiles(chosen);
    await refresh();
    const said = describeUpload(outcome);
    toast(said.message, said.ok ? 'success' : 'error');
  }, [refresh, toast]);

  // -- acting on a row ------------------------------------------------------

  const menuFor = useCallback(
    (entry: Entry): MenuEntry[] => {
      const label = entryLabel(entry);
      const isPage = entry.kind === 'page';
      const folderOf = isPage ? pageFolder(entry.path) : entry.path;
      const pasteLabel = describeClipboard(clipboard);
      const count = pagesOf(pages, entry).length;

      return [
        ...(isPage
          ? [
              {
                id: 'open',
                label: 'Open',
                icon: <PageIcon />,
                run: () => void openPage(entry.path),
              },
              {
                id: 'open-split',
                label: 'Open in a split',
                icon: <SplitIcon />,
                run: () => void openPage(entry.path, { mode: 'split-right', duplicate: true }),
              },
              {
                id: 'open-window',
                label: 'Open in a window',
                icon: <FloatIcon />,
                run: () => void openPage(entry.path, { mode: 'window', duplicate: true }),
              },
              { kind: 'separator' as const, id: 'sep-open' },
            ]
          : [
              {
                id: 'new-page',
                label: 'New page here',
                icon: <PlusIcon />,
                run: () => void newPage(entry.path),
              },
              { kind: 'separator' as const, id: 'sep-open' },
            ]),

        {
          id: 'cut',
          label: 'Cut',
          icon: <CutIcon />,
          hint: `${modKey}X`,
          run: () => setClipboard({ mode: 'cut', entries: [entry] }),
        },
        {
          id: 'copy',
          label: 'Copy',
          icon: <CopyIcon />,
          hint: `${modKey}C`,
          run: () => setClipboard({ mode: 'copy', entries: [entry] }),
        },
        {
          id: 'paste',
          label: pasteLabel ?? 'Paste',
          icon: <PasteIcon />,
          disabled: pasteLabel === null,
          run: () =>
            void run(
              (context) => pasteInto(context, clipboard!, folderOf),
              (result) => `Pasted ${result.moved} page${result.moved === 1 ? '' : 's'}.`,
            ),
        },
        {
          id: 'duplicate',
          label: 'Duplicate',
          icon: <CopyIcon />,
          run: () =>
            void run(
              (context) => copyEntry(context, entry, pageFolder(entry.path)),
              (result) => `Duplicated as ${result.destination}.`,
            ),
        },
        { kind: 'separator' as const, id: 'sep-edit' },
        {
          id: 'rename',
          label: 'Rename…',
          icon: <PenIcon />,
          run: async () => {
            const next = await workspace.ui.prompt(`Rename ${label}`, label);
            if (!next || next === label) return;
            const result = await run(
              (context) => renameEntry(context, entry, next),
              (outcome) => `Renamed to ${outcome.destination}.`,
            );
            // Follow a renamed page: you were probably reading it.
            if (result?.destination && isPage && currentPage === entry.path) {
              openPage(result.destination);
            }
          },
        },
        {
          id: 'delete',
          label: isPage ? 'Delete' : `Delete folder (${count} pages)`,
          icon: <TrashIcon />,
          danger: true,
          run: async () => {
            const question = isPage
              ? `Delete “${entry.path}”?`
              : `Delete “${entry.path}” and the ${count} page${count === 1 ? '' : 's'} in it?`;
            const answer = await workspace.ui.select(question, ['Delete', 'Cancel']);
            if (answer !== 'Delete') return;
            await run(
              (context) => deleteEntry(context, entry),
              (result) => `Deleted ${result.moved} page${result.moved === 1 ? '' : 's'}.`,
            );
          },
        },
      ];
    },
    [clipboard, pages, openPage, newPage, run, workspace, currentPage],
  );

  const openMenu = useCallback(
    (entry: Entry, event: React.MouseEvent | React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      popover.open({
        label: `Actions for ${entryLabel(entry)}`,
        role: 'menu',
        className: 'popover-menu',
        anchor: anchorPoint(event.clientX, event.clientY),
        render: ({ close }) => <PopoverMenu entries={menuFor(entry)} close={close} />,
      });
    },
    [popover, menuFor],
  );

  /**
   * Dragging a row.
   *
   * Two destinations from one gesture, decided by where it is released: inside
   * the navigator it is a *move* onto a folder, and anywhere in the workbench it
   * is an *open* — as a tab, a split, a rail or a window, through exactly the
   * same drop targets a tab drag uses. The threshold is what lets the same
   * press still be the click that opens the page.
   */
  const dropFolder = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const beginRowDrag = useCallback(
    (entry: Entry, event: React.PointerEvent) => {
      if (event.button !== 0) return;
      dropFolder.current = null;
      setDropTarget(null);

      startDrag(event, { kind: 'page', page: entry.path }, {
        threshold: DRAG_THRESHOLD,
        label: entryLabel(entry),
        onMove: () => {
          // Hit-tested from the DOM on every move rather than from rectangles
          // measured at drag start: the row list scrolls, and `closest` walking
          // out to the panel itself is what makes the empty space below the
          // rows mean "the root of the space".
          const under = document.elementFromPoint(lastPointer.x, lastPointer.y);
          const over = under?.closest<HTMLElement>('[data-nav-folder]');
          const folder = over ? (over.dataset.navFolder ?? '') : null;
          if (folder !== dropFolder.current) {
            dropFolder.current = folder;
            setDropTarget(folder);
          }
        },
        onCancel: () => {
          dropFolder.current = null;
          setDropTarget(null);
        },
      });
    },
    [startDrag],
  );

  /**
   * The pointer, for the folder hit test above.
   *
   * `startDrag`'s `onMove` reports a delta rather than a position, because that
   * is what a window drag needs. Rather than widen that contract for one
   * caller, the position is picked up from the window — this listener is only
   * alive while something is being dragged.
   */
  const lastPointer = useRef({ x: 0, y: 0 }).current;
  useEffect(() => {
    if (!drag) return;
    const onMove = (event: PointerEvent) => {
      lastPointer.x = event.clientX;
      lastPointer.y = event.clientY;
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [drag, lastPointer]);

  // A drop inside the navigator moves; the workbench handles everything else.
  // Watching the session end rather than owning the pointer release is what
  // keeps the two from both acting on the same drop.
  const wasDragging = useRef<{ page: string } | null>(null);
  useEffect(() => {
    if (drag?.payload.kind === 'page') {
      wasDragging.current = { page: drag.payload.page };
      return;
    }
    const finished = wasDragging.current;
    wasDragging.current = null;
    const folder = dropFolder.current;
    dropFolder.current = null;
    setDropTarget(null);

    if (!finished || folder === null) return;
    const entry: Entry = pages.some((page) => page.name === finished.page)
      ? { kind: 'page', path: finished.page }
      : { kind: 'folder', path: finished.page };
    if (pageFolder(finished.page) === folder) return;

    void run(
      (context) => moveEntry(context, entry, folder),
      (result) => `Moved to ${result.destination}.`,
    );
  }, [drag, pages, run]);

  const rowActions = useCallback(
    (node: { kind: 'page' | 'folder'; path: string }): RowActions => {
      const entry: Entry = { kind: node.kind, path: node.path };
      return {
        onDragStart: (event) => beginRowDrag(entry, event),
        onMenu: (event) => openMenu(entry, event),
        cut:
          clipboard?.mode === 'cut' &&
          clipboard.entries.some((held) => held.path === node.path),
        dropping: node.kind === 'folder' && dropTarget === node.path,
        // A drop on a page means "into the folder it is in", which is what
        // makes the gesture work in the flat list and in search results too.
        dropPath: node.kind === 'folder' ? node.path : pageFolder(node.path),
      };
    },
    [beginRowDrag, openMenu, clipboard, dropTarget],
  );

  // -- render ---------------------------------------------------------------

  const filtered = useMemo(() => filterPages(pages, query), [pages, query]);
  const tree = useMemo(() => buildTree(filtered, folders, sort), [filtered, folders, sort]);
  const searching = query.trim().length > 0;
  // A page already shown for matching its name doesn't need a second row for
  // also matching its contents.
  const filteredNames = useMemo(() => new Set(filtered.map((page) => page.name)), [filtered]);

  // The "Places" link is the way back when it isn't on screen. When the two
  // share a rail they now stack rather than tab — see `SidebarStack` in
  // `Workbench.tsx` — so Places is already visible above this, and a link to
  // it would just point at something you're already looking at.
  const placesVisible = useMemo(() => {
    const home = locate(layout, instanceId);
    if (home?.surface !== 'sidebar') return false;
    return layout.sidebars[home.side].views.some((view) => view.type === PLACES_VIEW);
  }, [layout, instanceId]);

  const actions = (
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
        title="Upload files into files/"
        aria-label="Upload files"
        onClick={() => void upload()}
      >
        <UploadIcon />
      </button>
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
      <ListMode
        pages={filtered}
        currentPage={currentPage}
        onOpen={open}
        rowActions={rowActions}
      />
    ) : effectiveMode === 'columns' ? (
      <ColumnsMode
        root={tree}
        currentPage={currentPage}
        onOpen={open}
        onAddPage={(folder) => void newPage(folder)}
        rowActions={rowActions}
      />
    ) : (
      <TreeMode
        root={tree}
        currentPage={currentPage}
        onOpen={open}
        onAddPage={(folder) => void newPage(folder)}
        rowActions={rowActions}
        expanded={expanded}
        onToggle={toggleFolder}
      />
    );

  return (
    <nav
      className="navigator"
      data-panel="pages"
      ref={hostRef}
      aria-label="Navigator"
      // Dropping onto the empty space in the panel means the root of the space.
      data-nav-folder=""
      data-nav-drop=""
      // Right-clicking the panel itself, away from any row, acts on the root —
      // which is how you paste something into the top level.
      onContextMenu={(event) => {
        if (event.defaultPrevented) return;
        openMenu({ kind: 'folder', path: '' }, event);
      }}
    >
      {/*
        The search field belongs to this panel and sits at the top of it.
        Results appear in the browser directly underneath, which is the only
        arrangement in which the field explains what it just did.
      */}
      <div className="nav-search">
        <span className="nav-search-icon">
          <SearchIcon />
        </span>
        <input
          className="nav-search-input"
          value={query}
          placeholder="Find a page"
          aria-label="Find a page"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.stopPropagation();
              setQuery('');
            }
          }}
        />
        {searching && (
          <button
            className="nav-search-clear"
            aria-label="Clear the search"
            title="Clear"
            onClick={() => setQuery('')}
          >
            ×
          </button>
        )}
      </div>

      <div className="nav-head">
        <span className="nav-head-title">
          {searching ? `${filtered.length} result${filtered.length === 1 ? '' : 's'}` : 'Pages'}
        </span>
        {actions}
      </div>

      <div className="nav-browser">
        {browser}
        {searching && (
          <ContentMatches hits={contentHits} exclude={filteredNames} onOpen={openContentHit} />
        )}
      </div>

      {/* Places is a panel of its own now, so there has to be a way back to it
          from here — otherwise splitting them off hides the journal behind a
          command nobody knows to run.

          There used to be a "Hide" button here too. It closed the rail when
          the navigator was its only occupant, but stacked with Places — its
          default arrangement — that same click called `closeView` instead,
          which does not hide the navigator, it removes it: reachable again
          only through a command, not through anything on screen. A button
          whose job is "put this away for later" must not have a second,
          unlabelled meaning of "get rid of this". Collapsing it (a click on
          its own title in classic mode, or the seam above it everywhere
          else) is the reversible version of the same idea. */}
      {!narrow && !placesVisible && (
        <div className="nav-foot">
          <button
            className="nav-foot-link"
            onClick={openPlaces}
            title="Views, recent pages and the journal"
          >
            Places
          </button>
        </div>
      )}
    </nav>
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
  children: React.ReactNode;
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

/** A row names itself by its last segment, whatever depth it is at. */
function entryLabel(entry: Entry): string {
  return pageBasename(entry.path) || 'the space';
}

/**
 * Pages that matched the query's *contents*, not its name — the filename
 * filter above already covers the title, so a page only needs a row here if
 * the reason it matched isn't otherwise visible.
 *
 * Each row shows the snippet it matched on, since "Improvements" on its own
 * doesn't say why it's in the results the way it does for a title match.
 */
function ContentMatches({
  hits,
  exclude,
  onOpen,
}: {
  hits: SearchHit[];
  exclude: ReadonlySet<string>;
  onOpen: (hit: SearchHit, event: React.MouseEvent) => void;
}) {
  // One row per page, not one per matching chunk — every row opens the same
  // page regardless of which passage matched, so a page with four hits would
  // otherwise be four near-identical rows in a row. `hits` already arrives
  // best-first, so the first chunk seen per page is its best one.
  const seen = new Set<string>();
  const shown = hits.filter((hit) => {
    if (exclude.has(hit.page) || seen.has(hit.page)) return false;
    seen.add(hit.page);
    return true;
  });
  if (shown.length === 0) return null;

  return (
    <div className="nav-search-hits">
      <div className="nav-search-hits-label">In your pages</div>
      {shown.map((hit) => (
        <button
          key={`${hit.page}:${hit.line}`}
          className="nav-search-hit"
          onClick={(event) => onOpen(hit, event)}
          title={hit.page}
        >
          <span className="nav-search-hit-title">
            <PageIcon />
            {hit.page}
          </span>
          <span className="nav-search-hit-snippet">
            {hit.heading ? `${hit.heading} — ` : ''}
            {snippetOf(hit.text)}
          </span>
        </button>
      ))}
    </div>
  );
}

const SNIPPET_LENGTH = 140;

/** The chunk's opening text, trimmed to a line worth reading rather than the whole paragraph. */
function snippetOf(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= SNIPPET_LENGTH) return trimmed;
  // Break on the last space before the limit, so the cut doesn't land mid-word.
  const cut = trimmed.slice(0, SNIPPET_LENGTH);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : SNIPPET_LENGTH)}…`;
}
