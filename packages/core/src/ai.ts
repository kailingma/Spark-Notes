import type { AiApi, AiOptions } from '@spark/plugin-sdk';

export type AiProvider = 'anthropic' | 'openai';

/**
 * One configured provider, as the browser is allowed to see it.
 *
 * There is no `apiKey` field, and that is the point: the key is written to
 * `.spark/ai.json` on the server at mode 0600 and never travels back. The UI
 * can say "a key ending …f3a1 is set" and nothing more.
 *
 * Several of these can exist at once — a mode preset
 * (`SparkMode.providerId`, `apps/server/src/spark-settings.ts`) picks which
 * one answers it, with `isDefault` marking the one a mode falls back to when
 * it names none.
 */
export interface AiProviderProfile {
  id: string;
  label: string;
  provider: AiProvider;
  model: string;
  endpoint: string;
  hasKey: boolean;
  keyHint: string;
  source: 'stored' | 'env';
  /** Embedding model for semantic search. Empty means text matching only. */
  embedModel: string;
  embedEndpoint: string;
  hasEmbedKey: boolean;
  /** A best-effort token budget, when one is known. */
  contextWindow?: number;
  isDefault: boolean;
}

/** The writable half. An omitted field leaves what's stored alone; `id` targets an existing profile, omitted creates a new one. */
export interface AiProviderProfilePatch {
  id?: string;
  label?: string;
  provider?: AiProvider;
  model?: string;
  endpoint?: string;
  apiKey?: string;
  embedModel?: string;
  embedEndpoint?: string;
  /** Omitted leaves the stored embedding key alone, the same rule as `apiKey`. */
  embedKey?: string;
  contextWindow?: number;
}

export interface AiTestResult {
  ok: boolean;
  model?: string;
  reply?: string;
  error?: string;
}

export interface AiModelInfo {
  id: string;
  created?: number;
  label?: string;
}

export interface AiModelsResult {
  ok: boolean;
  models: AiModelInfo[];
  error?: string;
}

/**
 * AI runs through the server so a provider key never reaches the browser.
 * Every call is opt-in and user-triggered — nothing here fires on its own.
 */
export class AiClient implements AiApi {
  #enabled = false;

  constructor(private readonly baseUrl = '/api/ai') {}

  // -- provider profiles ----------------------------------------------------

  async profiles(): Promise<AiProviderProfile[]> {
    const res = await fetch(`${this.baseUrl}/profiles`);
    if (!res.ok) throw new Error(`Could not read the AI settings (${res.status}).`);
    return (await res.json()) as AiProviderProfile[];
  }

  /** Creates a profile, or updates one when `patch.id` names an existing one. */
  async saveProfile(patch: AiProviderProfilePatch): Promise<AiProviderProfile> {
    const res = await fetch(`${this.baseUrl}/profiles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error((await res.text()) || `Could not save (${res.status}).`);
    return (await res.json()) as AiProviderProfile;
  }

  async deleteProfile(id: string): Promise<AiProviderProfile[]> {
    const res = await fetch(`${this.baseUrl}/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Could not remove the provider (${res.status}).`);
    return (await res.json()) as AiProviderProfile[];
  }

  /** Which profile a mode falls back to when it names none. */
  async setDefaultProfile(id: string): Promise<AiProviderProfile[]> {
    const res = await fetch(`${this.baseUrl}/profiles/${encodeURIComponent(id)}/default`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error((await res.text()) || `Could not set the default (${res.status}).`);
    return (await res.json()) as AiProviderProfile[];
  }

  /** Forgets every stored profile, falling back to whatever the server's environment describes. */
  async resetProfiles(): Promise<AiProviderProfile[]> {
    const res = await fetch(`${this.baseUrl}/profiles`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Could not reset the AI settings (${res.status}).`);
    return (await res.json()) as AiProviderProfile[];
  }

  /**
   * Asks the server to make one real call against a profile, so a bad key
   * fails here and not mid-note.
   *
   * `patch` overrides a stored profile (named by `patch.id`) field by
   * field — the ones typed into the form, not the ones on disk — or, with
   * `id` omitted, describes a wholly new profile that hasn't been saved
   * yet. Testing what is stored answers the wrong question: the whole
   * reason to press the button is to find out whether the key and model in
   * front of you work, *before* they replace ones that already do. Nothing
   * is saved by this call.
   */
  async test(patch: AiProviderProfilePatch = {}): Promise<AiTestResult> {
    const res = await fetch(`${this.baseUrl}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { ok: false, error: (await res.text()) || `Failed (${res.status}).` };
    return (await res.json()) as AiTestResult;
  }

  /** The named profile's model list, so a mode preset can be picked rather than typed. Same as-typed override as `test`. */
  async models(patch: AiProviderProfilePatch = {}): Promise<AiModelsResult> {
    const res = await fetch(`${this.baseUrl}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { ok: false, models: [], error: `Failed (${res.status}).` };
    return (await res.json()) as AiModelsResult;
  }

  // -- generation -------------------------------------------------------------

  /** Set from `/api/config` at boot; false when no provider key is configured. */
  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  available(): boolean {
    return this.#enabled;
  }

  async complete(prompt: string, options: AiOptions = {}): Promise<string> {
    let out = '';
    await this.stream(prompt, (chunk) => (out += chunk), options);
    return out;
  }

  async stream(
    prompt: string,
    onToken: (chunk: string) => void,
    options: AiOptions = {},
  ): Promise<string> {
    if (!this.#enabled) {
      throw new Error('AI is not configured. Add a provider and key in Settings → AI.');
    }

    const res = await fetch(`${this.baseUrl}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, system: options.system }),
      signal: options.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error((await res.text().catch(() => '')) || `AI request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      full += chunk;
      onToken(chunk);
    }

    return full;
  }
}
