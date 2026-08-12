import type Anthropic from '@anthropic-ai/sdk';
import { aiSettings, anthropic, describeFailure, sseData } from './ai.js';
import { endpointOf, type AiSettings } from './ai-settings.js';
import { allowAlways, alwaysAllowed, askApproval } from './approvals.js';
import type { ChatMessage } from './chats.js';
import { listCommands } from './commands.js';
import { webSearchEnabled } from './web-search.js';
import type { FilePayload, FileStore } from './files.js';
import type { MemoryStore, MemorySnapshot } from './memory.js';
import { RETRY_DELAYS_MS, isRetryable, isRetryableStatus, sleep } from './retry.js';
import { describeSandbox, sandboxEnabled } from './sandbox.js';
import { skills, type SkillMeta } from './skills.js';
import type { FileSpace } from './space.js';
import { sparkSettings, type SparkMode } from './spark-settings.js';
import {
  PERMISSION_MEANS,
  findTool,
  needsApproval,
  toolsFor,
  type PermissionMode,
  type SparkAction,
  type SparkTool,
  type ToolCitation,
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
  /**
   * The model reasoning out loud, when the model does that and the person has
   * asked to see it. Its own event rather than text with a marker: it is not part
   * of the answer, it must not be stored as one, and a client that hides it has to
   * be able to hide it without parsing prose.
   */
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool-result';
      id: string;
      ok: boolean;
      summary: string;
      pages?: string[];
      detail?: string;
      citations?: ToolCitation[];
    }
  /** A tool is waiting for a yes. Answered on `/api/spark/approve`. */
  | { type: 'approval'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'action'; action: SparkAction }
  | { type: 'memory'; summary: string }
  /**
   * The provider's first response this turn failed in a way worth trying
   * again — a dropped connection, a `429`, a `5xx` — and a retry is about to
   * happen. Only ever emitted before any `text`/`thinking`/`tool` event has
   * gone out this turn: once something has streamed, a retry would risk
   * duplicating it, so a later failure is reported through `error` instead.
   * A real event rather than folded into `text` for the same reason
   * `thinking` is its own event — it is not part of the answer.
   */
  | { type: 'retrying'; attempt: number; reason: string }
  /**
   * The primary provider profile failed — retries exhausted, or no retries
   * were even retryable — before any content streamed this turn, and a
   * configured fallback profile (`SparkMode.fallbackProviderId`) is about to
   * answer instead. Never emitted once anything has streamed, for the same
   * reason `retrying` isn't: two providers' output in one answer would be
   * worse than a clean error.
   */
  | { type: 'fallback'; from: string; to: string; reason: string }
  /**
   * Tokens actually billed for this turn, summed across every round — a
   * multi-round tool-calling turn is several requests, not one, so this is
   * only meaningful once, at the very end, not per round. `profileId`/
   * `model` name whichever provider actually answered (the fallback, if one
   * took over), since that's what the tokens were billed against.
   */
  | { type: 'usage'; inputTokens: number; outputTokens: number; profileId: string; model: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface SparkContext {
  /** The note in the tile beside the conversation, with its text. */
  neighbour?: { name: string; text: string };
  /** Names of everything else open on screen. */
  openPages?: string[];
  /**
   * Pages and passages the person attached to this message by hand.
   *
   * Distinct from `neighbour`, which is what happens to be beside the panel.
   * These were chosen, so they are described as chosen — a model that cannot tell
   * "the note I am looking at" from "the note I pointed at" answers about the
   * wrong one.
   */
  attached?: Array<{ name: string; text: string; selection?: boolean }>;
}

/**
 * Which folders this device treats as the journal and the templates —
 * see `apps/web/src/lib/dirs.ts`. A device-local setting, not a fact about
 * the space, so it travels with every request rather than living on the
 * server: two devices open on the same space are allowed to call the same
 * folder something different.
 */
export interface SparkDirs {
  journal: string;
  templates: string;
}

const DEFAULT_DIRS: SparkDirs = { journal: 'journal', templates: '_templates' };

export interface SparkRequest {
  message: string;
  /** Earlier turns, oldest first. */
  history: ChatMessage[];
  context: SparkContext;
  /** Journal and templates folder names, as this device has them set. */
  dirs?: SparkDirs;
  permissions: ToolPermissions;
  /** How much happens without being asked about. */
  mode: PermissionMode;
  /** Which model preset to use. Falls back to the one saved in settings. */
  modeId?: string;
  /** Conversation id, for remembering an "always allow". */
  chatId: string;
  space: FileSpace;
  memory: MemoryStore;
  files: FileStore;
  /** Attachment names travelling with this message, already uploaded. */
  attachments?: string[];
  signal?: AbortSignal;
}

/**
 * How many times the model may act before it has to say something.
 *
 * Generous, and deliberately so: this used to be eight, and eight is fewer than a
 * real piece of work takes. Reading four pages, editing three of them and
 * presenting the result is nine calls before a word has been written, so the cap
 * was landing on the jobs it was least reasonable to interrupt — and the person
 * saw an apology instead of the work that was nearly finished.
 *
 * The cap is not removed, because a loop that cannot terminate is worse than one
 * that stops early. What changed is what happens *at* it: see `finalWord`.
 */
const MAX_ROUNDS = 24;
const MAX_TOKENS = 8192;

/**
 * How much of a tool's own detail — `read_page`'s full text, `run_code`'s
 * stdout, `search`'s matched passages — reaches the person, in the
 * expandable panel under its one-line summary in the transcript. Separate
 * from (and much smaller than) `spark-tools.ts`'s `READ_LIMIT`, which caps
 * what the *model* is sent: a model can use 60,000 characters of context, a
 * person reading a chat transcript cannot use 60,000 characters under one
 * tool call.
 */
const TOOL_DETAIL_UI_LIMIT = 4000;

function capToolDetail(detail: string): string {
  return detail.length > TOOL_DETAIL_UI_LIMIT
    ? `${detail.slice(0, TOOL_DETAIL_UI_LIMIT)}\n\n[truncated: ${detail.length - TOOL_DETAIL_UI_LIMIT} more characters]`
    : detail;
}

export async function* runSpark(request: SparkRequest): AsyncGenerator<SparkEvent> {
  const defaultProfile = aiSettings.defaultProfile();
  const mode = sparkSettings.modeFor(defaultProfile.provider, request.modeId);

  // A mode that never named a provider gets the one marked default — the
  // same "absence is a real state" rule the rest of `SparkMode` follows —
  // and a mode that named one since deleted falls back the same way rather
  // than erroring the turn over a stale id.
  const primary = aiSettings.profile(mode?.providerId) ?? defaultProfile;
  const fallback = mode?.fallbackProviderId ? aiSettings.profile(mode.fallbackProviderId) : null;

  const tools = toolsFor(request.permissions);

  // Read once per turn rather than per call: the memory files, the skills and the
  // shape of the space are all small, and reading them here means one place
  // decides what the model is told about itself.
  const snapshot = request.permissions.remember ? await request.memory.snapshot() : null;
  const catalogue = await skills.list();
  const commands = await listCommands();
  const attachments = await loadAttachments(request);

  const ctx: ToolContext = {
    space: request.space,
    permissions: request.permissions,
    actions: [],
    memory: request.memory,
    files: request.files,
    chatId: request.chatId,
    signal: request.signal,
  };

  // Deduplicated by page: creating a page queues a presentation, and Spark is
  // also told to present what it created, so the same note routinely gets asked
  // for twice in one turn. Presenting it twice is not wrong, only noisy. Shared
  // with the provider loops below, which yield each action the moment its tool
  // call resolves rather than waiting for the whole turn to finish.
  const shown = new Set<string>();

  /** One full attempt against one provider profile — everything the model is told is built fresh, since it names *which* profile is answering. */
  async function* attempt(profile: AiSettings): AsyncGenerator<SparkEvent> {
    // The preset names a model; an empty one means "whatever is configured", which
    // is the only sensible default for the long tail of OpenAI-compatible servers.
    const active: AiSettings = mode?.model ? { ...profile, model: mode.model } : profile;
    const system = buildSystemPrompt({
      context: request.context,
      dirs: request.dirs ?? DEFAULT_DIRS,
      permissions: request.permissions,
      mode: request.mode,
      memory: snapshot,
      memoryText: snapshot ? request.memory.promptSection(snapshot) : null,
      skills: catalogue,
      commands: commands.filter((command) => command.kind === 'builtin').map((command) => command.name),
      model: active.model,
      provider: profile.provider,
      modeLabel: mode?.label ?? null,
      folders: await topFolders(request.space),
      settings: sparkSettings.get(defaultProfile.provider),
    });

    if (profile.provider === 'anthropic') {
      yield* runAnthropic(active, system, request, tools, ctx, attachments, mode, shown);
    } else {
      yield* runOpenAi(active, system, request, tools, ctx, attachments, mode, shown);
    }
  }

  // Whether anything has reached the person yet this turn — the line a
  // fallback is not allowed to cross. `runAnthropic`/`runOpenAi` already
  // retry a round-0 failure internally (see `RETRY_DELAYS_MS`); by the time
  // either one actually throws past that, a round-0 failure has never
  // yielded content and a later round's failure always has, so this flag is
  // exactly the fallback-eligibility test the design calls for.
  let sawContent = false;
  try {
    for await (const event of attempt(primary)) {
      if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool') sawContent = true;
      yield event;
    }
  } catch (err) {
    if (sawContent || !fallback || request.signal?.aborted) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) };
      return;
    }
    yield {
      type: 'fallback',
      from: primary.label,
      to: fallback.label,
      reason: err instanceof Error ? err.message : String(err),
    };
    try {
      yield* attempt(fallback);
    } catch (fallbackErr) {
      yield {
        type: 'error',
        message: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
      };
      return;
    }
  }

  // Catches anything queued outside a round's tool loop — in practice nothing,
  // since every path that pushes an action does so from inside a tool call, but
  // a defensive no-op here is cheaper than a presentation silently never
  // reaching the browser if that ever stops being true.
  yield* newActions(ctx, shown);

  yield { type: 'done' };
}

