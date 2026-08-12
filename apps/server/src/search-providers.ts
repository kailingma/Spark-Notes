/**
 * The registry of web-search providers.
 *
 * Pure data and pure checks — no fetching, no store. This module is imported by
 * both `spark-settings.ts` (the store) and `web-search.ts` (the adapters), so
 * it must not import either of them. Putting the registry here is what keeps
 * those two from forming a cycle: the store lists the providers for the
 * settings panel, the adapters dispatch over them, and neither owns the list.
 *
 * `providerReady` is also here rather than next to the fetching code because
 * the store's `publicView` needs it to report `webSearchReady`, and a function
 * that only reads a configuration and a registry has no business being in the
 * file that hits the network.
 */

export type SearchProviderId =
  | 'exa'
  | 'tavily'
  | 'brave'
  | 'serper'
  | 'mojeek'
  | 'ddg'
  | 'searxng'
  | 'custom';

export interface SearchProviderMeta {
  id: SearchProviderId;
  label: string;
  /** A sentence for the settings panel and the tool description. */
  hint: string;
  /** Needs an API key from the person. */
  needsKey: boolean;
  /** Needs a user-supplied base URL (SearXNG, custom). */
  needsEndpoint: boolean;
  /** Works with nothing configured at all (DuckDuckGo). */
  keyless: boolean;
  /** Returns full page text rather than a search snippet. */
  returnsText: boolean;
}

export interface SearchProviderConfig {
  key: string;
  endpoint: string;
}

export type SearchProviders = Record<SearchProviderId, SearchProviderConfig>;

/** How the settings panel and the tool choose one engine over another. */
export const SEARCH_PROVIDERS: SearchProviderMeta[] = [
  {
    id: 'exa',
    label: 'Exa',
    hint: 'Semantic search over the whole web, with full page text. The default, and the original engine.',
    needsKey: true,
    needsEndpoint: false,
    keyless: false,
    returnsText: true,
  },
  {
    id: 'tavily',
    label: 'Tavily',
    hint: 'Search built for LLMs, returning full page text.',
    needsKey: true,
    needsEndpoint: false,
    keyless: false,
    returnsText: true,
  },
  {
    id: 'brave',
    label: 'Brave',
    hint: 'Independent index, private by design. Returns snippets, not full text.',
    needsKey: true,
    needsEndpoint: false,
    keyless: false,
    returnsText: false,
  },
  {
    id: 'serper',
    label: 'Serper (Google)',
    hint: 'Google results through the Serper API. Returns snippets, not full text.',
    needsKey: true,
    needsEndpoint: false,
    keyless: false,
    returnsText: false,
  },
  {
    id: 'mojeek',
    label: 'Mojeek',
    hint: 'An independent index built from its own crawl. Returns snippets.',
    needsKey: true,
    needsEndpoint: false,
    keyless: false,
    returnsText: false,
  },
  {
    id: 'ddg',
    label: 'DuckDuckGo',
    hint: 'Zero-configuration, no key. Uses the same HTML page the browser shows, so it is a scraper rather than an API — fragile, and snippets only.',
    needsKey: false,
    needsEndpoint: false,
    keyless: true,
    returnsText: false,
  },
  {
    id: 'searxng',
    label: 'SearXNG',
    hint: 'Your own self-hosted SearXNG instance. Any URL that serves JSON (`?format=json`) works. An API key is optional (Bearer).',
    needsKey: false,
    needsEndpoint: true,
    keyless: false,
    returnsText: false,
  },
  {
    id: 'custom',
    label: 'Custom /v1/search',
    hint: 'Any endpoint that speaks OpenAI\'s `/v1/search` shape: POST `{ query, limit }`, returns `{ results: [...] }`. A key is optional (Bearer).',
    // Was `true`, disagreeing with the hint above and with `providerReady`'s
    // actual behaviour (it checks `needsEndpoint` first and never reaches
    // this flag for a provider that needs both) — a misleading, unread flag
    // rather than a real requirement. `searxng` already has the correct
    // shape for "a key is optional, an endpoint is not."
    needsKey: false,
    needsEndpoint: true,
    keyless: false,
    returnsText: false,
  },
];

export function searchProviderMeta(id: string): SearchProviderMeta | undefined {
  return SEARCH_PROVIDERS.find((p) => p.id === id);
}

/** A config with nothing in it, ready to be filled in. */
export function emptySearchProviders(): SearchProviders {
  return Object.fromEntries(
    SEARCH_PROVIDERS.map((p) => [p.id, { key: '', endpoint: '' }]),
  ) as SearchProviders;
}

/**
 * "May this provider run right now?" — capability, not permission. The key
 * questions are what the meta says is needed: a key for the API engines, a
 * base URL for the self-hosted ones, and nothing at all for DuckDuckGo.
 */
export function providerReady(conf: SearchProviders, id: SearchProviderId): boolean {
  const meta = searchProviderMeta(id);
  const entry = conf[id];
  if (!meta || !entry) return false;
  if (meta.keyless) return true;
  if (meta.needsEndpoint) return entry.endpoint.trim().length > 0;
  if (meta.needsKey) return entry.key.trim().length > 0;
  return false;
}
