import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { aiSettings, describeFailure } from './ai.js';
import { embeddingEndpointOf, type AiSettings } from './ai-settings.js';
import { config } from './config.js';
import { fetchWithRetry } from './retry.js';
import type { FileSpace } from './space.js';

/**
 * Finding things by meaning.
 *
 * Two rankers over the same chunks, fused. The lexical half is BM25, which needs
 * no model, no key and no network, and is a real improvement on the substring
 * `search` tool on its own — it ranks, it weights rare words, and it does not
 * care about word order. The dense half is embeddings, and it is *optional*: it
 * turns on when an embedding model is configured and is simply absent otherwise.
 *
 * That split is the point. Anthropic has no embeddings endpoint, so a design that
 * required vectors would leave Claude users with no search at all, and a design
 * that shipped a local ONNX model would put a model download in the boot path of
 * a notes app. Lexical always works; dense is an upgrade you opt into.
 *
 * Three decisions worth keeping:
 *
 * - **Chunks are built on demand, never indexed.** `/api/tasks`, `/api/tags` and
 *   backlinks already scan the space per request, for the reason this app exists:
 *   a folder of markdown can be edited by anything, so a stored index is wrong the
 *   moment you touch a file in vim. Chunking is a string split, and it costs
 *   nothing next to reading the files.
 * - **Vectors are cached by the hash of the chunk text.** This is what removes all
 *   the staleness logic: edit a page and its chunks hash differently, so they miss
 *   the cache and are re-embedded, and nothing has to track revisions or
 *   invalidate anything. The cache is disposable — deleting
 *   `.spark/embeddings.json` costs one re-embed and nothing else.
 * - **The two lists are fused with reciprocal rank, not by mixing scores.** A
 *   BM25 score and a cosine similarity are numbers on unrelated scales, and
 *   whatever weight you pick to add them is a calibration that goes wrong on
 *   somebody else's notes. RRF only reads *positions*, so it needs no tuning and
 *   cannot be miscalibrated. Vellum reaches for a PCA step to make cosine
 *   distances behave; ranks make the question not arise.
 */

export interface Chunk {
  page: string;
  /** Zero-based line the chunk starts on, so a hit can be cited. */
  line: number;
  text: string;
  /** Nearest heading above the chunk, for context in the result. */
  heading?: string;
}

export interface Hit extends Chunk {
  /** Fused rank score. Only meaningful relative to the other hits. */
  score: number;
  /** Which rankers found it, for the summary line. */
  found: Array<'text' | 'meaning'>;
}

export interface FindResult {
  hits: Hit[];
  /** True when the dense half ran. */
  semantic: boolean;
  /** Why it did not, when it did not. */
  note?: string;
}

/** Target chunk size in characters. A paragraph or two. */
const CHUNK_CHARS = 900;

/** Chunks past this are ignored by the dense half, to bound cost. */
const MAX_DENSE_CHUNKS = 2000;

/** Embedding inputs per request. */
const BATCH = 64;

/** Cached vectors. Beyond this the oldest are dropped. */
const MAX_CACHED = 6000;

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Splits a page into chunks on blank lines, tracking the heading above each.
 *
 * Blank lines rather than a fixed window, so a chunk is a thought rather than a
 * slice: retrieval that returns half a sentence makes the model guess at the
 * other half. Code fences are kept whole for the same reason.
 */
export function chunkPage(page: string, text: string): Chunk[] {
  const lines = text.split('\n');
  const chunks: Chunk[] = [];

  let heading: string | undefined;
  let buffer: string[] = [];
  let start = 0;
  let inFence = false;

  const flush = () => {
    const body = buffer.join('\n').trim();
    buffer = [];
    if (body.length < 12) return;
    chunks.push({ page, line: start, text: body.slice(0, CHUNK_CHARS * 2), heading });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;

    if (!inFence) {
      const found = /^(#{1,6})\s+(.*)$/.exec(line);
      if (found) {
        flush();
        heading = found[2].trim();
        start = i;
        continue;
      }
      if (!line.trim()) {
        if (buffer.join('\n').trim().length >= CHUNK_CHARS) flush();
        if (buffer.length === 0) start = i + 1;
        else buffer.push('');
        continue;
      }
    }

    if (buffer.length === 0) start = i;
    buffer.push(line);
  }

  flush();
  return chunks;
}

export async function chunkSpace(space: FileSpace): Promise<Chunk[]> {
  const pages = await space.readAllMarkdown();
  return pages.flatMap((page) => chunkPage(page.name, page.text));
}

// ---------------------------------------------------------------------------
// BM25
// ---------------------------------------------------------------------------

const K1 = 1.2;
const B = 0.75;

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((word) => word.length > 1 && word.length < 40);

/** Ranks chunks lexically. Returns indices into `chunks`, best first. */
export function bm25(chunks: Chunk[], query: string, limit: number): number[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const docs = chunks.map((chunk) => tokenize(`${chunk.heading ?? ''} ${chunk.text}`));
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / (docs.length || 1);

  // Document frequency, over the query's terms only — there is no reason to
  // count words nobody asked about.
  const frequency = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set(doc);
    for (const term of terms) if (seen.has(term)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }

  const scored = docs.map((doc, index) => {
    const counts = new Map<string, number>();
    for (const word of doc) counts.set(word, (counts.get(word) ?? 0) + 1);

    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term);
      if (!tf) continue;
      const df = frequency.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (doc.length / (avgLength || 1)))));
    }
    return { index, score };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.index);
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