/** Actions queued since the last check, each shown at most once. */
function* newActions(ctx: ToolContext, shown: Set<string>): Generator<SparkEvent> {
  for (const action of ctx.actions) {
    if (shown.has(action.page)) continue;
    shown.add(action.page);
    yield { type: 'action', action };
  }
}

/**
 * The shape of the space, for the prompt.
 *
 * Top level only, with counts. The whole page list is the wrong thing to put in a
 * system prompt — it is thousands of lines for most of the questions that never
 * needed it — but *where things go* is needed by almost every request that writes
 * anything, and a model that has to call a tool to find out asks the same question
 * every turn.
 */
async function topFolders(space: FileSpace): Promise<Array<{ name: string; pages: number }>> {
  const [pages, folders] = await Promise.all([space.list(), space.listFolders()]);
  const counts = new Map<string, number>();
  for (const folder of folders) counts.set(folder.split('/')[0], counts.get(folder.split('/')[0]) ?? 0);
  for (const page of pages) {
    const slash = page.name.indexOf('/');
    if (slash === -1) continue;
    const top = page.name.slice(0, slash);
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, pages: count }))
    .sort((a, b) => b.pages - a.pages || a.name.localeCompare(b.name))
    .slice(0, 40);
}

// ---------------------------------------------------------------------------
// Running one tool
// ---------------------------------------------------------------------------

