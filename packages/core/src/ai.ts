import type { AiApi, AiOptions } from '@spark/plugin-sdk';

/**
 * AI runs through the server so the provider key never reaches the browser.
 * Every call is opt-in and user-triggered — nothing here fires on its own.
 */
export class AiClient implements AiApi {
  #enabled = false;

  constructor(private readonly baseUrl = '/api/ai') {}

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
      throw new Error(
        'AI is not configured. Set ANTHROPIC_API_KEY on the server to enable it.',
      );
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
