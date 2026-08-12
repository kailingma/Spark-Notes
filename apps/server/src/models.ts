import { aiSettings, describeFailure } from './ai.js';
import { endpointOf, type AiSettings } from './ai-settings.js';
import { fetchWithRetry } from './retry.js';

/**
 * The provider's model list.
 *
 * This exists so nobody has to type `claude-haiku-4-5-20251001` from memory into
 * a mode preset. Both shapes of API happen to agree on this one endpoint —
 * `GET /v1/models`, a list of objects with an `id` — which is why it is worth
 * fetching rather than shipping a table that goes stale between releases.
 *
 * A failure is returned, not thrown: the settings page still works with the field
 * typed by hand, and "could not reach the provider" is a sentence to show beside
 * the button rather than an error state for the whole panel.
 */

export interface ModelInfo {
  id: string;
  /** Creation date, when the provider gives one. Newest first is the useful order. */
  created?: number;
  /** What the provider calls it, when that differs from the id. */
  label?: string;
}

export async function listModels(
  settings: AiSettings = aiSettings.get(),
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const base = endpointOf(settings);
  // The chat endpoint may have been pasted in full — `.../chat/completions` —
  // in which case the models list is two levels up from it, not beside it.
  const root = base.replace(/\/(chat\/)?completions$/, '');
  const url = settings.provider === 'anthropic' ? `${root}/v1/models?limit=100` : `${root}/models`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (settings.provider === 'anthropic') {
    if (settings.apiKey) headers['x-api-key'] = settings.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (settings.apiKey) {
    headers.authorization = `Bearer ${settings.apiKey}`;
  }

  const res = await fetchWithRetry(url, { headers, signal });
  if (!res.ok) throw new Error(await describeFailure(res));

  const parsed = (await res.json()) as {
    data?: Array<{ id?: string; created?: number; created_at?: string; display_name?: string }>;
  };

  const models = (parsed.data ?? [])
    .map((entry): ModelInfo | null => {
      if (!entry.id) return null;
      const created =
        entry.created ?? (entry.created_at ? Date.parse(entry.created_at) / 1000 : undefined);
      return {
        id: entry.id,
        ...(Number.isFinite(created) ? { created: created as number } : {}),
        ...(entry.display_name ? { label: entry.display_name } : {}),
      };
    })
    .filter((model): model is ModelInfo => model !== null);

  // Newest first, then alphabetically, because a list of eighty ids sorted by
  // nothing in particular is a list nobody reads to the end of.
  return models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
}