interface ToolOutcome {
  ok: boolean;
  summary: string;
  detail: string;
  pages?: string[];
  citations?: ToolCitation[];
}

/**
 * Running one tool, with the pause for approval where it belongs.
 *
 * A generator rather than a plain async function because the approval question
 * has to reach the browser *before* the answer can come back, and the only way
 * out of this loop is the event stream. So it yields the question, waits, and then
 * yields the result — which also means the transcript shows the pause, rather than
 * the turn appearing to hang.
 */
async function* runTool(
  tool: SparkTool | undefined,
  id: string,
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  gate: { mode: PermissionMode; chatId: string; signal?: AbortSignal },
): AsyncGenerator<SparkEvent, ToolOutcome> {
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

  if (needsApproval(tool, gate.mode) && !alwaysAllowed(gate.chatId, name)) {
    yield { type: 'approval', id, name, input };
    const decision = await askApproval(id, gate.signal);
    if (decision === 'always') allowAlways(gate.chatId, name);
    if (decision === 'deny') {
      return {
        ok: false,
        summary: `Declined: ${label(name)}`,
        // Phrased so the model treats this as a decision rather than a fault:
        // apologising for a refusal the person made on purpose reads badly, and
        // retrying it immediately is worse.
        detail:
          'They declined this. Do not try it again. Carry on with what you can do without it, or say what you would need permission for and stop.',
      };
    }
  }

  try {
    const result = await tool.run(input, ctx);
    return {
      ok: true,
      summary: result.summary,
      detail: result.detail,
      pages: result.pages,
      citations: result.citations,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, summary: `${name} failed: ${message}`, detail: message };
  }
}

