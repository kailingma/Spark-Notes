import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseFrontmatter, type AiProviderProfile, type PageMeta } from '@spark/core';
import { useApp } from '../app-context';
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  FloatIcon,
  FolderIcon,
  GripIcon,
  HistoryIcon,
  MemoryIcon,
  MoreIcon,
  PageIcon,
  PenIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RegenerateIcon,
  RewindIcon,
  SearchIcon,
  ShowIcon,
  SplitIcon,
  TrashIcon,
} from '../components/Icons';
import { anchorElement, anchorPoint, PopoverMenu, usePopover, type MenuEntry } from '../components/Popover';
import { NotePicker } from '../components/pickers';
import { SparkComposer, AttachTextForm, type ContextItem } from '../components/SparkComposer';
import { SparkLogo, SparkWatermark } from '../components/SparkLogo';
import { journalFolder, templatesFolder } from '../lib/dirs';
import { MAX_ATTACHMENT_BYTES, uploadFiles, type UploadHandle } from '../lib/uploads';
import { renderMarkdown } from '../lib/markdown-render';
import { type Preferences } from '../lib/preferences';
import {
  filesApi,
  memoryApi,
  sparkApi,
  type AssistantVariant,
  type Chat,
  type ChatCitation,
  type ChatMessage,
  type ChatSummary,
  type ChatToolCall,
  type ChatUsage,
  type ChatVariant,
  type CommandInfo,
  type SparkMode,
  type SparkSettings,
  type StoredFile,
} from '../lib/spark-client';
import { DRAG_THRESHOLD, startPointerDrag } from '../windows/drag';
import { useViewInstance } from '../windows/instance';
import { useWindows } from '../windows/manager';
import { locate } from '../windows/model';

/**
 * Where projects and the notes they carry live — pages in the space, so they
 * sync, show up in the navigator and can be edited in vim like everything
 * else. A project is the page `<this>/<name>`, marked with `type:
 * spark-project` frontmatter; a text note attached by hand is a page directly
 * under the folder, which is how the folder can hold both.
 */
const PROJECT_FOLDER = 'Spark/projects';

/** Where "Export to a note" writes — beside projects, not mixed into the person's own journal habit. */
const EXPORT_FOLDER = 'Spark/exports';

/**
 * Below this panel width the overlay fills the full panel; above it, the
 * overlay docks as a column that leaves the conversation visible. The same
 * threshold also switches the projects list between grid and list mode.
 */
const OVERLAY_FILL_WIDTH = 500;

/**
 * The docked overlay's drag-resize bounds. The dock never grows past
 * `panelWidth - OVERLAY_DOCK_GUTTER`, because the conversation beside it has
 * to stay readable — that is the whole point of docking rather than covering.
 */
const OVERLAY_DOCK_MIN = 300;
const OVERLAY_DOCK_GUTTER = 160;

/** `Spark/projects/Website` is `Website` everywhere it is shown. */
function projectShortName(name: string): string {
  return name.startsWith(`${PROJECT_FOLDER}/`) ? name.slice(PROJECT_FOLDER.length + 1) : name;
}

/**
 * A conversation, rendered as a note — the text and tool summaries, in the
 * order they happened. Thinking is left out on purpose: it is reasoning, not
 * something Spark said, and the live view already never sends it back to the
 * server for the same reason.
 */
