import Anthropic from '@anthropic-ai/sdk';
import {
  AiSettingsStore,
  endpointOf,
  type AiSettings,
} from './ai-settings.js';
import { fetchWithRetry, isRetryable, sleep, RETRY_DELAYS_MS } from './retry.js';

/**
 * The AI proxy.
 *
 * Two shapes of API are spoken: Anthropic's Messages API, and the
 * OpenAI-compatible `/chat/completions` — which is what OpenAI, OpenRouter,
 * Groq, Together, Ollama, LM Studio and vLLM all serve, so "OpenAI-compatible"
 * is really "everything else". The OpenAI side is plain `fetch` rather than
 * another SDK: the request is one JSON body and the response is server-sent
 * events, and a dependency that only wraps that would also decide for us which
 * parameter names are allowed, which is exactly what breaks against the
 * long tail of compatible servers.
 *
 * Every call originates from an explicit user action — a slash command, the
 * voice capture, a button. Nothing here runs on a timer or watches what you
 * type, and the API key never leaves the server.
 */

export const aiSettings = new AiSettingsStore();

export const aiEnabled = (): boolean => aiSettings.enabled();

export interface CompletionRequest {
  prompt: string;
  system?: string;
  signal?: AbortSignal;
  /** Overrides the stored settings — used by "Test connection". */
  settings?: AiSettings;
}

/**
 * Streams a completion as plain text chunks.
 *
 * Streaming rather than buffering keeps the editor responsive on long
 * generations and avoids request timeouts at high token counts.
 */
export async function* streamCompletion(
  request: CompletionRequest,
): AsyncGenerator<string> {
  const settings = request.settings ?? aiSettings.get();
  const system = request.system ?? DEFAULT_SYSTEM;

  if (settings.provider === 'anthropic') {
    yield* streamAnthropic(settings, request.prompt, system, request.signal);
  } else {
    yield* streamOpenAi(settings, request.prompt, system, request.signal);
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

let cached: { key: string; baseURL: string; client: Anthropic } | null = null;

/** Shared with the Spark agent loop, which needs the same client. */
export function anthropic(settings: AiSettings): Anthropic {
  const baseURL = endpointOf(settings);
  if (cached?.key !== settings.apiKey || cached.baseURL !== baseURL) {
    cached = { key: settings.apiKey, baseURL, client: new Anthropic({ apiKey: settings.apiKey, baseURL }) };
  }
  return cached.client;
}

async function* streamAnthropic(
  settings: AiSettings,
  prompt: string,
  system: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  // Retried only up until the first real chunk: once something has reached
  // the editor, restarting the request from scratch would mean whatever
  // called this yields the same text twice. A failure after that point is
  // rare (a mid-stream connection drop) and is left to surface as-is — see
  // `RETRY_DELAYS_MS`'s doc comment for why this line is drawn the same way
  // in the Spark agent loop.
  for (let attempt = 0; ; attempt++) {
    const stream = anthropic(settings).messages.stream(
      {
        model: settings.model,
        max_tokens: 64_000,
        system,
        messages: [{ role: 'user', content: prompt }],
      },
      { signal },
    );

    let sawContent = false;
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          sawContent = true;
          yield event.delta.text;
        }
      }
      return;
    } catch (err) {
      if (sawContent || attempt >= RETRY_DELAYS_MS.length || !isRetryable(err) || signal?.aborted) throw err;
      await sleep(RETRY_DELAYS_MS[attempt], signal);
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------

async function* streamOpenAi(
  settings: AiSettings,
  prompt: string,
  system: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const base = endpointOf(settings);
  // Some people paste the full completions URL and some paste the base. Both
  // are reasonable readings of "endpoint", so accept either.
  const url = /\/(chat\/)?completions$/.test(base) ? base : `${base}/chat/completions`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // A local runtime typically wants no key; sending an empty bearer token makes
  // some of them reject the request outright.
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;

  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      stream: true,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(await describeFailure(res));
  }

  for await (const data of sseData(res.body)) {
    if (data === '[DONE]') return;

    let event: OpenAiChunk;
    try {
      event = JSON.parse(data) as OpenAiChunk;
    } catch {
      // A keep-alive comment or a partial frame; the reader will catch up.
      continue;
    }

    // An error can arrive mid-stream once the status line is already 200.
    if (event.error) throw new Error(event.error.message ?? 'the provider returned an error');

    const choice = event.choices?.[0];
    // `message` rather than `delta` means a server that ignored `stream: true`
    // and answered in one piece — take it rather than yielding nothing.
    const text = choice?.delta?.content ?? choice?.message?.content;
    if (text) yield text;
  }
}

interface OpenAiChunk {
  error?: { message?: string };
  choices?: Array<{
    delta?: { content?: string | null };
    message?: { content?: string | null };
  }>;
}

/** Yields the payload of each `data:` line in a server-sent event stream. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line; anything after the last one is a
    // partial frame and has to wait for the next read.
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
      split = buffer.indexOf('\n\n');
    }
  }
}

/**
 * A readable reason for a failed request.
 *
 * Providers put the useful part in `error.message` and everything else in a
 * wrapper; a raw JSON dump in a toast helps nobody.
 */
export async function describeFailure(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; message?: string };
    const message = parsed.error?.message ?? parsed.message;
    if (message) return `${message} (${res.status})`;
  } catch {
    /* not JSON */
  }
  return body.trim() ? `${body.trim().slice(0, 300)} (${res.status})` : `request failed (${res.status})`;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM = `You are a writing assistant inside a markdown notes app.

Reply with markdown that can be pasted straight into the user's note — no
preamble, no "Here is", no surrounding code fence unless the answer genuinely
is code. Match the note's existing voice. Keep it tight: the user asked for
help with their notes, not an essay about them.`;

/** Turns a rambling voice capture into structured notes. */
export const BRAINDUMP_SYSTEM = `You organize raw, unedited thinking into notes.

The input is a transcript — spoken aloud, unpunctuated, full of restarts and
tangents. Turn it into clean markdown:

- Keep the person's own words and voice wherever you can. Do not summarize away
  detail or make it sound like a report.
- Anything that is a commitment or an intention becomes "- [ ] task".
- Group related thoughts under short "##" headings only if there is genuinely
  more than one subject. A single train of thought needs no headings.
- Drop filler ("um", "you know", "like"), false starts, and repetition.
- Never invent content, conclusions, or tasks that were not said.

Output only the markdown.`;
