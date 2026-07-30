import type { AiApi, AiOptions } from '@spark/plugin-sdk';

export type AiProvider = 'anthropic' | 'openai';

/**
 * The AI settings as the browser is allowed to see them.
 *
 * There is no `apiKey` field, and that is the point: the key is written to
 * `.spark/ai.json` on the server at mode 0600 and never travels back. The UI
 * can say "a key ending …f3a1 is set" and nothing more.
 */
export interface AiConfig {
  provider: AiProvider;
  model: string;
  endpoint: string;
  hasKey: boolean;
  keyHint: string;
  source: 'stored' | 'env' | 'none';
  /** Embedding model for semantic search. Empty means text matching only. */
  embedModel: string;
  embedEndpoint: string;
  hasEmbedKey: boolean;
}

/** The writable half. An omitted `apiKey` leaves the stored key alone. */
export interface AiConfigPatch {
  provider?: AiProvider;
  model?: string;
  endpoint?: string;
  apiKey?: string;
  embedModel?: string;
  embedEndpoint?: string;
  /** Omitted leaves the stored embedding key alone, the same rule as `apiKey`. */
  embedKey?: string;
}

export interface AiTestResult {
  ok: boolean;
  model?: string;
  reply?: string;
  error?: string;
}

/**
 * AI runs through the server so the provider key never reaches the browser.
 * Every call is opt-in and user-triggered — nothing here fires on its own.
 */
export class AiClient implements AiApi {
  #enabled = false;

  constructor(private readonly baseUrl = '/api/ai') {}

  // -- configuration --------------------------------------------------------

  async config(): Promise<AiConfig> {
    const res = await fetch(`${this.baseUrl}/config`);
    if (!res.ok) throw new Error(`Could not read the AI settings (${res.status}).`);
    return (await res.json()) as AiConfig;
  }

  async saveConfig(patch: AiConfigPatch): Promise<AiConfig> {
    const res = await fetch(`${this.baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error((await res.text()) || `Could not save (${res.status}).`);
    // Deliberately does not flip `#enabled` here: whether AI is usable is the
    // server's judgement (a local endpoint needs no key), and `/api/config` is
    // where that answer lives. The caller re-reads it.
    return (await res.json()) as AiConfig;
  }

  /** Forgets the stored settings; the server falls back to its environment. */
  async clearConfig(): Promise<AiConfig> {
    const res = await fetch(`${this.baseUrl}/config`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`Could not clear the AI settings (${res.status}).`);
    return (await res.json()) as AiConfig;
  }

  /**
   * Asks the server to make one real call, so a bad key fails here and not
   * mid-note.
   *
   * `patch` names the settings to test — the ones typed into the form, not the
   * ones on disk. Testing what is saved answers a question nobody asked: the
   * whole reason to press the button is to find out whether the key and model
   * in front of you work, *before* they replace ones that already do. Anything
   * omitted falls back to what the server has stored. Nothing is saved.
   */
  async test(patch: AiConfigPatch = {}): Promise<AiTestResult> {
    const res = await fetch(`${this.baseUrl}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { ok: false, error: (await res.text()) || `Failed (${res.status}).` };
    return (await res.json()) as AiTestResult;
  }

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
