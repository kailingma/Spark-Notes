import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

/**
 * Where conversations with Spark are kept.
 *
 * In `.spark/chats/`, one JSON file per conversation, next to the credentials
 * and outside the space. That placement is the decision worth explaining:
 *
 * - **Not in the space.** A chat is not a note. Writing them into the markdown
 *   would put them in the page list, in search, in backlinks and in git — four
 *   places you did not ask for them, and a sync conflict every time two devices
 *   talk to Spark at once. If a conversation is worth keeping, Spark can write
 *   it into a real page, which is a thing you choose.
 * - **Not in `localStorage`.** History follows the notes, not the browser. Open
 *   the same server from a laptop and a phone and it is the same history.
 * - **One file per chat.** An index file would be a second source of truth that
 *   can disagree with the directory, which is the mistake the whole app avoids.
 */

/**
 * One source a retrieval-shaped tool call actually drew from. Mirrors
 * `spark-tools.ts`'s `ToolCitation` — duplicated rather than imported, the
 * same call this file already makes for `ChatMessage`/`ChatSegment`'s
 * shapes, and here it also sidesteps a real cycle: `spark-tools.ts` reaches
 * this file transitively through `chat-retrieval.ts`.
 */
export interface ChatCitation {
  label: string;
  page?: string;
  line?: number;
  chatId?: string;
  url?: string;
}

export interface ChatToolCall {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  /** One line a person can read, e.g. `Created "projects/spark"`. */
  summary: string;
  /** Pages the call touched, so a reread transcript can still link to them. */
  pages?: string[];
  /**
   * What the tool actually read, wrote or ran — `read_page`'s full text,
   * `run_code`'s stdout, `search`'s matched passages — capped for a person
   * to read (`spark.ts`'s `TOOL_DETAIL_UI_LIMIT`, smaller than what the
   * model itself is sent). Absent for a tool whose one-line `summary`
   * already says everything there is to say.
   */
  detail?: string;
  /** The passages/results behind this call, when it was a retrieval tool. */
  citations?: ChatCitation[];
}

/**
 * A reply as it actually happened, in order: a round of reasoning, the tool
 * calls it made, the next round of reasoning, and so on. Persisted so a
 * conversation reloaded from disk — or a variant switched to from one
 * generated earlier — shows the true interleaving instead of
 * `segmentsOf`'s thinking-then-tools-then-text fallback, which is the best
 * a message with only the flat `thinking`/`tools`/`text` fields below can
 * ever do. Mirrors the client's own live `Segment` type (`SparkView.tsx`)
 * minus `startedAt`, a wall-clock moment that means nothing once a turn is
 * saved.
 */
export type ChatSegment =
  | { kind: 'thinking'; text: string; elapsedMs?: number }
  | { kind: 'tools'; tools: ChatToolCall[] }
  | { kind: 'text'; text: string };

/** Tokens actually billed for a turn, summed across every round it took. */
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  /** A best-effort dollar estimate from `pricing.ts` — absent when the model isn't in its table. */
  costUsd?: number;
}

/** One of the replies "Try again" has produced for a single question. */
export interface AssistantVariant {
  text: string;
  tools?: ChatToolCall[];
  presented?: string[];
  thinking?: string;
  /** Wall-clock time spent thinking before the first token or tool call. */
  thinkingMs?: number;
  /** The true order this reply happened in — see `ChatSegment`. */
  segments?: ChatSegment[];
  /** Which model preset produced this reply. */
  modeId?: string;
  /** Which AI provider profile actually answered — the fallback, if the primary didn't. */
  providerId?: string;
  /** The model id the answering profile actually used. */
  model?: string;
  usage?: ChatUsage;
  at: number;
  /**
   * Set when this reply did not finish cleanly — a provider error, a dropped
   * connection, or the person hitting Stop. The text/tools/thinking already
   * captured before the failure are kept rather than discarded (the same
   * "kept, carrying its reason" instinct `files.ts` uses for an attachment
   * that couldn't be read), but this field is what tells a reader — and
   * `replayHistory`, which must not replay a truncated reply as if it were
   * a complete answer — that the turn is incomplete.
   */
  error?: string;
  /**
   * The messages that followed this reply when it was set aside for another —
   * what a switch back to this reply restores. Present only once the turn has
   * been regenerated or the conversation forked past it; the active variant's
   * future is the chat's own message list, not a branch.
   */
  branch?: ChatMessage[];
}

/** A prompt that was rewound to and re-sent: the earlier wording, and the conversation that followed it. */
export interface UserVariant {
  text: string;
  at: number;
  /** What came after this wording when the fork moved away from it, restored on switch-back. */
  branch?: ChatMessage[];
}

