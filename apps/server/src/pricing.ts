/**
 * A best-effort guess at what a turn cost, in dollars.
 *
 * Best-effort and no further: a table of model ids to per-million-token
 * prices goes stale the moment a provider changes its price list, and this
 * app has no way to know when that happens. So it is treated exactly the
 * way `AiProviderProfile.contextWindow` is — a known model gets a number,
 * an unrecognized one (a fine-tune, a brand-new release, a local runtime
 * with no real price at all) gets nothing rather than a wrong guess. The
 * token counts themselves (`ChatMessage.usage`) are always real, read
 * straight from the provider's own response; only the dollar conversion is
 * a guess.
 *
 * Prices are dollars per million tokens, input and output, matched by the
 * longest prefix of the model id that's listed — `claude-opus-5-20260115`
 * matches the `claude-opus-5` entry the same way it would match a shorter
 * release-dated id.
 */

/** Longest-prefix match against a model-id-keyed table — shared by price and context-window lookups. */
function longestPrefixMatch<T>(table: Record<string, T>, model: string): T | null {
  const id = model.toLowerCase();
  let best: { key: string; value: T } | null = null;
  for (const [key, value] of Object.entries(table)) {
    if (id.startsWith(key) && (!best || key.length > best.key.length)) best = { key, value };
  }
  return best?.value ?? null;
}

interface Price {
  input: number;
  output: number;
}

const PRICES: Record<string, Price> = {
  // Anthropic
  'claude-opus-5': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },

  // OpenAI
  'gpt-5': { input: 5, output: 15 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  o1: { input: 15, output: 60 },
  'o1-mini': { input: 1.1, output: 4.4 },
  o3: { input: 2, output: 8 },
  'o3-mini': { input: 1.1, output: 4.4 },
};

/** In dollars, or `null` when the model isn't in the table — never a guessed number. */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = longestPrefixMatch(PRICES, model);
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

/**
 * A best-effort context-window size, for the "this conversation is getting
 * long" warning. Same honesty rule as `estimateCost`: a model not in the
 * table gets no number, not a guessed one — `AiProviderProfile.contextWindow`
 * stays `undefined` and the warning simply never fires for it, which is the
 * right failure mode for a number nobody can otherwise correct here (there
 * is deliberately no per-profile override field in Settings yet; if this
 * table drifts, editing it is the fix).
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  // Anthropic — every current Claude model shares this
  claude: 200_000,

  // OpenAI
  'gpt-5': 400_000,
  'gpt-4.1': 1_000_000,
  'gpt-4o': 128_000,
  'gpt-4-turbo': 128_000,
  o1: 200_000,
  o3: 200_000,
};

export function contextWindowFor(model: string): number | null {
  return longestPrefixMatch(CONTEXT_WINDOWS, model);
}