/** `create_page` reads as "Creating a page" in a sentence. */
function label(name: string): string {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

interface Attachment {
  name: string;
  payload: FilePayload;
}

/**
 * `files.payload()` already refuses any single file over 5MB, but several
 * files each just under that limit can still add up to more than a request
 * should carry — the failure then arrives as an opaque rejection from the
 * provider, or a turn that silently eats most of the context window on
 * attachments instead of the conversation. 20MB total leaves real room for a
 * handful of images or a couple of PDFs while catching the pathological case.
 */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Bytes a payload actually costs the request — base64 is ~4/3 its decoded size. */
function payloadBytes(payload: FilePayload): number {
  if (payload.kind === 'text') return payload.text.length;
  if (payload.kind === 'image' || payload.kind === 'document') return Math.ceil(payload.base64.length * 0.75);
  return 0;
}

/**
 * Reads the files travelling with this message.
 *
 * A file that cannot be sent is *kept* rather than dropped, carrying its reason,
 * so the model can say "that HEIC is stored but I cannot look at it" instead of
 * answering as though nothing was attached — which is the confusing failure: the
 * person watched the upload succeed. A file that would push the turn over the
 * aggregate budget gets the same treatment: kept, with a reason, rather than
 * silently omitted or left to fail as an opaque provider error.
 */
async function loadAttachments(request: SparkRequest): Promise<Attachment[]> {
  const names = (request.attachments ?? []).slice(0, 8);
  const out: Attachment[] = [];
  let budget = MAX_ATTACHMENT_BYTES;
  for (const name of names) {
    try {
      const payload = await request.files.payload(name);
      const bytes = payloadBytes(payload);
      if (payload.kind !== 'unsupported' && bytes > budget) {
        out.push({
          name,
          payload: {
            kind: 'unsupported',
            reason: `"${name}" was left out: these attachments together are over the ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB limit for one message. It is on disk and can be linked to.`,
          },
        });
        continue;
      }
      budget -= bytes;
      out.push({ name, payload });
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
  mode: SparkMode | null,
  shown: Set<string>,
): AsyncGenerator<SparkEvent> {
  const client = anthropic(settings);
  const messages: Anthropic.MessageParam[] = [
    ...replayHistory(request.history),
    { role: 'user', content: anthropicContent(request.message, attachments) },
  ];

  // A multi-round tool-calling turn is several requests, not one — summed
  // here and yielded once, at whichever `return` actually ends the turn.
  let inputTokens = 0;
  let outputTokens = 0;
  const usageEvent = (): SparkEvent => ({
    type: 'usage',
    inputTokens,
    outputTokens,
    profileId: settings.id,
    model: settings.model,
  });

  const declared = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.schema as Anthropic.Tool.InputSchema,
  }));

  const thinking = mode?.thinking ?? 0;
  // The budget has to fit inside the reply, with room left for the reply itself.
  // Sending a budget at or above `max_tokens` is rejected outright.
  const maxTokens = thinking > 0 ? thinking + MAX_TOKENS : MAX_TOKENS;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // The last round is run without tools. See `finalWord`.
    const last = round === MAX_ROUNDS - 1;

    const buildStream = () =>
      client.messages.stream(
        {
          model: settings.model,
          max_tokens: maxTokens,
          system,
          ...(last ? {} : { tools: declared }),
          ...(thinking > 0 ? { thinking: { type: 'enabled' as const, budget_tokens: thinking } } : {}),
          messages: last ? [...messages, { role: 'user' as const, content: finalWord() }] : messages,
        },
        {
          signal: request.signal,
          // Without this, thinking blocks only cover the reasoning *before* a
          // tool call, not the reasoning between receiving a result and deciding
          // the next action — so a multi-round turn showed thinking once, at the
          // start, and then a silent run of tool calls. `headers` rather than
          // switching to `client.beta.messages`, which has its own parallel set
          // of block types and would mean retyping every `Anthropic.*` reference
          // in this function for one header.
          ...(thinking > 0 ? { headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } } : {}),
        },
      );

    // Retried only on `round === 0`, and only until the first real chunk:
    // once something has streamed this turn, restarting the request would
    // risk the person seeing it twice. A later round's failure — after tools
    // have already run — always throws straight through to the caller's
    // error-marking path instead, the same reasoning in both places.
    let stream = buildStream();
    let sawContent = false;
    for (let attempt = 0; ; attempt++) {
      try {
        for await (const event of stream) {
          if (event.type !== 'content_block_delta') continue;
          if (event.delta.type === 'text_delta') {
            sawContent = true;
            yield { type: 'text', text: event.delta.text };
          }
          if (event.delta.type === 'thinking_delta') {
            sawContent = true;
            yield { type: 'thinking', text: event.delta.thinking };
          }
        }
        break;
      } catch (err) {
        if (round > 0 || sawContent || attempt >= RETRY_DELAYS_MS.length || !isRetryable(err) || request.signal?.aborted) {
          throw err;
        }
        yield {
          type: 'retrying',
          attempt: attempt + 1,
          reason: err instanceof Error ? err.message : String(err),
        };
        await sleep(RETRY_DELAYS_MS[attempt], request.signal);
        stream = buildStream();
      }
    }

    // Read regardless of `last`: the SDK has already built this from the
    // stream just consumed above, so it costs nothing extra, and usage is
    // exactly the information the last round would otherwise return without
    // ever reporting.
    const final = await stream.finalMessage();
    inputTokens += final.usage.input_tokens;
    outputTokens += final.usage.output_tokens;

    if (last) {
      yield usageEvent();
      return;
    }

    // Pushed whole, thinking blocks included: with extended thinking on, the API
    // requires the reasoning that led to a tool call to come back with the result,
    // and stripping it here fails the next request rather than this one.
    messages.push({ role: 'assistant', content: final.content });

    const calls = final.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (calls.length === 0) {
      yield usageEvent();
      return;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      const input = (call.input ?? {}) as Record<string, unknown>;
      yield { type: 'tool', id: call.id, name: call.name, input };

      const outcome = yield* runTool(findTool(call.name), call.id, call.name, input, ctx, {
        mode: request.mode,
        chatId: request.chatId,
        signal: request.signal,
      });
      yield {
        type: 'tool-result',
        id: call.id,
        ok: outcome.ok,
        summary: outcome.summary,
        ...(outcome.pages ? { pages: outcome.pages } : {}),
        ...(outcome.detail ? { detail: capToolDetail(outcome.detail) } : {}),
        ...(outcome.citations ? { citations: outcome.citations } : {}),
      };

      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: outcome.detail,
        is_error: !outcome.ok,
      });

      // Right after the tool that queued it resolves, not batched to the end of
      // the turn — see `SparkAction`'s doc comment.
      yield* newActions(ctx, shown);
    }

    messages.push({ role: 'user', content: results });
  }
}

/**
 * What is said at the round cap.
 *
 * The old behaviour was a canned apology appended to whatever half-finished text
 * had streamed, which is the worst of both: the work is not reported and the
 * person is told nothing useful about it. Instead the last round runs with the
 * tools taken away, so the model has no option but to write the answer — and it
 * has just done twenty-odd calls' worth of reading, so it has one to write.
 */