export type ChatVariant = AssistantVariant | UserVariant;

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  /** What Spark did while producing this reply. Assistant turns only. */
  tools?: ChatToolCall[];
  /** Pages presented during this reply — shown as a card, not opened. Assistant turns only. */
  presented?: string[];
  /** What Spark reasoned before answering. Assistant turns only, never sent back to the model. */
  thinking?: string;
  thinkingMs?: number;
  /** The true order this reply happened in. Assistant turns only. See `ChatSegment`. */
  segments?: ChatSegment[];
  /** Which model preset produced this reply. Assistant turns only. */
  modeId?: string;
  /** Which AI provider profile actually answered. Assistant turns only. See `AssistantVariant.providerId`. */
  providerId?: string;
  /** The model id the answering profile actually used. Assistant turns only. */
  model?: string;
  /** Tokens billed for this turn. Assistant turns only. */
  usage?: ChatUsage;
  /** Set when this reply did not finish cleanly. See `AssistantVariant.error`. */
  error?: string;
  at: number;
  /**
   * Every way this turn has been re-worded, oldest first — "Try again" replies
   * for an assistant turn, earlier wordings of a rewound-to prompt for a user
   * turn. Present only once the turn has been regenerated or forked at least
   * once. `text`/`tools`/`presented`/`thinking`/`thinkingMs`/`segments`/
   * `modeId`/`providerId`/`model`/`usage`/`error` above always mirror
   * `variants[activeVariant]`, so a message that was never regenerated needs
   * no special-casing to read.
   */
  variants?: ChatVariant[];
  activeVariant?: number;
}

export interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: ChatMessage[];
  /**
   * Hidden from the default list, not deleted. An archive is a second look
   * you may never take — the file stays, a flag says which list it belongs
   * to, and there is no separate store to get out of step.
   */
  archived?: boolean;
  /**
   * The project this conversation belongs to — a page under `Spark/projects/`
   * in the space. A name, not an id: the project lives in the space and the
   * chat file only points at it, so deleting the project page leaves a chat
   * that still reads fine (badge falls back to the raw name).
   */
  project?: string;
}

/** The listing view: everything but the messages. */
export interface ChatSummary {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: number;
  archived?: boolean;
  project?: string;
}

const MAX_MESSAGES = 400;

