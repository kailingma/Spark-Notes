import { parseTasks } from '@spark/core/markdown';
import { findInPastChats } from './chat-retrieval.js';
import { searchProviderMeta } from './search-providers.js';
import { webSearch, webSearchEnabled } from './web-search.js';
import type { FileStore } from './files.js';
import type { MemoryStore } from './memory.js';
import { find } from './retrieval.js';
import {
  listWorkDir,
  readWorkFile,
  runCode,
  sandboxEnabled,
  sandboxRuntime,
} from './sandbox.js';
import { skills } from './skills.js';
import type { FileSpace } from './space.js';

/**
 * What Spark is allowed to do to the space.
 *
 * This is the whole surface: a fixed list of named operations with typed
 * inputs, executed here rather than anywhere near the model. It is the same
 * shape a tool server would expose, and deliberately so — if Spark should one
 * day reach an outside tool the loop already speaks the protocol — but the
 * built-in tools stay in-process because the space is a directory on this
 * machine and a socket between the two would buy nothing.
 *
 * Three rules the design rests on:
 *
 * 1. **Permissions are enforced here, not in the prompt.** A model can be
 *    talked out of an instruction. It cannot be talked out of a tool that was
 *    never handed to it, and `toolsFor()` is what does the handing.
 * 2. **Edits are surgical by default.** `edit_page` replaces an exact string
 *    and refuses when the match is ambiguous, so the failure mode is "Spark
 *    asks you to be more specific" rather than "Spark rewrote your note from
 *    memory and lost a paragraph".
 * 3. **Every call returns a line a person can read.** The chat shows what
 *    happened, in the transcript, at the moment it happened.
 */

export interface ToolPermissions {
  /** Create pages and add to them. */
  write: boolean;
  /** Overwrite wholesale, rename, delete. */
  destroy: boolean;
  /**
   * Keep notes about you in `memory/`.
   *
   * Separate from `write` because it is a different question. Writing to your
   * notes is Spark doing work you asked for; writing to memory is Spark forming
   * an opinion about you, and someone can reasonably want the first without the
   * second — or the second without the first.
   */
  remember: boolean;
  /** Execute code in the sandbox. Also requires a runtime on the server. */
  run: boolean;
}

/** What each permission covers, for the refusal a model gets when it lacks one. */
export const PERMISSION_MEANS: Record<keyof ToolPermissions, string> = {
  write: 'change pages',
  destroy: 'delete, rename or overwrite pages',
  remember: 'keep notes about them in memory',
  run: 'run code',
};

/**
 * How much of the work happens without being asked about.
 *
 * A separate axis from `ToolPermissions`, and the distinction is the point.
 * Permissions answer "may Spark ever do this", and are enforced by *withholding
 * the tool* — a model cannot be talked into a capability it was never handed.
 * The mode answers "must it check with me first", and is enforced by *pausing*.
 * Neither can stand in for the other: withholding cannot express "yes, but tell
 * me each time", and pausing cannot express "never, whatever you say".
 *
 * The four modes are a ladder, each one pre-approving a class the one below asks
 * about:
 *
 * - `manual` — every tool call waits for a yes.
 * - `code` — manual, except that running code and looking in the working
 *   directory go ahead. This is the mode for "do the arithmetic, ask before
 *   touching my notes".
 * - `edit` — reading, writing and running go ahead; deleting, renaming and
 *   overwriting still ask. Everything except the edits you cannot check by
 *   reading the result.
 * - `auto` — nothing asks.
 */
export type PermissionMode = 'manual' | 'code' | 'edit' | 'auto';

export const PERMISSION_MODES: PermissionMode[] = ['manual', 'code', 'edit', 'auto'];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as string[]).includes(value);
}

/** Tools that are "code": the sandbox and the directory it works in. */
const CODE_TOOLS = new Set(['run_code', 'list_workspace', 'read_workspace_file']);

/**
 * Whether a tool has to be approved before it runs, under a given mode.
 *
 * Keyed on the tool's declared `needs` rather than on a list of names, so a tool
 * added later lands in the right class by saying what it needs — which is the
 * only way a rule like this stays true.
 */
export function needsApproval(tool: SparkTool, mode: PermissionMode): boolean {
  if (mode === 'auto') return false;
  if (CODE_TOOLS.has(tool.name)) return mode === 'manual';
  if (mode === 'edit') return tool.needs === 'destroy';
  // `manual` and `code` both ask about everything else, reading included: the
  // mode is called manual because it means manual.
  return true;
}

/**
 * Something for the browser to do, as soon as the tool call that queued it
 * finishes — not batched to the end of the turn.
 *
 * `present` rather than `open`: the page is shown as a card in the
 * conversation, with a button to open it, *and* attached to the conversation
 * as context, so the next thing the person says about "it" is about the page
 * that was just shown — without the disruption of the app yanking their
 * focus onto a note they did not ask to read.
 */
export type SparkAction = { kind: 'present'; page: string };

export interface ToolContext {
  space: FileSpace;
  permissions: ToolPermissions;
  actions: SparkAction[];
  memory: MemoryStore;
  files: FileStore;
  /** The conversation this turn belongs to — so `search_past_chats` can exclude it from its own results. */
  chatId: string;
  signal?: AbortSignal;
}