function finalWord(): string {
  return '<instruction>You have used up the work you get for this turn. Stop calling tools and answer now: say what you did, what you found, and what is left. If something is unfinished, name the one thing you would do next. Do not apologise for the number of steps.</instruction>';
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
  mode: SparkMode | null,
  shown: Set<string>,
): AsyncGenerator<SparkEvent> {
  const base = endpointOf(settings);
  const url = /\/(chat\/)?completions$/.test(base) ? base : `${base}/chat/completions`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;

  const messages: OpenAiMessage[] = [
    { role: 'system', content: system },
    ...replayHistory(request.history).map(
      (turn): OpenAiMessage => ({
        role: turn.role,
        content: typeof turn.content === 'string' ? turn.content : '',
      }),
    ),
    { role: 'user', content: openAiContent(request.message, attachments) },
  ];

  const declared = tools.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.schema },
  }));

  // Summed across every round, the same reasoning `runAnthropic`'s own
  // accumulator has — a multi-round tool-calling turn is several requests.
  let inputTokens = 0;
  let outputTokens = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const last = round === MAX_ROUNDS - 1;

    const body = JSON.stringify({
      model: settings.model,
      stream: true,
      // Standard OpenAI streaming option to get a `usage` field on the final
      // chunk. A server that doesn't recognise it just ignores it, same as
      // `reasoning_effort` below — this is safe to send unconditionally.
      stream_options: { include_usage: true },
      messages: last ? [...messages, { role: 'user', content: finalWord() }] : messages,
      ...(declared.length > 0 && !last ? { tools: declared } : {}),
      // Named the way the reasoning-capable compatible servers name it. A
      // server that does not know the field ignores it, which is why it is safe
      // to send rather than gated on a list of model ids that would go stale.
      ...(mode?.thinking ? { reasoning_effort: mode.thinking >= 8192 ? 'high' : 'medium' } : {}),
    });

    // Retried only on `round === 0`, the same reasoning as `runAnthropic`'s
    // own retry loop: this is the request that hasn't streamed anything yet,
    // so a dropped connection or a `429`/`5xx` here is worth trying again
    // before giving up. Once the connection succeeds, a failure while
    // reading the body below is left alone — the SSE loop may already have
    // yielded text by then.
    let res: Response;
    if (round === 0) {
      for (let attempt = 0; ; attempt++) {
        try {
          res = await fetch(url, { method: 'POST', headers, body, signal: request.signal });
        } catch (err) {
          if (attempt >= RETRY_DELAYS_MS.length || !isRetryable(err) || request.signal?.aborted) throw err;
          yield { type: 'retrying', attempt: attempt + 1, reason: err instanceof Error ? err.message : String(err) };
          await sleep(RETRY_DELAYS_MS[attempt], request.signal);
          continue;
        }
        if (!res.ok && isRetryableStatus(res.status) && attempt < RETRY_DELAYS_MS.length && !request.signal?.aborted) {
          yield { type: 'retrying', attempt: attempt + 1, reason: `request failed (${res.status})` };
          await sleep(RETRY_DELAYS_MS[attempt], request.signal);
          continue;
        }
        break;
      }
    } else {
      res = await fetch(url, { method: 'POST', headers, body, signal: request.signal });
    }

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

      // The usage-carrying chunk is often its own frame — no choices, no
      // delta — sent right before `[DONE]`, so this has to run before the
      // `!delta` guard below would otherwise skip it entirely.
      if (event.usage) {
        inputTokens += event.usage.prompt_tokens ?? 0;
        outputTokens += event.usage.completion_tokens ?? 0;
      }

      const choice = event.choices?.[0];
      const delta = choice?.delta ?? choice?.message;
      if (!delta) continue;

      if (delta.content) {
        text += delta.content;
        yield { type: 'text', text: delta.content };
      }

      // Two spellings, because the compatible servers did not agree on one.
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) yield { type: 'thinking', text: reasoning };

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

    if (last || calls.size === 0) {
      yield { type: 'usage', inputTokens, outputTokens, profileId: settings.id, model: settings.model };
      return;
    }

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

      const outcome: ToolOutcome = parseError
        ? { ok: false, summary: `${call.function.name} failed: bad arguments`, detail: parseError }
        : yield* runTool(findTool(call.function.name), call.id, call.function.name, input, ctx, {
            mode: request.mode,
            chatId: request.chatId,
            signal: request.signal,
          });

      yield {
        type: 'tool-result',
        id: call.id,
        ok: outcome.ok,
        summary: outcome.summary,
        ...(outcome.pages ? { pages: outcome.pages } : {}),
        ...(outcome.detail ? { detail: capToolDetail(outcome.detail) } : {}),
        ...(outcome.citations ? { citations: outcome.citations } : {}),
      };
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.detail });

      // Right after the tool that queued it resolves, not batched to the end of
      // the turn — see `SparkAction`'s doc comment.
      yield* newActions(ctx, shown);
    }
  }
}

