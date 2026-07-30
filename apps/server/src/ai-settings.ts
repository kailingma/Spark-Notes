import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

/**
 * Where the AI provider key lives.
 *
 * The same rule as the GitHub token: the credential is written to `.spark/`
 * at mode 0600 — outside the space, so it is never committed and never pushed
 * by sync — and the browser is only ever told *that* a key is configured, plus
 * the last four characters so you can tell which one it is. Nothing that can
 * make a paid API call is put in `localStorage`, where any script on the page
 * (a space plugin, an extension) could read it back out.
 *
 * Spark is a personal server: one space, one owner. Anyone who can reach it can
 * already read the notes, so the key is protected to the same standard as the
 * notes themselves and no further.
 */

export type AiProvider = 'anthropic' | 'openai';

export interface AiSettings {
  provider: AiProvider;
  /** Model id, exactly as the provider names it. */
  model: string;
  /** Base URL of the API. Empty string means the provider's own default. */
  endpoint: string;
  apiKey: string;

  /**
   * Embedding model for semantic search. Empty means semantic search is off.
   *
   * Separate from `model` because it is a separate decision: Anthropic serves no
   * embeddings at all, so the person using Claude for conversation still has to
   * name somewhere else for vectors, and a local runtime is a perfectly good
   * answer for this half even when the chat model is remote.
   */
  embedModel: string;
  /** Base URL for embeddings. Empty falls back to `endpoint`, then to OpenAI. */
  embedEndpoint: string;
  /** Key for the embedding endpoint. Empty falls back to `apiKey`. */
  embedKey: string;
}

/** The redacted view the browser is allowed to see. */
export interface PublicAiSettings {
  provider: AiProvider;
  model: string;
  endpoint: string;
  /** True when a usable key is present, from either the file or the environment. */
  hasKey: boolean;
  /** Last four characters of the key, for telling two keys apart. */
  keyHint: string;
  /** Where the current settings came from, so the UI can say so. */
  source: 'stored' | 'env' | 'none';

  embedModel: string;
  embedEndpoint: string;
  /** True when a separate embedding key is stored. Its value never leaves here. */
  hasEmbedKey: boolean;
}

const DEFAULT_ENDPOINTS: Record<AiProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-5',
};

export class AiSettingsStore {
  #stored: AiSettings | null = null;
  #loaded = false;

  get #file(): string {
    return join(config.stateDir, 'ai.json');
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as Partial<AiSettings>;
      this.#stored = normalize(parsed);
    } catch {
      // No file yet, or an unreadable one: fall back to the environment.
      this.#stored = null;
    }
  }

  /** The settings in force, file first and environment second. */
  get(): AiSettings {
    return this.#stored ?? fromEnv();
  }

  enabled(): boolean {
    const settings = this.get();
    // A local runtime (Ollama, LM Studio) is reached over a private endpoint and
    // wants no key at all, so a custom endpoint is enough on its own.
    return settings.apiKey.length > 0 || isCustomEndpoint(settings);
  }

  publicView(): PublicAiSettings {
    const settings = this.get();
    return {
      provider: settings.provider,
      model: settings.model,
      endpoint: settings.endpoint,
      hasKey: settings.apiKey.length > 0,
      keyHint: settings.apiKey.slice(-4),
      source: this.#stored ? 'stored' : this.enabled() ? 'env' : 'none',
      embedModel: settings.embedModel,
      embedEndpoint: settings.embedEndpoint,
      hasEmbedKey: settings.embedKey.length > 0,
    };
  }

  /**
   * Writes new settings.
   *
   * An absent field means "leave that one alone", which is not the same as an
   * empty one: the settings page never receives the key, so it cannot send it
   * back, and saving a new model must not silently wipe the credential. An
   * empty *string* is a real value — it is how you say "use the provider's
   * default endpoint" — so absence has to be tested for, not falsiness.
   */
  async save(patch: Partial<AiSettings>): Promise<void> {
    const current = this.get();
    const next = normalize({
      provider: patch.provider ?? current.provider,
      model: patch.model ?? current.model,
      endpoint: patch.endpoint ?? current.endpoint,
      apiKey: patch.apiKey ?? current.apiKey,
      embedModel: patch.embedModel ?? current.embedModel,
      embedEndpoint: patch.embedEndpoint ?? current.embedEndpoint,
      embedKey: patch.embedKey ?? current.embedKey,
    });

    this.#stored = next;
    await mkdir(config.stateDir, { recursive: true });
    await writeFile(this.#file, JSON.stringify(next, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  /** Forgets the stored settings, falling back to the environment. */
  async clear(): Promise<void> {
    this.#stored = null;
    try {
      await writeFile(this.#file, 'null', { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* nothing to clear */
    }
  }
}

/** The base URL to call, with the provider's default filled in. */
export function endpointOf(settings: AiSettings): string {
  const base = settings.endpoint.trim() || DEFAULT_ENDPOINTS[settings.provider];
  return base.replace(/\/+$/, '');
}

/**
 * Where to send an embedding request.
 *
 * Its own endpoint first, then the chat endpoint, then OpenAI's. The middle step
 * is what makes the common local setup one field: someone running Ollama has
 * already typed its address once, and their embedding model is on the same
 * server. The fallback is OpenAI's rather than the provider's own default,
 * because when the provider is Anthropic there is no such thing.
 */
export function embeddingEndpointOf(settings: AiSettings): string {
  const base =
    settings.embedEndpoint.trim() ||
    (settings.provider === 'openai' ? settings.endpoint.trim() : '') ||
    DEFAULT_ENDPOINTS.openai;
  return base.replace(/\/+$/, '');
}

function isCustomEndpoint(settings: AiSettings): boolean {
  const endpoint = settings.endpoint.trim();
  return endpoint.length > 0 && endpoint !== DEFAULT_ENDPOINTS[settings.provider];
}

function normalize(raw: Partial<AiSettings>): AiSettings {
  const provider: AiProvider = raw.provider === 'anthropic' ? 'anthropic' : 'openai';
  return {
    provider,
    model: (raw.model ?? '').trim() || DEFAULT_MODELS[provider],
    endpoint: (raw.endpoint ?? '').trim(),
    apiKey: (raw.apiKey ?? '').trim(),
    // No default embedding model. Semantic search costs money per page and its
    // absence is a working state, so it has to be asked for by name.
    embedModel: (raw.embedModel ?? '').trim(),
    embedEndpoint: (raw.embedEndpoint ?? '').trim(),
    embedKey: (raw.embedKey ?? '').trim(),
  };
}

/**
 * Environment defaults, so a server configured the old way keeps working and a
 * container can be handed a key without anyone opening the settings page.
 */
function fromEnv(): AiSettings {
  const anthropicKey = config.ai.anthropicKey;
  const openaiKey = config.ai.openaiKey;

  // An explicit provider wins; otherwise whichever key is actually present.
  const provider: AiProvider =
    config.ai.provider === 'anthropic' || config.ai.provider === 'openai'
      ? config.ai.provider
      : anthropicKey && !openaiKey
        ? 'anthropic'
        : 'openai';

  return normalize({
    provider,
    model: config.ai.model,
    endpoint: config.ai.endpoint,
    apiKey: provider === 'anthropic' ? anthropicKey : openaiKey,
    embedModel: config.ai.embedModel,
    embedEndpoint: config.ai.embedEndpoint,
    // An Anthropic chat key is useless for embeddings, so it is not inherited:
    // the environment has to name a key for this half if it wants one.
    embedKey: provider === 'anthropic' ? openaiKey : '',
  });
}
