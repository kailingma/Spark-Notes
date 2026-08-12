import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { contextWindowFor } from './pricing.js';

/**
 * Where the AI provider keys live.
 *
 * The same rule as the GitHub token: a credential is written to `.spark/` at
 * mode 0600 — outside the space, so it is never committed and never pushed by
 * sync — and the browser is only ever told *that* a key is configured, plus
 * its last four characters so you can tell which one it is. Nothing that can
 * make a paid API call is put in `localStorage`, where any script on the page
 * (a space plugin, an extension) could read it back out.
 *
 * Spark is a personal server: one space, one owner. Anyone who can reach it can
 * already read the notes, so a key is protected to the same standard as the
 * notes themselves and no further.
 *
 * **Multiple providers, not one.** What used to be a single stored object is
 * now a list of *profiles* — a provider, a model, an endpoint and a key,
 * named and kept independently, so a mode preset (`spark-settings.ts`'s
 * `SparkMode.providerId`) can point Fast at a cheap fast model on one
 * provider and Quality at a different one entirely, with a fallback profile
 * for when the primary is rate-limited or down. `AiSettings` is kept as an
 * alias for the profile shape — the ~15 call sites across `spark.ts`,
 * `models.ts`, `retrieval.ts` and `ai.ts` that ask for "the settings" by that
 * name keep working unchanged; they were always really asking for "the
 * profile in force," and now there is more than one to choose from.
 */

export type AiProvider = 'anthropic' | 'openai';

export interface AiProviderProfile {
  /** Stable across renames — what a `SparkMode` points at. */
  id: string;
  /** What the person called it — "Anthropic", "Groq (fast)", "Local Ollama". */
  label: string;
  provider: AiProvider;
  /** Model id, exactly as the provider names it. */
  model: string;
  /** Base URL of the API. Empty string means the provider's own default. */
  endpoint: string;
  apiKey: string;

  /**
   * Embedding model for semantic search. Empty means semantic search is off
   * *for this profile*.
   *
   * Separate from `model` because it is a separate decision: Anthropic serves no
   * embeddings at all, so a profile using Claude for conversation still has to
   * name somewhere else for vectors, and a local runtime is a perfectly good
   * answer for this half even when the chat model is remote.
   */
  embedModel: string;
  /** Base URL for embeddings. Empty falls back to `endpoint`, then to OpenAI. */
  embedEndpoint: string;
  /** Key for the embedding endpoint. Empty falls back to `apiKey`. */
  embedKey: string;
  /**
   * A best-effort token budget, for the context-window warning. Absent means
   * unknown — the client falls back to a table of known models, and beyond
   * that says nothing rather than guessing.
   */
  contextWindow?: number;
}

/** Kept as the name most of the codebase already reaches for. */
export type AiSettings = AiProviderProfile;

/** The redacted view the browser is allowed to see, for one profile. */
export interface PublicAiProviderProfile {
  id: string;
  label: string;
  provider: AiProvider;
  model: string;
  endpoint: string;
  /** True when a usable key is present, from either the file or the environment. */
  hasKey: boolean;
  /** Last four characters of the key, for telling two keys apart. */
  keyHint: string;
  /** Where this profile came from, so the UI can say so. */
  source: 'stored' | 'env';
  embedModel: string;
  embedEndpoint: string;
  /** True when a separate embedding key is stored. Its value never leaves here. */
  hasEmbedKey: boolean;
  contextWindow?: number;
  /** Whether this is the profile a mode falls back to when it names none. */
  isDefault: boolean;
}

/** Back-compat name for a single profile's public view. */
export type PublicAiSettings = PublicAiProviderProfile;

const DEFAULT_ENDPOINTS: Record<AiProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-5',
};

function labelFor(provider: AiProvider): string {
  return provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible';
}

interface StoredShape {
  profiles: AiProviderProfile[];
  /** Id of the profile a mode falls back to when it names none. */
  defaultId: string;
}

export class AiSettingsStore {
  #stored: StoredShape | null = null;
  #loaded = false;