interface OpenAiStreamChunk {
  error?: { message?: string };
  choices?: Array<{
    delta?: OpenAiDelta;
    message?: OpenAiDelta;
  }>;
  /** Present on the final chunk when `stream_options.include_usage` is honoured. */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAiDelta {
  content?: string | null;
  /** Reasoning, under the two names the compatible servers use for it. */
  reasoning_content?: string | null;
  reasoning?: string | null;
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
 * Stored turns, as the model should read them back.
 *
 * Tool activity is replayed as a *note attached to the person's next message*,
 * never as part of the assistant's own text, and that placement is a bug fix
 * rather than a preference.
 *
 * The old version appended `[Actions taken in this turn: ...]` to the assistant
 * text. Which worked, until it did not: the model reads its own previous turns as
 * examples of how it writes, saw that every reply that used a tool ended in a
 * bracketed list of tool calls, and started producing that list itself — as
 * literal prose, at the end of real answers, in front of the person. A format
 * that appears in the assistant's voice is a format the assistant will imitate.
 * Anything the model should know but not copy has to arrive in somebody else's
 * voice, which here means the app's, folded into the user turn that follows.
 *
 * The same reasoning is why `stripActionTrail` exists: conversations saved by the
 * old code still have those brackets in their stored text, and replaying them
 * would teach the habit all over again.
 */
function replayHistory(history: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  /** Tool activity from the assistant turn just seen, waiting for a home. */
  let trail: string | null = null;

  for (const turn of history) {
    if (turn.role === 'assistant') {
      // A turn marked `error` stopped partway through — replaying its text as
      // an ordinary finished reply would teach the model that the fragment
      // *was* the answer, rather than the interruption it actually was.
      const text = turn.error
        ? `(this reply did not finish — ${turn.error}${turn.text ? `\n\n${stripActionTrail(turn.text)}` : ''})`
        : stripActionTrail(turn.text) || '(no reply was recorded)';
      out.push({ role: 'assistant', content: text });
      trail = turn.tools?.length
        ? turn.tools.map((tool) => `- ${tool.summary}`).join('\n')
        : null;
      continue;
    }

    out.push({
      role: 'user',
      content: trail
        ? `<note>Before this message, you did the following:\n${trail}\n</note>\n\n${turn.text}`
        : turn.text,
    });
    trail = null;
  }

  // A trail left over belongs to the last assistant turn, with the message being
  // sent now as the user turn it attaches to. Emitting it as its own user message
  // would put two user turns in a row, which Anthropic merges and OpenAI tolerates
  // but neither reads the way this is meant.
  if (trail) {
    out.push({ role: 'user', content: `<note>In your last reply you did:\n${trail}\n</note>` });
    out.push({ role: 'assistant', content: 'Understood.' });
  }

  return out;
}

/** Removes the bracketed tool list the old replay format taught the model to write. */
function stripActionTrail(text: string): string {
  return text.replace(/\n*\[Actions taken in this turn:[\s\S]*?\n\]\s*$/g, '').trimEnd();
}

const BASE_SYSTEM = `You are Spark, the assistant inside a markdown notes app called Spark Notes. You are talking with the person whose notes these are, in a panel beside their writing.

## What the notes are

The space is a folder of markdown files and nothing else. There is no database. A page is a file; a folder is a slash in a page name; a task is a line that reads "- [ ] something"; a tag is "#word" written in the text; a link to another page is "[[page name]]". Everything you write should be plain markdown that would still make sense if the app were deleted tomorrow.

## How to work

Read before you write. When a request touches an existing page, read it first so the text you edit is the text that is there, rather than what you remember of it. When you are unsure which page someone means, list or search rather than guessing at a name.

Prefer the smallest edit that does the job. Appending to a page cannot lose anything; a targeted replacement can only affect the passage you named; rewriting a page in full discards whatever you did not carry over. Reach for them in that order.

Make the change, then say what you did in one or two sentences. Do not narrate your intentions before acting, do not read a page back to the person who wrote it, and do not list the tool calls you are about to make — the app already shows them, and writing them out again is the one habit that makes a good answer unreadable. Never end a reply with a summary of the tools you used. If something failed, say what failed and what you would need in order to fix it.

When you create or substantially change a page, present it with \`present_page\` so they can read it. Presenting is how you show your work: it shows the page as a card in the conversation, with a button they can open it from, and attaches it to the conversation — so quoting a page back at them is never the right move.

Ask a question when the answer would change what you do. Otherwise choose sensibly and say which way you went, so a wrong guess is cheap to correct.

## Where things go, and what they are called

Read the space before deciding where something belongs. The folders that are already there are the person's filing system, and matching it is almost always right; inventing a new top-level folder beside four that already fit is not.

**Your own working notes go in \`ai/\`** unless the request names somewhere else or the content plainly belongs with theirs. A summary they asked you to write about their projects is a note and goes where notes go; a scratch list, a draft you are iterating on, a report you generated is yours and goes in \`ai/\`, so their space does not slowly fill with things they did not write.

Page names are **titles, not filenames**. Write them the way the person would write a heading: capitals where capitals belong, ordinary spaces between words. "Project Kickoff", not "project-kickoff" or "project_kickoff". A folder prefix is lowercase where their folders are lowercase — match what is there.

Never put an em-dash, an en-dash, a colon, a slash you did not mean as a folder, or a quotation mark in a page name. They read badly in a file listing and some of them are not legal on every filesystem the space might be synced to. If a title wants a dash, use a plain hyphen with spaces around it.

## How to write

Write in careful prose. Full sentences, ordinary words, and a paragraph when a paragraph is the right shape. Bullet points are for lists of actual things, not for cutting a thought into fragments.

Never use emoji, anywhere, including in page content unless the person's existing notes already use them.

Use em-dashes sparingly, at most one in a reply. A comma, a full stop or a semicolon is nearly always the better choice, and a sentence that needs three dashes needs to be two sentences.

Do not open with a compliment, a restatement of the question, or a phrase like "Great question" or "Certainly". Begin with the answer. Do not close by offering further help; if there is an obvious next step, name it in a sentence, and otherwise stop.

Match the register of the notes you are working in. A journal entry is not a report. When you write into someone's page, write in their voice rather than yours: keep their vocabulary, their level of detail, and their formatting habits.

Say plainly when you do not know something or cannot find it. An honest "that is not in your notes" is worth more than a confident paragraph that is not.`;

export interface PromptInput {
  context: SparkContext;
  dirs: SparkDirs;
  permissions: ToolPermissions;
  mode: PermissionMode;
  /** Null when remembering is switched off. */
  memory: MemorySnapshot | null;
  memoryText: string | null;
  skills: SkillMeta[];
  /** Built-in slash command names, so Spark can tell someone what to type. */
  commands: string[];
  /** The model actually answering, and who serves it. */
  model: string;
  provider: 'anthropic' | 'openai';
  /** The preset in force — "Fast", "Quality" — or null when none is set. */
  modeLabel: string | null;
  folders: Array<{ name: string; pages: number }>;
  settings: { userName: string; instructions: string };
}

/**
 * The system prompt, assembled from what is true this turn.
 *
 * The order is deliberate: **the person's own instructions first**, then who you
 * are, what you know, what you can do, what you are looking at, and when it is.
 *
 * Custom instructions going *above* the base prompt rather than below it is the
 * load-bearing choice. Later text does not reliably beat earlier text, so
 * position cannot be what makes them win; what makes them win is that they are
 * introduced as outranking everything that follows, and that only works if there
 * is something following to outrank. A standing instruction buried under two
 * thousand words of house style is one the house style quietly overrules.
 */
export function buildSystemPrompt(input: PromptInput): string {
  const { context, permissions } = input;
  const parts: string[] = [];

  const instructions = input.settings.instructions.trim();
  if (instructions) {
    parts.push(
      [
        '## Their instructions',
        '',
        'This person has told you how they want you to work. What follows outranks everything else in this prompt, including the house style below. Where the two disagree, they win; where they are silent, the rest applies.',
        '',
        instructions,
      ].join('\n'),
    );
  }

  parts.push(BASE_SYSTEM);

  if (input.settings.userName) {
    parts.push(
      `## Who you are talking to\n\nTheir name is ${input.settings.userName}. Use it the way a colleague would: rarely, and never as a way of opening a sentence.`,
    );
  }

  if (input.memoryText) parts.push(input.memoryText);

  if (permissions.remember) {
    parts.push(MEMORY_HABITS);
  }

  parts.push(describeSpace(input.folders));
  parts.push(describeTemplates(input.dirs));

  const catalogue = skills.describe(input.skills);
  if (catalogue) parts.push(catalogue);

  if (input.commands.length > 0) {
    parts.push(
      [
        '## Slash commands',
        '',
        `They can start a message with a slash to reach a job directly: ${input.commands.map((name) => `\`/${name}\``).join(', ')}. Every skill is also a command under its own name. A command expands into instructions before you see it, so you will never read the slash itself — this is here only so you can tell someone what to type when it would save them explaining the same thing again.`,
      ].join('\n'),
    );
  }

  if (webSearchEnabled()) {
    parts.push(
      '## The web\n\nYou can search the web with `web_search`, which returns a summary of each page it finds — the page text where the configured search engine returns it, otherwise its snippet. Use it when the answer is outside their notes and it matters that it is current or correct — a fact, a version number, what happened. Say where a claim came from. When the results are snippets rather than full text, say that you only saw snippets and offer to open the page. Do not reach for it when the question is about their own notes.',
    );
  }

  if (permissions.run && sandboxEnabled()) {
    parts.push(
      `## Running code\n\nYou can run short Python or JavaScript programs with \`run_code\`. Use it for anything numeric — totals, counts, dates, reshaping a table — rather than working it out in your head, and say what the number is rather than pasting the script at them.\n\nYou have a working directory that survives between runs: \`list_workspace\` shows what is in it and \`read_workspace_file\` reads one back. A job too big for one script is a job you do in steps, leaving the intermediate file behind for the next one.\n\nThe runtime is: ${describeSandbox()}`,
    );
  }

  parts.push(describePermissions(input.mode, permissions));

  const situational = describeContext(context);
  if (situational) parts.push(situational);

  parts.push(describeNow(input));

  return parts.join('\n\n');
}

/** The shape of the space, so a page can be filed without a tool call first. */
function describeSpace(folders: Array<{ name: string; pages: number }>): string {
  if (folders.length === 0) {
    return '## This space\n\nThe space has no folders yet — every page is at the top level. Put your own working notes in "ai/", and follow whatever filing they start using.';
  }

  const rows = folders.map(
    (folder) => `- \`${folder.name}/\` — ${folder.pages} page${folder.pages === 1 ? '' : 's'}`,
  );

  return [
    '## This space',
    '',
    'The folders at the top level, with how many pages are in each. This is their filing system: match it rather than inventing beside it, and use `list_pages` or `list_directories` when you need to see further in.',
    '',
    ...rows,
    '',
    'Four of these, if they are here, are not notes. `memory/` is what you know about them and is written only through the memory tools. `_skills/` holds procedures. `_plugins/` is their code. `files/` is attachments. `ai/` is yours.',
  ].join('\n');
}

/**
 * The journal and templates folders, and how templating actually works.
 *
 * Both folder names are a per-device setting (`apps/web/src/lib/dirs.ts`), not
 * a fixed name — a space can rename either at any time, so this is told fresh
 * every turn rather than assumed. Told separately from the generic folder
 * list in `describeSpace` because *what a template is* is not derivable from
 * a page count: nothing about a folder named `_templates` says that its pages
 * hold `{{variables}}`, or that one of them can opt itself into being applied
 * automatically.
 */
function describeTemplates(dirs: SparkDirs): string {
  return [
    '## Journal and templates',
    '',
    `Their daily notes live under \`${dirs.journal}/\`, one page per day, named by date alone (\`${dirs.journal}/YYYY-MM-DD\`) — see **Right now** below for today's exact name. This is a per-device setting, so do not assume "journal" is the name if you have seen this space call it something else.`,
    '',
    `Templates live under \`${dirs.templates}/\`, also a per-device setting. A template is an ordinary page there; what makes it a template is only how it is used. Its body can contain \`{{date}}\`, \`{{isoDate}}\`, \`{{time}}\`, \`{{weekday}}\` and \`{{page}}\`, filled in at the moment it is inserted or a journal page is seeded from it — never before, so writing a template does not itself produce a date anywhere.`,
    '',
    `A template opts into seeding new journal pages automatically by setting \`journal: true\` in its frontmatter. A \`days:\` key — a day name, \`weekday\`, \`weekend\`, or a list of these — restricts which days it applies to; a template with no \`days\` key is the default for whichever day nothing more specific claims. Someone can also insert any template by hand, anywhere, with \`/template\` or "Use template" from the command palette.`,
    '',
    `Before writing a fresh journal entry from scratch, check what is under \`${dirs.templates}/\` — if a template already defines the day's shape, match its structure rather than inventing your own.`,
  ].join('\n');
}

/**
 * What is and is not allowed, and what will be asked about.
 *
 * The mode is described as well as the permissions because they are different
 * questions and a model that confuses them behaves badly in both directions: one
 * that thinks it must ask when it may act narrates instead of working, and one
 * that thinks it may act when it must ask writes a paragraph that reads as though
 * the edit already happened.
 */
function describePermissions(mode: PermissionMode, permissions: ToolPermissions): string {
  const lines: string[] = [];

  if (!permissions.write) {
    lines.push(
      'You can read the notes but not change them. If asked to write something, draft it in the conversation and say that changing pages is switched off in Settings.',
    );
  }
  if (permissions.write && !permissions.destroy) {
    lines.push(
      'You can create pages and add to them, but not delete, rename or overwrite one wholesale. If a request needs that, say so rather than working around it.',
    );
  }
  if (!permissions.remember) {
    lines.push(
      'You cannot keep notes about this person between conversations. Everything said here is forgotten when it ends, so do not promise to remember anything.',
    );
  }

  const asking: Record<PermissionMode, string> = {
    manual:
      'Every tool call is shown to them and waits for a yes. Work in as few calls as the job takes, because each one is a question they have to answer. If one is declined, do not try it again by another route.',
    code: 'Running code goes ahead on its own; every other tool call waits for a yes. If one is declined, do not try it again by another route.',
    edit: 'Reading, writing and running go ahead on their own. Deleting, renaming and overwriting wait for a yes, because those are the edits that cannot be checked by reading the result.',
    auto: 'Nothing waits for approval. That is a reason to be more careful rather than less: prefer the smallest edit, and read before you write.',
  };
  lines.push(asking[mode]);

  return `## Permissions\n\n${lines.join('\n\n')}`;
}

/**
 * The time, the date, and what is answering.
 *
 * The model is told which model it is because it is asked, often, and a model
 * guessing at its own identity from its training data gets it wrong with complete
 * confidence — which is a worse answer than "I do not know" and much worse than
 * the true one, which the server has sitting in a variable.
 */
function describeNow(input: PromptInput): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const readable = now.toLocaleString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  return [
    '## Right now',
    '',
    `It is ${readable}. In the space's own format that is ${date}, and the daily page for today is "${input.dirs.journal}/${date}".`,
    '',
    `You are \`${input.model}\`, served by ${input.provider === 'anthropic' ? 'Anthropic' : 'an OpenAI-compatible endpoint'}${input.modeLabel ? `, under the "${input.modeLabel}" preset` : ''}. Say so if you are asked, rather than guessing from what you remember about yourself.`,
  ].join('\n');
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

