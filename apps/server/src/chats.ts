import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

export interface ChatToolCall {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  /** One line a person can read, e.g. `Created "projects/spark"`. */
  summary: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  /** What Spark did while producing this reply. Assistant turns only. */
  tools?: ChatToolCall[];
  at: number;
}

export interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: ChatMessage[];
}

/** The listing view: everything but the messages. */
export interface ChatSummary {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: number;
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

  async list(): Promise<ChatSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }

    const chats = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const chat = await this.read(name.replace(/\.json$/, '')).catch(() => null);
          if (!chat) return null;
          return {
            id: chat.id,
            title: chat.title,
            created: chat.created,
            updated: chat.updated,
            messages: chat.messages.length,
          } satisfies ChatSummary;
        }),
    );

    return chats
      .filter((chat): chat is ChatSummary => chat !== null)
      .sort((a, b) => b.updated - a.updated);
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
  }

  async rename(id: string, title: string): Promise<Chat> {
    const chat = await this.read(id);
    chat.title = title.trim().slice(0, 120) || chat.title;
    chat.updated = Date.now();
    await this.#write(chat);
    return chat;
  }

  async delete(id: string): Promise<void> {
    await rm(this.#fileFor(id), { force: true });
  }

  async #write(chat: Chat): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await writeFile(this.#fileFor(chat.id), JSON.stringify(chat, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New conversation';
}