  get #file(): string {
    return join(config.stateDir, 'ai.json');
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as unknown;
      this.#stored = normalizeStored(parsed);
    } catch {
      // No file yet, or an unreadable one: fall back to the environment.
      this.#stored = null;
    }
  }

  /** Every configured profile. The environment's single profile, when nothing is stored. */
  #profiles(): AiProviderProfile[] {
    return this.#stored && this.#stored.profiles.length > 0 ? this.#stored.profiles : [fromEnv()];
  }

  #defaultId(): string {
    const profiles = this.#profiles();
    if (this.#stored && profiles.some((p) => p.id === this.#stored!.defaultId)) {
      return this.#stored.defaultId;
    }
    return profiles[0].id;
  }

  listProfiles(): AiProviderProfile[] {
    return this.#profiles();
  }

  /** A named profile, or `null` if that id doesn't exist (a deleted profile a mode still points at). */
  profile(id: string | undefined): AiProviderProfile | null {
    if (!id) return this.defaultProfile();
    return this.#profiles().find((p) => p.id === id) ?? null;
  }

  defaultProfile(): AiProviderProfile {
    const id = this.#defaultId();
    return this.#profiles().find((p) => p.id === id) ?? this.#profiles()[0];
  }

  /**
   * Back-compat shape: the named profile if it still exists, the default
   * profile otherwise — never `null`, which is what every existing call
   * site built around a single always-present `AiSettings` expects.
   */
  get(id?: string): AiSettings {
    return this.profile(id) ?? this.defaultProfile();
  }

  enabled(): boolean {
    const settings = this.defaultProfile();
    // A local runtime (Ollama, LM Studio) is reached over a private endpoint and
    // wants no key at all, so a custom endpoint is enough on its own.
    return settings.apiKey.length > 0 || isCustomEndpoint(settings);
  }

  publicProfile(profile: AiProviderProfile): PublicAiProviderProfile {
    return {
      id: profile.id,
      label: profile.label,
      provider: profile.provider,
      model: profile.model,
      endpoint: profile.endpoint,
      hasKey: profile.apiKey.length > 0,
      keyHint: profile.apiKey.slice(-4),
      source: this.#stored ? 'stored' : 'env',
      embedModel: profile.embedModel,
      embedEndpoint: profile.embedEndpoint,
      hasEmbedKey: profile.embedKey.length > 0,
      ...(profile.contextWindow ? { contextWindow: profile.contextWindow } : {}),
      isDefault: profile.id === this.#defaultId(),
    };
  }

  listPublicProfiles(): PublicAiProviderProfile[] {
    return this.#profiles().map((profile) => this.publicProfile(profile));
  }

  /** Back-compat: the default profile's redacted view. */
  publicView(): PublicAiProviderProfile {
    return this.publicProfile(this.defaultProfile());
  }

  /**
   * Creates a profile, or updates one by id.
   *
   * The same absence-means-leave-alone rule as before: the settings page
   * never receives a stored key, so it cannot send it back, and saving a new
   * model must not silently wipe the credential. An empty *string* is a real
   * value — it is how you say "use the provider's default endpoint" — so
   * absence has to be tested for, not falsiness.
   */
  async saveProfile(
    patch: Partial<AiProviderProfile> & { id?: string },
  ): Promise<AiProviderProfile> {
    const stored = this.#stored ?? { profiles: [], defaultId: '' };
    const existing = patch.id ? stored.profiles.find((p) => p.id === patch.id) : undefined;
    const merged = normalizeProfile({
      id: existing?.id ?? patch.id,
      label: patch.label ?? existing?.label,
      provider: patch.provider ?? existing?.provider,
      model: patch.model ?? existing?.model,
      endpoint: patch.endpoint ?? existing?.endpoint,
      apiKey: patch.apiKey ?? existing?.apiKey,
      embedModel: patch.embedModel ?? existing?.embedModel,
      embedEndpoint: patch.embedEndpoint ?? existing?.embedEndpoint,
      embedKey: patch.embedKey ?? existing?.embedKey,
      contextWindow: patch.contextWindow ?? existing?.contextWindow,
    })!;

    const profiles = existing
      ? stored.profiles.map((p) => (p.id === merged.id ? merged : p))
      : [...stored.profiles, merged];
    const defaultId = profiles.some((p) => p.id === stored.defaultId) ? stored.defaultId : profiles[0].id;

    await this.#write({ profiles, defaultId });
    return merged;
  }

  /**
   * Removes a profile. Deleting the default hands the role to whichever
   * profile is first afterwards, rather than leaving nothing in force — a
   * mode that named the deleted profile falls back the same way `profile()`
   * already does for any id that stops existing.
   */
  async deleteProfile(id: string): Promise<void> {
    if (!this.#stored) return;
    const profiles = this.#stored.profiles.filter((p) => p.id !== id);
    if (profiles.length === 0) {
      await this.clear();
      return;
    }
    const defaultId = this.#stored.defaultId === id ? profiles[0].id : this.#stored.defaultId;
    await this.#write({ profiles, defaultId });
  }

  async setDefaultProfile(id: string): Promise<void> {
    const stored = this.#stored ?? { profiles: this.#profiles(), defaultId: this.#defaultId() };
    if (!stored.profiles.some((p) => p.id === id)) throw new Error('No such provider profile.');
    await this.#write({ ...stored, defaultId: id });
  }

  /** Forgets everything stored, falling back to the environment. */
  async clear(): Promise<void> {
    this.#stored = null;
    try {
      await writeFile(this.#file, 'null', { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* nothing to clear */
    }
  }

  async #write(next: StoredShape): Promise<void> {
    this.#stored = next;
    await mkdir(config.stateDir, { recursive: true });
    await writeFile(this.#file, JSON.stringify(next, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
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

/**
 * Fills in a profile's defaults — a model when none is named, a generated id
 * — without persisting it. Used both by the store's own writes and by
 * `/api/ai/test`'s draft-profile path, so "test what's typed" resolves
 * exactly the same defaults a save would.
 */
export function normalizeProfile(raw: Partial<AiProviderProfile> | undefined): AiProviderProfile | null {
  if (!raw) return null;
  const provider: AiProvider = raw.provider === 'anthropic' ? 'anthropic' : 'openai';
  const model = (raw.model ?? '').toString().trim() || DEFAULT_MODELS[provider];
  const explicitContextWindow = Number(raw.contextWindow);
  // No manual override field exists yet — a known model's best-effort size
  // (`pricing.ts`) is filled in automatically, and an unrecognised one
  // simply has none, the same "no guessed number" rule the price table uses.
  const contextWindow = Number.isFinite(explicitContextWindow) && explicitContextWindow > 0
    ? explicitContextWindow
    : contextWindowFor(model);
  return {
    id: (typeof raw.id === 'string' && raw.id.trim()) || randomUUID(),
    label: (typeof raw.label === 'string' && raw.label.trim().slice(0, 60)) || labelFor(provider),
    provider,
    model,
    endpoint: (raw.endpoint ?? '').toString().trim(),
    apiKey: (raw.apiKey ?? '').toString().trim(),
    // No default embedding model. Semantic search costs money per page and its
    // absence is a working state, so it has to be asked for by name.
    embedModel: (raw.embedModel ?? '').toString().trim(),
    embedEndpoint: (raw.embedEndpoint ?? '').toString().trim(),
    embedKey: (raw.embedKey ?? '').toString().trim(),
    ...(contextWindow ? { contextWindow } : {}),
  };
}

/**
 * Reads the persisted file, migrating a pre-multi-provider install in place:
 * a file written by the old single-object `AiSettingsStore` has no
 * `profiles` array at all, so its absence is exactly the signal to wrap the
 * whole parsed object as the sole profile — zero-touch, nothing the person
 * has to notice or redo.
 */
function normalizeStored(raw: unknown): StoredShape | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  if (Array.isArray(obj.profiles)) {
    const profiles = (obj.profiles as unknown[])
      .map((entry) => normalizeProfile(entry as Partial<AiProviderProfile>))
      .filter((p): p is AiProviderProfile => p !== null);
    if (profiles.length === 0) return null;
    const defaultId =
      typeof obj.defaultId === 'string' && profiles.some((p) => p.id === obj.defaultId)
        ? obj.defaultId
        : profiles[0].id;
    return { profiles, defaultId };
  }

  const legacy = normalizeProfile({
    ...(obj as Partial<AiProviderProfile>),
    id: 'default',
    label: 'Default',
  });
  if (!legacy) return null;
  return { profiles: [legacy], defaultId: legacy.id };
}

/**
 * Environment defaults, so a server configured the old way keeps working and a
 * container can be handed a key without anyone opening the settings page.
 * Synthesized as a single profile — the environment can only ever describe
 * one provider, by design; a second one is a reason to open Settings.
 */
function fromEnv(): AiProviderProfile {
  const anthropicKey = config.ai.anthropicKey;
  const openaiKey = config.ai.openaiKey;

  // An explicit provider wins; otherwise whichever key is actually present.
  const provider: AiProvider =
    config.ai.provider === 'anthropic' || config.ai.provider === 'openai'
      ? config.ai.provider
      : anthropicKey && !openaiKey
        ? 'anthropic'
        : 'openai';

  return normalizeProfile({
    id: 'env',
    label: labelFor(provider),
    provider,
    model: config.ai.model,
    endpoint: config.ai.endpoint,
    apiKey: provider === 'anthropic' ? anthropicKey : openaiKey,
    embedModel: config.ai.embedModel,
    embedEndpoint: config.ai.embedEndpoint,
    // An Anthropic chat key is useless for embeddings, so it is not inherited:
    // the environment has to name a key for this half if it wants one.
    embedKey: provider === 'anthropic' ? openaiKey : '',
  })!;
}