  // Attached first, because it was chosen. What is beside the panel is where the
  // person happens to be sitting; what they attached is what they meant, and the
  // order says so without needing a sentence to.
  const attached = context.attached ?? [];
  if (attached.length > 0) {
    lines.push(
      attached.length === 1
        ? 'They attached this to the message, so it is what the question is about:'
        : 'They attached these to the message, so they are what the question is about:',
      '',
    );
    for (const item of attached) {
      lines.push(
        item.selection
          ? `<selection from="${item.name}">`
          : `<note name="${item.name}">`,
        item.text.slice(0, 40_000),
        item.selection ? '</selection>' : '</note>',
        '',
      );
    }
  }

  const attachedNames = new Set(attached.map((item) => item.name));

  if (context.neighbour && !attachedNames.has(context.neighbour.name)) {
    lines.push(
      `They have "${context.neighbour.name}" open in the tile beside this conversation. When they say "this note", "here" or "the page"${attached.length > 0 ? ' and it is not one of the above' : ''}, that is what they mean. Its current text follows, including anything typed but not yet saved.`,
      '',
      `<note name="${context.neighbour.name}">`,
      context.neighbour.text.slice(0, 40_000),
      '</note>',
    );
  }

  const others = (context.openPages ?? []).filter(
    (name) => name !== context.neighbour?.name && !attachedNames.has(name),
  );
  if (others.length > 0) {
    lines.push(
      '',
      `Also open elsewhere on screen: ${others.map((name) => `"${name}"`).join(', ')}. You have not been given their contents; read one if you need it.`,
    );
  }

  return lines.length > 0 ? `## What is on screen\n\n${lines.join('\n')}` : null;
}