export class ChatStore {
  get #dir(): string {
    return join(config.stateDir, 'chats');
  }

  #fileFor(id: string): string {
    // The id is generated here and never comes from a request body without
    // passing this check, so a chat id can't be turned into a path.
    if (!/^[a-f0-9-]{6,64}$/i.test(id)) throw new Error('invalid chat id');
    return join(this.#dir, `${id}.json`);
  }

  /**
   * One chain of promises per chat id, so two mutations of the same
   * conversation — a double-submitted message, a regenerate fired while the
   * original turn is still streaming, two tabs open on the same chat — run
   * one after the other instead of racing a read-modify-write against each
   * other. There is no cross-process lock here (nothing needs one: a single
   * server process is the only writer), just an in-process queue.
   */
  #locks = new Map<string, Promise<unknown>>();

  /**
   * Runs `fn` after every mutation already queued for `id` has settled, and
   * queues it as the new tail. A failed mutation does not poison the chain —
   * the next caller's `fn` still runs, re-reading the file fresh — and the
   * map entry is dropped once nothing is left queued for `id`, so a chat
   * nobody is writing to doesn't hold a promise forever.
   */
  async #serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.#locks.get(id) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.#locks.set(id, settled);
    void settled.then(() => {
      if (this.#locks.get(id) === settled) this.#locks.delete(id);
    });
    return run;
  }

  async list(includeArchived = false): Promise<ChatSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }

    const all: ChatSummary[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const chat = await this.read(name.replace(/\.json$/, '')).catch(() => null);
      if (!chat) continue;
      all.push({
        id: chat.id,
        title: chat.title,
        created: chat.created,
        updated: chat.updated,
        messages: chat.messages.length,
        archived: chat.archived,
        project: chat.project,
      });
    }

    return all
      .filter((chat) => (includeArchived ? true : !chat.archived))
      .sort((a, b) => b.updated - a.updated);
  }

  /**
   * Every chat, in full — messages included, archived included (an archived
   * chat is hidden from the default list, not forgotten; `search_past_chats`
   * has no reason to forget it either). Used by `chat-retrieval.ts` to build
   * chunks for a turn's own recall of prior conversations, on demand and
   * uncached, the same "no index that can disagree with the directory" rule
   * `list()` and `search()` already follow.
   */
  async readAll(excludeId?: string): Promise<Chat[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }
    const ids = names
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.replace(/\.json$/, ''))
      .filter((id) => id !== excludeId);
    const chats = await Promise.all(ids.map((id) => this.read(id).catch(() => null)));
    return chats.filter((chat): chat is Chat => chat !== null);
  }

  /**
   * Conversations whose title or any message mentions `query`.
   *
   * The titles alone can't answer "where did I write that" — the phrase being
   * hunted is usually inside a reply — so each chat is read in full once the
   * cheap title test misses. `list()` already reads every file for its
   * summaries, so an index would be a second source of truth that can disagree
   * with the directory; scanning on demand is the same call the rest of the
   * app makes for tasks and backlinks.
   */
  async search(query: string): Promise<ChatSummary[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const results: ChatSummary[] = [];
    for (const summary of await this.list()) {      if (summary.title.toLowerCase().includes(needle)) {
        results.push(summary);
        continue;
      }
      const chat = await this.read(summary.id).catch(() => null);
      if (chat?.messages.some((message) => message.text.toLowerCase().includes(needle))) {
        results.push(summary);
      }
    }
    return results.slice(0, 50);
  }

  async read(id: string): Promise<Chat> {
    const raw = await readFile(this.#fileFor(id), 'utf8');
    const parsed = JSON.parse(raw) as Chat;
    return {
      id: parsed.id ?? id,
      title: parsed.title ?? 'Untitled',
      created: parsed.created ?? Date.now(),
      updated: parsed.updated ?? Date.now(),
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      archived: parsed.archived,
      project: parsed.project,
    };
  }

  async create(title = 'New conversation'): Promise<Chat> {
    const now = Date.now();
    const chat: Chat = { id: randomUUID(), title, created: now, updated: now, messages: [] };
    await this.#write(chat);
    return chat;
  }

  /** Reads a chat, creating it if the id is unknown. */
  async ensure(id: string | undefined): Promise<Chat> {
    if (!id) return this.create();
    try {
      return await this.read(id);
    } catch {
      return this.create();
    }
  }

  async append(id: string, ...messages: ChatMessage[]): Promise<Chat> {
    return this.#serialize(id, async () => {
      const chat = await this.read(id);
      chat.messages.push(...messages);

      // A conversation that runs forever is a file that grows forever. Trimming
      // the oldest keeps the recent context, which is the part that is used.
      if (chat.messages.length > MAX_MESSAGES) {
        chat.messages = chat.messages.slice(-MAX_MESSAGES);
      }

      chat.updated = Date.now();
      // The first thing you said is a better name than anything generated, and it
      // costs nothing.
      if (chat.title === 'New conversation') {
        const first = chat.messages.find((message) => message.role === 'user');
        if (first) chat.title = titleFrom(first.text);
      }

      await this.#write(chat);
      return chat;
    });
  }

  /**
   * Replace the assistant reply at `index` with a new one, keeping the old
   * content as a variant to switch back to rather than losing it. Everything
   * stored after `index` leaves the active line — the same "regenerating an
   * older turn discards what came after" behaviour the transcript already has,
   * now correctly reflected in what's on disk instead of silently diverging
   * from it — but it is kept as the old reply's branch, so switching back to
   * that reply restores it rather than losing it to the rewrite.
   */
  async regenerate(id: string, index: number, variant: AssistantVariant): Promise<Chat> {
    return this.#serialize(id, async () => {
      const chat = await this.read(id);
      const target = chat.messages[index];
      if (!target || target.role !== 'assistant') {
        throw new Error(`Message ${index} is not an assistant reply`);
      }

      const variants =
        target.variants?.map((existing) => ({ ...existing })) ??
        ([
          {
            text: target.text,
            tools: target.tools,
            presented: target.presented,
            thinking: target.thinking,
            thinkingMs: target.thinkingMs,
            segments: target.segments,
            modeId: target.modeId,
            providerId: target.providerId,
            model: target.model,
            usage: target.usage,
            error: target.error,
            at: target.at,
          },
        ] satisfies AssistantVariant[]);
      const tail = chat.messages.slice(index + 1);
      this.#parkActiveBranch(variants, target.activeVariant, tail);
      variants.push(variant);

      const updated: ChatMessage = { ...target, ...variant, variants, activeVariant: variants.length - 1 };
      chat.messages = [...chat.messages.slice(0, index), updated];
      chat.updated = Date.now();
      await this.#write(chat);
      return chat;
    });
  }

  /**
   * Continue from a prompt that was rewound to.
   *
   * The new wording replaces the old one at `index` and becomes its newest
   * variant; everything that followed the old wording leaves the active line —
   * it is not sent to the model and no longer shows in the transcript — but
   * stays reachable as that variant's branch, so a switch back to the earlier
   * wording brings its conversation with it. Forking keeps both paths of a
   * rewind instead of the alternative: the old request or the responses beyond
   * it being sent again by mistake.
   */
  async rewindAndAppend(
    id: string,
    index: number,
    userMessage: ChatMessage,
    reply: ChatMessage,
  ): Promise<Chat> {
    return this.#serialize(id, async () => {
      const chat = await this.read(id);
      const prior = chat.messages[index];
      if (!prior || prior.role !== 'user') {
        throw new Error(`Message ${index} is not a prompt`);
      }

      const variants =
        prior.variants?.map((existing) => ({ ...existing })) ??
        ([{ text: prior.text, at: prior.at }] satisfies UserVariant[]);
      this.#parkActiveBranch(variants, prior.activeVariant, chat.messages.slice(index + 1));
      variants.push({ text: userMessage.text, at: userMessage.at });

      const updated: ChatMessage = { ...prior, ...userMessage, variants, activeVariant: variants.length - 1 };
      chat.messages = [...chat.messages.slice(0, index), updated, reply];
      chat.updated = Date.now();

      if (chat.title === 'New conversation') {
        const first = chat.messages.find((message) => message.role === 'user');
        if (first) chat.title = titleFrom(first.text);
      }

      await this.#write(chat);
      return chat;
    });
  }

  /**
   * Point a forked turn at a different one of its stored wordings, forking the
   * future to match. The conversation that currently follows the turn is saved
   * on the variant it belongs to, and the variant being switched to brings its
   * own — so two rewordings of the same turn each keep the conversation that
   * grew under them, and switching between them is switching between branches.
   */
  async setActiveVariant(id: string, index: number, variantIndex: number): Promise<Chat> {
    return this.#serialize(id, async () => {
      const chat = await this.read(id);
      const target = chat.messages[index];
      const variants = target?.variants?.map((existing) => ({ ...existing }));
      const variant = variants?.[variantIndex];
      if (!variant) throw new Error(`No such variant`);

      this.#parkActiveBranch(variants, target.activeVariant, chat.messages.slice(index + 1));

      const { branch, ...content } = variant;
      chat.messages = [
        ...chat.messages.slice(0, index),
        { ...target, ...content, variants, activeVariant: variantIndex },
        ...(branch ?? []),
      ];
      chat.updated = Date.now();
      await this.#write(chat);
      return chat;
    });
  }

  async rename(id: string, title: string): Promise<Chat> {
    return this.#serialize(id, async () => {
      const chat = await this.read(id);
      chat.title = title.trim().slice(0, 120) || chat.title;
      chat.updated = Date.now();
      await this.#write(chat);
      return chat;
    });
  }

  async setArchived(id: string, archived: boolean): Promise<Chat> {
    return this.#serialize(id, async () => {
      const chat = await this.read(id);
      chat.archived = archived;
      chat.updated = Date.now();
      await this.#write(chat);
      return chat;
    });
  }

  /**
   * Moves a conversation into a project — see `Chat.project`. An empty value
   * detaches it again; the project itself is never touched, because a project
   * is a page in the space and only this pointer belongs to the chat.
   */
  async setProject(id: string, project: string | null): Promise<Chat> {
    return this.#serialize(id, async () => {
      const chat = await this.read(id);
      chat.project = project ? project.slice(0, 120) : undefined;
      chat.updated = Date.now();
      await this.#write(chat);
      return chat;
    });
  }

  async delete(id: string): Promise<void> {
    await this.#serialize(id, async () => {
      await rm(this.#fileFor(id), { force: true });
    });
  }

  /**
   * The active variant's future is the chat's own message list, never a stored
   * branch. When a turn is forked or switched away from, that future has to
   * move onto the variant before the line is rewritten — this is what keeps
   * each wording's branch intact across switches, so a branch that grew since
   * it was last shown isn't lost when another one takes its place. An empty
   * tail is nothing to preserve, and an empty branch is stored as absent.
   */
  #parkActiveBranch(variants: ChatVariant[], activeVariant: number | undefined, tail: ChatMessage[]): void {
    if (tail.length === 0) return;
    const active = activeVariant ?? 0;
    const current = variants[active];
    if (!current) return;
    variants[active] = { ...current, branch: tail };
  }

  /**
   * Written to a temp file and renamed into place, rather than a direct
   * `writeFile`, so a process crash or a `writeFile` that only landed part of
   * its buffer never leaves the chat's own file half-written — `rename()` on
   * the same filesystem is atomic, so a reader always sees either the old
   * content or the new one, never a truncated mix of both. Callers already go
   * through `#serialize`, so this only has to be safe against the process
   * dying mid-write, not against another write racing it.
   */
  async #write(chat: Chat): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const file = this.#fileFor(chat.id);
    const tmp = join(this.#dir, `.${chat.id}.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(chat, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  }
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New conversation';
}

/**
 * The one instance, shared by every module that touches chats —
 * `index.ts`'s routes and `chat-retrieval.ts`'s past-conversation search
 * alike. Not optional: `#locks` (the per-chat write-serialization map that
 * fixes the concurrent-write race) only does its job if there is exactly
 * one of it in the process. A second `new ChatStore()` anywhere would be
 * two independent lock maps agreeing on nothing.
 */
export const chats = new ChatStore();
