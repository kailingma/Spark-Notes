import { chats, type Chat } from './chats.js';
import { bm25, findInChunks, type Chunk, type FindResult } from './retrieval.js';

/**
 * Finding things Spark said, or was told, in a *different* conversation.
 *
 * `find()` in `retrieval.ts` answers "what's in the notes"; this answers
 * "what did we already discuss" — the gap memory's four files were never
 * meant to close (`memory.ts`'s own doc comment: "memory holds only what
 * the notes cannot... a second graph over the first would be the stale
 * index this app exists to avoid"). A past *conversation* is not a note and
 * was never going to be promoted into one, so recalling it needs its own
 * path — this one, built on the exact same chunk-and-rank machinery
 * `find()` uses, so a chat hit is ranked the same principled way a note hit
 * is.
 *
 * Chunked on demand, per call, the same "no index that can disagree with
 * the directory" rule every other retrieval in this app follows — a chat
 * transcript changes rarely enough (each save is append-only) that this
 * costs nothing next to reading the files.
 */

/** Target chunk size, matching `retrieval.ts`'s `CHUNK_CHARS` — same granularity, same reasoning. */
const CHUNK_CHARS = 900;

/** Turns one chat's messages into chunks. Each chunk knows which chat and which message it came from. */
export function chunkChat(chat: Chat): Chunk[] {
  const chunks: Chunk[] = [];

  chat.messages.forEach((message, index) => {
    const text = message.text.trim();
    if (!text) return;

    // Simple paragraph-window splitting — a chat message is prose, not a
    // page with headings and code fences to respect, so it doesn't need
    // `chunkPage`'s markdown-structural passes, just its target size.
    const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let buffer = '';
    const flush = () => {
      const body = buffer.trim();
      buffer = '';
      if (body.length < 12) return;
      chunks.push({
        page: `chat:${chat.id}`,
        line: index,
        text: body.slice(0, CHUNK_CHARS * 2),
        // The chat's title travels as the heading, the same role a page's
        // nearest heading plays — it is often the only topical word near a
        // short reply, and `bm25` already scores headings alongside the body.
        heading: chat.title,
      });
    };

    for (const paragraph of paragraphs) {
      if (buffer && buffer.length + paragraph.length > CHUNK_CHARS) flush();
      buffer += (buffer ? '\n\n' : '') + paragraph;
    }
    flush();
  });

  return chunks;
}

/** Every other chat's chunks, excluding the one currently open — recalling *other* conversations, not re-reading this one. */
export async function chunkPastChats(excludeId?: string): Promise<Chunk[]> {
  const all = await chats.readAll(excludeId);
  return all.flatMap(chunkChat);
}

/**
 * Full BM25+embeddings search over past chats — what `search_past_chats`
 * (`spark-tools.ts`) calls. A hit's `page` reads `chat:<id>`; the chat's
 * title is on `heading`.
 */
export async function findInPastChats(
  query: string,
  excludeId: string | undefined,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<FindResult> {
  const chunks = await chunkPastChats(excludeId);
  return findInChunks(chunks, query, { ...options, emptyNote: 'there are no other conversations yet' });
}

/**
 * The narrow, BM25-only half `memory.ts`'s consolidation pass uses when
 * `deepMemory` is on — never embeddings, so a synchronous pass someone is
 * waiting through never pays for an extra round of API calls it didn't ask
 * for. Returns the raw chunks, not a full `FindResult`: consolidation wants
 * source material for its own prompt, not a ranked-hits response shape.
 */
export async function bm25PastChats(
  query: string,
  excludeId: string | undefined,
  limit = 5,
): Promise<Chunk[]> {
  const chunks = await chunkPastChats(excludeId);
  const indices = bm25(chunks, query, limit);
  return indices.map((index) => chunks[index]);
}
