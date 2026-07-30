import type Anthropic from '@anthropic-ai/sdk';
import { aiSettings, anthropic, describeFailure, sseData } from './ai.js';
import { endpointOf, type AiSettings } from './ai-settings.js';
import type { ChatMessage } from './chats.js';
import type { FilePayload, FileStore } from './files.js';
import type { MemoryStore, MemorySnapshot } from './memory.js';
import { describeSandbox, sandboxEnabled } from './sandbox.js';
import { skills, type SkillMeta } from './skills.js';
import type { FileSpace } from './space.js';
import {
  PERMISSION_MEANS,
  findTool,
  toolsFor,
  type SparkAction,
  type SparkTool,
  type ToolContext,
  type ToolPermissions,
} from './spark-tools.js';

/**
 * Spark: the conversation, and the loop that lets it act.
 *
 * The shape is the ordinary one — send the conversation with a list of tools,
 * run whatever comes back, send the results, repeat until there is nothing left
 * to run — and the interesting decisions are around the edges:
 *
 * - **Two providers, one loop.** Anthropic's Messages API and the
 *   OpenAI-compatible `/chat/completions` disagree about almost every field
 *   name, so each has its own `runX` that translates in and out. The tools, the
 *   permissions and the events they emit are shared, which is where the
 *   behaviour that matters actually lives.
 * - **History is replayed as prose.** Stored turns go back as plain user and
 *   assistant text, not as reconstructed tool blocks. Rebuilding a provider's
 *   exact block structure from disk is a migration problem waiting to happen,
 *   and the model does not need it: what it needs from three turns ago is what
 *   was said, and what a tool did is summarised in the assistant text.
 * - **Everything streams.** Text as it arrives, and a line the moment a tool
 *   starts, so a long piece of work reads as work rather than as a hang.
 */

