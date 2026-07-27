import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

/**
 * The AI proxy.
 *
 * Every call originates from an explicit user action — a slash command, the
 * voice capture, a button. Nothing here runs on a timer or watches what you
 * type, and the API key stays on the server.
 */

let client: Anthropic | null = null;

function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: config.anthropicKey });
  return client;
}

export interface CompletionRequest {
  prompt: string;
  system?: string;
  signal?: AbortSignal;
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
  const stream = anthropic().messages.stream(
    {
      model: config.aiModel,
      max_tokens: 64_000,
      system: request.system ?? DEFAULT_SYSTEM,
      messages: [{ role: 'user', content: request.prompt }],
    },
    { signal: request.signal },
  );

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
  }
}

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
