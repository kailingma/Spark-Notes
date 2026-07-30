import { parseTasks } from '@spark/core/markdown';
import type { FileStore } from './files.js';
import type { MemoryStore } from './memory.js';
import { find } from './retrieval.js';
import { runCode, sandboxEnabled, sandboxRuntime } from './sandbox.js';
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

/** Something for the browser to do once the turn is over. */
export type SparkAction = { kind: 'open'; page: string };

export interface ToolContext {
  space: FileSpace;
  permissions: ToolPermissions;
  actions: SparkAction[];
  memory: MemoryStore;
  files: FileStore;
  signal?: AbortSignal;
}

export interface ToolResult {
  /** One human-readable line for the transcript. */
  summary: string;
  /** What goes back to the model. */
  detail: string;
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
      const content = typeof input.content === 'string' ? input.content : '';
      if (await ctx.space.exists(name)) {
        throw new Error(`"${name}" already exists. Read it first, then edit it if that is what you meant.`);
      }
      // An empty base revision means "create"; the space refuses if the file
      // appeared between the check above and this write.
      const page = await ctx.space.write(name, ensureTrailingNewline(content), '');
      ctx.actions.push({ kind: 'open', page: page.name });
      return { summary: `Created “${page.name}”`, detail: `Created ${page.name} (${page.size} bytes).` };
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
      return { summary: `Added to “${page.name}”`, detail: `Appended ${addition.length} characters to ${page.name}.` };
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
      const content = typeof input.content === 'string' ? input.content : '';
      const page = await ctx.space.read(name);
      const written = await ctx.space.write(name, ensureTrailingNewline(content), page.rev);
      return {
        summary: `Rewrote “${written.name}”`,
        detail: `Replaced the contents of ${written.name}.`,
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
      await ctx.space.rename(from, to);
      return { summary: `Renamed “${from}” to “${to}”`, detail: `Renamed ${from} to ${to}.` };
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
      };
    },
  },

  {
    name: 'open_page',
    description:
      'Bring a page up in front of the person you are talking to. Use it after creating something, so they can see it, rather than pasting the whole thing back into the conversation.',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    async run(input, ctx) {
      const name = str(input.name, 'name');
      ctx.actions.push({ kind: 'open', page: name });
      return { summary: `Opened “${name}”`, detail: `${name} is now on screen.` };
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
      ctx.actions.push({ kind: 'open', page: written.page });
      return { summary: `Wrote the “${name}” skill`, detail: `Saved to ${written.page}.` };
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
  // Code
  // -------------------------------------------------------------------------

  {
    name: 'run_code',
    description:
      'Run a short Python or JavaScript program and get its output back. This is for the questions about a folder of markdown that are arithmetic rather than reading: totalling a column, counting across months, reshaping a CSV, working out dates. Reason about text yourself; compute numbers here, because a total you worked out in your head is a total you might have got wrong. Name the pages or files the script needs in "files" and they appear in the working directory as plain files — do not go looking for the space by path, because whether that even works depends on how the server is set up. Anything the script writes to "out/" is saved as an attachment. Print what you want to see; nothing else comes back.',
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
      const files: Array<{ name: string; bytes: Uint8Array }> = [];
      const absent: string[] = [];
      for (const name of wanted) {
        try {
          if (/^files\//i.test(name)) {
            const { bytes } = await ctx.files.bytes(name);
            files.push({ name, bytes });
          } else {
            const page = await ctx.space.read(name);
            files.push({ name: `${name.split('/').pop()}.md`, bytes: Buffer.from(page.text, 'utf8') });
          }
        } catch {
          absent.push(name);
        }
      }

      const result = await runCode({ language, code, files });

      const saved: string[] = [];
      for (const produced of result.produced) {
        const stored = await ctx.files.save(produced.name, produced.bytes);
        saved.push(stored.name);
      }

      const detail = [
        absent.length > 0 ? `These could not be found and were not provided: ${absent.join(', ')}.` : '',
        result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : '(no output)',
        result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
        saved.length > 0 ? `Saved: ${saved.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      return {
        summary: result.timedOut
          ? 'Code timed out'
          : result.ok
            ? `Ran ${language}${saved.length > 0 ? ` — produced ${saved.length} file${saved.length === 1 ? '' : 's'}` : ''}`
            : `${language} exited with an error`,
        detail,
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