/** What the browser receives, one JSON object per line. */
export type SparkEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-result'; id: string; ok: boolean; summary: string }
  | { type: 'action'; action: SparkAction }
  | { type: 'memory'; summary: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface SparkContext {
  /** The note in the tile beside the conversation, with its text. */
  neighbour?: { name: string; text: string };
  /** Names of everything else open on screen. */
  openPages?: string[];
}

export interface SparkRequest {
  message: string;
  /** Earlier turns, oldest first. */
  history: ChatMessage[];
  context: SparkContext;
  permissions: ToolPermissions;
  space: FileSpace;
  memory: MemoryStore;
  files: FileStore;
  /** Attachment names travelling with this message, already uploaded. */
  attachments?: string[];
  signal?: AbortSignal;
}

/** How many times the model may act before it has to say something. */
const MAX_ROUNDS = 8;
const MAX_TOKENS = 8192;

export async function* runSpark(request: SparkRequest): AsyncGenerator<SparkEvent> {
  const settings = aiSettings.get();
  const tools = toolsFor(request.permissions);

  // Both are read once per turn rather than per call: the memory files and the
  // skill catalogue are small, and reading them here means one place decides what
  // the model is told about itself.
  const snapshot = request.permissions.remember ? await request.memory.snapshot() : null;
  const catalogue = await skills.list();

  const system = buildSystemPrompt({
    context: request.context,
    permissions: request.permissions,
    memory: snapshot,
    memoryText: snapshot ? request.memory.promptSection(snapshot) : null,
    skills: catalogue,
  });

  const attachments = await loadAttachments(request);

  const ctx: ToolContext = {
    space: request.space,
    permissions: request.permissions,
    actions: [],
    memory: request.memory,
    files: request.files,
    signal: request.signal,
  };

  try {
    if (settings.provider === 'anthropic') {
      yield* runAnthropic(settings, system, request, tools, ctx, attachments);
    } else {
      yield* runOpenAi(settings, system, request, tools, ctx, attachments);
    }
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
    return;
  }

  // Deduplicated by page: creating a page queues an open, and Spark is also
  // told to open what it created, so the same note routinely gets asked for
  // twice in one turn. Opening it twice is not wrong, only noisy.
  const opened = new Set<string>();
  for (const action of ctx.actions) {
    if (opened.has(action.page)) continue;
    opened.add(action.page);
    yield { type: 'action', action };
  }

  yield { type: 'done' };
}

// ---------------------------------------------------------------------------
// Running one tool
// ---------------------------------------------------------------------------

interface ToolOutcome {
  ok: boolean;
  summary: string;
  detail: string;
}

async function runTool(
  tool: SparkTool | undefined,
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (!tool) {
    return { ok: false, summary: `No such tool: ${name}`, detail: `There is no tool called "${name}".` };
  }
  if (tool.needs && !ctx.permissions[tool.needs]) {
    // Reachable when a model asks for a tool it was never given. Answering with
    // a refusal rather than throwing lets it explain the situation to the user.
    return {
      ok: false,
      summary: `Not permitted: ${name}`,
      detail: `The person has not allowed Spark to ${PERMISSION_MEANS[tool.needs]}. Tell them, and suggest they turn it on in Settings.`,
    };
  }

  try {
    const result = await tool.run(input, ctx);
    return { ok: true, summary: result.summary, detail: result.detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: `${name} failed: ${message}`, detail: message };
  }
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

interface Attachment {
  name: string;
  payload: FilePayload;
}

/**
 * Reads the files travelling with this message.
 *
 * A file that cannot be sent is *kept* rather than dropped, carrying its reason,
 * so the model can say "that HEIC is stored but I cannot look at it" instead of
 * answering as though nothing was attached — which is the confusing failure: the
 * person watched the upload succeed.
 */
async function loadAttachments(request: SparkRequest): Promise<Attachment[]> {
  const names = (request.attachments ?? []).slice(0, 8);
  const out: Attachment[] = [];
  for (const name of names) {
    try {
      out.push({ name, payload: await request.files.payload(name) });
    } catch (err) {
      out.push({
        name,
        payload: { kind: 'unsupported', reason: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function* runAnthropic(
  settings: AiSettings,
  system: string,
  request: SparkRequest,
  tools: SparkTool[],
  ctx: ToolContext,
  attachments: Attachment[],
): AsyncGenerator<SparkEvent> {
  const client = anthropic(settings);
  const messages: Anthropic.MessageParam[] = [
    ...request.history.map(
      (turn): Anthropic.MessageParam => ({ role: turn.role, content: describeTurn(turn) }),
    ),
    { role: 'user', content: anthropicContent(request.message, attachments) },
  ];

  const declared = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema as Anthropic.Tool.InputSchema,
  }));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const stream = client.messages.stream(
      {
        model: settings.model,
        max_tokens: MAX_TOKENS,
        system,
        tools: declared,
        messages,
      },
      { signal: request.signal },
    );

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }

    const final = await stream.finalMessage();
    messages.push({ role: 'assistant', content: final.content });

    const calls = final.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (calls.length === 0) return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const input = (call.input ?? {}) as Record<string, unknown>;
      yield { type: 'tool', id: call.id, name: call.name, input };

      const outcome = await runTool(findTool(call.name), call.name, input, ctx);
      yield { type: 'tool-result', id: call.id, ok: outcome.ok, summary: outcome.summary };

      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: outcome.detail,
        is_error: !outcome.ok,
      });
    }

    messages.push({ role: 'user', content: results });
  }

  yield {
    type: 'text',
    text: '\n\nI stopped after several rounds of work without reaching an answer. Tell me what to focus on and I will pick it up from there.',
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A text part, or an image as a data URL — the two the compatible APIs agree on. */
type OpenAiPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | OpenAiPart[] | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

async function* runOpenAi(
  settings: AiSettings,
  system: string,
  request: SparkRequest,
  tools: SparkTool[],
  ctx: ToolContext,
  attachments: Attachment[],
): AsyncGenerator<SparkEvent> {
  const base = endpointOf(settings);
  const url = /\/(chat\/)?completions$/.test(base) ? base : `${base}/chat/completions`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;

  const messages: OpenAiMessage[] = [
    { role: 'system', content: system },
    ...request.history.map((turn): OpenAiMessage => ({ role: turn.role, content: describeTurn(turn) })),
    { role: 'user', content: openAiContent(request.message, attachments) },
  ];

  const declared = tools.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.schema },
  }));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: settings.model,
        stream: true,
        messages,
        ...(declared.length > 0 ? { tools: declared } : {}),
      }),
      signal: request.signal,
    });

    if (!res.ok || !res.body) throw new Error(await describeFailure(res));

    let text = '';
    // Tool calls arrive in fragments keyed by index: the name in one frame, the
    // arguments a few characters at a time across many more.
    const calls = new Map<number, OpenAiToolCall>();

    for await (const data of sseData(res.body)) {
      if (data === '[DONE]') break;

      let event: OpenAiStreamChunk;
      try {
        event = JSON.parse(data) as OpenAiStreamChunk;
      } catch {
        continue;
      }
      if (event.error) throw new Error(event.error.message ?? 'the provider returned an error');

      const choice = event.choices?.[0];
      const delta = choice?.delta ?? choice?.message;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        yield { type: 'text', text: delta.content };
      }

      for (const fragment of delta.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const call = calls.get(index) ?? {
          id: fragment.id ?? `call_${index}`,
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.function.name = fragment.function.name;
        if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
        calls.set(index, call);
      }
    }

    if (calls.size === 0) return;

    const toolCalls = [...calls.values()];
    messages.push({ role: 'assistant', content: text || null, tool_calls: toolCalls });

    for (const call of toolCalls) {
      let input: Record<string, unknown> = {};
      let parseError: string | null = null;
      try {
        input = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
      } catch {
        parseError = 'The arguments were not valid JSON. Send them again as a single JSON object.';
      }

      yield { type: 'tool', id: call.id, name: call.function.name, input };

      const outcome = parseError
        ? { ok: false, summary: `${call.function.name} failed: bad arguments`, detail: parseError }
        : await runTool(findTool(call.function.name), call.function.name, input, ctx);

      yield { type: 'tool-result', id: call.id, ok: outcome.ok, summary: outcome.summary };
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.detail });
    }
  }

  yield {
    type: 'text',
    text: '\n\nI stopped after several rounds of work without reaching an answer. Tell me what to focus on and I will pick it up from there.',
  };
}