type VectorCache = Record<string, number[]>;

/**
 * Vectors on disk, keyed by the hash of the text they describe.
 *
 * Held in memory for the life of the process and written back after a search
 * that added anything, rather than on every insert: a search over a fresh space
 * embeds hundreds of chunks and writing the file each time would be hundreds of
 * writes of a growing file.
 */
class EmbeddingCache {
  #vectors: VectorCache | null = null;
  #dirty = false;

  get #file(): string {
    return join(config.stateDir, 'embeddings.json');
  }

  async #load(): Promise<VectorCache> {
    if (this.#vectors) return this.#vectors;
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as VectorCache;
      this.#vectors = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      // Missing, corrupt or from an older shape: it is a cache, so start again.
      this.#vectors = {};
    }
    return this.#vectors;
  }

  async get(keys: string[]): Promise<Map<string, number[]>> {
    const vectors = await this.#load();
    const found = new Map<string, number[]>();
    for (const key of keys) {
      const vector = vectors[key];
      if (Array.isArray(vector)) found.set(key, vector);
    }
    return found;
  }

  async put(entries: Array<[string, number[]]>): Promise<void> {
    const vectors = await this.#load();
    for (const [key, vector] of entries) vectors[key] = vector;
    this.#dirty = this.#dirty || entries.length > 0;

    const keys = Object.keys(vectors);
    if (keys.length > MAX_CACHED) {
      // Insertion order is the closest thing to recency available here, and a
      // wrong eviction costs one re-embed.
      for (const key of keys.slice(0, keys.length - MAX_CACHED)) delete vectors[key];
    }
  }

  async flush(): Promise<void> {
    if (!this.#dirty || !this.#vectors) return;
    this.#dirty = false;
    try {
      await mkdir(config.stateDir, { recursive: true });
      await writeFile(this.#file, JSON.stringify(this.#vectors), { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* a cache that cannot be written is still a cache in memory */
    }
  }

  /** Forgets everything. Exposed so Settings can offer it. */
  async clear(): Promise<void> {
    this.#vectors = {};
    this.#dirty = true;
    await this.flush();
  }
}

const cache = new EmbeddingCache();

export const clearEmbeddings = (): Promise<void> => cache.clear();

/** Whether the dense half can run at all. */
export function embeddingsEnabled(settings: AiSettings = aiSettings.get()): boolean {
  return settings.embedModel.trim().length > 0;
}

/**
 * Embeds texts through the OpenAI-compatible `/embeddings` shape.
 *
 * One shape rather than one per provider: OpenAI, Voyage, Ollama, LM Studio,
 * llama.cpp and vLLM all serve it, and a provider that does not is configured by
 * pointing `embedEndpoint` at something that does.
 */
async function embed(texts: string[], settings: AiSettings, signal?: AbortSignal): Promise<number[][]> {
  const base = embeddingEndpointOf(settings);
  const url = /\/embeddings$/.test(base) ? base : `${base}/embeddings`;
  const key = settings.embedKey.trim() || settings.apiKey;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: settings.embedModel.trim(), input: texts.slice(i, i + BATCH) }),
      signal,
    });
    if (!res.ok) throw new Error(await describeFailure(res));

    const body = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    for (const entry of body.data ?? []) {
      if (Array.isArray(entry.embedding)) out.push(entry.embedding);
    }
  }

  if (out.length !== texts.length) {
    throw new Error('the embedding endpoint returned a different number of vectors than it was sent');
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const keyOf = (text: string, model: string): string =>
  createHash('sha256').update(`${model}\n${text}`).digest('hex').slice(0, 24);

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

/** Reciprocal rank fusion. `k` damps the top of each list; 60 is the usual value. */
const RRF_K = 60;

export async function find(
  space: FileSpace,
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<FindResult> {
  const chunks = await chunkSpace(space);
  return findInChunks(chunks, query, { ...options, emptyNote: 'the space is empty' });
}

/**
 * The ranking core of `find()`, pulled out so a caller with a different
 * source of chunks — `chat-retrieval.ts`'s past-conversation search is the
 * one that exists today — gets the same BM25+embeddings fusion rather than
 * a second, drifting implementation of it. `find()` itself is now the thin
 * "chunk the space, then this" wrapper.
 */
export async function findInChunks(
  chunks: Chunk[],
  query: string,
  options: { limit?: number; signal?: AbortSignal; emptyNote?: string } = {},
): Promise<FindResult> {
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 30);
  if (chunks.length === 0) return { hits: [], semantic: false, note: options.emptyNote ?? 'nothing to search' };

  // Deeper than `limit` on purpose: fusion is only interesting if each list has
  // candidates the other missed.
  const lexical = bm25(chunks, query, limit * 4);

  let dense: number[] = [];
  let semantic = false;
  let note: string | undefined;

  const settings = aiSettings.get();
  if (embeddingsEnabled(settings)) {
    try {
      const ranked = await denseRank(chunks, query, settings, limit * 4, options.signal);
      dense = ranked.indices;
      semantic = true;
      if (ranked.truncated) {
        note = `The space has more than ${MAX_DENSE_CHUNKS} passages, so semantic search only considered the ${MAX_DENSE_CHUNKS} most textually relevant to this query — a passage that shares none of the query's words could still be missed.`;
      }
    } catch (err) {
      // A failed embedding call must not fail the search: BM25 already has an
      // answer, and "no results" would be a worse lie than "fewer results".
      note = `Semantic search is configured but failed: ${err instanceof Error ? err.message : String(err)}. These results are text matches only.`;
    }
  } else {
    note = 'Text matching only — no embedding model is configured.';
  }

  const scores = new Map<number, { score: number; found: Set<'text' | 'meaning'> }>();
  const fuse = (ranked: number[], label: 'text' | 'meaning') => {
    ranked.forEach((index, position) => {
      const entry = scores.get(index) ?? { score: 0, found: new Set<'text' | 'meaning'>() };
      entry.score += 1 / (RRF_K + position + 1);
      entry.found.add(label);
      scores.set(index, entry);
    });
  };

  fuse(lexical, 'text');
  fuse(dense, 'meaning');

  const hits = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([index, entry]) => ({ ...chunks[index], score: entry.score, found: [...entry.found] }));

  return { hits, semantic, note };
}