function chatToMarkdown(chat: Chat): string {
  const lines: string[] = [`# ${chat.title}`, ''];
  for (const message of chat.messages) {
    lines.push(message.role === 'user' ? '## You' : '## Spark', '');
    if (message.role === 'assistant' && message.tools && message.tools.length > 0) {
      for (const tool of message.tools) {
        lines.push(`- ${tool.ok ? '' : '⚠️ '}**${tool.name}** — ${tool.summary}`);
      }
      lines.push('');
    }
    const text = message.text.trim();
    if (text) lines.push(text, '');
    if (message.error) lines.push(`*Didn’t finish: ${message.error}*`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Spark.
 *
 * A conversation about your notes that can act on them. Two shapes on purpose:
 * what you said is a bubble, because it is a remark; what Spark said is a full
 * column of prose, because it is an answer, and squeezing an answer into a
 * speech bubble makes it read like chatter.
 *
 * The view is an ordinary virtual page, so it tiles beside a note, floats in a
 * window, or takes the whole screen, and `[[Spark]]` links to it. What it knows
 * about its surroundings comes from the workbench: the name of everything on
 * screen, the full text of the one note directly beside it, and whatever you
 * attached by hand — which outranks both, because you chose it.
 */
export function SparkView() {
  const { workspace, config, preferences, setPreferences, toast, pages, refreshPages } = useApp();
  const { contextFor, openPageBeside, openPage, closeView, startDrag, classic, layout, splitFocused, moveView } =
    useWindows();
  const instanceId = useViewInstance();

  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  /** What the history list is filtered by — matches in titles *and* in what was said. */
  const [chatQuery, setChatQuery] = useState('');
  /** How the history list is ordered: recency (the server's natural order), title, or grouped by project. */
  const [chatSort, setChatSort] = useState<'recent' | 'alpha' | 'project' | 'date'>(
    () => preferences.sparkChatSort,
  );
  /** The conversation list and the projects, covering the whole panel. */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /**
   * What the overlay is showing: the conversation list, or the projects
   * screen. Not a tabbed surface — a single button in the toolbar switches
   * between them, and the projects screen fills the whole panel rather than
   * sitting in a second tab beside the list.
   */
  const [overlayMode, setOverlayMode] = useState<'chats' | 'projects'>('chats');
  /**
   * The docked overlay's width, in px. Owned here so the drag handle on its
   * right edge can move it live, seeded from (and saved back to) the
   * preference so a width you dragged survives a reload.
   */
  const [dockWidth, setDockWidth] = useState(() => preferences.sparkOverlayWidth);
  /** Whether the history list shows archived conversations instead of live ones. */
  const [showArchived, setShowArchived] = useState(false);
  /** Projects — pages under `Spark/projects/` carrying `type: spark-project`. */
  const [projects, setProjects] = useState<string[]>([]);
  /** Project descriptions, from each project's frontmatter — what the cards show. */
  const [projectDescriptions, setProjectDescriptions] = useState<Record<string, string>>({});
  /** The project being edited in the Projects tab, by page name. */
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState<Reply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<ContextItem[]>([]);
  const [uploads, setUploads] = useState<UploadHandle[]>([]);
  const [settings, setSettings] = useState<SparkSettings | null>(null);
  /** For the context-window warning — which profile a mode resolves to, and its best-effort size. */
  const [profiles, setProfiles] = useState<AiProviderProfile[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [finding, setFinding] = useState(false);
  /** What the last consolidation pass did, shown once and then replaced. */
  const [memoryNote, setMemoryNote] = useState<string | null>(null);
  /** Open threads, read from the memory file. No model call is involved. */
  const [openThreads, setOpenThreads] = useState(0);
  /** The assistant turn the pointer is over, for arrow-key switching between its regenerated replies. */
  const [hoveredTurn, setHoveredTurn] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * The panel's width, tracked so the overlay can fill the full panel when
   * narrow and dock as a column beside the transcript when wide. Below
   * `OVERLAY_FILL_WIDTH` the overlay covers everything; above it, it becomes
   * a sidebar that leaves the conversation visible.
   */
  const [panelWidth, setPanelWidth] = useState(0);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setPanelWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const overlayFills = panelWidth > 0 && panelWidth < OVERLAY_FILL_WIDTH;

  /** The projects screen starts as its selector, not at whatever project was last open. */
  const openProjects = useCallback(() => {
    setSelectedProject(null);
    setOverlayMode('projects');
  }, []);

  /**
   * The docked overlay's right edge drags. A resize seam's press means nothing
   * on its own, so the threshold is zero. The width is clamped to the dock's
   * bounds live and committed to the preference once, on release.
   */
  const startDockResize = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const start = dockWidth;
      const max = Math.max(OVERLAY_DOCK_MIN, panelWidth - OVERLAY_DOCK_GUTTER);
      let width = start;
      startPointerDrag(event, {
        onMove: (_native, delta) => {
          width = Math.min(Math.max(start + delta.dx, OVERLAY_DOCK_MIN), max);
          setDockWidth(width);
        },
        onEnd: () => {
          setPreferences({ sparkOverlayWidth: width });
        },
      });
    },
    [dockWidth, panelWidth, setPreferences],
  );

  /**
   * Every turn in flight, keyed by a run id rather than by the chat — a chat's
   * id is not known until the server answers the request that creates it, and
   * the same chat can keep running after its view has moved on to another one.
   * `chatIdRef` mirrors the *displayed* chat, so a turn that lands while its
   * chat is not on screen updates the registry and nothing else.
   */
  const runsRef = useRef(new Map<number, ActiveRun>());
  const runSeq = useRef(0);
  const chatIdRef = useRef<string | null>(null);
  chatIdRef.current = chatId;
  /**
   * Identifies *which* blank-composer visit a still-anonymous run belongs
   * to. `chatId: null` alone can't: two different visits to the blank
   * composer, each starting its own send before either's `onChat` has
   * answered, would otherwise be indistinguishable, and whichever one's
   * `onChat` happened to land first would take over whatever blank screen
   * currently happened to be showing — reported as "New Conversation
   * sometimes shows someone else's reply". `run()` mints a fresh id for
   * every anonymous send and this screen claims it the moment it starts one;
   * `startNew()` mints its own so a freshly opened blank screen never
   * inherits an older pending send's identity.
   */
  const draftIdRef = useRef<string | null>(null);
  /**
   * The prompt a rewind put in the composer. The truncated view has dropped
   * the rewound-to turn itself, so `run` could not rebuild the fork metadata
   * from `messages` alone — the turn stays here, with its variant list, until
   * the send consumes it (or a load, a new chat, or a regenerate makes the
   * rewind moot).
   */
  const rewoundRef = useRef<{ at: number; prior: DisplayMessage } | null>(null);
  /** Latest variant-switch request wins, so out-of-order responses can't regress a rapid double-click. */
  const switchSeq = useRef(0);

  const findRun = useCallback((id: string | null): ActiveRun | null => {
    for (const run of runsRef.current.values()) {
      if (run.chatId === id) return run;
    }
    return null;
  }, []);

  /** The anonymous run this screen itself started, if any — see `draftIdRef`. */
  const findOwnDraftRun = useCallback((): ActiveRun | null => {
    if (draftIdRef.current === null) return null;
    for (const run of runsRef.current.values()) {
      if (run.chatId === null && run.draftId === draftIdRef.current) return run;
    }
    return null;
  }, []);

  /**
   * Whether `entry`'s turn is the one this screen is currently showing —
   * the gate every handler in `run()` uses before touching `reply`,
   * `messages` or the error/memory banners, so a turn that outlived the
   * screen that started it only ever updates its own registry entry. For a
   * confirmed chat this is the ordinary `chatId` match; for a still-
   * anonymous run it also has to agree on `draftId`, or any two blank
   * screens with sends in flight at once would be indistinguishable — see
   * `draftIdRef`.
   */
  const isDisplayed = useCallback(
    (entry: ActiveRun): boolean =>
      entry.chatId !== null
        ? entry.chatId === chatIdRef.current
        : chatIdRef.current === null && entry.draftId === draftIdRef.current,
    [],
  );

  // Recomputed on every render of the view rather than memoised against the
  // layout: it is three array operations, and a stale answer here would mean
  // Spark reading the wrong note. A `useMemo` keyed on anything narrower than
  // "every render" is exactly that staleness — focusing a different tab
  // touches neither `instanceId` nor `messages`, so a memo gated on those
  // alone kept reporting whichever note was focused when Spark last computed
  // it, not the one actually in front of you.
  const surroundings = instanceId ? contextFor(instanceId) : { openPages: [], neighbour: null };

  /**
   * Refetches the conversation list, keeping whatever search is in effect.
   *
   * The query and the archived toggle are read from refs rather than taken as
   * parameters everywhere, so `onSaved` — which fires from inside the
   * streaming run, where the latest `chatQuery` would otherwise have to ride
   * along in dependencies — refreshes *the same filtered list* the person is
   * looking at instead of suddenly showing every conversation over it.
   */
  const chatQueryRef = useRef('');
  chatQueryRef.current = chatQuery;
  const showArchivedRef = useRef(false);
  showArchivedRef.current = showArchived;
  const refreshChats = useCallback(async (q?: string) => {
    setChats(await sparkApi.chats(q ?? chatQueryRef.current, showArchivedRef.current));
  }, []);

  // Debounced, because the search scans every conversation's text on the
  // server — cheap once, not something to run on every keystroke of a fast
  // typist. The first run is skipped: the mount effect below already fetched
  // the unfiltered list.
  const chatQueryFirst = useRef(true);
  useEffect(() => {
    if (chatQueryFirst.current) {
      chatQueryFirst.current = false;
      return;
    }
    const timer = setTimeout(() => void refreshChats(chatQuery), 150);
    return () => clearTimeout(timer);
  }, [chatQuery, refreshChats]);

  useEffect(() => {
    void refreshChats();
    void sparkApi.settings().then(setSettings);
    void sparkApi.commands().then(setCommands);
    void workspace.ai.profiles().then(setProfiles).catch(() => setProfiles([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshChats]);

  // Flipping the archived toggle swaps which list is shown; the effect keeps
  // the side effect out of the updater (see AGENTS → "setState updaters run
  // more than once").
  useEffect(() => {
    void refreshChats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

  /**
   * The project list, re-read whenever the page list changes.
   *
   * A project is any page under `Spark/projects/` whose frontmatter says so —
   * the same "no index that can disagree with the directory" call everything
   * else in the app makes. Text notes attached by hand live in the same
   * folder without the marker, which is what keeps the two apart.
   */
  const refreshProjects = useCallback(async () => {
    const candidates = pages.filter((page) => page.name.startsWith(`${PROJECT_FOLDER}/`));
    const marked: string[] = [];
    const descriptions: Record<string, string> = {};
    await Promise.all(
      candidates.map(async (page) => {
        const stored = await workspace.space.read(page.name).catch(() => null);
        if (!stored) return;
        const { data } = parseFrontmatter(stored.text);
        if (data.type !== 'spark-project') return;
        marked.push(page.name);
        if (typeof data.description === 'string' && data.description.trim()) {
          descriptions[page.name] = data.description.trim();
        }
      }),
    );
    setProjects(marked);
    setProjectDescriptions(descriptions);
  }, [pages, workspace]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  /**
   * The project the current chat belongs to — what `run()` attaches
   * automatically. Lives in a ref because it changes with the loaded chat,
   * not with a render.
   */
  const chatProjectRef = useRef<string | null>(null);

  /**
   * Anything outstanding, on the empty screen.
   *
   * This is as close to being proactive as Spark gets, and it stays on the right
   * side of "never speaks first" because no model is asked anything: it is a
   * count of unticked lines in a markdown file. You are told there is something
   * waiting; whether to ask about it is yours.
   */
  useEffect(() => {
    if (!preferences.sparkRemembers) {
      setOpenThreads(0);
      return;
    }
    let cancelled = false;
    void memoryApi.read().then((snapshot) => {
      if (cancelled || !snapshot) return;
      setOpenThreads(snapshot.threads.bullets.filter((bullet) => !bullet.done).length);
    });
    return () => {
      cancelled = true;
    };
  }, [preferences.sparkRemembers, messages.length]);

  /**
   * The passage you have selected, as a chip that keeps up with you.
   *
   * Automatic because the alternative is worse in both directions: a person who
   * highlights three paragraphs and then asks "tighten this" means *those*
   * paragraphs, and being asked to press a button to say so is the app pretending
   * not to have noticed. It is removable, and removing it dismisses this
   * selection rather than the feature — highlight something else and it returns.
   */
  useEffect(() => {
    if (!preferences.sparkSendsCurrentFile) return;

    const sync = () => {
      const page = workspace.editor.page();
      const selected = workspace.editor.selectedText().trim();
      setContext((current) => {
        const withoutAuto = current.filter((item) => !(item.automatic && item.kind === 'selection'));
        // A word or two is a cursor drag, not a choice. Below that the chip
        // would flicker in and out as somebody double-clicks around the page.
        if (!page || selected.length < 24) return withoutAuto;
        if (current.some((item) => item.kind === 'selection' && item.text === selected)) return current;
        return [...withoutAuto, { name: page, kind: 'selection', text: selected, automatic: true }];
      });
    };

    const off = workspace.editor.onChange(sync);
    // `selectionchange` on the document, because CodeMirror moving the caret is
    // not a React event and nothing else tells us it happened.
    document.addEventListener('selectionchange', sync);
    return () => {
      off();
      document.removeEventListener('selectionchange', sync);
    };
  }, [workspace, preferences.sparkSendsCurrentFile]);

  /**
   * The note beside you, as a chip rather than as an invisible fact.
   *
   * `run()` has always sent this note in full when it is the one sibling in
   * the group — see **Context** in `AGENTS.md`. It travelled with nothing to
   * show for it, though, which meant the only way to know Spark could see your
   * note was to remember a sentence of documentation. A chip is honest about
   * it, and being hideable rather than removable matches what it actually is:
   * not a choice you made, a fact about what's on screen that you can ask
   * Spark to disregard without it stopping being true a moment later.
   */
  useEffect(() => {
    const name = preferences.sparkSeesContext ? surroundings.neighbour : null;
    setContext((current) => {
      const without = current.filter((item) => item.kind !== 'neighbour');
      // Already attached by hand: a second chip for the same page would say
      // the same thing twice.
      if (!name || current.some((item) => item.kind === 'page' && item.name === name)) {
        return without.length === current.length ? current : without;
      }
      const existing = current.find((item) => item.kind === 'neighbour');
      // Keeps a hidden neighbour hidden across re-renders where it hasn't
      // actually changed — only a genuinely different note resets it.
      if (existing?.name === name) return current;
      return [...without, { name, kind: 'neighbour', automatic: true }];
    });
  }, [preferences.sparkSeesContext, surroundings.neighbour]);

  /**
   * Uploads, from any of the three ways a file arrives.
   *
   * The upload happens now rather than when the message is sent: the file lands
   * in `files/` immediately, so abandoning the message still leaves you with the
   * file, and the turn carries names instead of megabytes.
   */
  const attachFiles = useCallback(
    async (incoming: FileList | File[] | null) => {
      const list = [...(incoming ?? [])];
      if (list.length === 0) return;

      const outcome = await uploadFiles(list, {
        onStart: (handle) => setUploads((current) => [...current, handle]),
        onSettle: (handle) => setUploads((current) => current.filter((item) => item.id !== handle.id)),
      });
      for (const stored of outcome.stored) {
        setContext((current) =>
          current.some((item) => item.name === stored.name)
            ? current
            : [...current, { name: stored.name, kind: 'file', file: stored }],
        );
      }
      for (const failure of outcome.failed) {
        if (failure.reason !== 'Cancelled.') toast(failure.reason, 'error');
      }
    },
    [toast],
  );

  /** A note chosen from the picker, or one Spark just presented. */
  const attachPage = useCallback(
    async (name: string, automatic = false) => {
      const live = workspace.editor.textOf(name);
      const text =
        live ?? (await workspace.space.read(name).then((page) => page.text).catch(() => ''));
      setContext((current) =>
        current.some((item) => item.name === name && item.kind === 'page')
          ? current
          : [...current, { name, kind: 'page', text, automatic }],
      );
    },
    [workspace],
  );

  /** The "Open" button on a presented-page pill — the navigation `onAction` used to do automatically. */
  const openPresented = useCallback(
    (page: string) => {
      if (instanceId) openPageBeside(instanceId, page);
      else openPage(page);
    },
    [instanceId, openPageBeside, openPage],
  );

  /**
   * A text note, written into the space as `Spark/projects/<title>` — the
   * same folder projects live in, because that is where this app's project
   * material is. Returns the page name, or `null` if nothing was written.
   */
  const createTextNote = useCallback(
    async (title: string, text: string): Promise<string | null> => {
      const fallback = text.trim().split('\n')[0].slice(0, 40).trim();
      const name = `${PROJECT_FOLDER}/${title.trim() || fallback || 'Note'}`;
      if (!text.trim()) return null;
      const existing = await workspace.space.read(name).catch(() => null);
      await workspace.space.write(name, text, existing?.rev ?? undefined);
      await refreshPages();
      return name;
    },
    [workspace, refreshPages],
  );

  /**
   * "Export to a note" — fetches the full transcript (the row menu only
   * carries a `ChatSummary`), renders it, and writes it under `EXPORT_FOLDER`
   * with a name unique enough not to collide with an earlier export of the
   * same conversation.
   */
  const exportChatToNote = useCallback(
    async (chat: ChatSummary) => {
      const full = await sparkApi.chat(chat.id);
      if (!full) {
        toast('Could not load that conversation.', 'error');
        return;
      }
      const base = `${EXPORT_FOLDER}/${full.title.trim() || 'Conversation'}`;
      let name = base;
      for (let n = 2; await workspace.space.exists(name); n++) name = `${base} (${n})`;
      await workspace.space.write(name, chatToMarkdown(full), '');
      await refreshPages();
      openPage(name);
      toast(`Exported to “${name}”.`, 'success');
    },
    [workspace, refreshPages, openPage, toast],
  );

  /**
   * Everything a project carries, as context items.
   *
   * The project page names its attachments; resolving them to their current
   * text is the whole job — the note list is a list of *links*, not a copy,
   * so editing a note the project points at changes what the next turn sees.
   * The instructions travel as their own item so the model reads them as a
   * standing instruction rather than as a page's content.
   */
  const projectMaterial = useCallback(
    async (pageName: string): Promise<ContextItem[]> => {
      const page = await workspace.space.read(pageName).catch(() => null);
      if (!page) return [];
      const doc = parseProjectDoc(page.text);
      const items: ContextItem[] = [];
      if (doc.description.trim()) {
        items.push({
          name: `Project ${projectShortName(pageName)} — description`,
          kind: 'page',
          text: doc.description,
        });
      }
      if (doc.instructions.trim()) {
        items.push({
          name: `Project ${projectShortName(pageName)} — instructions`,
          kind: 'page',
          text: doc.instructions,
        });
      }
      for (const note of [...doc.notes, ...doc.textNotes]) {
        if (items.some((item) => item.name === note)) continue;
        const text = await workspace.space
          .read(note)
          .then((stored) => stored.text)
          .catch(() => '');
        if (text) items.push({ name: note, kind: 'page', text });
      }
      for (const file of doc.files) items.push({ name: file, kind: 'file' });
      if (doc.memory.length > 0) {
        items.push({
          name: `Project ${projectShortName(pageName)} — memory`,
          kind: 'page',
          text: doc.memory.map((line) => `- ${line}`).join('\n'),
        });
      }
      return items;
    },
    [workspace],
  );

  /** Attaches a project to the conversation — from the panel, or automatically when a chat belongs to one. */
  const attachProjectMaterial = useCallback(
    async (pageName: string, markAutomatic = false) => {
      const items = await projectMaterial(pageName);
      if (items.length === 0) return 0;
      setContext((current) => {
        const names = new Set(current.map((item) => item.name));
        const fresh = items
          .filter((item) => !names.has(item.name))
          .map((item) => ({ ...item, automatic: markAutomatic }));
        return fresh.length === 0 ? current : [...current, ...fresh];
      });
      return items.length;
    },
    [projectMaterial],
  );

  /** Creates a project page (frontmatter-marked), or returns `null` if the name is taken. */
  const createProject = useCallback(
    async (): Promise<string | null> => {
      const asked = await workspace.ui.prompt('New project name');
      const name = asked?.trim();
      if (!name) return null;
      const pageName = `${PROJECT_FOLDER}/${name}`;
      if (pages.some((page) => page.name === pageName)) {
        toast('A project with that name already exists.', 'error');
        return null;
      }
      await workspace.space.write(pageName, renderProjectDoc(name, emptyProjectDoc()), undefined);
      await refreshPages();
      await refreshProjects();
      return pageName;
    },
    [workspace, pages, refreshPages, refreshProjects, toast],
  );

  /** Writes a project page from the panel's edited document. */
  const saveProject = useCallback(
    async (pageName: string, doc: ProjectDoc) => {
      const existing = await workspace.space.read(pageName).catch(() => null);
      await workspace.space.write(pageName, renderProjectDoc(projectShortName(pageName), doc), existing?.rev ?? undefined);
      await refreshPages();
      toast('Project saved.', 'success');
    },
    [workspace, refreshPages, toast],
  );

  const deleteProject = useCallback(
    async (pageName: string) => {
      await workspace.space.delete(pageName);
      await refreshPages();
      void refreshProjects();
      setSelectedProject(null);
      toast('Project deleted.', 'success');
    },
    [workspace, refreshPages, refreshProjects, toast],
  );

  /**
   * Moves a conversation into (or out of) a project — the chat file points at
   * the project page, and the project's material then travels with every turn
   * of that chat. See `chatProjectRef`'s use in `run`.
   */
  const moveToProject = useCallback(
    async (chat: ChatSummary, project: string | null) => {
      await sparkApi.update(chat.id, { project });
      if (chat.id === chatId) chatProjectRef.current = project;
      void refreshChats();
      toast(
        project ? `Moved to ${projectShortName(project)}.` : 'Removed from its project.',
        'success',
      );
    },
    [chatId, refreshChats, toast],
  );

  // Follow the conversation as it grows, but only from the bottom: scrolling up
  // to reread something should not be undone by the next token arriving.
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 160;
    if (nearBottom) host.scrollTop = host.scrollHeight;
  }, [messages, reply]);

  const load = useCallback(
    async (id: string) => {
      const chat = await sparkApi.chat(id);
      if (!chat) {
        // Gone — deleted from another device, most likely. Nothing left to
        // resume into, so stop pointing at it.
        setPreferences({ sparkLastChatId: '' });
        return;
      }
      setChatId(chat.id);
      chatProjectRef.current = chat.project ?? null;
      rewoundRef.current = null;
      // A chat with a turn still in flight: the fetch could have caught the
      // reply that turn is about to append itself, so the run's own
      // transcript is the one that knows what is on screen. The live reply
      // comes back the same way — the run's accumulated snapshot.
      const run = findRun(chat.id);
      setMessages(run ? run.base : chat.messages);
      setReply(run ? run.reply : null);
      setError(null);
      setPreferences({ sparkLastChatId: chat.id });
    },
    [setPreferences, findRun],
  );

  /**
   * Opens a chat from the overlay — the history list or a project's list. The
   * overlay closes unless it is pinned *and* docked: pinned means "keep the
   * list up while I browse", and a list that covers the whole panel has
   * hidden the very chat it just opened, so pinning is ignored there.
   */
  const openChatFromOverlay = useCallback(
    (id: string) => {
      void load(id);
      setOverlayMode('chats');
      if (overlayFills || !preferences.sparkOverlayPinned) setSidebarOpen(false);
    },
    [load, overlayFills, preferences.sparkOverlayPinned],
  );

  /** A citation is one of three kinds of source — resolve to whichever opening path it names. */
  const openCitation = useCallback(
    (citation: ChatCitation) => {
      if (citation.chatId) openChatFromOverlay(citation.chatId);
      else if (citation.url) window.open(citation.url, '_blank', 'noopener,noreferrer');
      else if (citation.page) openPage(citation.page, citation.line !== undefined ? { line: citation.line } : {});
    },
    [openChatFromOverlay, openPage],
  );

  const startNew = useCallback(() => {
    // Deliberately not aborting what is in flight: a run belongs to its chat,
    // not to this view, and it keeps going (and keeps streaming into this
    // registry) while the screen moves on — see **Spark → Conversations** in
    // `AGENTS.md`. Stopping is the stop button's job, one chat at a time.
    setChatId(null);
    chatProjectRef.current = null;
    setMessages([]);
    rewoundRef.current = null;
    // A fresh identity, not a reattachment: a genuinely new blank screen
    // shows nothing, even if some earlier visit to the blank composer still
    // has a send in flight — that run keeps going in the background, but it
    // belongs to the screen that started it, not to this one. Reusing
    // `chatId: null` as if it named one conversation is what let a later
    // "New Conversation" click show someone else's still-streaming reply.
    draftIdRef.current = null;
    setReply(null);
    setError(null);
    setContext([]);
    setMemoryNote(null);
    setPreferences({ sparkLastChatId: '' });
  }, [setPreferences]);

  /**
   * Leaving and coming back should not lose the thread.
   *
   * `chatId` lives in this component's own state, so closing the panel — or
   * the tab it's in, or reloading — throws it away like any other unmounted
   * component's state throws away what it held. `sparkLastChatId` is a
   * device-local preference exactly like `sparkModeId`, and it is the one
   * thing about "which conversation" that survives. Read once, on mount:
   * `load` and `startNew` keep it current from here on, so picking a
   * different conversation or starting fresh updates what the next mount
   * resumes into.
   */
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    if (preferences.sparkLastChatId) void load(preferences.sparkLastChatId);
    // Deliberately once — see the doc comment above. `preferences` and `load`
    // are read at that one moment, not tracked afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * One turn.
   *
   * Takes the message rather than reading the draft, so rewinding can reuse
   * it without pretending to type. `message` is `null` for a regenerate: the
   * question isn't retyped, the server re-reads it from the stored turn
   * `fork.regenerate.at` names, and no new user bubble is added to the
   * transcript — the one that's already there, at that position, is the same
   * question. `fork.rewind` marks the other way a turn can reach back: the
   * message is the re-worded successor of the prompt at `fork.rewind.at`,
   * and it replaces that prompt (as its newest variant) instead of being
   * appended after whatever the rewind left behind.
   */
  const run = useCallback(
    async (
      message: string | null,
      carried: ContextItem[],
      history: ChatMessage[],
      fork?: {
        /** Set for "Try again": the assistant turn being replaced. */
        regenerate?: { at: number; priorVariants: AssistantVariant[] };
        /** Set when the turn continues from a rewound-to prompt. */
        rewind?: { at: number; priorVariants: ChatVariant[] };
      },
      /**
       * "Try again with…" — a mode for this one send only, not a change to
       * the person's actual active-mode preference. Falls back to that
       * preference exactly as before when omitted.
       */
      modeIdOverride?: string,
    ) => {
      if (!config.ai) {
        toast('Spark needs a provider and a key. Add them in Settings → Spark.', 'error');
        return;
      }

      // A chat that belongs to a project carries the project with it — the
      // instructions and every attachment, on every turn, until the chat is
      // moved away. Shown as automatic chips the same way the neighbour is,
      // so what travelled is visible and removable (it returns next turn,
      // because it is the project's own material, not a choice about this
      // message).
      let effective = carried;
      const projectName = chatProjectRef.current;
      if (projectName) {
        const material = await projectMaterial(projectName);
        if (material.length > 0) {
          setContext((current) => {
            const names = new Set(current.map((item) => item.name));
            const fresh = material.filter((item) => !names.has(item.name));
            return fresh.length === 0
              ? current
              : [...current, ...fresh.map((item) => ({ ...item, automatic: true }))];
          });
          effective = [...carried, ...material];
        }
      }

      const files = effective.filter((item) => item.kind === 'file').map((item) => item.name);
      // A hidden chip stays in the bar — greyed, so it reads as suppressed
      // rather than gone — but carries nothing to the model. `neighbour` is
      // its own field below rather than a plain attachment, since it has no
      // `text` of its own to send here.
      const attached = effective
        .filter((item) => item.kind !== 'file' && item.kind !== 'neighbour' && !item.hidden)
        .map((item) => ({ name: item.name, text: item.text ?? '', selection: item.kind === 'selection' }));

      setError(null);
      setMemoryNote(null);
      const userText = message === null ? null : withAttachments(message, files);
      // A rewind's successor replaces the rewound-to prompt in the transcript,
      // so the optimistic bubble carries the same variant list the server will
      // store: the old wordings first (with whatever branches this session has
      // seen), the new one last and active.
      const optimisticUser: ChatMessage | null =
        userText === null
          ? null
          : {
              role: 'user',
              text: userText,
              at: Date.now(),
              ...(fork?.rewind
                ? {
                    variants: [...fork.rewind.priorVariants, { text: userText, at: Date.now() }],
                    activeVariant: fork.rewind.priorVariants.length,
                  }
                : {}),
            };
      setMessages(optimisticUser ? [...history, optimisticUser] : history);
      setReply({ text: '', segments: [], approval: null, presented: [] });

      // The turn accumulates here, on its own registry entry, rather than
      // inside the `setReply` updaters. React invokes an updater more than once
      // (StrictMode does it deliberately, to catch exactly this), so an
      // updater that both derives state *and* does something else runs that
      // something else twice — which is how the finished answer was landing in
      // the transcript in duplicate. The entry is also what lets a turn keep
      // going when its chat is not the one on screen: `show()` writes the
      // snapshot to the entry always, and to `reply` only when the entry's
      // chat is the one being displayed.
      const controller = new AbortController();
      const runId = ++runSeq.current;
      // Only meaningful while the chat is still anonymous — see `draftIdRef`.
      // This screen claims it immediately: it is the one that just started
      // this send, so it is the one `isDisplayed` should recognise as this
      // run's home until a real chat id (or a fresh `startNew`) replaces it.
      const draftId = chatId === null ? crypto.randomUUID() : null;
      if (draftId !== null) draftIdRef.current = draftId;
      const entry: ActiveRun = {
        id: runId,
        chatId: chatId ?? null,
        draftId,
        controller,
        base: optimisticUser ? [...history, optimisticUser] : history,
        text: '',
        segments: [],
        approval: null,
        presented: [],
        pendingTools: new Map(),
        reply: { text: '', segments: [], approval: null, presented: [] },
      };
      runsRef.current.set(runId, entry);

      const show = () => {
        entry.reply = {
          text: entry.text,
          segments: entry.segments.map((segment) =>
            segment.kind === 'tools' ? { ...segment, tools: [...segment.tools] } : segment,
          ),
          approval: entry.approval,
          presented: [...entry.presented],
        };
        if (isDisplayed(entry)) setReply(entry.reply);
      };

      // The note beside the chat travels in full, and the live editor text
      // beats what is on disk: the question is usually about the paragraph
      // just typed, which is still inside the autosave debounce.
      let neighbour: { name: string; text: string } | undefined;
      const already = new Set(attached.map((item) => item.name));
      const neighbourChip = carried.find((item) => item.kind === 'neighbour');
      if (
        preferences.sparkSeesContext &&
        surroundings.neighbour &&
        !already.has(surroundings.neighbour) &&
        !neighbourChip?.hidden
      ) {
        const name = surroundings.neighbour;
        const live = workspace.editor.textOf(name);
        const body =
          live ?? (await workspace.space.read(name).then((page) => page.text).catch(() => ''));
        neighbour = { name, text: body };
      }

      try {
        await sparkApi.send(
          {
            chatId: chatId ?? undefined,
            ...(message === null
              ? { regenerateAt: fork!.regenerate!.at }
              : fork?.rewind
                ? { message, rewindTo: fork.rewind.at }
                : { message }),
            context: {
              ...(preferences.sparkSeesContext
                ? { neighbour, openPages: surroundings.openPages }
                : {}),
              ...(attached.length > 0 ? { attached } : {}),
            },
            dirs: { journal: journalFolder(workspace), templates: templatesFolder(workspace) },
            permissions: {
              write: preferences.sparkCanWrite,
              destroy: preferences.sparkCanDestroy,
              remember: preferences.sparkRemembers,
              // The server checks this again against its own sandbox, so a stale
              // preference cannot turn on something the machine cannot do.
              run: preferences.sparkCanRun,
            },
            mode: preferences.sparkPermissionMode,
            modeId: modeIdOverride ?? preferences.sparkModeId,
            historyDepth: preferences.sparkHistoryDepth,
            ...(files.length > 0 ? { attachments: files } : {}),
          },
          {
            onChat: (id) => {
              // Asked before `entry.chatId` changes: `isDisplayed` needs the
              // *old* identity here — whether this screen is specifically the
              // one that started this draft (by `draftId`), not merely
              // whether some blank screen or other is showing. Checking only
              // `chatIdRef.current === null` was the bug: any blank screen
              // reads as "the empty state", including one that opened after
              // this send was already under way.
              const owned = isDisplayed(entry);
              entry.chatId = id;
              if (owned) {
                setChatId(id);
                setPreferences({ sparkLastChatId: id });
              }
              show();
            },
            onText: (chunk) => {
              // The first chunk of the answer is also the moment any
              // thinking still open stops being live.
              closeThinking(entry.segments);
              entry.text += chunk;
              const last = entry.segments[entry.segments.length - 1];
              // Same merge-or-start rule as thinking and tools: text keeps
              // growing the segment already in progress, and a tool call in
              // between starts a fresh one — which is what lets a reply that
              // talks, acts, then talks again show up in that order instead
              // of every word landing in one block under all the tool calls.
              if (last?.kind === 'text') last.text += chunk;
              else entry.segments.push({ kind: 'text', text: chunk });
              show();
            },
            onThinking: (chunk) => {
              const last = entry.segments[entry.segments.length - 1];
              // Still growing the same segment only if it's both a thinking
              // segment *and* nobody has closed it out yet — a later round's
              // thinking must not be mistaken for a continuation of one a
              // tool call already ended.
              if (last?.kind === 'thinking' && last.elapsedMs === undefined) last.text += chunk;
              else entry.segments.push({ kind: 'thinking', text: chunk, startedAt: Date.now() });
              show();
            },
            onTool: (id, name, input) => {
              // A tool call is the other way a thinking segment stops being
              // the live one.
              closeThinking(entry.segments);
              let last = entry.segments[entry.segments.length - 1];
              if (last?.kind !== 'tools') {
                last = { kind: 'tools', tools: [] };
                entry.segments.push(last);
              }
              // Placed by index so the result can find it again without matching
              // on a summary string.
              entry.pendingTools.set(id, { segment: last, index: last.tools.length });
              last.tools.push({ name, input, ok: true, summary: `${label(name)}…` });
              show();
            },
            onApproval: (id, name, input) => {
              const call = entry.pendingTools.get(id);
              if (call) call.segment.tools[call.index] = { ...call.segment.tools[call.index], awaiting: true };
              entry.approval = { id, name, input };
              show();
            },
            onToolResult: (id, ok, summary, touched, detail, citations) => {
              const call = entry.pendingTools.get(id);
              if (call) {
                call.segment.tools[call.index] = {
                  ...call.segment.tools[call.index],
                  ok,
                  summary,
                  pages: touched,
                  detail,
                  citations,
                  awaiting: false,
                };
              }
              // Whatever it was waiting on has been answered, whichever way.
              if (entry.approval?.id === id) entry.approval = null;
              show();

              // A tool that wrote to a page changed a file the editor showing
              // it still believes is current — without this it keeps
              // displaying stale text, and the next autosave collides with
              // the write Spark just made. `page:save` is the exact signal
              // `Editor.tsx`'s own write and quick capture already emit for
              // this; replaying it here lets that already-correct,
              // conflict-safe listener do the rest for a write that happened
              // in a completely different request. Skipped for a page
              // nothing has open, so a turn that touches ten pages costs
              // nothing for the nine nobody is looking at.
              if (ok && touched) {
                for (const name of touched) {
                  if (workspace.editor.textOf(name) === null) continue;
                  void workspace.space
                    .read(name)
                    .then((fresh) => workspace.events.emit('page:save', { page: name, text: fresh.text, rev: fresh.rev }))
                    .catch(() => {
                      /* renamed or deleted out from under it — the next explicit action sorts it out */
                    });
                }
              }
            },
            onAction: (action) => {
              if (action.kind !== 'present') return;
              // Shown as a pill in the transcript, not opened — the whole point
              // of presenting rather than opening is that it does not yank
              // focus onto a page nobody asked to read. Still attached, though:
              // the page is now what "it" refers to, silently, since attaching
              // doesn't move anything on screen.
              if (!entry.presented.includes(action.page)) entry.presented.push(action.page);
              show();
              void attachPage(action.page, true);
            },
            onMemory: (summary) => {
              // A consolidation pass runs at the end of *its* turn — showing
              // the note under a different conversation would report another
              // chat's housekeeping as if it belonged to this one.
              if (isDisplayed(entry)) setMemoryNote(summary);
            },
            onSaved: () => void refreshChats(),
            onError: (message) => {
              if (isDisplayed(entry)) setError(message);
            },
            onWarning: (message) => {
              if (isDisplayed(entry)) toast(message, 'error');
            },
            onRetrying: (attempt, reason) => {
              if (isDisplayed(entry)) toast(`Trying again (${attempt}/4)… ${reason}`, 'error');
            },
            onFallback: (from, to, reason) => {
              if (isDisplayed(entry)) toast(`${from} didn't answer (${reason}) — trying ${to}.`, 'error');
            },
            onUsage: (inputTokens, outputTokens, profileId, model) => {
              entry.usage = { inputTokens, outputTokens };
              entry.providerId = profileId;
              entry.model = model;
            },
          },
          controller.signal,
        );
      } catch (err) {
        if (!controller.signal.aborted) {
          if (isDisplayed(entry)) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }
      } finally {
        runsRef.current.delete(runId);
        // Covers the one path `onText` and `onTool` don't: a turn that ends
        // — aborted, or the model stopped without ever answering — while
        // thinking was still the last thing that happened.
        closeThinking(entry.segments);
        if (entry.text.trim() || entry.segments.length > 0 || entry.presented.length > 0) {
          // What's persisted is a flat `thinking` string and a duration, the
          // same shape the server stores — captured here so a variant kept
          // for later switching (and a page reload) can show something
          // better than nothing, even though only *this* live render gets
          // the fully interleaved `segments`. The duration mirrors the
          // server's own rule: measured up to the first thing that isn't
          // more thinking, not the total across every round.
          const thinking =
            entry.segments
              .filter((segment): segment is Extract<Segment, { kind: 'thinking' }> => segment.kind === 'thinking')
              .map((segment) => segment.text)
              .join('') || undefined;
          const thinkingMs = entry.segments[0]?.kind === 'thinking' ? entry.segments[0].elapsedMs : undefined;
          const modeId = preferences.sparkModeId;
          const variant: AssistantVariant = {
            text: entry.text,
            presented: entry.presented.length > 0 ? entry.presented : undefined,
            thinking,
            thinkingMs,
            modeId,
            usage: entry.usage,
            providerId: entry.providerId,
            model: entry.model,
            at: Date.now(),
          };
          // Only the transcript actually showing this chat gets the message
          // appended to it. A chat the person has moved away from already has
          // the reply stored server-side, and the next `load` of it will fetch
          // it whole — appending here too would corrupt whichever transcript
          // is on screen instead.
          if (isDisplayed(entry)) {
            setMessages((existing) => [
              ...existing,
              {
                role: 'assistant',
                text: entry.text,
                segments: entry.segments.length > 0 ? entry.segments : undefined,
                presented: entry.presented.length > 0 ? entry.presented : undefined,
                thinking,
                thinkingMs,
                modeId,
                usage: entry.usage,
                providerId: entry.providerId,
                model: entry.model,
                at: Date.now(),
                ...(fork?.regenerate
                  ? { variants: [...fork.regenerate.priorVariants, variant], activeVariant: fork.regenerate.priorVariants.length }
                  : {}),
              },
            ]);
          }
        }
        if (isDisplayed(entry)) setReply(null);
      }
    },
    [
      config.ai,
      toast,
      preferences,
      surroundings,
      workspace,
      chatId,
      refreshChats,
      attachPage,
      setPreferences,
      findRun,
      isDisplayed,
      projectMaterial,
    ],
  );

  const send = useCallback(() => {
    const message = draft.trim();
    // A message with nothing but attachments is a real message — "what is this"
    // is implied by the act of attaching something — so the guard is on both
    // being empty rather than on the text alone.
    const files = context.filter((item) => item.kind === 'file');
    if ((!message && files.length === 0) || reply) return;

    const carried = context;
    setDraft('');
    // Files are consumed by the send; a page or a selection is not, because the
    // next question is usually about the same page and re-picking it every time
    // would be the app forgetting what you just told it.
    setContext((current) => current.filter((item) => item.kind !== 'file'));
    // A send after a rewind is a fork: the turn carries the rewound-to prompt
    // along so the server re-wordings it rather than appending after it.
    const rewound = rewoundRef.current;
    rewoundRef.current = null;
    void run(
      message,
      carried,
      messages,
      rewound
        ? {
            rewind: {
              at: rewound.at,
              priorVariants:
                rewound.prior.variants && rewound.prior.variants.length > 0
                  ? rewound.prior.variants
                  : [{ text: rewound.prior.text, at: rewound.prior.at }],
            },
          }
        : undefined,
    );
  }, [draft, context, reply, run, messages]);

  /**
   * Start a new conversation from a project's embedded composer.
   *
   * Sets the project association before the send so `run()` attaches the
   * project's material automatically, then closes the sidebar so the
   * conversation is what the person sees.
   */
  const startProjectChat = useCallback(
    async (projectName: string, message: string, carried: ContextItem[]) => {
      startNew();
      chatProjectRef.current = projectName;
      setSidebarOpen(false);
      void run(message, carried, []);
    },
    [startNew, run],
  );

  /**
   * Going back to before a message: puts your words back in the composer and
   * drops everything after them from view. The stored conversation is not
   * touched — nothing has been sent yet — and the turn itself is remembered
   * so the next send forks from it: the new wording replaces it, and what
   * came after it is neither sent nor shown again (except by switching back
   * to the earlier wording, which restores its conversation).
   */
  const rewindTo = useCallback(
    (index: number) => {
      const turn = messages[index];
      if (turn?.role !== 'user' || reply) return;
      // A variant switch in flight for this turn would otherwise land after
      // this truncates the view and silently restore the pre-rewind
      // transcript out from under it — the same stale-response race
      // `switchVariant` itself guards against, from the other direction.
      switchSeq.current++;
      setMessages(messages.slice(0, index));
      setDraft(stripAttachmentLine(turn.text));
      // The turn leaves the view with the rewind, but the send that follows
      // needs it: which stored prompt the new wording forks from, and the
      // old wordings it must survive as.
      rewoundRef.current = { at: index, prior: turn };
    },
    [messages, reply],
  );

  /** The user turn that produced an assistant turn, for regenerate. */
  const askFor = (index: number): number => {
    for (let i = index - 1; i >= 0; i--) if (messages[i].role === 'user') return i;
    return -1;
  };

  /**
   * "Try again": the same question, a fresh answer.
   *
   * Drops the old reply from the transcript the same way `rewindTo` drops a
   * rewound one — everything from `assistantIndex` on is gone from view — but
   * the question itself is never re-typed or re-sent as a new user turn: it's
   * already the last thing left in `history`, and the server re-reads it from
   * storage via `fork.regenerate.at`. The old reply travels along as the first
   * entry of `priorVariants` rather than being lost, so there's something to
   * switch back to once the new one lands — and what it *said* is kept by the
   * server too, as the branch a switch back restores. Regenerating rewrites
   * the future, which also makes any pending rewind moot.
   */
  const regenerateFrom = useCallback(
    (assistantIndex: number, modeIdOverride?: string) => {
      const old = messages[assistantIndex];
      if (reply || old?.role !== 'assistant') return;
      let userIndex = -1;
      for (let i = assistantIndex - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          userIndex = i;
          break;
        }
      }
      if (userIndex < 0) return;

      const priorVariants: AssistantVariant[] =
        old.variants ?? [
          {
            text: old.text,
            tools: old.tools,
            presented: old.presented,
            thinking: old.thinking,
            thinkingMs: old.thinkingMs,
            segments: old.segments,
            modeId: old.modeId,
            providerId: old.providerId,
            model: old.model,
            usage: old.usage,
            at: old.at,
          },
        ];
      const history = messages.slice(0, assistantIndex);
      // Same reasoning as `rewindTo`: a `switchVariant` response still in
      // flight for this chat must not be allowed to land after this and
      // overwrite the freshly-truncated history with the server's older
      // snapshot.
      switchSeq.current++;
      setMessages(history);
      rewoundRef.current = null;
      void run(null, context, history, { regenerate: { at: assistantIndex, priorVariants } }, modeIdOverride);
    },
    [messages, reply, run, context],
  );

  /**
   * Switches which of a forked turn's stored wordings is showing — the arrow
   * keys and the ‹ n/m › control both land here. For a regenerated reply that
   * only swaps the one message; for a rewound-to prompt, or a reply with a
   * future behind it, the whole branch follows: the server moves the current
   * continuation onto the wording it is leaving and restores the other
   * wording's, and its response becomes the transcript.
   */
  const switchVariant = useCallback(
    (index: number, delta: number) => {
      const message = messages[index];
      if (!message?.variants || message.variants.length < 2 || reply) return;
      const current = message.activeVariant ?? 0;
      const next = Math.min(Math.max(current + delta, 0), message.variants.length - 1);
      if (next === current) return;

      const variant = message.variants[next];
      const seq = ++switchSeq.current;
      // A switch rewrites the tail of the stored chat — the fork's `rewindTo`
      // index could point at a different message afterwards, so a pending
      // rewind dies with the view change; the draft stays, and the send
      // becomes a plain append.
      rewoundRef.current = null;
      // Optimistic swap of the one message so the turn feels immediate; the
      // branch it restores lives server-side, so the response replaces the
      // whole transcript with the authoritative one. The seq guard keeps a
      // rapid double-click from being undone by the first response landing
      // after the second.
      setMessages((existing) =>
        existing.map((entry, i) => (i === index ? { ...entry, ...variant, activeVariant: next, segments: undefined } : entry)),
      );
      if (chatId) {
        sparkApi
          .setVariant(chatId, index, next)
          .then((chat) => {
            if (seq !== switchSeq.current || chatIdRef.current !== chat.id) return;
            setMessages(chat.messages);
          })
          .catch((err) => {
            // The optimistic swap above already shows the chosen wording, so
            // this is only telling them it may not survive a reload — worth a
            // toast, not worth undoing what's on screen.
            toast(
              `Which reply is showing may not have saved${err instanceof Error ? `: ${err.message}` : ''}.`,
              'error',
            );
          });
      }
    },
    [messages, chatId, reply, toast],
  );

  /**
   * The approval id currently in flight to the server, so the buttons can be
   * disabled against a double-click and re-enabled if the request fails.
   */
  const [pendingApproval, setPendingApproval] = useState<string | null>(null);

  const answer = useCallback(
    (id: string, decision: 'once' | 'always' | 'deny') => {
      // The approval only clears once the server actually confirms the
      // decision landed. Clearing it optimistically, before that, meant a
      // dropped POST left the run parked server-side forever with nothing
      // on screen to say why — the approval UI had already vanished as if
      // it had been handled.
      setPendingApproval(id);
      sparkApi
        .approve(id, decision)
        .then(() => {
          setPendingApproval((current) => (current === id ? null : current));
          setReply((current) => (current?.approval?.id === id ? { ...current, approval: null } : current));
        })
        .catch((err) => {
          setPendingApproval((current) => (current === id ? null : current));
          toast(
            `Could not send that answer${err instanceof Error ? `: ${err.message}` : ''}. Try again.`,
            'error',
          );
        });
    },
    [toast],
  );

  /**
   * Typing anywhere in the panel goes to the composer.
   *
   * The panel is a place you read, so the pointer is usually somewhere in the
   * transcript when a thought arrives, and losing the first two characters of it
   * to a scroller with focus is the small daily annoyance this removes. Only
   * plain printable keys: a shortcut, an arrow, a paste all have to keep
   * working where they were pressed.
   */
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.length !== 1) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      const box = panel.querySelector<HTMLTextAreaElement>('.spark-input');
      if (!box) return;
      box.focus();
      // Not prevented and not inserted by hand: with the box now focused the
      // keypress lands in it on its own, and inserting it here as well is how
      // you get every character twice.
    };

    panel.addEventListener('keydown', onKeyDown);
    return () => panel.removeEventListener('keydown', onKeyDown);
  }, []);

  // ⌘F belongs to the panel while the panel has focus, so finding in a
  // conversation does not open the browser's own bar over the whole app.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'f' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setFinding(true);
    };
    panel.addEventListener('keydown', onKeyDown);
    return () => panel.removeEventListener('keydown', onKeyDown);
  }, []);

  // Escape dismisses the covering sidebar — the one thing on the panel that
  // has no way out except its own header toggle.
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [sidebarOpen]);

  const overlayToggleRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  /**
   * Focus moves into the overlay when it opens — a screen reader user
   * otherwise has no signal it opened at all beyond the toggle's own
   * `aria-pressed` — and back to the toggle when it closes, whether that
   * close came from Escape, a row being picked, or the toggle itself.
   * Guarded so a fresh mount (sidebar starts closed) doesn't yank focus to
   * the toggle before anyone has opened anything.
   */
  const sidebarWasOpen = useRef(false);
  useEffect(() => {
    if (sidebarOpen) {
      sidebarWasOpen.current = true;
      overlayRef.current?.focus();
    } else if (sidebarWasOpen.current) {
      sidebarWasOpen.current = false;
      overlayToggleRef.current?.focus();
    }
  }, [sidebarOpen]);

  /**
   * Arrow keys switch between a hovered — or keyboard-focused — turn's
   * wordings.
   *
   * `hoveredTurn` despite the name is set by both the pointer and by focus
   * landing anywhere inside a `.spark-turn` (its `onFocus`/`onBlur`), so a
   * keyboard user tabbing to a turn's own Copy/switcher buttons gets the same
   * arrow-key switching a mouse user gets by hovering — before this, the
   * ‹›buttons were themselves reachable by tab but the keys that mirror them
   * were not. Scoped this way rather than bound globally — `ArrowLeft`/
   * `ArrowRight` aren't `Command`-declared keys, so this doesn't collide with
   * the app-wide dispatcher that only owns those. Guarded against a focused
   * text field so the same keys keep moving the caret while typing in the
   * composer or editing a note beside it — and against a turn in flight,
   * because switching mid-stream would fight the streaming transcript's own
   * message list.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (hoveredTurn === null || reply) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]') || target?.closest('.cm-content')) return;
      const message = messages[hoveredTurn];
      if (!message?.variants || message.variants.length < 2) return;
      event.preventDefault();
      switchVariant(hoveredTurn, event.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hoveredTurn, messages, switchVariant, reply]);

  const empty = messages.length === 0 && !reply;

  /**
   * How close this conversation is to the answering profile's context
   * window — the same characters-per-4 estimate the live "Thinking · N
   * tokens" label already uses, over the whole transcript rather than one
   * segment. `contextWindow` is best-effort (`pricing.ts`) and often
   * absent, in which case this is simply never shown — a number nobody
   * asked for is worse than no number.
   */
  const contextUsage = useMemo(() => {
    const activeMode = settings?.modes.find((mode) => mode.id === preferences.sparkModeId) ?? settings?.modes[0];
    const activeProfile = activeMode?.providerId
      ? profiles.find((profile) => profile.id === activeMode.providerId)
      : (profiles.find((profile) => profile.isDefault) ?? profiles[0]);
    const contextWindow = activeProfile?.contextWindow;
    if (!contextWindow) return null;

    let chars = 0;
    for (const message of messages) {
      chars += message.text.length + (message.thinking?.length ?? 0);
    }
    const estimatedTokens = Math.round(chars / 4);
    return { estimatedTokens, contextWindow, ratio: estimatedTokens / contextWindow };
  }, [settings, preferences.sparkModeId, profiles, messages]);

  /**
   * Whether the files currently attached already add up to more than one
   * turn can carry — mirrors `MAX_ATTACHMENT_BYTES` in `spark.ts`, which
   * otherwise only surfaces after sending, as the model explaining which
   * attachment it had to leave out.
   */
  const overAttachmentBudget = useMemo(
    () =>
      context
        .filter((item) => item.kind === 'file')
        .reduce((sum, item) => sum + (item.file?.size ?? 0), 0) > MAX_ATTACHMENT_BYTES,
    [context],
  );

  /** Shared by the popover and the persistent sidebar — same list, same row, two homes. */
  const deleteChat = useCallback(
    async (chat: ChatSummary) => {
      await sparkApi.remove(chat.id);
      if (chat.id === chatId) startNew();
      void refreshChats();
    },
    [chatId, startNew, refreshChats],
  );

  const popover = usePopover();

  /**
   * The row's right-click menu — rename, move to a project, archive, delete.
   *
   * Everything here edits the chat file's own fields, never the space:
   * renaming is a title, "moving" points the chat at a project page, archiving
   * flags it, and only delete removes the file. The project submenu nests the
   * way the composer's dials do, so the pointer stays where it was pressed.
   */
  const openRowMenu = useCallback(
    (chat: ChatSummary, event: React.MouseEvent) => {
      event.preventDefault();
      const projectEntries = projects.map(
        (name): MenuEntry => ({
          id: name,
          label: projectShortName(name),
          icon: <FolderIcon />,
          hint: chat.project === name ? 'Current project' : undefined,
          run: () => void moveToProject(chat, name),
        }),
      );
      const entries: MenuEntry[] = [
        {
          id: 'rename',
          label: 'Rename…',
          icon: <PenIcon />,
          run: () => {
            void (async () => {
              const next = await workspace.ui.prompt('Rename conversation', chat.title);
              if (next?.trim()) {
                await sparkApi.update(chat.id, { title: next.trim() });
                void refreshChats();
              }
            })();
          },
        },
        {
          id: 'project',
          label: 'Move to a project…',
          icon: <FolderIcon />,
          run: () => {
            popover.open({
              label: 'Move to a project',
              anchor: anchorPoint(event.clientX, event.clientY),
              side: 'after',
              align: 'start',
              role: 'menu',
              render: ({ close: closeSub }) => (
                <PopoverMenu
                  close={closeSub}
                  entries={[
                    ...(projectEntries.length > 0
                      ? projectEntries
                      : [
                          {
                            id: 'none',
                            label: 'No projects yet',
                            disabled: true,
                            run: () => {},
                          } satisfies MenuEntry,
                        ]),
                    { kind: 'separator', id: 'sep-project' },
                    ...(chat.project
                      ? [
                          {
                            id: 'detach',
                            label: 'Remove from its project',
                            run: () => void moveToProject(chat, null),
                          } satisfies MenuEntry,
                          { kind: 'separator', id: 'sep-detach' } satisfies MenuEntry,
                        ]
                      : []),
                    {
                      id: 'new',
                      label: 'New project…',
                      run: () => {
                        void (async () => {
                          const pageName = await createProject();
                          if (pageName) await moveToProject(chat, pageName);
                        })();
                      },
                    },
                  ]}
                />
              ),
            });
          },
        },
        {
          id: 'export',
          label: 'Export to a note',
          icon: <PageIcon />,
          run: () => void exportChatToNote(chat),
        },
        { kind: 'separator', id: 'sep-1' },
        {
          id: 'archive',
          label: chat.archived ? 'Unarchive' : 'Archive',
          icon: <ArchiveIcon />,
          run: () => {
            void sparkApi.update(chat.id, { archived: !chat.archived }).then(() => refreshChats());
          },
        },
        { kind: 'separator', id: 'sep-2' },
        {
          id: 'delete',
          label: 'Delete conversation',
          icon: <TrashIcon />,
          danger: true,
          run: () => void deleteChat(chat),
        },
      ];

      const pointer = anchorPoint(event.clientX, event.clientY);
      popover.open({
        label: chat.title,
        anchor: pointer,
        side: 'below',
        align: 'start',
        role: 'menu',
        render: ({ close }) => <PopoverMenu close={close} entries={entries} />,
      });
    },
    [popover, projects, moveToProject, createProject, deleteChat, refreshChats, workspace, exportChatToNote],
  );

  /** The composer's "Attach text as a note": saved under `Spark/projects/`, then attached. */
  const attachText = useCallback(
    async (title: string, text: string) => {
      const name = await createTextNote(title, text);
      if (name) await attachPage(name);
    },
    [createTextNote, attachPage],
  );

  /**
   * The header is the handle.
   *
   * Every other lone tile gets a grip icon in a corner overlay you have to
   * find by hovering — the right answer for a bare editor, which has no
   * header of its own to carry one. Spark already has a header, so a second,
   * harder-to-discover handle beside it was one affordance too many; see
   * `TileActions` in `Workbench.tsx`, which now leaves Spark out of the grip
   * it draws for everyone else. A press on a button still has to reach that
   * button rather than start a drag, which is what the `closest('button')`
   * guard is for. A windowed Spark is moved by its window bar instead — the
   * same rule every other windowed view follows — so the header only drags
   * from a rail or a tile, where it is the only handle there is.
   */
  const beginHeaderDrag = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0 || classic || !instanceId) return;
      if (sidebarOpen) return;
      if (locate(layout, instanceId)?.surface === 'window') return;
      if ((event.target as HTMLElement).closest('button')) return;
      const box = event.currentTarget.getBoundingClientRect();
      startDrag(
        event,
        { kind: 'view', instanceId },
        {
          threshold: DRAG_THRESHOLD,
          label: 'Spark',
          offset: { x: event.clientX - box.left, y: event.clientY - box.top },
        },
      );
    },
    [classic, instanceId, startDrag, sidebarOpen, layout],
  );

  /**
   * The grip in the panel's top-right corner — the standard handle every other
   * view gets from `TileActions`, home-grown here because Spark draws its own
   * chrome: the workbench's corner overlay sits above the header and would
   * cover its buttons. The press is otherwise identical to the header drag's.
   * Split and close are plain buttons: they act on the view Spark already is.
   */
  const beginGripDrag = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0 || !instanceId || classic) return;
      if (locate(layout, instanceId)?.surface === 'window') return;
      const box = event.currentTarget.getBoundingClientRect();
      startDrag(
        event,
        { kind: 'view', instanceId },
        {
          threshold: DRAG_THRESHOLD,
          label: 'Spark',
          offset: { x: event.clientX - box.left, y: event.clientY - box.top },
        },
      );
    },
    [classic, instanceId, startDrag, layout],
  );

  /**
   * The split button. In a tile it is the ordinary split — a second copy of
   * the view beside itself, exactly what `TileActions` gives every other
   * view (the tile's own `onPointerDownCapture` has already made its group
   * the focused one by the time the click lands). In a rail there is no
   * group of its own to split against, so "Split right" means the same thing
   * the floating window's Split means for a document: leave the rail and
   * dock beside the focused group, which is the arrangement the neighbour
   * chip exists to show.
   */
  const splitSpark = useCallback(() => {
    if (classic || !instanceId) return;
    if (locate(layout, instanceId)?.surface === 'sidebar') {
      moveView(instanceId, { kind: 'split', groupId: layout.focus, side: 'right' });
    } else {
      splitFocused('right');
    }
  }, [classic, instanceId, layout, moveView, splitFocused]);

  // The header names the chat you are in: the conversation's own title, or
  // just "Spark" when nothing is open. The list can be one refresh behind a
  // brand-new chat, so a missing row falls back to the plain name rather than
  // blanking.
  const currentTitle =
    chatId === null ? 'Spark' : chats.find((chat) => chat.id === chatId)?.title ?? 'Spark';

  return (
    <div className="spark" ref={panelRef} tabIndex={-1}>
      <header className={classic ? 'spark-head spark-head-fixed' : 'spark-head'} onPointerDown={beginHeaderDrag}>
        {/*
          The sidebar toggle lives where the mark does. At rest it is the
          logo; hovering it shows the way back — the history glyph, or the
          close glyph while the sidebar is open. The logo itself is never
          replaced: the open list is a state of the panel, not a reason for
          the mark to disappear.
        */}
        <button
          ref={overlayToggleRef}
          className="spark-logo-toggle"
          aria-label={sidebarOpen ? 'Hide conversations and projects' : 'Show conversations and projects'}
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? 'Hide conversations and projects' : 'Conversations and projects'}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          <span className="spark-logo-rest">
            <SparkLogo size={16} />
          </span>
          <span className="spark-logo-hover">{sidebarOpen ? <CloseIcon /> : <HistoryIcon />}</span>
        </button>

        <span className="spark-title" title={currentTitle}>
          {currentTitle}
        </span>

        <button className="icon-button" aria-label="New conversation" title="New conversation" onClick={startNew}>
          <PlusIcon />
        </button>
      </header>

      {finding && <FindInChat scope={scrollRef} onClose={() => setFinding(false)} />}

      {/*
        The workspace is everything below the header — the transcript, the
        composer, and the covering overlay. Making the overlay position
        against *this* box is what keeps the header (with its close toggle)
        visible and on top while the overlay covers the panel's content.
      */}
      <div className="spark-workspace">
      {sidebarOpen && (
        <div
          ref={overlayRef}
          className="spark-overlay"
          data-mode={overlayMode}
          data-big={overlayMode === 'projects' || undefined}
          data-narrow={overlayFills || undefined}
          style={{ '--spark-dock': `${dockWidth}px` } as React.CSSProperties}
          tabIndex={-1}
          aria-label="Conversations and projects"
          onKeyDown={(event) => {
            // A hard Tab trap only when the overlay actually covers the
            // panel (narrow width, or the projects screen) — docked beside
            // the transcript it is an ordinary in-flow sibling, not a
            // modal, and trapping focus there would fight the rest of the
            // panel for no reason.
            if (event.key !== 'Tab' || !(overlayFills || overlayMode === 'projects')) return;
            const root = overlayRef.current;
            if (!root) return;
            const focusables = root.querySelectorAll<HTMLElement>(
              'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
            );
            if (focusables.length === 0) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }}
        >
          <div className="spark-overlay-toolbar">
            {overlayMode === 'projects' && (
              <button
                className="spark-overlay-action"
                aria-label="Back to conversations"
                title="Back to conversations"
                onClick={() => setOverlayMode('chats')}
              >
                <ChevronLeftIcon />
              </button>
            )}
            <span className="spark-overlay-toolbar-spacer" />
            {!overlayFills && (
              <button
                className="icon-button spark-overlay-pin"
                aria-pressed={preferences.sparkOverlayPinned}
                aria-label={
                  preferences.sparkOverlayPinned
                    ? 'Unpin the list so opening a chat closes it'
                    : 'Pin the list so it stays open when a chat opens'
                }
                title={
                  preferences.sparkOverlayPinned
                    ? 'Pinned — the list stays open when a chat opens'
                    : 'Not pinned — opening a chat closes the list'
                }
                onClick={() =>
                  setPreferences({ sparkOverlayPinned: !preferences.sparkOverlayPinned })
                }
              >
                {preferences.sparkOverlayPinned ? <PinOffIcon /> : <PinIcon />}
              </button>
            )}
          </div>

          {overlayMode === 'chats' ? (
            <div className="spark-overlay-chats">
              <div className="spark-overlay-list-actions">
                <button className="spark-list-action" onClick={() => { startNew(); setSidebarOpen(false); }}>
                  <PlusIcon />
                  New conversation
                </button>
                <button className="spark-list-action" onClick={openProjects}>
                  <FolderIcon />
                  Projects
                </button>
              </div>
              <div className="spark-overlay-search">
                <HistorySearch query={chatQuery} onQuery={setChatQuery} />
                <button
                  className="icon-button"
                  aria-pressed={showArchived}
                  aria-label={showArchived ? 'Showing archived conversations' : 'Show archived conversations'}
                  title="Archived conversations"
                  onClick={() => setShowArchived((value) => !value)}
                >
                  <ArchiveIcon />
                </button>
              </div>
              <div className="spark-overlay-sort">
                <span className="spark-overlay-sort-label">Sort</span>
                <div className="segmented">
                  <button
                    className="segment"
                    aria-pressed={chatSort === 'recent'}
                    onClick={() => {
                      setChatSort('recent');
                      setPreferences({ sparkChatSort: 'recent' });
                    }}
                  >
                    Recent
                  </button>
                  <button
                    className="segment"
                    aria-pressed={chatSort === 'alpha'}
                    onClick={() => {
                      setChatSort('alpha');
                      setPreferences({ sparkChatSort: 'alpha' });
                    }}
                  >
                    A–Z
                  </button>
                  <button
                    className="segment"
                    aria-pressed={chatSort === 'project'}
                    onClick={() => {
                      setChatSort('project');
                      setPreferences({ sparkChatSort: 'project' });
                    }}
                  >
                    By project
                  </button>
                  <button
                    className="segment"
                    aria-pressed={chatSort === 'date'}
                    onClick={() => {
                      setChatSort('date');
                      setPreferences({ sparkChatSort: 'date' });
                    }}
                  >
                    By date
                  </button>
                </div>
              </div>
              <div className="spark-overlay-rows">
                <HistoryRows
                  chats={chats}
                  sort={chatSort}
                  current={chatId}
                  query={chatQuery}
                  onOpen={openChatFromOverlay}
                  onRowMenu={openRowMenu}
                />
              </div>
            </div>
          ) : (
            <ProjectsTab
              projects={projects}
              descriptions={projectDescriptions}
              selected={selectedProject}
              onSelect={setSelectedProject}
              onCreate={createProject}
              onDelete={deleteProject}
              onSave={saveProject}
              onAttach={attachProjectMaterial}
              onAddText={createTextNote}
              pages={pages}
              chats={chats}
              onOpenChat={openChatFromOverlay}
              overlayFills={overlayFills}
              onStartChat={startProjectChat}
              settings={settings}
              preferences={preferences}
              setPreferences={setPreferences}
              webSearchReady={settings?.webSearchReady ?? false}
              commands={commands}
            />
          )}

          {!overlayFills && overlayMode === 'chats' && (
            <div className="spark-overlay-resize" onPointerDown={startDockResize} />
          )}
        </div>
      )}

      <div className="spark-chat">
        <div className="spark-body">
        <div className="spark-scroll" ref={scrollRef}>
          {empty ? (
            <Welcome
              enabled={config.ai}
              name={settings?.userName ?? ''}
              openThreads={openThreads}
              onThreads={() => openPage('Memory')}
            />
          ) : null}

          {messages.map((message, index) =>
            message.role === 'user' ? (
              <div
                className="spark-turn"
                data-role="user"
                key={index}
                onMouseEnter={() => setHoveredTurn(index)}
                onMouseLeave={() => setHoveredTurn((current) => (current === index ? null : current))}
                onFocus={() => setHoveredTurn(index)}
                onBlur={(event) => {
                  // Moving focus between two buttons inside the same turn
                  // (Copy to the ‹›switcher, say) must not read as leaving
                  // it — only a blur that actually lands outside does.
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setHoveredTurn((current) => (current === index ? null : current));
                  }
                }}
              >
                <div className="spark-bubble">{message.text}</div>
                <TurnActions
                  onCopy={() => copy(message.text, toast)}
                  onRewind={reply ? undefined : () => rewindTo(index)}
                  variantNoun="prompt"
                  variantCount={message.variants?.length}
                  activeVariant={message.activeVariant}
                  onPrevVariant={() => switchVariant(index, -1)}
                  onNextVariant={() => switchVariant(index, 1)}
                />
              </div>
            ) : (
              <div
                className="spark-turn"
                data-role="assistant"
                key={index}
                onMouseEnter={() => setHoveredTurn(index)}
                onMouseLeave={() => setHoveredTurn((current) => (current === index ? null : current))}
                onFocus={() => setHoveredTurn(index)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setHoveredTurn((current) => (current === index ? null : current));
                  }
                }}
              >
                {segmentsOf(message).map((segment, segIndex) => {
                  if (segment.kind === 'thinking') {
                    return (
                      preferences.sparkShowThinking && (
                        <Thinking
                          key={segIndex}
                          text={segment.text}
                          live={false}
                          elapsedMs={segment.elapsedMs}
                        />
                      )
                    );
                  }
                  if (segment.kind === 'tools') {
                    return (
                      preferences.sparkShowActions && (
                        <ToolTrail key={segIndex} tools={segment.tools} onOpen={openPage} onOpenCitation={openCitation} />
                      )
                    );
                  }
                  return (
                    <div className="spark-prose" key={segIndex}>
                      {renderMarkdown(segment.text)}
                    </div>
                  );
                })}
                <PresentedFiles pages={message.presented} onOpen={openPresented} />
                <TurnActions
                  onCopy={() => copy(message.text, toast)}
                  onRegenerate={reply || askFor(index) < 0 ? undefined : () => regenerateFrom(index)}
                  onRegenerateWith={
                    reply || askFor(index) < 0 ? undefined : (modeId) => regenerateFrom(index, modeId)
                  }
                  modes={settings?.modes}
                  variantCount={message.variants?.length}
                  activeVariant={message.activeVariant}
                  onPrevVariant={() => switchVariant(index, -1)}
                  onNextVariant={() => switchVariant(index, 1)}
                  usage={message.usage}
                  model={message.model}
                />
              </div>
            ),
          )}

          {reply && (
            <div className="spark-turn" data-role="assistant">
              {reply.segments.map((segment, segIndex) => {
                // Only the segment still being appended to is "live" — earlier
                // ones already gave way to a tool call or to the next round of
                // reasoning, so they render as finished, collapsed thoughts even
                // though the turn as a whole is still going.
                const last = segIndex === reply.segments.length - 1;
                if (segment.kind === 'thinking') {
                  return (
                    preferences.sparkShowThinking && (
                      <Thinking
                        key={segIndex}
                        text={segment.text}
                        live={last}
                        elapsedMs={segment.elapsedMs}
                      />
                    )
                  );
                }
                if (segment.kind === 'tools') {
                  return (
                    preferences.sparkShowActions && (
                      <ToolTrail key={segIndex} tools={segment.tools} onOpen={openPage} onOpenCitation={openCitation} />
                    )
                  );
                }
                return (
                  <div className="spark-prose" key={segIndex}>
                    {renderMarkdown(segment.text)}
                    {last && <span className="spark-cursor" aria-label="Spark is writing" />}
                  </div>
                );
              })}

              {reply.approval && (
                <Approval
                  name={reply.approval.name}
                  input={reply.approval.input}
                  sending={pendingApproval === reply.approval.id}
                  onAnswer={(decision) => answer(reply.approval!.id, decision)}
                />
              )}

              {/* Between sending and the first token there is nothing to show,
                  and an empty column reads as a hang. This is the only place the
                  app admits to waiting. */}
              {reply.segments.length === 0 && !reply.approval && (
                <p className="spark-thinking" role="status">
                  Thinking
                  <span className="spark-dots" aria-hidden="true" />
                </p>
              )}
              <PresentedFiles pages={reply.presented} onOpen={openPresented} />
            </div>
          )}

          {/* What consolidation did, under the reply rather than inside it: it is
              Spark's own housekeeping, not part of the answer, and putting it in
              the prose would make every fourth reply end in a status line. */}
          {memoryNote && (
            <button className="spark-memory-note" onClick={() => openPage('Memory')}>
              <MemoryIcon />
              {memoryNote}
            </button>
          )}

          {error && (
            <div className="spark-error" role="alert">
              {error}
            </div>
          )}

          {contextUsage && contextUsage.ratio >= 0.75 && (
            <div className="spark-context-warning" role="status" data-urgent={contextUsage.ratio >= 0.9 || undefined}>
              <span>
                {contextUsage.ratio >= 0.9
                  ? 'This conversation is nearly at the model’s context limit — replies may start losing earlier context.'
                  : 'This conversation is getting long for the model in use.'}
              </span>
              <button className="button" data-variant="ghost" onClick={startNew}>
                Continue in a new chat
              </button>
            </div>
          )}
        </div>
      </div>

      <SparkComposer
        draft={draft}
        onDraft={setDraft}
        onSend={send}
        onStop={() => (chatId !== null ? findRun(chatId) : findOwnDraftRun())?.controller.abort()}
        busy={Boolean(reply)}
        enabled={config.ai}
        context={context}
        onRemoveContext={(item) =>
          setContext((current) => current.filter((entry) => entry !== item))
        }
        onToggleContextHidden={(item) =>
          setContext((current) =>
            current.map((entry) => (entry === item ? { ...entry, hidden: !entry.hidden } : entry)),
          )
        }
        onAttachFiles={(files) => void attachFiles(files)}
        onAttachPage={(name) => void attachPage(name)}
        onAttachText={attachText}
        onAttachProject={(name) => void attachProjectMaterial(name)}
        projects={projects}
        uploads={uploads}
        overAttachmentBudget={overAttachmentBudget}
        pages={pages}
        settings={settings}
        preferences={preferences}
        setPreferences={setPreferences}
        webSearchReady={settings?.webSearchReady ?? false}
        commands={commands}
      />
        {/*
          The window controls — the grip, split, float and close every other
          view gets from the workbench's corner overlay. Spark draws its own
          header, so the overlay would cover it; the same controls live here
          instead, in the main chat area below the header, drawn on top of
          the transcript's corner. The grip and the header drag are the same
          gesture with two handles — exactly as a tab and a tile grip are.
        */}
        {!classic && instanceId && locate(layout, instanceId)?.surface !== 'window' && (
          <div className="spark-window-controls">
            <button
              className="icon-button"
              title="Split right"
              aria-label="Split right"
              onClick={splitSpark}
            >
              <SplitIcon />
            </button>
            <button
              className="icon-button"
              title="Float as window"
              aria-label="Float as window"
              onClick={() =>
                moveView(instanceId, {
                  kind: 'window',
                  rect: {
                    x: Math.max(24, window.innerWidth / 2 - 340),
                    y: 90,
                    width: 680,
                    height: 560,
                  },
                })
              }
            >
              <FloatIcon />
            </button>
            <button
              className="icon-button"
              title={`Close ${currentTitle}`}
              aria-label={`Close ${currentTitle}`}
              onClick={() => closeView(instanceId)}
            >
              <CloseIcon />
            </button>
            <button
              className="icon-button tile-grip"
              title="Move Spark"
              aria-label="Move Spark"
              onPointerDown={beginGripDrag}
            >
              <GripIcon />
            </button>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

/**
 * One stretch of the same kind of thing, in the order it happened.
 *
 * A turn is thinking, then the calls that thinking led to, then — often —
 * more thinking about what came back, then more calls, and so on, ending in
 * an answer. Keeping that as an ordered list rather than as one flat
 * `thinking` string and one flat `tools` array is what lets the transcript
 * show a round of reasoning, the tool calls it made, and the next round of
 * reasoning as three things in the order they occurred, instead of every
 * thought in one box up top and every tool call in a list below all of it.
 */
export type Segment =
  | {
      kind: 'thinking';
      text: string;
      /**
       * `Date.now()` when this segment started — a wall-clock moment, never
       * sent anywhere. Optional because a segment reloaded from the server
       * (`ChatSegment`, `lib/spark-client.ts`) has no use for it: it is
       * already finished and already carries its final `elapsedMs`, so
       * nothing ever needs to compute a duration from it — see
       * `closeThinking`, the only place this field is read.
       */
      startedAt?: number;
      /**
       * Set once, the instant this stops being the segment still growing —
       * a tool call starts, the answer starts, or the turn ends. Lives on
       * the segment itself rather than in the component that renders it,
       * because that component is thrown away and rebuilt the moment the
       * reply finishes streaming and lands in `messages` — a duration held
       * only in a ref there would vanish along with it, which is exactly why
       * "Thought for Xs" was reverting to "Thought about it" the instant a
       * turn completed.
       */
      elapsedMs?: number;
    }
  | { kind: 'tools'; tools: ChatToolCall[] }
  | { kind: 'text'; text: string };

/** A stored message, plus the ordered segments a message from *this* session was built from. */
type DisplayMessage = ChatMessage & { segments?: Segment[] };

/**
 * Segments for a message however it arrived.
 *
 * A message built this session already carries them in order, tool calls
 * interleaved with the text around them. One reloaded from the server, or one
 * switched to from a different regenerated variant, has only the flat
 * `thinking`/`tools`/`text` fields, so the best this can do is
 * thinking-then-tools-then-text, which is also exactly what the old
 * rendering showed before thinking was persisted at all — the one thing this
 * fallback *can* now know that it couldn't before is how long that thinking
 * took, carried on `thinkingMs`.
 */
function segmentsOf(message: DisplayMessage): Segment[] {
  if (message.segments) return message.segments;
  const segments: Segment[] = [];
  if (message.thinking) {
    segments.push({ kind: 'thinking', text: message.thinking, startedAt: 0, elapsedMs: message.thinkingMs });
  }
  if (message.tools && message.tools.length > 0) segments.push({ kind: 'tools', tools: message.tools });
  if (message.text) segments.push({ kind: 'text', text: message.text });
  return segments;
}

/** Closes out the segment still growing, the instant something else starts happening. */
function closeThinking(segments: Segment[]): void {
  const last = segments[segments.length - 1];
  // `startedAt` is only ever missing on a segment that arrived already
  // closed (reloaded from the server), which by definition already has
  // `elapsedMs` set — so this fallback never actually fires, it just keeps
  // the arithmetic below total instead of needing a second guard.
  if (last?.kind === 'thinking' && last.elapsedMs === undefined) {
    last.elapsedMs = Date.now() - (last.startedAt ?? Date.now());
  }
}

interface Reply {
  text: string;
  segments: Segment[];
  /** The tool call currently waiting for a yes, if any. */
  approval: { id: string; name: string; input: Record<string, unknown> } | null;
  /** Pages presented so far this turn — see `PresentedFiles`. */
  presented: string[];
}

/**
 * One turn in flight.
 *
 * Lives in a registry rather than in component state because a turn outlives
 * the moment that started it: the person can switch to another conversation —
 * or start another one — while this one keeps streaming. The entry holds
 * everything the turn accumulated (the same local variables it used to hold),
 * plus `chatId` — `null` until the server confirms the chat it created, and
 * `base`, the transcript it started from, which is what a chat re-loaded
 * mid-run shows instead of a fetch that might disagree with the turn's own
 * accounting. See **Spark → Conversations** in `AGENTS.md`.
 */
interface ActiveRun {
  id: number;
  /** The chat this turn belongs to; `null` until the server confirms one. */
  chatId: string | null;
  /**
   * Which blank-composer visit this run belongs to, set only while `chatId`
   * is still `null`. Two different visits to the blank composer can each
   * have their own send in flight at once, and `chatId: null` alone can't
   * tell them apart — see `draftIdRef` in the component above.
   */
  draftId: string | null;
  controller: AbortController;
  /** The transcript the turn started from — the run's own view of its chat. */
  base: DisplayMessage[];
  /** The accumulator, so the entry and the live reply never disagree. */
  text: string;
  segments: Segment[];
  approval: Reply['approval'];
  presented: string[];
  /** Set once the `usage` event lands, right before the turn ends. */
  usage?: ChatUsage;
  providerId?: string;
  model?: string;
  /** Tool call id to the segment and index holding it, so a result can find its way back. */
  pendingTools: Map<string, { segment: Extract<Segment, { kind: 'tools' }>; index: number }>;
  /** The snapshot `show()` writes — what `load`/`startNew` pick up on return. */
  reply: Reply;
}

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

/**
 * What the model thought on the way to the answer.
 *
 * Collapsed by default once the answer has arrived, and open while it is still
 * the only thing happening — which is the honest ordering: mid-turn it is the
 * most interesting thing on screen, and afterwards it is a footnote to a reply
 * you can read instead.
 *
 * Set in the faint colour at the tool trail's size rather than as prose. It is
 * not addressed to you, and typography is how that gets said without a label.
 *
 * The label carries a number while it streams and a duration once it stops.
 * Both come in as props — `elapsedMs` off the segment itself, set once by
 * `closeThinking()` the instant this stops being the live one — rather than
 * being timed by this component, because this component does not live as
 * long as the thing it would be timing: the ephemeral copy under the live
 * reply unmounts the moment the turn finishes, and a fresh instance mounts
 * for the same segment now sitting in `messages`. A duration held in a ref
 * here would vanish with the old instance; carried on the segment, the new
 * one just reads it. A message read back from history carries its own
 * `thinkingMs` (see `segmentsOf`) and shows the same duration it did live; a
 * message from before that was persisted, or one switched to a variant that
 * genuinely never recorded one, falls back to the plain "Thought about it".
 */
function Thinking({
  text,
  live,
  elapsedMs,
}: {
  text: string;
  live: boolean;
  elapsedMs?: number;
}) {
  const [open, setOpen] = useState(live);
  const tail = useRef<HTMLDivElement>(null);

  // Follows itself while it streams, so the newest line is the one you see.
  useEffect(() => {
    if (live && open) tail.current?.scrollTo({ top: tail.current.scrollHeight });
  }, [text, live, open]);

  // Collapses itself the moment it stops being the live thing on screen —
  // because a tool call started, or because the answer did. Only on that
  // transition: a block a person reopened by hand while reading back over a
  // finished turn is not re-collapsed by anything after that.
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);

  // A real token count would mean asking the provider for one mid-stream,
  // which extended thinking doesn't hand over as it goes — this is the same
  // characters-per-token estimate every "about N tokens" readout in the
  // industry uses, honest enough to watch climb without claiming precision
  // it doesn't have.
  const tokens = Math.max(1, Math.round(text.length / 4));

  return (
    <div className="spark-think" data-live={live || undefined} data-open={open || undefined}>
      <button
        className="spark-think-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ShowIcon />
        <span>
          {live
            ? `Thinking · ${tokens} token${tokens === 1 ? '' : 's'}`
            : elapsedMs !== undefined
              ? `Thought for ${formatDuration(elapsedMs)}`
              : 'Thought about it'}
        </span>
      </button>
      {open && (
        <div className="spark-think-body" ref={tail}>
          {text}
          {live && <span className="spark-cursor" aria-hidden="true" />}
        </div>
      )}
    </div>
  );
}

/**
 * What Spark did while it was answering, in the order it did it.
 *
 * Every page a call touched is a link, because the commonest thing to want after
 * reading "Edited 'Improvements'" is to look at Improvements. The names come from
 * the server as a list rather than being parsed back out of the summary — the
 * summary is prose for a person, and a regular expression over its quoted
 * fragments would find page names in some tools and section headings in others.
 */
/**
 * Below this, a tool's own `detail` — `read_page`'s full text, `run_code`'s
 * stdout — is worth a expand toggle. Under it, `detail` is already close
 * enough to redundant with the one-line `summary` sitting next to it, so an
 * expand affordance that reveals almost nothing is worse than none at all.
 */
const TOOL_DETAIL_EXPAND_THRESHOLD = 80;

function ToolTrail({
  tools,
  onOpen,
  onOpenCitation,
}: {
  tools?: ChatToolCall[];
  onOpen: (page: string) => void;
  /** Resolves a citation's own kind of source — a page and line, a past chat, or a URL. */
  onOpenCitation: (citation: ChatCitation) => void;
}) {
  const idBase = useId();
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  if (!tools || tools.length === 0) return null;

  return (
    <ul className="spark-tools">
      {tools.map((tool, index) => {
        const { parts, linked } = linkifySummary(tool.summary, tool.pages, onOpen);
        const hasCitations = Boolean(tool.citations?.length);
        const expandable =
          hasCitations ||
          (Boolean(tool.detail) && (tool.detail!.length > TOOL_DETAIL_EXPAND_THRESHOLD || tool.detail!.includes('\n')));
        const open = expandable && expanded.has(index);
        const detailId = `${idBase}-detail-${index}`;
        return (
          <li
            key={index}
            data-ok={tool.ok}
            data-pending={tool.summary.endsWith('…') || undefined}
            data-awaiting={tool.awaiting || undefined}
          >
            <div className="spark-tool-row">
              {tool.ok ? null : <CloseIcon />}
              <span>{parts}</span>
              {tool.pages
                ?.filter((page) => !linked.has(page))
                .map((page) => (
                  <button
                    key={page}
                    className="spark-tool-link"
                    title={`Open ${page}`}
                    onClick={() => onOpen(page)}
                  >
                    {page}
                  </button>
                ))}
              {expandable && (
                <button
                  type="button"
                  className="spark-tool-expand"
                  aria-expanded={open}
                  aria-controls={detailId}
                  onClick={() =>
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(index)) next.delete(index);
                      else next.add(index);
                      return next;
                    })
                  }
                >
                  {open ? 'Hide' : 'Show'}
                </button>
              )}
            </div>
            {open && (
              <div id={detailId}>
                {hasCitations && (
                  <ul className="spark-tool-citations">
                    {tool.citations!.map((citation, ci) => (
                      <li key={ci}>
                        <button
                          type="button"
                          className="spark-tool-link"
                          title={
                            citation.url
                              ? citation.url
                              : citation.chatId
                                ? 'Open this conversation'
                                : `Open ${citation.page}`
                          }
                          onClick={() => onOpenCitation(citation)}
                        >
                          {citation.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {tool.detail && <pre className="spark-tool-detail">{tool.detail}</pre>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Turns the page name inside a tool's summary into the same clickable link
 * shown beside it — "Read journal/2026-07-27" becomes prose where
 * "journal/2026-07-27" is the link — instead of showing the name twice, once
 * inert in the prose and once as a pill beside it. Falls back to the pill (in
 * `ToolTrail`, for any page not returned here as `linked`) for a page that
 * isn't a literal substring of the summary, which the server does not
 * guarantee for every tool — the names come from `pages`, not by parsing the
 * summary, and a regular expression over its quoted fragments would find page
 * names in some tools and section headings in others.
 */
function linkifySummary(
  summary: string,
  pages: string[] | undefined,
  onOpen: (page: string) => void,
): { parts: ReactNode[]; linked: Set<string> } {
  const linked = new Set<string>();
  if (!pages || pages.length === 0) return { parts: [summary], linked };

  // Longest first, so a page name that is a substring of another candidate
  // isn't matched partially.
  const candidates = [...pages].sort((a, b) => b.length - a.length);

  const nodes: ReactNode[] = [];
  let rest = summary;
  let key = 0;

  while (rest.length > 0) {
    let earliest: { index: number; page: string } | null = null;
    for (const page of candidates) {
      const index = rest.indexOf(page);
      if (index !== -1 && (earliest === null || index < earliest.index)) earliest = { index, page };
    }
    if (!earliest) break;

    if (earliest.index > 0) nodes.push(rest.slice(0, earliest.index));
    const page = earliest.page;
    nodes.push(
      <button key={key++} className="spark-tool-link" title={`Open ${page}`} onClick={() => onOpen(page)}>
        {page}
      </button>,
    );
    linked.add(page);
    rest = rest.slice(earliest.index + page.length);
  }
  if (rest) nodes.push(rest);

  return { parts: nodes, linked };
}

/**
 * A page Spark presented this turn — shown as a card with a button to open
 * it, never opened automatically (see `SparkAction`'s doc comment in
 * `spark-tools.ts`). Rendered from `reply.presented` while the turn is still
 * streaming, so a page presented mid-turn appears mid-turn, and from
 * `message.presented` once the turn has landed in history — same list, same
 * component, whichever is live.
 */
function PresentedFiles({ pages, onOpen }: { pages?: string[]; onOpen: (page: string) => void }) {
  if (!pages || pages.length === 0) return null;

  return (
    <ul className="spark-presented">
      {pages.map((page) => (
        <li key={page} className="spark-presented-pill">
          <span className="spark-presented-name">{page}</span>
          <button className="spark-presented-open" onClick={() => onOpen(page)}>
            <ShowIcon />
            Open
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * A tool call waiting for a yes.
 *
 * "Always" exists because manual mode without it is unusable — being asked about
 * `read_page` eight times in one answer is how a safety feature becomes a thing
 * people switch off. It lasts for this conversation only; see the server's
 * `approvals.ts`.
 */
function Approval({
  name,
  input,
  sending,
  onAnswer,
}: {
  name: string;
  input: Record<string, unknown>;
  /** A decision is in flight to the server — buttons disabled against a double-send. */
  sending?: boolean;
  onAnswer: (decision: 'once' | 'always' | 'deny') => void;
}) {
  const summary = describeInput(input);
  // A turn parking on this is exactly the moment a keyboard or screen-reader
  // user's focus needs to be told where to go — it can be anywhere in the
  // composer or the transcript when the question actually arrives.
  const allowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    allowRef.current?.focus();
  }, []);

  return (
    <div className="spark-approval" role="alertdialog" aria-label={`Allow ${label(name)}?`}>
      <p className="spark-approval-what">
        <strong>{label(name)}</strong>
        {summary && <span className="spark-approval-input">{summary}</span>}
      </p>
      <div className="spark-approval-actions">
        <button
          ref={allowRef}
          className="button"
          data-variant="primary"
          disabled={sending}
          onClick={() => onAnswer('once')}
        >
          <CheckIcon />
          Allow
        </button>
        <button className="button" disabled={sending} onClick={() => onAnswer('always')}>
          Always
        </button>
        <button className="button" data-variant="ghost" disabled={sending} onClick={() => onAnswer('deny')}>
          No
        </button>
      </div>
    </div>
  );
}

/** The arguments, as one readable line. Long values are cut, never wrapped. */
function describeInput(input: Record<string, unknown>): string {
  const parts = Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}: ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`;
    });
  return parts.join(' · ').slice(0, 300);
}

/**
 * Copy, rewind, regenerate, and switch between a forked turn's wordings.
 *
 * Revealed on hover of the turn rather than always drawn: they belong to a
 * message you have decided something about, and eight rows of three buttons down
 * a transcript is a toolbar pretending to be a conversation. Copy takes the
 * *answer* and never the thinking — the thinking is not what you meant to quote.
 * The switcher is the same ‹ n/m › control on either role — a regenerated
 * reply's alternatives, or the earlier wordings of a rewound-to prompt —
 * differing only in what it calls the thing it is switching.
 */
function TurnActions({
  onCopy,
  onRewind,
  onRegenerate,
  onRegenerateWith,
  modes,
  variantNoun = 'response',
  variantCount,
  activeVariant,
  onPrevVariant,
  onNextVariant,
  usage,
  model,
}: {
  onCopy: () => void;
  onRewind?: () => void;
  onRegenerate?: () => void;
  /** "Try again with…" — regenerate against an explicitly chosen mode instead of the current one. */
  onRegenerateWith?: (modeId: string) => void;
  modes?: SparkMode[];
  /** What the switcher is switching — a reply or a prompt; decides its labels. */
  variantNoun?: 'response' | 'prompt';
  /** More than one only once a turn has been regenerated or forked at least once. */
  variantCount?: number;
  activeVariant?: number;
  onPrevVariant?: () => void;
  onNextVariant?: () => void;
  /** Tokens billed for this turn, if the server reported any — assistant turns only. */
  usage?: ChatUsage;
  model?: string;
}) {
  const hasVariants = (variantCount ?? 0) > 1;
  const active = activeVariant ?? 0;
  const popover = usePopover();
  const tryWithRef = useRef<HTMLButtonElement>(null);
  const enabledModes = (modes ?? []).filter((mode) => mode.enabled);

  const openTryWithMenu = () => {
    const entries: MenuEntry[] = enabledModes.map((mode) => ({
      id: mode.id,
      label: mode.label,
      run: () => onRegenerateWith?.(mode.id),
    }));
    popover.open({
      label: 'Try again with…',
      anchor: anchorElement(tryWithRef.current),
      side: 'above',
      align: 'start',
      role: 'menu',
      render: ({ close }) => <PopoverMenu close={close} entries={entries} />,
    });
  };

  return (
    <div className="spark-turn-actions">
      {hasVariants && (
        <div className="spark-variant-switcher">
          <button
            className="icon-button"
            aria-label={`Previous ${variantNoun}`}
            title={`Previous ${variantNoun}`}
            disabled={active === 0}
            onClick={onPrevVariant}
          >
            <ChevronLeftIcon />
          </button>
          <span>
            {active + 1}/{variantCount}
          </span>
          <button
            className="icon-button"
            aria-label={`Next ${variantNoun}`}
            title={`Next ${variantNoun}`}
            disabled={active === (variantCount ?? 1) - 1}
            onClick={onNextVariant}
          >
            <ChevronRightIcon />
          </button>
        </div>
      )}
      <button className="icon-button" aria-label="Copy" title="Copy" onClick={onCopy}>
        <CopyIcon />
      </button>
      {onRewind && (
        <button
          className="icon-button"
          aria-label="Rewind to here"
          title="Rewind — put this back in the box and drop what came after"
          onClick={onRewind}
        >
          <RewindIcon />
        </button>
      )}
      {onRegenerate && (
        <button
          className="icon-button"
          aria-label="Try again"
          title="Try again"
          onClick={onRegenerate}
        >
          <RegenerateIcon />
        </button>
      )}
      {onRegenerateWith && enabledModes.length > 1 && (
        <button
          ref={tryWithRef}
          className="icon-button"
          aria-label="Try again with…"
          title="Try again with a different mode"
          onClick={openTryWithMenu}
        >
          <ChevronDownIcon />
        </button>
      )}
      {usage && (
        <span
          className="spark-turn-usage"
          title={`${model ? `${model} · ` : ''}${usage.inputTokens.toLocaleString()} in, ${usage.outputTokens.toLocaleString()} out`}
        >
          {usage.costUsd !== undefined
            ? `$${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(2)}`
            : `${(usage.inputTokens + usage.outputTokens).toLocaleString()} tok`}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

interface HistoryListProps {
  chats: ChatSummary[];
  current: string | null;
  /** What the list is filtered by — `''` shows everything. */
  query: string;
  /** How the list is ordered — recency, title, grouped by project, or grouped by date. */
  sort: 'recent' | 'alpha' | 'project' | 'date';
  onOpen: (id: string) => void;
  /** The row's "…" button and its right-click both raise this. */
  onRowMenu: (chat: ChatSummary, event: React.MouseEvent) => void;
}

/**
 * The field that searches every conversation, not just their titles.
 *
 * A phrase you half-remember is almost never the title of the chat it was said
 * in — it is a sentence inside a reply — so the query goes to the server and
 * matches message text too. This is the *across-chats* search; finding inside
 * the open conversation is ⌘F, which has no button of its own.
 */
function HistorySearch({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const field = useRef<HTMLInputElement>(null);

  return (
    <div className="spark-history-search">
      <SearchIcon />
      <input
        ref={field}
        className="spark-history-search-input"
        value={query}
        placeholder="Search conversations"
        aria-label="Search conversations"
        onChange={(event) => onQuery(event.target.value)}
      />
      {query && (
        <button
          className="nav-search-clear"
          aria-label="Clear the search"
          title="Clear"
          onClick={() => {
            onQuery('');
            field.current?.focus();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * The day a conversation last moved, in the two shapes a past chat wears.
 *
 * Under a week old it is the day of the week — "Mon" — because that is the
 * scale a recent chat is measured in; older, it is the month and day — "Aug 3"
 * — with no year, because the year is the one part of the date that is never
 * useful here: nothing in the list is old enough to need disambiguating.
 */
function chatDate(updated: number): string {
  const date = new Date(updated);
  const ageDays = (Date.now() - updated) / 86_400_000;
  return ageDays < 7
    ? date.toLocaleDateString(undefined, { weekday: 'short' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** One row per conversation, in the covering sidebar. */
function HistoryRows({ chats, current, query, sort, onOpen, onRowMenu }: HistoryListProps) {
  if (chats.length === 0) {
    return <p className="nav-empty">{query.trim() ? 'No conversations match.' : 'No conversations yet.'}</p>;
  }
  return (
    <>
      {groupChats(chats, sort).map((group) => (
        <Fragment key={group.key}>
          {group.title && <p className="spark-history-group">{group.title}</p>}
          {group.chats.map((chat) => (
            <div
              className="spark-history-row"
              key={chat.id}
              data-current={chat.id === current || undefined}
              data-archived={chat.archived || undefined}
              // The row's verbs live on the "…" button and the right-click
              // menu — one gesture for people who found the button, one for
              // people who already know the convention.
              onContextMenu={(event) => onRowMenu(chat, event)}
            >
              <button className="spark-history-open" onClick={() => onOpen(chat.id)}>
                <span className="spark-history-line">
                  <span className="spark-history-title">{chat.title}</span>
                  <small className="spark-history-date">{chatDate(chat.updated)}</small>
                </span>
                {chat.project && (
                  <small
                    className="spark-history-project"
                    title={`Project ${projectShortName(chat.project)}`}
                  >
                    {projectShortName(chat.project)}
                  </small>
                )}
              </button>
              <button
                className="icon-button spark-history-menu"
                aria-label={`Options for ${chat.title}`}
                title="Options"
                onClick={(event) => onRowMenu(chat, event)}
              >
                <MoreIcon />
              </button>
            </div>
          ))}
        </Fragment>
      ))}
    </>
  );
}

/**
 * Chats ordered and grouped for the list. Pure, so changing the sort is a
 * re-render of what the server already sent — the search query still runs
 * there, and this only reorders its result. Within a group the server's
 * recency order is kept.
 */
function groupChats(
  chats: ChatSummary[],
  sort: HistoryListProps['sort'],
): { key: string; title?: string; chats: ChatSummary[] }[] {
  if (sort === 'alpha') {
    return [{ key: 'alpha', chats: [...chats].sort((a, b) => a.title.localeCompare(b.title)) }];
  }
  if (sort === 'project') {
    const buckets = new Map<string, ChatSummary[]>();
    const ungrouped: ChatSummary[] = [];
    for (const chat of chats) {
      const name = chat.project ? projectShortName(chat.project) : null;
      if (name === null) {
        ungrouped.push(chat);
      } else {
        let bucket = buckets.get(name);
        if (!bucket) buckets.set(name, (bucket = []));
        bucket.push(chat);
      }
    }
    const groups = [...buckets.entries()].map(([name, list]) => ({ key: name, title: name, chats: list }));
    groups.sort((a, b) => a.title!.localeCompare(b.title!));
    if (ungrouped.length) groups.push({ key: '__none__', title: 'No project', chats: ungrouped });
    return groups;
  }
  if (sort === 'date') {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 86_400_000;
    const startOfWeek = startOfToday - 7 * 86_400_000;
    const buckets = {
      today: [] as ChatSummary[],
      yesterday: [] as ChatSummary[],
      week: [] as ChatSummary[],
      older: [] as ChatSummary[],
    };
    for (const chat of chats) {
      if (chat.updated >= startOfToday) buckets.today.push(chat);
      else if (chat.updated >= startOfYesterday) buckets.yesterday.push(chat);
      else if (chat.updated >= startOfWeek) buckets.week.push(chat);
      else buckets.older.push(chat);
    }
    return [
      { key: 'today', title: 'Today', chats: buckets.today },
      { key: 'yesterday', title: 'Yesterday', chats: buckets.yesterday },
      { key: 'week', title: 'This week', chats: buckets.week },
      { key: 'older', title: 'Older', chats: buckets.older },
    ].filter((group) => group.chats.length > 0);
  }
  return [{ key: 'recent', chats }];
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** A project page, parsed into the managed sections plus anything a hand edit left outside them. */
interface ProjectDoc {
  /** A short description shown in the project card and sent to the model. */
  description: string;
  instructions: string;
  /** Pages from anywhere in the space. */
  notes: string[];
  /** Names under `files/`. */
  files: string[];
  /** Pages under `Spark/projects/` — notes attached by hand. */
  textNotes: string[];
  /** Per-project memory: facts Spark should remember about this project. */
  memory: string[];
  /** Anything outside the sections, preserved verbatim on save. */
  extra: string;
}

function emptyProjectDoc(): ProjectDoc {
  return { description: '', instructions: '', notes: [], files: [], textNotes: [], memory: [], extra: '' };
}

/**
 * The page shape: four `##` sections, each holding a bullet list of links
 * (instructions holds prose). Everything outside the sections survives a
 * rewrite — someone will write a paragraph in there, and the app must not eat
 * it — but the four sections are the app's own, replaced whole on save.
 */
function parseProjectDoc(text: string): ProjectDoc {
  const { body, data } = parseFrontmatter(text);
  const doc = emptyProjectDoc();
  // Description lives in frontmatter so it can be shown in the project card
  // without reading the whole body.
  if (typeof data.description === 'string') doc.description = data.description.trim();
  const inside: Record<'instructions' | 'notes' | 'files' | 'textNotes' | 'memory', string[]> = {
    instructions: [],
    notes: [],
    files: [],
    textNotes: [],
    memory: [],
  };
  const outside: string[] = [];
  let section: keyof typeof inside | null = null;

  for (const line of body.split('\n')) {
    const head = /^##\s+(.+)$/.exec(line);
    if (head) {
      const name = head[1].trim().toLowerCase();
      section =
        name === 'instructions'
          ? 'instructions'
          : name === 'notes'
            ? 'notes'
            : name === 'files'
              ? 'files'
              : name === 'text'
                ? 'textNotes'
                : name === 'memory'
                  ? 'memory'
                  : null;
      continue;
    }
    if (section) inside[section].push(line);
    else outside.push(line);
  }

  doc.instructions = inside.instructions.join('\n').trim();
  doc.notes = inside.notes.map(wikiTarget).filter((name): name is string => name !== null);
  doc.files = inside.files.map(linkTarget).filter((name): name is string => name !== null);
  doc.textNotes = inside.textNotes.map(wikiTarget).filter((name): name is string => name !== null);
  doc.memory = inside.memory.map((line) => line.replace(/^-\s*/, '').trim()).filter(Boolean);
  doc.extra = outside.join('\n').trim();
  return doc;
}

/** `- [[Some note]]` → `Some note`. */
function wikiTarget(line: string): string | null {
  return /\[\[([^\]]+)\]\]/.exec(line)?.[1]?.trim() ?? null;
}

/** `- [scan.png](files/scan.png)` → `files/scan.png`. */
function linkTarget(line: string): string | null {
  return /\]\(([^)]+)\)/.exec(line)?.[1]?.trim() ?? null;
}

function renderProjectDoc(title: string, doc: ProjectDoc): string {
  const frontmatter: string[] = ['---', 'type: spark-project'];
  if (doc.description) frontmatter.push(`description: ${doc.description}`);
  frontmatter.push('---');
  const parts = [
    ...frontmatter,
    '',
    `# ${title}`,
    '',
    '## Instructions',
    '',
    doc.instructions,
    '',
    '## Notes',
    '',
    ...doc.notes.map((name) => `- [[${name}]]`),
    '',
    '## Files',
    '',
    ...doc.files.map((name) => `- [${name.replace(/^files\//, '')}](${name})`),
    '',
    '## Text',
    '',
    ...doc.textNotes.map((name) => `- [[${name}]]`),
    '',
    '## Memory',
    '',
    ...doc.memory.map((line) => `- ${line}`),
  ];
  if (doc.extra) parts.push('', doc.extra);
  return `${parts.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '')}\n`;
}

/** The two lists of the sidebar: projects, then one project. */
function ProjectsTab({
  projects,
  descriptions,
  selected,
  onSelect,
  onCreate,
  onDelete,
  onSave,
  onAttach,
  onAddText,
  pages,
  chats,
  onOpenChat,
  overlayFills,
  onStartChat,
  settings,
  preferences,
  setPreferences,
  webSearchReady,
  commands,
}: {
  projects: string[];
  selected: string | null;
  onSelect: (name: string) => void;
  onCreate: () => Promise<string | null>;
  onDelete: (name: string) => Promise<void>;
  onSave: (name: string, doc: ProjectDoc) => Promise<void>;
  onAttach: (name: string, markAutomatic?: boolean) => Promise<number>;
  onAddText: (title: string, text: string) => Promise<string | null>;
  pages: PageMeta[];
  chats: ChatSummary[];
  onOpenChat: (id: string) => void;
  overlayFills: boolean;
  onStartChat: (projectName: string, message: string, carried: ContextItem[]) => Promise<void>;
  settings: SparkSettings | null;
  preferences: Preferences;
  setPreferences: (patch: Partial<Preferences>) => void;
  webSearchReady: boolean;
  commands: CommandInfo[];
  descriptions: Record<string, string>;
}) {
  const updatedAt = useMemo(() => {
    const map = new Map<string, number>();
    for (const page of pages) map.set(page.name, page.modified);
    return map;
  }, [pages]);

  if (selected) {
    return (
      <ProjectPanel
        key={selected}
        pageName={selected}
        onBack={() => onSelect('')}
        onDelete={onDelete}
        onSave={onSave}
        onAttach={onAttach}
        onAddText={onAddText}
        pages={pages}
        chats={chats}
        onOpenChat={onOpenChat}
        overlayFills={overlayFills}
        onStartChat={onStartChat}
        settings={settings}
        preferences={preferences}
        setPreferences={setPreferences}
        webSearchReady={webSearchReady}
        commands={commands}
        allProjects={projects}
      />
    );
  }

  return (
    <div className="spark-projects" data-narrow={overlayFills || undefined}>
      <button className="spark-projects-new" onClick={() => void onCreate()}>
        <PlusIcon />
        New project
      </button>
      {projects.length === 0 ? (
        <p className="nav-empty">
          Projects gather the notes, files and instructions a recurring job needs, so one click
          attaches them all to a conversation.
        </p>
      ) : (
        <ul className="spark-projects-grid" data-narrow={overlayFills || undefined}>
          {projects.map((name) => {
            const count = chats.filter((chat) => chat.project === name).length;
            const description = descriptions[name];
            const modified = updatedAt.get(name);
            return (
              <li key={name}>
                <button className="spark-project-card" onClick={() => onSelect(name)}>
                  <span className="spark-project-card-head">
                    <FolderIcon className="spark-project-card-icon" />
                    <span className="spark-project-card-name">{projectShortName(name)}</span>
                  </span>
                  {description ? (
                    <small className="spark-project-card-desc">{description}</small>
                  ) : null}
                  <span className="spark-project-card-foot">
                    <small className="spark-project-card-count">
                      {count} chat{count === 1 ? '' : 's'}
                    </small>
                    {modified !== undefined && (
                      <small className="spark-project-card-date">{chatDate(modified)}</small>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * One project: an embedded composer, past chats, and a right-side drawer
 * holding instructions, attachments, and per-project memory.
 *
 * Every change is written through to the project page — the space is the
 * store, and the panel is only ever an editor over it. The page stays
 * readable and editable in vim, and nothing here exists that the file does
 * not say. When the panel is wide enough, the instructions, attachments
 * and memory live in a right-side drawer; when narrow, they stack below
 * the composer and chats.
 */
function ProjectPanel({
  pageName,
  onBack,
  onDelete,
  onSave,
  onAttach,
  onAddText,
  pages,
  chats,
  onOpenChat,
  overlayFills,
  onStartChat,
  settings,
  preferences,
  setPreferences,
  webSearchReady,
  commands,
  allProjects,
}: {
  pageName: string;
  onBack: () => void;
  onDelete: (name: string) => Promise<void>;
  onSave: (name: string, doc: ProjectDoc) => Promise<void>;
  onAttach: (name: string, markAutomatic?: boolean) => Promise<number>;
  onAddText: (title: string, text: string) => Promise<string | null>;
  pages: Array<{ name: string }>;
  chats: ChatSummary[];
  onOpenChat: (id: string) => void;
  overlayFills: boolean;
  onStartChat: (projectName: string, message: string, carried: ContextItem[]) => Promise<void>;
  settings: SparkSettings | null;
  preferences: Preferences;
  setPreferences: (patch: Partial<Preferences>) => void;
  webSearchReady: boolean;
  commands: CommandInfo[];
  allProjects: string[];
}) {
  const { workspace, toast } = useApp();
  const popover = usePopover();
  const [doc, setDoc] = useState<ProjectDoc | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploads, setUploads] = useState<UploadHandle[]>([]);
  const [draft, setDraft] = useState('');
  const [projectContext, setProjectContext] = useState<ContextItem[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    void workspace.space
      .read(pageName)
      .then((page) => {
        if (!cancelled) setDoc(parseProjectDoc(page.text));
      })
      .catch(() => {
        if (!cancelled) setDoc(emptyProjectDoc());
      });
    return () => {
      cancelled = true;
    };
  }, [pageName, workspace]);

  if (!doc) return <p className="nav-empty">Loading…</p>;

  const save = async () => {
    setSaving(true);
    try {
      await onSave(pageName, doc);
    } finally {
      setSaving(false);
    }
  };

  const attachItem = (item: { kind: 'note' | 'file'; name: string }) => {
    if (item.kind === 'file') {
      setDoc((current) => current && { ...current, files: [...current.files, item.name] });
    } else {
      setDoc((current) => current && { ...current, notes: [...current.notes, item.name] });
    }
  };

  const addTextNote = async (title: string, text: string) => {
    const name = await onAddText(title, text);
    if (name) setDoc((current) => current && { ...current, textNotes: [...current.textNotes, name] });
  };

  const openAttachmentMenu = () =>
    popover.open({
      label: 'Add an attachment',
      anchor: anchorElement(addRef.current),
      side: 'above',
      align: 'end',
      role: 'menu',
      render: ({ close }) => (
        <PopoverMenu
          close={close}
          entries={[
            {
              id: 'note',
              label: 'Add a note from the space',
              run: () => {
                popover.open({
                  label: 'Add a note',
                  anchor: anchorElement(addRef.current),
                  side: 'above',
                  align: 'start',
                  className: 'popover-picker',
                  render: ({ close: closePicker }) => (
                    <NotePicker
                      pages={pages}
                      exclude={[...doc.notes, ...doc.textNotes]}
                      emptyLabel="Every page is already attached."
                      onPick={(name) => {
                        attachItem({ kind: 'note', name });
                        closePicker();
                      }}
                    />
                  ),
                });
              },
            },
            {
              id: 'file',
              label: 'Add a file from the space',
              run: () => {
                popover.open({
                  label: 'Add a file',
                  anchor: anchorElement(addRef.current),
                  side: 'above',
                  align: 'start',
                  className: 'popover-picker',
                  render: ({ close: closePicker }) => (
                    <FilePicker
                      exclude={doc.files}
                      onPick={(name) => {
                        attachItem({ kind: 'file', name });
                        closePicker();
                      }}
                    />
                  ),
                });
              },
            },
            {
              id: 'upload',
              label: 'Upload a file',
              hint: 'into files/',
              run: () => fileInput.current?.click(),
            },
            {
              id: 'text',
              label: 'Attach text',
              hint: 'saved as a note in this folder',
              run: () => {
                popover.open({
                  label: 'Attach text as a note',
                  anchor: anchorElement(addRef.current),
                  side: 'above',
                  align: 'start',
                  className: 'popover-picker',
                  render: ({ close: closeForm }) => (
                    <AttachTextForm
                      onAttach={async (title, text) => {
                        await addTextNote(title, text);
                        closeForm();
                      }}
                    />
                  ),
                });
              },
            },
          ]}
        />
      ),
    });

  const short = projectShortName(pageName);
  const projectChats = chats.filter((chat) => chat.project === pageName);

  const sendProjectMessage = () => {
    const message = draft.trim();
    const files = projectContext.filter((item) => item.kind === 'file');
    if (!message && files.length === 0) return;
    const carried = projectContext;
    setDraft('');
    setProjectContext((current) => current.filter((item) => item.kind !== 'file'));
    void onStartChat(pageName, message, carried);
  };

  const attachFiles = async (files: FileList | File[] | null) => {
    const list = [...(files ?? [])];
    if (list.length === 0) return;

    const outcome = await uploadFiles(list, {
      onStart: (handle) => setUploads((current) => [...current, handle]),
      onSettle: (handle) => setUploads((current) => current.filter((item) => item.id !== handle.id)),
    });
    for (const stored of outcome.stored) {
      setProjectContext((current) => [...current, { name: stored.name, kind: 'file', file: stored }]);
    }
    for (const failure of outcome.failed) {
      if (failure.reason !== 'Cancelled.') toast(failure.reason, 'error');
    }
  };

  const attachPageToComposer = async (name: string) => {
    try {
      const page = await workspace.space.read(name);
      setProjectContext((current) => [...current, { name, kind: 'page', text: page.text }]);
    } catch {
      /* page may not exist yet */
    }
  };

  const attachTextToComposer = async (title: string, text: string) => {
    const name = await onAddText(title, text);
    if (name) await attachPageToComposer(name);
  };

  const attachProjectToComposer = async (name: string) => {
    void onAttach(name);
  };

  return (
    <div className="spark-project" data-narrow={overlayFills || undefined}>
      <input
        ref={fileInput}
        className="spark-file-input"
        type="file"
        multiple
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          for (const file of [...(event.target.files ?? [])]) {
            void filesApi
              .upload(file)
              .then((stored) => attachItem({ kind: 'file', name: stored.name }))
              .catch((err) =>
                toast(err instanceof Error ? err.message : `Could not upload ${file.name}.`, 'error'),
              );
          }
          event.target.value = '';
        }}
      />
      <div className="spark-project-head">
        <button className="icon-button" aria-label="Back to projects" title="Back to projects" onClick={onBack}>
          <ChevronLeftIcon />
        </button>
        <span className="spark-project-name">{short}</span>
        <button
          className="icon-button"
          aria-label="Delete project"
          title="Delete project"
          onClick={() => void onDelete(pageName)}
        >
          <TrashIcon />
        </button>
      </div>

      <div className="spark-project-content">
        {/* Main column: description, composer, past chats */}
        <div className="spark-project-main">
          <label className="spark-project-field spark-project-description">
            <span>Description</span>
            <input
              value={doc.description}
              placeholder="A short description shown in the project card."
              onChange={(event) =>
                setDoc((current) => current && { ...current, description: event.target.value })
              }
            />
          </label>

          <div className="spark-project-composer">
            <SparkComposer
              draft={draft}
              onDraft={setDraft}
              onSend={sendProjectMessage}
              onStop={() => {}}
              busy={false}
              enabled={true}
              context={projectContext}
              onRemoveContext={(item) =>
                setProjectContext((current) => current.filter((entry) => entry !== item))
              }
              onToggleContextHidden={(item) =>
                setProjectContext((current) =>
                  current.map((entry) =>
                    entry === item ? { ...entry, hidden: !entry.hidden } : entry,
                  ),
                )
              }
              onAttachFiles={attachFiles}
              onAttachPage={attachPageToComposer}
              onAttachText={attachTextToComposer}
              onAttachProject={attachProjectToComposer}
              projects={allProjects}
              uploads={uploads}
              overAttachmentBudget={
                projectContext
                  .filter((item) => item.kind === 'file')
                  .reduce((sum, item) => sum + (item.file?.size ?? 0), 0) > MAX_ATTACHMENT_BYTES
              }
              pages={pages}
              settings={settings}
              preferences={preferences}
              setPreferences={setPreferences}
              webSearchReady={webSearchReady}
              commands={commands}
            />
          </div>

          <div className="spark-project-field">
            <span>Conversations in this project</span>
            <ul className="spark-project-chats">
              {projectChats.length === 0 ? (
                <li className="spark-project-empty">
                  None yet — send a message above or right-click a conversation and choose "Move to a project".
                </li>
              ) : (
                projectChats.map((chat) => (
                  <li key={chat.id}>
                    <button onClick={() => onOpenChat(chat.id)}>{chat.title}</button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>

        {/* Right drawer: instructions, attachments, memory */}
        <aside className="spark-project-drawer">
          <label className="spark-project-field">
            <span>Instructions</span>
            <textarea
              value={doc.instructions}
              placeholder="How Spark should work within this project — standing instructions that travel with every chat moved here."
              rows={5}
              onChange={(event) =>
                setDoc((current) => current && { ...current, instructions: event.target.value })
              }
            />
          </label>

          <div className="spark-project-field">
            <span className="spark-project-attachments-head">
              Attachments
              <button
                ref={addRef}
                className="icon-button spark-project-add"
                aria-label="Add an attachment"
                title="Add an attachment"
                onClick={openAttachmentMenu}
              >
                <PlusIcon />
              </button>
            </span>
            <ul className="spark-project-attachments">
              {doc.notes.map((name) => (
                <li key={`note:${name}`} data-kind="note">
                  <span>{name}</span>
                  <button
                    className="icon-button"
                    aria-label={`Remove ${name}`}
                    onClick={() =>
                      setDoc((current) => current && { ...current, notes: current.notes.filter((n) => n !== name) })
                    }
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
              {doc.files.map((name) => (
                <li key={`file:${name}`} data-kind="file">
                  <span>{name.replace(/^files\//, '')}</span>
                  <button
                    className="icon-button"
                    aria-label={`Remove ${name}`}
                    onClick={() =>
                      setDoc((current) => current && { ...current, files: current.files.filter((f) => f !== name) })
                    }
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
              {doc.textNotes.map((name) => (
                <li key={`text:${name}`} data-kind="text">
                  <span>{projectShortName(name)}</span>
                  <button
                    className="icon-button"
                    aria-label={`Remove ${name}`}
                    onClick={() =>
                      setDoc((current) =>
                        current && { ...current, textNotes: current.textNotes.filter((n) => n !== name) },
                      )
                    }
                  >
                    <CloseIcon />
                  </button>
                </li>
              ))}
              {doc.notes.length + doc.files.length + doc.textNotes.length === 0 && (
                <li className="spark-project-empty">Nothing attached yet.</li>
              )}
            </ul>
          </div>

          <div className="spark-project-field">
            <span className="spark-project-attachments-head">
              Memory
              <button
                className="icon-button spark-project-add"
                aria-label="Add a memory item"
                title="Add a memory item"
                onClick={() =>
                  setDoc((current) => current && { ...current, memory: [...current.memory, ''] })
                }
              >
                <PlusIcon />
              </button>
            </span>
            <ul className="spark-project-memory">
              {doc.memory.length === 0 ? (
                <li className="spark-project-empty">
                  Facts Spark should remember about this project.
                </li>
              ) : (
                doc.memory.map((line, index) => (
                  <li key={index}>
                    <input
                      value={line}
                      placeholder="Something Spark should remember…"
                      onChange={(event) =>
                        setDoc((current) =>
                          current && {
                            ...current,
                            memory: current.memory.map((m, i) => (i === index ? event.target.value : m)),
                          },
                        )
                      }
                    />
                    <button
                      className="icon-button"
                      aria-label="Remove this memory"
                      onClick={() =>
                        setDoc((current) =>
                          current && { ...current, memory: current.memory.filter((_, i) => i !== index) },
                        )
                      }
                    >
                      <CloseIcon />
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>

          <button className="button" data-variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save project'}
          </button>
        </aside>
      </div>
    </div>
  );
}

/** The files in `files/`, as a picker — the same list the navigator's uploads land in. */
function FilePicker({ exclude, onPick }: { exclude: string[]; onPick: (name: string) => void }) {
  const [files, setFiles] = useState<StoredFile[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void filesApi
      .list()
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (files === null) return <p className="nav-empty">Loading…</p>;
  if (files.length === 0) return <p className="nav-empty">No files yet.</p>;
  return (
    <div className="popover-list">
      {files.map((file) => (
        <button
          key={file.name}
          className="menu-item"
          disabled={exclude.includes(file.name)}
          onClick={() => onPick(file.name)}
        >
          <span className="menu-item-label">{file.name.replace(/^files\//, '')}</span>
          <span className="menu-item-hint">{file.mime}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------

/**
 * Finding something said earlier.
 *
 * Highlighted with the CSS Custom Highlight API rather than by wrapping matches
 * in elements. The transcript is rendered markdown — React owns that tree, and
 * splitting its text nodes to insert `<mark>` would either fight the next render
 * or mean re-implementing the renderer. A highlight registry paints ranges over
 * the DOM without touching it at all, which is precisely the problem it exists
 * for. Where it is unavailable the bar still counts and still scrolls; only the
 * colouring is missing, which is the right thing to lose.
 */
function FindInChat({
  scope,
  onClose,
}: {
  scope: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const [count, setCount] = useState(0);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  useEffect(() => {
    const host = scope.current;
    const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    if (!host) return;

    const search = query.trim().toLowerCase();
    if (!search) {
      highlights?.delete('spark-find');
      setCount(0);
      return;
    }

    // Only the text a person can see. Walking the whole subtree would match
    // inside the thinking block and the tool trail as readily as the answer,
    // which is right — all of it is in the conversation.
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.toLowerCase() ?? '';
      let from = text.indexOf(search);
      while (from !== -1) {
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, from + search.length);
        ranges.push(range);
        from = text.indexOf(search, from + search.length);
      }
    }

    setCount(ranges.length);
    setAt((current) => (ranges.length === 0 ? 0 : Math.min(current, ranges.length - 1)));

    if (highlights && ranges.length > 0) {
      const Highlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
        .Highlight;
      if (Highlight) highlights.set('spark-find', new Highlight(...ranges));
    } else {
      highlights?.delete('spark-find');
    }

    ranges[at]?.startContainer.parentElement?.scrollIntoView({ block: 'center' });

    return () => {
      highlights?.delete('spark-find');
    };
  }, [query, at, scope]);

  // A plain closure over `count`, not a memoized callback, so it always sees
  // this render's value without needing to read it out of a `setCount`
  // updater — calling `setAt` from inside that updater purely to reach
  // `total` was the "setState updaters run more than once" trap: React can
  // replay an updater (StrictMode does, deliberately), and each replay would
  // have queued its own `setAt`, stepping twice for one call to `step`.
  const step = (by: number) => setAt((current) => (count === 0 ? 0 : (current + by + count) % count));

  return (
    <div className="spark-find" role="search">
      <SearchIcon />
      <input
        ref={field}
        className="spark-find-input"
        value={query}
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
          if (event.key === 'Enter') {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="spark-find-count">{count === 0 ? (query ? 'none' : '') : `${at + 1}/${count}`}</span>
      <button className="icon-button" aria-label="Close find" onClick={onClose}>
        <CloseIcon />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The empty screen
// ---------------------------------------------------------------------------

/**
 * Greetings rather than suggestions.
 *
 * The four suggestion chips were replaced because of what they actually did:
 * they answered "what can this do" with four things it does, which is both
 * wrong (it does hundreds) and limiting (people picked one instead of asking
 * for what they wanted). Worse, they made the empty state busy — four buttons
 * and a paragraph of explanation is a landing page, and the product principle is
 * that nothing greets you.
 *
 * So: the mark, and one line. The line rotates and half of them use your name if
 * you have set one, which is the only thing on this screen that could not be
 * printed on a poster.
 */
const GREETINGS: Array<(name: string) => string> = [
  () => 'What are we looking at?',
  (name) => (name ? `Evening, ${name}. Or morning. It is hard to tell from in here.` : 'Ready when you are.'),
  () => 'I have read everything. Ask me anything about it.',
  (name) => (name ? `Go on then, ${name}.` : 'Go on then.'),
  () => 'Somewhere in your notes is the thing you are trying to remember.',
  () => 'A blank box, and all the time in the world.',
  (name) => (name ? `What is on your mind, ${name}?` : 'What is on your mind?'),
  () => 'I can find it, fix it, or write it down. Your call.',
  () => 'No small talk. What do you need?',
  () => 'Your notes, but with someone to talk to about them.',
];

function Welcome({
  enabled,
  name,
  openThreads,
  onThreads,
}: {
  enabled: boolean;
  name: string;
  openThreads: number;
  onThreads: () => void;
}) {
  // Chosen once per mount, not per render: a greeting that changed on every
  // keystroke would be the busiest thing on a screen meant to be quiet.
  const greeting = useMemo(
    () => GREETINGS[Math.floor(Math.random() * GREETINGS.length)](name),
    [name],
  );

  return (
    <div className="spark-welcome">
      <SparkLogo size={64} className="spark-welcome-mark" />
      <p className="spark-greeting">{greeting}</p>

      {!enabled && (
        <p className="spark-warning">
          No provider is configured yet. Open Settings and add one under Spark.
        </p>
      )}

      {/* The only unprompted thing on this screen, and it costs no model call:
          a count of unticked lines in a file. It tells you something is waiting
          without deciding that you want to hear about it now. */}
      {openThreads > 0 && (
        <button className="spark-threads" onClick={onThreads}>
          <MemoryIcon />
          {openThreads} open thread{openThreads === 1 ? '' : 's'} from earlier
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** `create_page` reads as "Creating a page" while it is still running. */
function label(name: string): string {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `12s`, `1m, 2s` — never `0s`, since a duration nobody could perceive is not one worth reporting. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m, ${seconds}s` : `${seconds}s`;
}

function copy(text: string, toast: (message: string, kind?: 'info' | 'success' | 'error') => void) {
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast('Copied.', 'success'))
    .catch(() => toast('Could not copy.', 'error'));
}

/**
 * What the transcript shows for a message that carried files.
 *
 * Written into the stored text as a markdown link rather than kept as separate
 * metadata, because the transcript then says what was sent when it is reread
 * next week — and because a chat that mentions `files/scan.png` is a chat whose
 * attachment is still findable from the page it was about.
 */
function withAttachments(message: string, names: string[]): string {
  if (names.length === 0) return message;
  const list = names.map((name) => `[${name.replace(/^files\//, '')}](${name})`).join(', ');
  return message ? `${message}\n\n(${list})` : `(${list})`;
}

/** The inverse, for rewinding: what you typed, without the file list. */
function stripAttachmentLine(text: string): string {
  return text.replace(/\n\n\((?:\[[^\]]*\]\([^)]*\)(?:, )?)+\)$/, '');
}

export { SparkWatermark };