interface OpenAiStreamChunk {
  error?: { message?: string };
  choices?: Array<{
    delta?: OpenAiDelta;
    message?: OpenAiDelta;
  }>;
}

interface OpenAiDelta {
  content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

// ---------------------------------------------------------------------------
// Turning attachments into message content
// ---------------------------------------------------------------------------

/**
 * The user turn, as Anthropic content blocks.
 *
 * Attachments come first and the person's words last, because a question about a
 * picture reads better after the picture — the same order you would put them in
 * an email. A PDF travels as a `document` block, which the Messages API reads
 * natively, pages and all.
 */
function anthropicContent(message: string, attachments: Attachment[]): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];

  for (const { name, payload } of attachments) {
    if (payload.kind === 'image') {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: payload.mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          data: payload.base64,
        },
      });
      blocks.push({ type: 'text', text: `(the image above is "${name}")` });
    } else if (payload.kind === 'document') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: payload.base64 },
      });
      blocks.push({ type: 'text', text: `(the document above is "${name}")` });
    } else if (payload.kind === 'text') {
      blocks.push({ type: 'text', text: `<attachment name="${name}">\n${payload.text}\n</attachment>` });
    } else {
      blocks.push({ type: 'text', text: `(they attached "${name}", but ${payload.reason})` });
    }
  }

  blocks.push({ type: 'text', text: message });
  return blocks;
}

/**
 * The same turn for the OpenAI-compatible shape.
 *
 * With no attachments this stays a plain string rather than a one-element array:
 * a good number of "OpenAI-compatible" servers accept only the string form, and
 * there is no reason to make every text-only turn depend on the multimodal one.
 * PDFs have no place in this shape at all, so they are named and declined.
 */