/** One source a retrieval-shaped tool actually drew from, for the transcript to link to. */
export interface ToolCitation {
  /** What to show — a page name and heading, a chat title, a URL's own title. */
  label: string;
  /** Opens this page at this line, for a `find` hit. */
  page?: string;
  line?: number;
  /** Opens this chat, for a `search_past_chats` hit. */
  chatId?: string;
  /** Opens this URL, for a `web_search` result. */
  url?: string;
}

export interface ToolResult {
  /** One human-readable line for the transcript. */
  summary: string;
  /** What goes back to the model. */
  detail: string;
  /**
   * Pages this call touched, so the transcript line can link to them.
   *
   * Named separately rather than parsed back out of `summary`: the summary is
   * prose meant for a person, and a regular expression over quoted fragments of
   * it would find page names in some tools and section headings in others.
   */
  pages?: string[];
  /**
   * The passages/results a retrieval tool actually returned — `find`,
   * `search_past_chats`, `web_search` — so a reply that leans on one of
   * them can be checked against its source without re-running the search.
   * Best-effort: absent for every tool that isn't itself retrieval.
   */
  citations?: ToolCitation[];
}

export interface SparkTool {
  name: string;
  description: string;
  schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** The permission this tool needs, if any. */
  needs?: keyof ToolPermissions;
  /**
   * Whether the server can offer this tool at all, regardless of permission.
   *
   * The sandbox is the case that needs it: no runtime configured means the tool
   * cannot work, and offering it anyway produces a model that promises to run
   * something and then apologises.
   */
  available?: () => boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Enough of a page to reason about without spending the context window on it. */
const LIST_LIMIT = 400;
const SEARCH_LIMIT = 60;
const READ_LIMIT = 60_000;

const str = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`"${field}" is required and must be a non-empty string`);
  }
  return value;
};

/**
 * Memory is written through the memory tools and nowhere else.
 *
 * Two reasons, and the first is a hole this closes. `remember` is a separate
 * permission precisely so someone can let Spark edit their notes without letting
 * it form a view about them — but the memory files *are* pages, so
 * `append_to_page` would have reached them under `write` alone and walked
 * straight around the switch.
 *
 * The second is the same one-writer rule the rest of the app follows: `memory.ts`
 * owns the format, the caps and the dedup, and a page tool writing raw markdown
 * into `memory/threads` would produce lines that parse back as something else.
 *
 * A person who wants to edit these by hand still can — in the editor, in vim, or
 * on the Memory page. This only governs Spark.
 */
function refuseMemoryPage(name: string): void {
  if (!/^memory(\/|$)/i.test(name.trim().replace(/^\/+/, ''))) return;
  // Careful not to name the memory tools here: this refusal is reached most often
  // when `remember` is off, and pointing at tools that were withheld produces a
  // reply that offers to do the thing it cannot do.
  throw new Error(
    'The pages under "memory/" are memory, not notes, and the page tools do not write to them — the memory tools do, if you were given them. If you have not been, say that changing memory is switched off, and that the Memory page and the editor are both ways they can change it themselves.',
  );
}

