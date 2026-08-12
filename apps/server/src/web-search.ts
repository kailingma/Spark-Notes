/**
 * Web search — a provider registry instead of a single engine.
 *
 * One tool (`web_search`), many engines behind it. All of them resolve to the
 * same flattened row — `title`, `url`, `text` (full page text or a snippet;
 * that difference is the one honest caveat) and an optional `published` date —
 * because that is the only shape the model and the transcript ever see. An
 * engine that returns snippets where another returns full text does not get to
 * masquerade as the other: `web_search`'s descriptions depend on which engine
 * is active (see `returnsText` in `search-providers.ts`), so a model never
 * promises to read a page it is only going to get a snippet of.
 *
 * The active engine is chosen in Settings, not here. This file only knows how
 * to turn a query into results for whichever engine the store currently says
 * is active, and every engine is exactly as reachable as the Exa adapter used
 * to be.
 */

import { fetchWithRetry } from './retry.js';
import { searchProviderMeta, providerReady, type SearchProviderId } from './search-providers.js';
import { sparkSettings } from './spark-settings.js';

export interface WebResult {
  title: string;
  url: string;
  /** Full page text for some engines, a snippet for others. */
  text: string;
  /** ISO date, where the engine provides one. */
  published?: string;
}

/** Characters of page text / snippet to keep per result. */
export const MAX_TEXT = 4000;

interface SearchOptions {
  limit?: number;
  signal?: AbortSignal;
  key: string;
  endpoint: string;
}

type SearchFn = (query: string, opts: SearchOptions) => Promise<WebResult[]>;

const clampLimit = (limit: number | undefined): number =>
  Math.min(Math.max(Math.round(limit ?? 5), 1), 10);

/** A result row `undefined`-safe: flatten a number or object to a string. */
const oneLine = (v: unknown): string => String(v ?? '').replace(/\s*\n\s*/g, ' ').trim();

/** Turn a non-2xx response into a sentence, not a stack trace. */
async function readJson(res: Response, provider: string): Promise<unknown> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const detail = body.trim() ? `: ${body.trim().slice(0, 200)}` : '';
    throw new Error(`${provider} refused the search (${res.status})${detail}`);
  }
  return res.json();
}

/** A row an engine returned, reduced to the one shape the app knows. */
function fromRow(raw: unknown): WebResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const first = (...keys: string[]): unknown => {
    for (const k of keys) if (row[k] != null) return row[k];
    return undefined;
  };
  const url = oneLine(first('url', 'link', 'href', 'webpage_url'));
  if (!url) return null;
  const title = oneLine(first('title', 'name', 'heading')) || url;
  // `text` sits last on purpose: `contents.text` is the Exa field, and the
  // engines that return full text tend to call it something obvious.
  const text = oneLine(first('content', 'snippet', 'description', 'text', 'body', 'abstract'));
  const publishedRaw = first('published', 'published_date', 'publishedDate', 'date', 'age');
  return {
    title,
    url,
    text,
    ...(publishedRaw ? { published: oneLine(publishedRaw).slice(0, 10) } : {}),
  };
}

/** Map a response's result list through `fromRow`, dropping the unusable rows. */
function toResults(list: unknown[]): WebResult[] {
  return list.map(fromRow).filter((r): r is WebResult => r !== null);
}

/** Pull the result list out of the half-dozen shapes search APIs actually use. */
function asList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  const o = json as Record<string, unknown>;
  if (Array.isArray(o.results)) return o.results;
  if (Array.isArray(o.data)) return o.data;
  if (Array.isArray(o.organic)) return o.organic;
  if (Array.isArray(o.items)) return o.items;
  const web = o.web;
  if (web && typeof web === 'object' && Array.isArray((web as Record<string, unknown>).results)) {
    return (web as Record<string, unknown>).results as unknown[];
  }
  return [];
}

async function searchExa(query: string, opts: SearchOptions): Promise<WebResult[]> {
  const res = await fetchWithRetry('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': opts.key },
    body: JSON.stringify({
      query,
      numResults: clampLimit(opts.limit),
      type: 'auto',
      contents: { text: { maxCharacters: MAX_TEXT } },
    }),
    signal: opts.signal,
  });
  const json = await readJson(res, 'Exa');
  return toResults(asList(json));
}

async function searchTavily(query: string, opts: SearchOptions): Promise<WebResult[]> {
  const res = await fetchWithRetry('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${opts.key}` },
    body: JSON.stringify({ query, max_results: clampLimit(opts.limit), search_depth: 'advanced' }),
    signal: opts.signal,
  });
  const json = await readJson(res, 'Tavily');
  return toResults(asList(json));
}
async function searchBrave(query: string, opts: SearchOptions): Promise<WebResult[]> {
  const params = new URLSearchParams({ q: query, count: String(clampLimit(opts.limit)) });
  const res = await fetchWithRetry(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': opts.key },
    signal: opts.signal,
  });
  const json = await readJson(res, 'Brave');
  return toResults(asList(json));
}

async function searchSerper(query: string, opts: SearchOptions): Promise<WebResult[]> {
  const res = await fetchWithRetry('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-KEY': opts.key },
    body: JSON.stringify({ q: query, num: clampLimit(opts.limit) }),
    signal: opts.signal,
  });
  const json = await readJson(res, 'Serper');
  return toResults(asList(json));
}

async function searchMojeek(query: string, opts: SearchOptions): Promise<WebResult[]> {
  const params = new URLSearchParams({ q: query, fmt: 'json', api_key: opts.key });
  const res = await fetchWithRetry(`https://www.mojeek.com/search?${params}`, { signal: opts.signal });
  const json = await readJson(res, 'Mojeek');
  return toResults(asList(json));
}