function openAiContent(message: string, attachments: Attachment[]): string | OpenAiPart[] {
  if (attachments.length === 0) return message;

  const parts: OpenAiPart[] = [];
  for (const { name, payload } of attachments) {
    if (payload.kind === 'image') {
      parts.push({ type: 'image_url', image_url: { url: `data:${payload.mime};base64,${payload.base64}` } });
      parts.push({ type: 'text', text: `(the image above is "${name}")` });
    } else if (payload.kind === 'text') {
      parts.push({ type: 'text', text: `<attachment name="${name}">\n${payload.text}\n</attachment>` });
    } else if (payload.kind === 'document') {
      parts.push({
        type: 'text',
        text: `(they attached "${name}", a PDF. This provider cannot be sent PDFs; say so, and offer to work from it if they paste the part that matters.)`,
      });
    } else {
      parts.push({ type: 'text', text: `(they attached "${name}", but ${payload.reason})` });
    }
  }

  parts.push({ type: 'text', text: message });
  return parts;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/**
 * A stored turn, as the model should read it back.
 *
 * Tool activity becomes one plain line rather than a reconstructed block, so
 * the model knows a page was created without the transcript pretending to be a
 * provider's wire format.
 */
function describeTurn(turn: ChatMessage): string {
  if (turn.role !== 'assistant' || !turn.tools?.length) return turn.text;
  const done = turn.tools.map((tool) => `- ${tool.summary}`).join('\n');
  return `${turn.text}\n\n[Actions taken in this turn:\n${done}\n]`;
}

const BASE_SYSTEM = `You are Spark, the assistant inside a markdown notes app called Spark Notes. You are talking with the person whose notes these are, in a panel beside their writing.

## What the notes are

The space is a folder of markdown files and nothing else. There is no database. A page is a file; a folder is a slash in a page name; a task is a line that reads "- [ ] something"; a tag is "#word" written in the text; a link to another page is "[[page name]]". Everything you write should be plain markdown that would still make sense if the app were deleted tomorrow.

## How to work

Read before you write. When a request touches an existing page, read it first so the text you edit is the text that is there, rather than what you remember of it. When you are unsure which page someone means, list or search rather than guessing at a name.

Prefer the smallest edit that does the job. Appending to a page cannot lose anything; a targeted replacement can only affect the passage you named; rewriting a page in full discards whatever you did not carry over. Reach for them in that order.

Make the change, then say what you did in one or two sentences. Do not narrate your intentions before acting, do not read a page back to the person who wrote it, and do not list the tool calls you are about to make. If something failed, say what failed and what you would need in order to fix it.

When you create or substantially change a page, open it so they can see it.

Ask a question when the answer would change what you do. Otherwise choose sensibly and say which way you went, so a wrong guess is cheap to correct.

## How to write

Write in careful prose. Full sentences, ordinary words, and a paragraph when a paragraph is the right shape. Bullet points are for lists of actual things, not for cutting a thought into fragments.

Never use emoji, anywhere, including in page content unless the person's existing notes already use them.

Use em-dashes sparingly, at most one in a reply. A comma, a full stop or a semicolon is nearly always the better choice, and a sentence that needs three dashes needs to be two sentences.

Do not open with a compliment, a restatement of the question, or a phrase like "Great question" or "Certainly". Begin with the answer. Do not close by offering further help; if there is an obvious next step, name it in a sentence, and otherwise stop.

Match the register of the notes you are working in. A journal entry is not a report. When you write into someone's page, write in their voice rather than yours: keep their vocabulary, their level of detail, and their formatting habits.

Say plainly when you do not know something or cannot find it. An honest "that is not in your notes" is worth more than a confident paragraph that is not.`;

export interface PromptInput {
  context: SparkContext;
  permissions: ToolPermissions;
  /** Null when remembering is switched off. */
  memory: MemorySnapshot | null;
  memoryText: string | null;
  skills: SkillMeta[];
}

/**
 * The system prompt, assembled from what is true this turn.
 *
 * The order is deliberate and is roughly "who you are, what you know, what you
 * can do, what you are looking at, when it is". Memory comes early because it
 * changes how everything after it should be read; the situational context comes
 * last but one because it is the most likely thing to be about.
 */
export function buildSystemPrompt(input: PromptInput): string {
  const { context, permissions } = input;
  const parts = [BASE_SYSTEM];

  if (input.memoryText) parts.push(input.memoryText);

  if (permissions.remember) {
    parts.push(MEMORY_HABITS);
  }

  const catalogue = skills.describe(input.skills);
  if (catalogue) parts.push(catalogue);

  if (permissions.run && sandboxEnabled()) {
    parts.push(
      `## Running code\n\nYou can run short Python or JavaScript programs with \`run_code\`. Use it for anything numeric — totals, counts, dates, reshaping a table — rather than working it out in your head, and say what the number is rather than pasting the script at them.\n\nThe runtime is: ${describeSandbox()}`,
    );
  }

  const capability: string[] = [];
  if (!permissions.write) {
    capability.push(
      'You can read the notes but not change them. If asked to write something, draft it in the conversation and say that changing pages is switched off in Settings.',
    );
  }
  if (permissions.write && !permissions.destroy) {
    capability.push(
      'You can create pages and add to them, but not delete, rename or overwrite one wholesale. If a request needs that, say so rather than working around it.',
    );
  }
  if (!permissions.remember) {
    capability.push(
      'You cannot keep notes about this person between conversations. Everything said here is forgotten when it ends, so do not promise to remember anything.',
    );
  }
  if (capability.length > 0) parts.push(`## Permissions\n\n${capability.join('\n\n')}`);

  const situational = describeContext(context);
  if (situational) parts.push(situational);

  const today = new Date().toISOString().slice(0, 10);
  parts.push(`## Right now\n\nToday is ${today}. The daily page for today is "journal/${today}".`);

  return parts.join('\n\n');
}

/**
 * How to use memory, told separately from what is in it.
 *
 * Kept apart from the memory content so the instruction survives an empty
 * memory: the first conversation is exactly when learning matters most, and a
 * prompt that only mentions remembering once there is something remembered would
 * never get started.
 */
const MEMORY_HABITS = `## Learning

You keep a memory between conversations, in their space at "memory/", which they can read and edit. Two habits make it worth having:

Record a **correction** the moment you get one. If they tell you that something you believed was wrong, or that you did something the wrong way, remove the wrong line and write the right one down before you carry on with the answer. Being told the same thing twice is the specific failure this exists to prevent, and it is the one they will notice.

Record a **standing preference** as a convention, in the imperative, when they express one about how their notes or your replies should be. "Put meeting notes in meetings/YYYY-MM-DD." "Never use bullet points in a journal entry."

Otherwise be strict. Do not record what happened — their notes are the record of what happened. Do not record what is already obvious from reading a page. Do not record anything they would be uncomfortable to find written down about themselves. Every line you add is a line in every future conversation, so the test is whether you would want to read it at the top of all of them.

Never mention that you are recording something unless it is a correction, in which case one clause is enough: "noted, meetings go in meetings/." Do not narrate memory, do not read it back, and do not thank them for it.`;

/**
 * What is on screen, told to the model.
 *
 * The neighbouring note arrives in full because "this paragraph" and "the third
 * heading" only mean something if you can see them; everything else arrives as
 * a name, because knowing a page is open is useful and reading all of them is
 * both expensive and presumptuous.
 */
function describeContext(context: SparkContext): string | null {
  const lines: string[] = [];

  if (context.neighbour) {
    lines.push(
      `The person has "${context.neighbour.name}" open in the tile beside this conversation. When they say "this note", "here" or "the page", that is what they mean. Its current text follows, including anything typed but not yet saved.`,
      '',
      `<note name="${context.neighbour.name}">`,
      context.neighbour.text.slice(0, 40_000),
      '</note>',
    );
  }

  const others = (context.openPages ?? []).filter((name) => name !== context.neighbour?.name);
  if (others.length > 0) {
    lines.push(
      '',
      `Also open elsewhere on screen: ${others.map((name) => `"${name}"`).join(', ')}. You have not been given their contents; read one if you need it.`,
    );
  }

  return lines.length > 0 ? `## What is on screen\n\n${lines.join('\n')}` : null;
}