export const SPARK_TOOLS: SparkTool[] = [
  {
    name: 'list_pages',
    description:
      'List page names in the space, newest first. Use this before guessing a name. Optionally restrict to a folder prefix such as "journal" or "projects".',
    schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Only pages under this folder prefix.' },
        limit: { type: 'number', description: `Maximum results (default 100, max ${LIST_LIMIT}).` },
      },
    },
    async run(input, ctx) {
      const folder = typeof input.folder === 'string' ? input.folder.replace(/\/$/, '') : '';
      const limit = Math.min(Number(input.limit) || 100, LIST_LIMIT);
      const pages = (await ctx.space.list())
        .filter((page) => !folder || page.name === folder || page.name.startsWith(`${folder}/`))
        .slice(0, limit);

      return {
        summary: `Listed ${pages.length} page${pages.length === 1 ? '' : 's'}${folder ? ` under ${folder}` : ''}`,
        detail:
          pages.length === 0
            ? 'No pages matched.'
            : pages
                .map((page) => `${page.name} (modified ${new Date(page.modified).toISOString()})`)
                .join('\n'),
      };
    },
  },

  {
    name: 'read_page',
    description:
      'Read a page in full. Always read a page before editing it, so the text you match against is the text that is actually there.',
    schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Page name without ".md".' } },
      required: ['name'],
    },
    async run(input, ctx) {
      const name = str(input.name, 'name');
      const page = await ctx.space.read(name);
      const text = page.text.length > READ_LIMIT
        ? `${page.text.slice(0, READ_LIMIT)}\n\n[truncated: the page is longer than ${READ_LIMIT} characters]`
        : page.text;
      return {
        summary: `Read “${page.name}”`,
        detail: text || '(the page is empty)',
        pages: [page.name],
      };
    },
  },

  {
    name: 'list_directories',
    description:
      'The folders at the top of the space, with how many pages are in each. Read this first when you need to know how the space is organised — where a new page belongs, or what kind of place this is. Cheaper than listing every page, and it is the shape of the space rather than its contents.',
    schema: { type: 'object', properties: {} },
    async run(_input, ctx) {
      const pages = await ctx.space.list();
      const folders = await ctx.space.listFolders();

      // Counted per top-level segment, including pages nested deeper: "journal has
      // 240 pages" is the useful fact, and "journal/2026 has 12" is a level of
      // detail that belongs to a later `list_pages`.
      const counts = new Map<string, number>();
      let loose = 0;
      for (const page of pages) {
        const slash = page.name.indexOf('/');
        if (slash === -1) loose += 1;
        else counts.set(page.name.slice(0, slash), (counts.get(page.name.slice(0, slash)) ?? 0) + 1);
      }
      // An empty folder someone just made is still a folder, and is often exactly
      // the answer to "where does this go".
      for (const folder of folders) {
        const top = folder.split('/')[0];
        if (!counts.has(top)) counts.set(top, 0);
      }

      const rows = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, count]) => `${name}/ — ${count} page${count === 1 ? '' : 's'}${describeFolder(name)}`);
      if (loose > 0) rows.push(`(and ${loose} page${loose === 1 ? '' : 's'} at the top level)`);

      return {
        summary: `Listed ${counts.size} top-level folder${counts.size === 1 ? '' : 's'}`,
        detail: rows.length === 0 ? 'The space has no folders yet.' : rows.join('\n'),
      };
    },
  },

  {
    name: 'search',
    description:
      'Search every page for a phrase, returning the matching lines with their page and line number. Case-insensitive plain text, not a regular expression.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: `Maximum matches (default 30, max ${SEARCH_LIMIT}).` },
      },
      required: ['query'],
    },
    async run(input, ctx) {
      const query = str(input.query, 'query').toLowerCase();
      const limit = Math.min(Number(input.limit) || 30, SEARCH_LIMIT);
      const pages = await ctx.space.readAllMarkdown();

      const hits: string[] = [];
      for (const page of pages) {
        const lines = page.text.split('\n');
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (lines[i].toLowerCase().includes(query)) {
            hits.push(`${page.name}:${i}: ${lines[i].trim().slice(0, 240)}`);
          }
        }
        if (hits.length >= limit) break;
      }

      return {
        summary: `Searched for “${input.query as string}” — ${hits.length} match${hits.length === 1 ? '' : 'es'}`,
        detail: hits.length === 0 ? 'No matches.' : hits.join('\n'),
      };
    },
  },

  {
    name: 'create_page',
    description:
      'Create a new page. Fails if a page of that name already exists, so it can never overwrite anything. Use a folder prefix ("projects/name") to file it.',
    needs: 'write',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        content: { type: 'string', description: 'Full markdown body, usually starting with "# Title".' },
      },
      required: ['name', 'content'],
    },
    async run(input, ctx) {
      const name = str(input.name, 'name');
      refuseMemoryPage(name);
      const content = typeof input.content === 'string' ? input.content : '';
      if (await ctx.space.exists(name)) {
        throw new Error(`"${name}" already exists. Read it first, then edit it if that is what you meant.`);
      }
      // An empty base revision means "create"; the space refuses if the file
      // appeared between the check above and this write.
      const page = await ctx.space.write(name, ensureTrailingNewline(content), '');
      ctx.actions.push({ kind: 'present', page: page.name });
      return {
        summary: `Created “${page.name}”`,
        detail: `Created ${page.name} (${page.size} bytes). It has already been presented to them as a card in the conversation, so you do not need to present it again.`,
        pages: [page.name],
      };
    },
  },

  {
    name: 'append_to_page',
    description:
      'Add text to the end of a page, creating the page if it does not exist. The safest way to add to a note: nothing already written can be touched.',
    needs: 'write',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, content: { type: 'string' } },
      required: ['name', 'content'],
    },
    async run(input, ctx) {
      const name = str(input.name, 'name');
      refuseMemoryPage(name);
      const addition = str(input.content, 'content');

      let existing = '';
      let rev: string | null = '';
      try {
        const page = await ctx.space.read(name);
        existing = page.text;
        rev = page.rev;
      } catch {
        existing = '';
        rev = '';
      }

      const body = existing.trimEnd();
      const next = body ? `${body}\n\n${addition.trim()}\n` : `${addition.trim()}\n`;
      const page = await ctx.space.write(name, next, rev);
      return {
        summary: `Added to “${page.name}”`,
        detail: `Appended ${addition.length} characters to ${page.name}.`,
        pages: [page.name],
      };
    },
  },

  {
    name: 'edit_page',
    description:
      'Replace an exact passage in a page. Give enough surrounding text for "find" to be unique; if it matches more than once the edit is refused rather than guessed. This is the way to change something that is already written.',
    needs: 'write',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        find: { type: 'string', description: 'Exact text to replace, including whitespace.' },
        replace: { type: 'string', description: 'What to put there. Empty string deletes the passage.' },
        all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique one.' },
      },
      required: ['name', 'find', 'replace'],
    },
    async run(input, ctx) {
      const name = str(input.name, 'name');
      refuseMemoryPage(name);
      const find = str(input.find, 'find');
      const replace = typeof input.replace === 'string' ? input.replace : '';
      const all = input.all === true;

      const page = await ctx.space.read(name);
      const occurrences = countOccurrences(page.text, find);

      if (occurrences === 0) {
        throw new Error(
          `That passage is not in "${name}". Read the page again and match its text exactly, including indentation.`,
        );
      }
      if (occurrences > 1 && !all) {
        throw new Error(
          `That passage appears ${occurrences} times in "${name}". Include more surrounding text so it is unique, or pass all: true.`,
        );
      }

      const next = all ? page.text.split(find).join(replace) : page.text.replace(find, replace);
      const written = await ctx.space.write(name, next, page.rev);
      return {
        summary: `Edited “${written.name}”`,
        detail: `Replaced ${all ? occurrences : 1} occurrence(s) in ${written.name}.`,
        pages: [written.name],
      };
    },
  },

  {
    name: 'rewrite_page',
    description:
      'Replace a page in full. Destructive: everything currently in the page is discarded. Prefer edit_page or append_to_page unless the whole document really is being replaced.',
    needs: 'destroy',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, content: { type: 'string' } },
      required: ['name', 'content'],
    },
    async run(input, ctx) {
      const name = str(input.name, 'name');
      refuseMemoryPage(name);
      const content = typeof input.content === 'string' ? input.content : '';
      const page = await ctx.space.read(name);
      const written = await ctx.space.write(name, ensureTrailingNewline(content), page.rev);
      return {
        summary: `Rewrote “${written.name}”`,
        detail: `Replaced the contents of ${written.name}.`,
        pages: [written.name],
      };
    },
  },

  {
    name: 'rename_page',
    description: 'Rename or move a page. Fails if the destination already exists.',
    needs: 'destroy',
    schema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
    async run(input, ctx) {
      const from = str(input.from, 'from');
      const to = str(input.to, 'to');
      refuseMemoryPage(from);
      refuseMemoryPage(to);
      await ctx.space.rename(from, to);
      return {
        summary: `Renamed “${from}” to “${to}”`,
        detail: `Renamed ${from} to ${to}.`,
        pages: [to],
      };
    },
  },

  {
    name: 'delete_page',
    description:
      'Delete a page. There is no undo beyond the git history, if sync is set up. Only do this when asked in so many words.',
    needs: 'destroy',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    async run(input, ctx) {
      const name = str(input.name, 'name');
      refuseMemoryPage(name);
      if (!(await ctx.space.exists(name))) throw new Error(`"${name}" does not exist.`);
      await ctx.space.delete(name);
      return { summary: `Deleted “${name}”`, detail: `Deleted ${name}.` };
    },
  },

  {
    name: 'list_tasks',
    description:
      'Every "- [ ]" task in the space, with the page and line it lives on. Pass done: true to see completed ones instead.',
    schema: {
      type: 'object',
      properties: {
        done: { type: 'boolean' },
        page: { type: 'string', description: 'Only tasks on this page.' },
      },
    },
    async run(input, ctx) {
      const wantDone = input.done === true;
      const only = typeof input.page === 'string' ? input.page : null;
      const pages = await ctx.space.readAllMarkdown();

      const tasks = pages
        .filter((page) => !only || page.name === only)
        .flatMap((page) => parseTasks(page.name, page.text))
        .filter((task) => task.done === wantDone)
        .slice(0, 200);

      return {
        summary: `Listed ${tasks.length} ${wantDone ? 'completed' : 'open'} task${tasks.length === 1 ? '' : 's'}`,
        detail:
          tasks.length === 0
            ? 'No tasks matched.'
            : tasks.map((task) => `${task.page}:${task.line}: ${task.text}`).join('\n'),
      };
    },
  },

  {
    name: 'set_task',
    description:
      'Tick or untick a task by the page and line number that list_tasks reported. Refuses if that line is not a task, so a shifted line cannot be mistaken for one.',
    needs: 'write',
    schema: {
      type: 'object',
      properties: {
        page: { type: 'string' },
        line: { type: 'number', description: 'Zero-based line number.' },
        done: { type: 'boolean' },
      },
      required: ['page', 'line', 'done'],
    },
    async run(input, ctx) {
      const name = str(input.page, 'page');
      const line = Number(input.line);
      const done = input.done === true;

      const page = await ctx.space.read(name);
      const lines = page.text.split('\n');
      const source = lines[line];
      if (source === undefined) throw new Error(`${name} has no line ${line}.`);

      const match = /^(\s*[-*+]\s+\[)([ xX])(\].*)$/.exec(source);
      if (!match) throw new Error(`Line ${line} of ${name} is not a task: "${source.trim().slice(0, 80)}"`);

      lines[line] = `${match[1]}${done ? 'x' : ' '}${match[3]}`;
      await ctx.space.write(name, lines.join('\n'), page.rev);
      return {
        summary: `${done ? 'Completed' : 'Reopened'} a task in “${name}”`,
        detail: `${name}:${line} is now ${done ? 'done' : 'open'}.`,
        pages: [name],
      };
    },
  },

  {
    name: 'present_page',
    description:
      'Show a page to the person you are talking to, as a card in the conversation with a button they can open it from. Use it instead of pasting a page back into the conversation, and after writing something so they can read what you wrote. Presenting also attaches the page to the conversation, so anything they say next about "it" is about this page — which is why this is better than describing what you did. It does not open the page itself; opening it is their choice.',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    async run(input, ctx) {
      const name = str(input.name, 'name');
      ctx.actions.push({ kind: 'present', page: name });
      return {
        summary: `Presented “${name}”`,
        detail: `${name} is now shown as a card in the conversation, attached to it, for them to open when they choose.`,
        pages: [name],
      };
    },
  },

  // -------------------------------------------------------------------------
  // Finding things
  // -------------------------------------------------------------------------

  {
    name: 'find',
    description:
      'Search the space by meaning as well as by words, returning the passages that match with the page and line they are on. Use this rather than "search" when you do not know the exact wording — "what did I decide about pricing" finds a paragraph that never says "pricing". Use "search" when you need every literal occurrence of an exact string.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A phrase or a question, in the person\'s own terms.' },
        limit: { type: 'number', description: 'Passages to return (default 8, max 30).' },
      },
      required: ['query'],
    },
    async run(input, ctx) {
      const query = str(input.query, 'query');
      const result = await find(ctx.space, query, {
        limit: Number(input.limit) || 8,
        signal: ctx.signal,
      });

      if (result.hits.length === 0) {
        return {
          summary: `Found nothing for “${query}”`,
          detail: `No passage matched.${result.note ? ` (${result.note})` : ''}`,
        };
      }

      const passages = result.hits.map((hit) => {
        const where = hit.heading ? `${hit.page} › ${hit.heading}` : hit.page;
        return `--- ${where} (line ${hit.line})\n${hit.text}`;
      });

      return {
        summary: `Found ${result.hits.length} passage${result.hits.length === 1 ? '' : 's'} for “${query}”${result.semantic ? '' : ' (text only)'}`,
        detail: [result.note, ...passages].filter(Boolean).join('\n\n'),
        citations: result.hits.map((hit) => ({
          label: hit.heading ? `${hit.page} › ${hit.heading}` : hit.page,
          page: hit.page,
          line: hit.line,
        })),
      };
    },
  },

  {
    name: 'search_past_chats',
    description:
      'Search other conversations you have had with this person — not this one, and not their notes — for something they referenced, asked about before, or that would help answer what they are asking now. Use it when they say things like "like we discussed before", "what did you say about X last time", or when recalling an earlier conversation would plainly help and the notes would not have it, since a conversation is not a note. Ranked by meaning as well as by words, the same as "find".',
    // Read-only recall of the person's own transcript history — the same
    // class of action as `search`/`find`, not something that forms a
    // belief about them the way `remember` does, so it needs no permission
    // gate of its own.
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A phrase or a question, in the person\'s own terms.' },
        limit: { type: 'number', description: 'Passages to return (default 6, max 20).' },
      },
      required: ['query'],
    },
    async run(input, ctx) {
      const query = str(input.query, 'query');
      const result = await findInPastChats(query, ctx.chatId, {
        limit: Math.min(Number(input.limit) || 6, 20),
        signal: ctx.signal,
      });

      if (result.hits.length === 0) {
        return {
          summary: `Found nothing in past conversations for “${query}”`,
          detail: `No passage matched.${result.note ? ` (${result.note})` : ''}`,
        };
      }

      const passages = result.hits.map((hit) => `--- “${hit.heading}”\n${hit.text}`);

      return {
        summary: `Found ${result.hits.length} passage${result.hits.length === 1 ? '' : 's'} in past conversations for “${query}”${result.semantic ? '' : ' (text only)'}`,
        detail: [result.note, ...passages].filter(Boolean).join('\n\n'),
        // `chunkChat` (chat-retrieval.ts) names a hit's page `chat:<id>` —
        // the id is lifted back out here rather than carried as a separate
        // field on `Hit`, which would mean widening the shape `find()`'s
        // note-taking pages share too, for one caller.
        citations: result.hits.map((hit) => ({
          label: hit.heading ?? 'Untitled conversation',
          chatId: hit.page.replace(/^chat:/, ''),
        })),
      };
    },
  },

  // -------------------------------------------------------------------------
  // Memory
  // -------------------------------------------------------------------------

  {
    name: 'remember',
    description:
      'Write something down about this person so that every future conversation starts already knowing it. Use "essential" for a durable fact about them or the people around them; "convention" for how they want their space organised or how they want you to behave, phrased as an instruction; "thread" for something outstanding, which becomes a task they will see in Tasks. Record a correction the moment you receive one — being told the same thing twice is the failure this exists to prevent. Do not record what is already plain in their notes, and do not record passing detail.',
    needs: 'remember',
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['essential', 'convention', 'thread'] },
        text: {
          type: 'string',
          description: 'One sentence, under 200 characters, in the third person ("prefers…", "works at…").',
        },
        due: { type: 'string', description: 'Threads only: an ISO date, when one is genuinely known.' },
      },
      required: ['kind', 'text'],
    },
    async run(input, ctx) {
      const kind = str(input.kind, 'kind');
      const text = str(input.text, 'text');
      const map: Record<string, 'essentials' | 'conventions' | 'threads'> = {
        essential: 'essentials',
        essentials: 'essentials',
        convention: 'conventions',
        conventions: 'conventions',
        thread: 'threads',
        threads: 'threads',
      };
      const target = map[kind.toLowerCase()];
      if (!target) throw new Error('"kind" must be "essential", "convention" or "thread".');

      const due = typeof input.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input.due) ? input.due : undefined;
      const outcome = await ctx.memory.add(target, text, { due });

      return {
        summary: outcome.added ? `Remembered: ${text.slice(0, 60)}` : `Already knew that`,
        detail: outcome.added
          ? `Recorded in memory/${target}.`
          : `Not recorded: ${outcome.reason ?? 'it is already there'}.`,
      };
    },
  },

  {
    name: 'note_observation',
    description:
      'Park something you noticed but are not sure is worth keeping. It goes into a buffer that gets reviewed and either promoted, merged or thrown away later, so this is the cheap option: use it when something might matter and use "remember" when it plainly does.',
    needs: 'remember',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    async run(input, ctx) {
      const text = str(input.text, 'text');
      await ctx.memory.observe(text);
      return { summary: 'Noted for later', detail: 'Added to the memory buffer.' };
    },
  },

  {
    name: 'forget',
    description:
      'Remove what you know matching a phrase. Use it when the person asks you to forget something, or when you find that something recorded is wrong. Removing a wrong line and recording the right one is how a correction should be handled.',
    needs: 'remember',
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['essential', 'convention', 'thread'] },
        match: { type: 'string', description: 'A phrase from the line to remove.' },
      },
      required: ['kind', 'match'],
    },
    async run(input, ctx) {
      const kind = str(input.kind, 'kind').toLowerCase();
      const match = str(input.match, 'match');
      const target =
        kind.startsWith('essential') ? 'essentials' : kind.startsWith('convention') ? 'conventions' : 'threads';

      const removed = await ctx.memory.forget(target, match);
      return {
        summary: removed > 0 ? `Forgot ${removed} line${removed === 1 ? '' : 's'}` : 'Nothing matched',
        detail:
          removed > 0
            ? `Removed ${removed} line(s) from memory/${target}.`
            : `Nothing in memory/${target} matched "${match}".`,
      };
    },
  },

  {
    name: 'close_thread',
    description: 'Tick off an open thread that has been dealt with.',
    needs: 'remember',
    schema: {
      type: 'object',
      properties: { match: { type: 'string' } },
      required: ['match'],
    },
    async run(input, ctx) {
      const match = str(input.match, 'match');
      const closed = await ctx.memory.closeThread(match);
      return {
        summary: closed > 0 ? `Closed ${closed} thread${closed === 1 ? '' : 's'}` : 'No open thread matched',
        detail: closed > 0 ? `Ticked off ${closed} thread(s).` : `No open thread matched "${match}".`,
      };
    },
  },

  // -------------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------------

  {
    name: 'read_skill',
    description:
      'Get the full instructions for one of the skills you were told about. Read it before doing the job it describes, and then follow it rather than your own instincts about how the job should go.',
    schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The skill\'s folder name.' } },
      required: ['name'],
    },
    async run(input) {
      const name = str(input.name, 'name');
      const skill = await skills.read(name);
      const extras =
        skill.files.length > 0
          ? `\n\nOther files in this skill, readable with read_skill_file: ${skill.files.join(', ')}`
          : '';
      return {
        summary: `Read the “${name}” skill`,
        detail: `${skill.body}${extras}`,
      };
    },
  },

  {
    name: 'read_skill_file',
    description: 'Read a file that belongs to a skill — a template, a script, an example.',
    schema: {
      type: 'object',
      properties: { skill: { type: 'string' }, file: { type: 'string' } },
      required: ['skill', 'file'],
    },
    async run(input) {
      const skill = str(input.skill, 'skill');
      const file = str(input.file, 'file');
      const text = await skills.readFile(skill, file);
      return { summary: `Read ${skill}/${file}`, detail: text || '(the file is empty)' };
    },
  },

  {
    name: 'write_skill',
    description:
      'Write down a procedure so you do it the same way next time. Reach for this when the person explains how they want a recurring job done, or corrects the way you did one: the correction belongs in a skill rather than in this conversation, which ends. Read the skill first if it already exists, and keep what still applies.',
    needs: 'write',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lowercase, hyphenated: "weekly-review".' },
        description: { type: 'string', description: 'One line: what the skill does.' },
        when: { type: 'string', description: 'One line: when to reach for it.' },
        body: {
          type: 'string',
          description: 'The instructions, in markdown. Write them as steps addressed to yourself.',
        },
      },
      required: ['name', 'description', 'body'],
    },
    async run(input, ctx) {
      const name = str(input.name, 'name');
      const written = await skills.write(name, {
        description: str(input.description, 'description'),
        when: typeof input.when === 'string' ? input.when : undefined,
        body: str(input.body, 'body'),
      });
      ctx.actions.push({ kind: 'present', page: written.page });
      return {
        summary: `Wrote the “${name}” skill`,
        detail: `Saved to ${written.page}.`,
        pages: [written.page],
      };
    },
  },

  // -------------------------------------------------------------------------
  // Attachments
  // -------------------------------------------------------------------------

  {
    name: 'list_files',
    description:
      'List the attachments in this space — anything uploaded, and anything a script has produced.',
    schema: { type: 'object', properties: {} },
    async run(_input, ctx) {
      const files = await ctx.files.list();
      return {
        summary: `Listed ${files.length} file${files.length === 1 ? '' : 's'}`,
        detail:
          files.length === 0
            ? 'There are no attachments.'
            : files
                .map((file) => `${file.name} — ${file.mime}, ${Math.ceil(file.size / 1024)} kB`)
                .join('\n'),
      };
    },
  },

  {
    name: 'read_file',
    description:
      'Read an attachment as text. Works for text, markdown, CSV, JSON and code. An image or a PDF cannot be read this way — ask the person to attach it to a message, which is how you get to look at it.',
    schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'For example "files/notes.csv".' } },
      required: ['name'],
    },
    async run(input, ctx) {
      const name = str(input.name, 'name');
      const payload = await ctx.files.payload(name);

      if (payload.kind === 'text') {
        return { summary: `Read ${name}`, detail: payload.text || '(the file is empty)' };
      }
      if (payload.kind === 'unsupported') {
        return { summary: `Could not read ${name}`, detail: payload.reason };
      }
      return {
        summary: `${name} is not text`,
        detail: `"${name}" is a ${payload.mime}. Ask them to attach it to a message so you can look at it directly.`,
      };
    },
  },

  // -------------------------------------------------------------------------
  // The web
  // -------------------------------------------------------------------------

  {
    name: 'web_search',
    description:
      'Search the web and get back what each matching page said about the topic — the page text where the configured search engine returns it, otherwise its snippet. Use it for anything the notes cannot answer because it is outside them: a fact, a definition, what a library does now, what happened. Say where each claim came from. Do not use it for questions about their own notes — that is what "find" is for. When the results are snippets rather than full text, say that you only saw snippets and offer to fetch the page.',
    // Capability rather than permission: with no configured provider the tool
    // cannot work, and a model told it can search will promise to and then
    // apologise.
    available: webSearchEnabled,
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up, phrased as you would to a search engine or as a question.' },
        limit: { type: 'number', description: 'Results to read (default 5, max 10).' },
      },
      required: ['query'],
    },
    async run(input, ctx) {
      const query = str(input.query, 'query');
      const { results, engine: engineId, fellBackFrom } = await webSearch(query, {
        limit: Number(input.limit) || 5,
        signal: ctx.signal,
      });
      // The engine that actually answered, not necessarily the configured
      // active one — a fallback took over if `fellBackFrom` is set, and the
      // summary has to say that plainly rather than name the engine that
      // failed as if it had answered.
      const engine = searchProviderMeta(engineId)?.label ?? 'web search';
      const via = fellBackFrom
        ? ` (${searchProviderMeta(fellBackFrom)?.label ?? fellBackFrom} didn't answer, so this used ${engine} instead)`
        : '';

      if (results.length === 0) {
        return { summary: `Searched ${engine} for “${query}”${via} — nothing`, detail: 'No results.' };
      }

      return {
        summary: `Searched ${engine} for “${query}”${via} — ${results.length} result${results.length === 1 ? '' : 's'}`,
        detail: results
          .map(
            (result) =>
              `--- ${result.title}\n${result.url}${result.published ? ` (${result.published})` : ''}\n${result.text}`,
          )
          .join('\n\n'),
        citations: results.map((result) => ({ label: result.title, url: result.url })),
      };
    },
  },

  // -------------------------------------------------------------------------
  // Code, and the directory it runs in
  // -------------------------------------------------------------------------

  {
    name: 'list_workspace',
    description:
      'List what is in your working directory. It survives between runs, so this is how you find out what an earlier script left behind rather than guessing at a filename.',
    needs: 'run',
    available: sandboxEnabled,
    schema: { type: 'object', properties: {} },
    async run() {
      const entries = await listWorkDir();
      return {
        summary: `Listed ${entries.length} file${entries.length === 1 ? '' : 's'} in the workspace`,
        detail:
          entries.length === 0
            ? 'The working directory is empty.'
            : entries
                .map(
                  (entry) =>
                    `${entry.name} — ${Math.ceil(entry.size / 1024)} kB, written ${new Date(entry.modified).toISOString()}`,
                )
                .join('\n'),
      };
    },
  },

  {
    name: 'read_workspace_file',
    description:
      'Read a text file out of your working directory — a result an earlier script wrote, a CSV you assembled. For anything that is not text, have a script print what you need instead.',
    needs: 'run',
    available: sandboxEnabled,
    schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Path relative to the working directory.' } },
      required: ['name'],
    },
    async run(input) {
      const name = str(input.name, 'name');
      const text = await readWorkFile(name);
      return { summary: `Read ${name} from the workspace`, detail: text || '(the file is empty)' };
    },
  },

  {
    name: 'run_code',
    description:
      'Run a short Python or JavaScript program and get its output back. This is for the questions about a folder of markdown that are arithmetic rather than reading: totalling a column, counting across months, reshaping a CSV, working out dates. Reason about text yourself; compute numbers here, because a total you worked out in your head is a total you might have got wrong. Name the pages or files the script needs in "files" and they appear in the working directory as plain files — do not go looking for the space by path, because whether that even works depends on how the server is set up. The working directory is yours and survives between runs, so a long job can be done in steps: write an intermediate file, then read it back next time. Anything the script writes to "out/" is saved as an attachment. Print what you want to see; nothing else comes back.',
    needs: 'run',
    available: sandboxEnabled,
    schema: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python', 'javascript'] },
        code: {
          type: 'string',
          description: 'A complete program. Print what you want to see; nothing else comes back.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Pages or attachments to place in the working directory, by name.',
        },
      },
      required: ['language', 'code'],
    },
    async run(input, ctx) {
      const language = str(input.language, 'language').toLowerCase();
      if (language !== 'python' && language !== 'javascript') {
        throw new Error('"language" must be "python" or "javascript".');
      }
      const code = str(input.code, 'code');
      const wanted = Array.isArray(input.files)
        ? input.files.filter((name): name is string => typeof name === 'string').slice(0, 12)
        : [];

      // Read what was asked for, from the attachments or from the space. A name
      // that resolves to neither is reported rather than silently absent, so the
      // model does not debug a script whose input was never there.
      // Each file keeps the name it was asked for, so the script opens it under
      // the name the model already knows. A page gains `.md`, which is what it is
      // called on disk.
      const files: Array<{ name: string; bytes: Uint8Array }> = [];
      const absent: string[] = [];
      for (const name of wanted) {
        try {
          if (/^files\//i.test(name)) {
            const { bytes } = await ctx.files.bytes(name);
            files.push({ name, bytes });
          } else {
            const page = await ctx.space.read(name);
            files.push({ name: `${name}.md`, bytes: Buffer.from(page.text, 'utf8') });
          }
        } catch {
          absent.push(name);
        }
      }

      const result = await runCode({ language, code, files });

      const provided =
        files.length > 0
          ? `Files placed in the working directory for this run: ${files.map((file) => file.name).join(', ')}.`
          : // Said only on failure, and worth saying: the commonest first mistake
            // is a script that opens a file it never asked to be given. The
            // directory persists, so the advice is now "look" as well as "ask".
            'Nothing was placed in the working directory this run, because "files" was empty. A page or an attachment the script needs has to be named there; anything an earlier run left behind is still there and list_workspace will show it.';
      const missing = absent.length > 0 ? `Not found, so not provided: ${absent.join(', ')}.` : '';

      // A script that failed is a failed step, not a successful tool call that
      // happened to return an error. Throwing is how every other tool here
      // reports failure, and it is what puts a red line in the transcript rather
      // than a green one the person has to read to discover went wrong.
      if (!result.ok) {
        throw new Error(
          [
            result.timedOut
              ? 'The script was killed for running too long.'
              : 'The script exited with an error.',
            missing,
            provided,
            result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : '',
            result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        );
      }

      const saved: string[] = [];
      for (const produced of result.produced) {
        const stored = await ctx.files.save(produced.name, produced.bytes);
        saved.push(stored.name);
      }

      return {
        summary: `Ran ${language}${saved.length > 0 ? ` — produced ${saved.length} file${saved.length === 1 ? '' : 's'}` : ''}`,
        detail: [
          missing,
          result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : '(the script printed nothing)',
          result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
          saved.length > 0 ? `Saved as: ${saved.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      };
    },
  },
];

/**
 * The tools available under a set of permissions.
 *
 * A tool that is withheld is simply absent from the request: the model is never
 * told about a capability it cannot use, which is both cheaper and less likely
 * to produce a reply that promises something it then cannot do.
 */
export function toolsFor(permissions: ToolPermissions): SparkTool[] {
  return SPARK_TOOLS.filter(
    (tool) => (!tool.needs || permissions[tool.needs]) && (!tool.available || tool.available()),
  );
}

/** What the sandbox is, for the settings panel and for the system prompt. */
export const sandboxState = (): { enabled: boolean; runtime: string } => ({
  enabled: sandboxEnabled(),
  runtime: sandboxRuntime(),
});

export function findTool(name: string): SparkTool | undefined {
  return SPARK_TOOLS.find((tool) => tool.name === name);
}

/**
 * The four folders that are not notes, named where they appear.
 *
 * Said in the listing rather than only in the system prompt, because this is the
 * moment it matters: a model that has just been shown `_plugins/` and `memory/`
 * beside `projects/` will otherwise treat all three as places to file a page.
 */
function describeFolder(name: string): string {
  switch (name.toLowerCase()) {
    case 'memory':
      return ' — your memory about them. Not notes; use the memory tools.';
    case '_skills':
      return ' — the skills. Written with write_skill, read with read_skill.';
    case '_plugins':
      return ' — their own code, which extends the app. Leave it alone unless asked.';
    case 'files':
      return ' — attachments. Use list_files and read_file.';
    case 'journal':
      return ' — the daily pages.';
    case 'ai':
      return ' — where your own work goes unless a better home is obvious.';
    default:
      return '';
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}