/**
 * The candidates dense re-ranking will actually embed and compare. Bounded
 * to `MAX_DENSE_CHUNKS` to cap cost, but *which* chunks fill that bound
 * matters: on a space bigger than the bound, cutting by file-enumeration
 * order could drop a whole topic that happens to sit past it, silently,
 * every time. Picking by BM25 relevance instead means the chunks dropped
 * are the ones that share the fewest of the query's own words with it —
 * a much smaller loss, and `findInChunks` tells the caller it happened.
 */
function candidatesFor(chunks: Chunk[], query: string): { considered: Chunk[]; indexMap: number[]; truncated: boolean } {
  if (chunks.length <= MAX_DENSE_CHUNKS) {
    return { considered: chunks, indexMap: chunks.map((_, i) => i), truncated: false };
  }
  const indexMap = bm25(chunks, query, MAX_DENSE_CHUNKS);
  return { considered: indexMap.map((i) => chunks[i]), indexMap, truncated: true };
}

async function denseRank(
  chunks: Chunk[],
  query: string,
  settings: AiSettings,
  limit: number,
  signal?: AbortSignal,
): Promise<{ indices: number[]; truncated: boolean }> {
  const model = settings.embedModel.trim();
  const { considered, indexMap, truncated } = candidatesFor(chunks, query);
  const keys = considered.map((chunk) => keyOf(embedText(chunk), model));

  const known = await cache.get(keys);
  const missing = keys
    .map((key, index) => ({ key, index }))
    .filter((entry) => !known.has(entry.key));

  if (missing.length > 0) {
    const vectors = await embed(
      missing.map((entry) => embedText(considered[entry.index])),
      settings,
      signal,
    );
    await cache.put(missing.map((entry, i) => [entry.key, vectors[i]] as [string, number[]]));
    missing.forEach((entry, i) => known.set(entry.key, vectors[i]));
    void cache.flush();
  }

  // The query is embedded every time and never cached: it is one call, and a
  // cache of every phrase anyone has ever searched for is a log of their
  // searching, which is not something this app should keep.
  const [queryVector] = await embed([query], settings, signal);

  const indices = considered
    .map((_, index) => {
      const vector = known.get(keys[index]);
      return { index, score: vector ? cosine(queryVector, vector) : -1 };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    // Back to the original `chunks` indices — `considered` may be a
    // relevance-picked subset, not a prefix of `chunks`.
    .map((entry) => indexMap[entry.index]);

  return { indices, truncated };
}

/** The heading travels with the chunk: it is often the only topical word in it. */
function embedText(chunk: Chunk): string {
  const where = chunk.heading ? `${chunk.page} — ${chunk.heading}` : chunk.page;
  return `${where}\n\n${chunk.text}`.slice(0, 6000);
}