/** DuckDuckGo has no JSON API, so we scrape the page people actually see. */
async function searchDdg(query: string, opts: SearchOptions): Promise<WebResult[]> {
  const params = new URLSearchParams({ q: query });
  const res = await fetchWithRetry(`https://html.duckduckgo.com/html/?${params}`, {
    headers: { accept: 'text/html' },
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo refused the search (${res.status}).`);
  return parseDdg(await res.text()).slice(0, clampLimit(opts.limit));
}

/**
 * The HTML DDG returns is regular enough to pull anchors and their snippets
 * out with two regexes. This is a scraper, not an API: it works today, and the
 * meta's `hint` is the honest part — say "fragile" once, up front.
 */
function parseDdg(html: string): WebResult[] {
  const strip = (frag: string): string =>
    frag
      .replace(/<[^>]+>/g, '')
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .trim();

  const anchorRe = /class="result__a" rel="nofollow" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const anchors: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];
  let m: RegExpExecArray | null;

  anchorRe.lastIndex = 0;
  while ((m = anchorRe.exec(html)) !== null) {
    let url = m[1];
    // Links are wrapped in a redirector: //duckduckgo.com/l/?uddg=<encoded>&rut=…
    const inner = /uddg=([^&]+)/.exec(url);
    if (inner) {
      try {
        url = decodeURIComponent(inner[1]);
      } catch {
        /* keep the wrapped URL — still a real link */
      }
    }
    anchors.push({ url, title: strip(m[2]) });
  }
  snippetRe.lastIndex = 0;
  while ((m = snippetRe.exec(html)) !== null) snippets.push(strip(m[1]));

  const out: WebResult[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const { url, title } = anchors[i];
    if (!url) continue;
    out.push({ title: title || url, url, text: (snippets[i] ?? '').slice(0, MAX_TEXT) });
  }
  return out;
}

/** SearXNG: the endpoint serves JSON when asked, and may demand a key. */
async function searchSearxng(query: string, opts: SearchOptions): Promise<WebResult[]> {
  const base = opts.endpoint.trim().replace(/\/+$/, '');
  const target = base.endsWith('/search') ? base : `${base}/search`;
  const params = new URLSearchParams({ q: query, format: 'json' });
  const res = await fetchWithRetry(`${target}?${params}`, {
    headers: opts.key ? { Authorization: `Bearer ${opts.key}` } : {},
    signal: opts.signal,
  });
  const json = await readJson(res, 'SearXNG');
  return toResults(asList(json));
}

/** The person's own `/v1/search`: POST `{ query, limit }` in, rows out. */
async function searchCustom(query: string, opts: SearchOptions): Promise<WebResult[]> {
  const res = await fetchWithRetry(opts.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.key ? { Authorization: `Bearer ${opts.key}` } : {}),
    },
    body: JSON.stringify({ query, limit: clampLimit(opts.limit) }),
    signal: opts.signal,
  });
  const json = await readJson(res, 'Search');
  return toResults(asList(json));
}

const ENGINES: Record<SearchProviderId, SearchFn> = {
  exa: searchExa,
  tavily: searchTavily,
  brave: searchBrave,
  serper: searchSerper,
  mojeek: searchMojeek,
  ddg: searchDdg,
  searxng: searchSearxng,
  custom: searchCustom,
};

/**
 * "Free to run a search right now": the master web-search toggle is on, and
 * the engine currently selected is configured. This is where a stale
 * preference cannot switch on something the machine cannot do.
 */
export function webSearchEnabled(): boolean {
  const settings = sparkSettings.get();
  return settings.webSearch && providerReady(settings.searchProviders, settings.activeSearchProvider);
}

/** The name of the active engine, for summaries and tool descriptions. */
export function activeSearchLabel(): string {
  const settings = sparkSettings.get();
  return searchProviderMeta(settings.activeSearchProvider)?.label ?? 'web search';
}

export interface WebSearchOutcome {
  results: WebResult[];
  /** Which engine actually answered — the active one, unless it failed and a fallback took over. */
  engine: SearchProviderId;
  /** Set when the active engine failed and this ran instead. */
  fellBackFrom?: SearchProviderId;
}

/**
 * Runs a query against the active engine, falling back to a second
 * configured one if the first errors or rate-limits — the same
 * primary-then-fallback shape `spark.ts`'s AI provider fallback uses, and
 * for the same reason: a search that could have just worked a moment later
 * is worse to fail outright than to quietly try the other engine someone
 * already configured for exactly this. Each engine's own `fetch` call
 * already retries transient failures (`retry.ts`'s `fetchWithRetry`) before
 * this ever sees an error, so a fallback here means those retries were
 * already exhausted.
 */
export async function webSearch(
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<WebSearchOutcome> {
  const settings = sparkSettings.get();
  const id = settings.activeSearchProvider;
  const engine = ENGINES[id];
  if (!engine) throw new Error('No web-search provider configured.');
  const conf = settings.searchProviders[id];

  try {
    const results = await engine(query, { ...options, key: conf.key, endpoint: conf.endpoint });
    return { results, engine: id };
  } catch (err) {
    const fallbackId = settings.fallbackSearchProvider;
    if (!fallbackId || fallbackId === id || options.signal?.aborted) throw err;
    const fallbackEngine = ENGINES[fallbackId];
    if (!fallbackEngine || !providerReady(settings.searchProviders, fallbackId)) throw err;

    const fallbackConf = settings.searchProviders[fallbackId];
    const results = await fallbackEngine(query, {
      ...options,
      key: fallbackConf.key,
      endpoint: fallbackConf.endpoint,
    });
    return { results, engine: fallbackId, fellBackFrom: id };
  }
}