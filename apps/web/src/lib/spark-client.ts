/**
 * Talking to Spark.
 *
 * The turn endpoint answers with newline-delimited JSON, so this is a reader
 * rather than an `EventSource`: a turn is four kinds of thing interleaved —
 * prose, a tool starting, a tool finishing, something for the browser to do —
 * and they have to stay distinguishable as they arrive. Frames are buffered on
 * the newline, because a chunk boundary lands mid-object often enough to matter.
 */

export interface ChatSummary {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: number;
  /** Hidden from the default list — see the server's `ChatStore.list`. */
  archived?: boolean;
  /** A page under `Spark/projects/` in the space this conversation belongs to. */
  project?: string;
}

/** One source a retrieval-shaped tool call actually drew from. Mirrors the server's `ChatCitation`. */
export interface ChatCitation {
  label: string;
  page?: string;
  line?: number;
  chatId?: string;
  url?: string;
}

export interface ChatToolCall {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  summary: string;
  /** Pages the call touched, so the line can link to them. */
  pages?: string[];
  /** Set while the call is waiting for a yes, cleared when one arrives. */
  awaiting?: boolean;
  /** What the tool actually read, wrote or ran — capped for a person to read. See the server's `ChatToolCall.detail`. */
  detail?: string;
  /** The passages/results behind this call, when it was a retrieval tool. */
  citations?: ChatCitation[];
}

/**
 * A reply as it actually happened, in order — mirrors the server's
 * `ChatSegment` (`chats.ts`), which is itself modeled on this file's own
 * live `Segment` type in `SparkView.tsx` (minus `startedAt`, meaningless
 * once a turn is saved). Present once a turn has been persisted with the
 * true interleaving rather than just the flat fields below.
 */
export type ChatSegment =
  | { kind: 'thinking'; text: string; elapsedMs?: number }
  | { kind: 'tools'; tools: ChatToolCall[] }
  | { kind: 'text'; text: string };

/** Tokens actually billed for a turn, summed across every round it took. */
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  /** A best-effort dollar estimate — absent when the model isn't in the server's price table. */
  costUsd?: number;
}

/** One of the replies "Try again" has produced for a single question. */
export interface AssistantVariant {
  text: string;
  tools?: ChatToolCall[];
  presented?: string[];
  thinking?: string;
  thinkingMs?: number;
  segments?: ChatSegment[];
  modeId?: string;
  /** Which AI provider profile actually answered — the fallback, if the primary didn't. */
  providerId?: string;
  /** The model id the answering profile actually used. */
  model?: string;
  usage?: ChatUsage;
  /** Set when this reply didn't finish cleanly — a failure or a Stop, not a real answer. */
  error?: string;
  at: number;
  /**
   * The messages that followed this reply when it was set aside for another —
   * what a switch back to this reply restores. Present only once the turn has
   * been regenerated or the conversation forked past it.
   */
  branch?: ChatMessage[];
}

/** A prompt that was rewound to and re-sent: the earlier wording, and the conversation that followed it. */
export interface UserVariant {
  text: string;
  at: number;
  /** What came after this wording when the fork moved away from it, restored on switch-back. */
  branch?: ChatMessage[];
}

export type ChatVariant = AssistantVariant | UserVariant;

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  tools?: ChatToolCall[];
  /** Pages shown as a card during this reply — see `onAction`. */
  presented?: string[];
  /**
   * What the model reasoned before answering.
   *
   * Kept beside the reply rather than inside it, and never sent back to the
   * server: it is not part of the answer, and a transcript that stores it as one
   * would replay it as though Spark had said it out loud.
   */
  thinking?: string;
  /** Wall-clock time spent thinking, for a turn reloaded from history. */
  thinkingMs?: number;
  /** The true order this reply happened in. See `ChatSegment`. */
  segments?: ChatSegment[];
  /** Which model preset produced this reply. */
  modeId?: string;
  /** Which AI provider profile actually answered. See `AssistantVariant.providerId`. */
  providerId?: string;
  /** The model id the answering profile actually used. */
  model?: string;
  usage?: ChatUsage;
  /** Set when this reply didn't finish cleanly — a failure or a Stop, not a real answer. */
  error?: string;
  at: number;
  /**
   * Every way this turn has been re-worded, oldest first — "Try again" replies
   * for an assistant turn, earlier wordings of a rewound-to prompt for a user
   * turn. The fields above always mirror `variants[activeVariant]`.
   */
  variants?: ChatVariant[];
  activeVariant?: number;
}

export interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: ChatMessage[];
  archived?: boolean;
  project?: string;
}

/** How much of the work happens without being asked about. */
export type PermissionMode = 'manual' | 'code' | 'edit' | 'auto';

export interface SparkTurn {
  chatId?: string;
  /** Omitted for a regenerate — the server re-reads the original question from storage. */
  message?: string;
  /** Set for "Try again": the index of the stored assistant reply being replaced. */
  regenerateAt?: number;
  /**
   * Set when the turn continues from a rewound-to prompt: the index of that
   * prompt. `message` is its re-worded successor; nothing after the old
   * wording is sent, and the old wording and its conversation are kept as
   * variants of the new prompt.
   */
  rewindTo?: number;
  context: {
    neighbour?: { name: string; text: string };
    openPages?: string[];
    /** Pages and passages attached by hand, which outrank what is merely open. */
    attached?: Array<{ name: string; text: string; selection?: boolean }>;
  };
  /** Journal and templates folder names, as this device has them set — see `lib/dirs.ts`. */
  dirs?: { journal: string; templates: string };
  permissions: { write: boolean; destroy: boolean; remember: boolean; run: boolean };
  mode: PermissionMode;
  /** Which model preset to answer with. */
  modeId?: string;
  historyDepth: number;
  /** Names of files already uploaded, travelling with this message. */
  attachments?: string[];
}

export interface SparkHandlers {
  onChat?(id: string): void;
  onText?(chunk: string): void;
  onThinking?(chunk: string): void;
  onTool?(id: string, name: string, input: Record<string, unknown>): void;
  onToolResult?(
    id: string,
    ok: boolean,
    summary: string,
    pages?: string[],
    detail?: string,
    citations?: ChatCitation[],
  ): void;
  /** A tool is parked until `sparkApi.approve` answers for this id. */
  onApproval?(id: string, name: string, input: Record<string, unknown>): void;
  /**
   * A page Spark put in front of you.
   *
   * `present` rather than `open`: the page is shown *and* attached to the
   * conversation, so what you say next about "it" is about the page you are now
   * looking at. Opening it silently left the chat talking about something it
   * could no longer see.
   */
  onAction?(action: { kind: 'present'; page: string }): void;
  /** A consolidation pass ran at the end of the turn. */
  onMemory?(summary: string): void;
  onSaved?(title: string): void;
  /**
   * The primary provider failed before anything streamed and a configured
   * fallback is answering instead — `from`/`to` are provider labels.
   */
  onFallback?(from: string, to: string, reason: string): void;
  /** Tokens billed for the turn, once it's fully answered — see `ChatMessage.usage`. */
  onUsage?(inputTokens: number, outputTokens: number, profileId: string, model: string): void;
  onError?(message: string): void;
  /**
   * A single stream frame couldn't be parsed — a chunk boundary that landed
   * somewhere a flaky proxy mangled, in practice. Distinct from `onError`:
   * the turn itself is still running and the rest of the stream is still
   * trustworthy, so this is a heads-up that some fragment of it was lost,
   * not a report that the turn failed.
   */
  onWarning?(message: string): void;
  /** The server hit a retryable failure (a dropped connection, a rate limit) and is trying again. */
  onRetrying?(attempt: number, reason: string): void;
}

type ServerEvent =
  | { type: 'chat'; id: string }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | {
      type: 'tool-result';
      id: string;
      ok: boolean;
      summary: string;
      pages?: string[];
      detail?: string;
      citations?: ChatCitation[];
    }
  | { type: 'approval'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'action'; action: { kind: 'present'; page: string } }
  | { type: 'memory'; summary: string }
  | { type: 'saved'; title: string }
  | { type: 'retrying'; attempt: number; reason: string }
  | { type: 'fallback'; from: string; to: string; reason: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; profileId: string; model: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Memory and attachments
// ---------------------------------------------------------------------------

export interface MemoryBullet {
  text: string;
  learned?: string;
  done?: boolean;
  due?: string;
}

export interface MemoryFile {
  kind: 'essentials' | 'conventions' | 'threads' | 'buffer';
  /** The page it lives on, so the view can offer to open it. */
  page: string;
  bullets: MemoryBullet[];
  extra: string;
}

export interface MemorySnapshot {
  essentials: MemoryFile;
  conventions: MemoryFile;
  threads: MemoryFile;
  buffer: MemoryFile;
  lastPass: number;
  due: boolean;
}

export interface ConsolidationReport {
  ran: boolean;
  skipped?: string;
  promoted: number;
  merged: number;
  closed: number;
  discarded: number;
  summary: string;
}

export interface StoredFile {
  name: string;
  size: number;
  modified: number;
  mime: string;
}

export interface SkillMeta {
  name: string;
  description: string;
  when?: string;
}

// ---------------------------------------------------------------------------
// Spark's own settings
// ---------------------------------------------------------------------------

/** Emoji or the name of an icon in the app's own set — see `ModeGlyph`. */
export type IconKind = 'emoji' | 'lucide';

export interface SparkMode {
  id: string;
  label: string;
  icon: string;
  iconKind: IconKind;
  /** Empty means "whatever model is configured". */
  model: string;
  /** Thinking budget in tokens. Zero is off. */
  thinking: number;
  enabled: boolean;
  /** Which AI provider profile answers this mode. Empty means the one marked default. */
  providerId: string;
  /** A second profile to try if the primary fails before anything has streamed. Empty means no fallback. */
  fallbackProviderId: string;
}

/** The engines `web_search` can run. Mirrors the server's registry. */
export type SearchProviderId =
  | 'exa'
  | 'tavily'
  | 'brave'
  | 'serper'
  | 'mojeek'
  | 'ddg'
  | 'searxng'
  | 'custom';

/** What the browser learns about one engine: its meta, and *that* it is set. */
export interface SearchProvider {
  id: SearchProviderId;
  label: string;
  /** A sentence the settings panel shows under the dropdown. */
  hint: string;
  needsKey: boolean;
  needsEndpoint: boolean;
  keyless: boolean;
  returnsText: boolean;
  /** A key exists for it — never the key itself. */
  hasKey: boolean;
  /** Endpoints are not secrets, so the browser sees them to edit. */
  endpoint: string;
}

/** Saving a key or endpoint for one engine. Keys go, never come back. */
export interface SearchProviderPatch {
  key?: string;
  endpoint?: string;
}

export interface SparkSettings {
  userName: string;
  instructions: string;
  modes: SparkMode[];
  activeMode: string;
  webSearch: boolean;
  /** Which engine `web_search` uses, when it is on. */
  activeSearchProvider: SearchProviderId;
  /** A second engine to try if the active one errors or rate-limits. Empty means no fallback. */
  fallbackSearchProvider: SearchProviderId | '';
  searchProviders: SearchProvider[];
  /** True when web search can actually run with the current selection. */
  webSearchReady: boolean;
  /** Whether memory consolidation also searches past conversations for related material. */
  deepMemory: boolean;
  /** The opt-in background scan for overdue threads and unresolved questions. See `proactive.ts`. */
  proactiveScan: ProactiveScanSettings;
}

/** Mirrors the server's `ProactiveScanSettings` (`spark-settings.ts`). */
export interface ProactiveScanSettings {
  enabled: boolean;
  intervalHours: number;
}

/** Mirrors the server's `ProactiveStatus` (`proactive.ts`) — for Settings' "Scheduled" section. */
export interface ProactiveStatus {
  enabled: boolean;
  intervalHours: number;
  lastScan: number;
  nextDue: number;
}

export interface CommandInfo {
  name: string;
  description: string;
  argument?: string;
  /** Built-ins are the app's vocabulary; skills are yours. */
  kind: 'builtin' | 'skill';
}

export interface ModelInfo {
  id: string;
  created?: number;
  label?: string;
}

export const sparkApi = {
  async chats(q?: string, archived = false): Promise<ChatSummary[]> {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (archived) params.set('archived', '1');
    const res = await fetch(`/api/spark/chats${params.size > 0 ? `?${params}` : ''}`);
    return res.ok ? ((await res.json()) as ChatSummary[]) : [];
  },

  async chat(id: string): Promise<Chat | null> {
    const res = await fetch(`/api/spark/chats/${id}`);
    return res.ok ? ((await res.json()) as Chat) : null;
  },

  async create(): Promise<Chat> {
    const res = await fetch('/api/spark/chats', { method: 'POST' });
    if (!res.ok) throw new Error('Could not start a conversation.');
    return (await res.json()) as Chat;
  },

  async rename(id: string, title: string): Promise<void> {
    await this.update(id, { title });
  },

  /**
   * The one patch endpoint: title, the archived flag, or the project a
   * conversation belongs to. `null` detaches it from its project.
   */
  async update(
    id: string,
    patch: { title?: string; archived?: boolean; project?: string | null },
  ): Promise<void> {
    const res = await fetch(`/api/spark/chats/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error((await res.text()) || 'Could not update the conversation.');
  },

  async remove(id: string): Promise<void> {
    await fetch(`/api/spark/chats/${id}`, { method: 'DELETE' });
  },

  /** Points a regenerated turn at a different one of its stored replies. */
  async setVariant(chatId: string, index: number, variantIndex: number): Promise<Chat> {
    const res = await fetch(`/api/spark/chats/${chatId}/messages/${index}/variant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ variantIndex }),
    });
    if (!res.ok) throw new Error('Failed to switch response.');
    return (await res.json()) as Chat;
  },

  async settings(): Promise<SparkSettings | null> {
    const res = await fetch('/api/spark/settings');
    return res.ok ? ((await res.json()) as SparkSettings) : null;
  },

  /**
   * Saves some of the settings.
   *
   * A partial patch, because an absent field means "leave it alone" on the
   * server — which is how the panel can save one toggle without sending back
   * search keys it was never given.
   *
   * `searchProviders` is a partial record keyed by engine id: one provider's
   * key or endpoint. The server merges it against what it holds, so saving a
   * key for the engine you just switched to leaves every other engine's key
   * alone.
   */
  async saveSettings(
    patch: Partial<Omit<SparkSettings, 'webSearchReady' | 'searchProviders' | 'activeSearchProvider'>> & {
      activeSearchProvider?: SearchProviderId;
      searchProviders?: Partial<Record<SearchProviderId, SearchProviderPatch>>;
    },
  ): Promise<SparkSettings> {
    const res = await fetch('/api/spark/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error((await res.text()) || 'Could not save.');
    return (await res.json()) as SparkSettings;
  },

  /** For Settings' "Scheduled" section — when the proactive scan last ran and is next due. */
  async proactiveStatus(): Promise<ProactiveStatus | null> {
    const res = await fetch('/api/spark/proactive');
    return res.ok ? ((await res.json()) as ProactiveStatus) : null;
  },

  /** The "Ask Spark" badge was seen — clears it server-side so it does not come back. */
  async acknowledgeProactive(): Promise<void> {
    await fetch('/api/spark/proactive/ack', { method: 'POST' });
  },

  async commands(): Promise<CommandInfo[]> {
    const res = await fetch('/api/spark/commands');
    return res.ok ? ((await res.json()) as CommandInfo[]) : [];
  },

  /**
   * Answers a tool call that is waiting.
   *
   * A second request against a turn whose response is still streaming — see the
   * server's `approvals.ts` for why it cannot be part of the same one.
   */
  async approve(id: string, decision: 'once' | 'always' | 'deny'): Promise<void> {
    await fetch('/api/spark/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, decision }),
    });
  },

  /** One provider profile's model list, for the settings page. `id` names which profile; the rest override it as typed, before saving. */
  async models(
    patch: { id?: string; provider?: string; endpoint?: string; apiKey?: string } = {},
  ): Promise<{
    ok: boolean;
    models: ModelInfo[];
    error?: string;
  }> {
    const res = await fetch('/api/ai/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return { ok: false, models: [], error: `The server refused (${res.status}).` };
    return (await res.json()) as { ok: boolean; models: ModelInfo[]; error?: string };
  },

  async send(turn: SparkTurn, handlers: SparkHandlers, signal?: AbortSignal): Promise<void> {
    const res = await fetch('/api/spark/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(turn),
      signal,
    });

    if (!res.ok || !res.body) {
      handlers.onError?.((await res.text().catch(() => '')) || `Spark is unavailable (${res.status}).`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) dispatch(line, handlers);
        newline = buffer.indexOf('\n');
      }
    }

    // A stream that ended without a trailing newline still has one frame in it.
    if (buffer.trim()) dispatch(buffer.trim(), handlers);
  },
};

/** What Spark remembers, and the two things you can do to it from the app. */
export const memoryApi = {
  async read(): Promise<MemorySnapshot | null> {
    const res = await fetch('/api/memory');
    return res.ok ? ((await res.json()) as MemorySnapshot) : null;
  },

  async consolidate(): Promise<ConsolidationReport> {
    const res = await fetch('/api/memory/consolidate', { method: 'POST' });
    if (!res.ok) throw new Error((await res.text()) || 'Could not consolidate.');
    return (await res.json()) as ConsolidationReport;
  },

  async forget(kind: MemoryFile['kind'], match: string): Promise<number> {
    const res = await fetch(`/api/memory/${kind}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ match }),
    });
    if (!res.ok) return 0;
    return ((await res.json()) as { removed: number }).removed;
  },
};

/**
 * Attachments.
 *
 * The upload happens before the message is sent, not with it: the file is in the
 * space the moment it lands, so a message that is then abandoned still leaves you
 * with the file, and a turn carries names rather than megabytes.
 */
export const filesApi = {
  async list(): Promise<StoredFile[]> {
    const res = await fetch('/api/files');
    return res.ok ? ((await res.json()) as StoredFile[]) : [];
  },

  async upload(file: File, signal?: AbortSignal): Promise<StoredFile> {
    const body = new FormData();
    body.append('file', file);
    const res = await fetch('/api/files', { method: 'POST', body, signal });
    if (!res.ok) throw new Error((await res.text()) || `Could not upload ${file.name}.`);
    return (await res.json()) as StoredFile;
  },

  async remove(name: string): Promise<void> {
    const res = await fetch(this.url(name), { method: 'DELETE' });
    if (!res.ok) throw new Error(`Could not remove ${name}.`);
  },

  url(name: string): string {
    return `/api/files/${name.replace(/^files\//, '').split('/').map(encodeURIComponent).join('/')}`;
  },
};

export const skillsApi = {
  async list(): Promise<SkillMeta[]> {
    const res = await fetch('/api/skills');
    return res.ok ? ((await res.json()) as SkillMeta[]) : [];
  },
};

function dispatch(line: string, handlers: SparkHandlers): void {
  let event: ServerEvent;
  try {
    event = JSON.parse(line) as ServerEvent;
  } catch {
    // Dropping this silently would mean whatever it carried — a chunk of
    // text, a tool result — just never arrives, with nothing on screen to
    // say so. The rest of the stream is unaffected, so this is a warning,
    // not the turn-ending `onError`.
    handlers.onWarning?.('Part of the reply did not arrive intact.');
    return;
  }

  switch (event.type) {
    case 'chat':
      handlers.onChat?.(event.id);
      break;
    case 'text':
      handlers.onText?.(event.text);
      break;
    case 'thinking':
      handlers.onThinking?.(event.text);
      break;
    case 'tool':
      handlers.onTool?.(event.id, event.name, event.input);
      break;
    case 'tool-result':
      handlers.onToolResult?.(event.id, event.ok, event.summary, event.pages, event.detail, event.citations);
      break;
    case 'approval':
      handlers.onApproval?.(event.id, event.name, event.input);
      break;
    case 'action':
      handlers.onAction?.(event.action);
      break;
    case 'memory':
      handlers.onMemory?.(event.summary);
      break;
    case 'saved':
      handlers.onSaved?.(event.title);
      break;
    case 'error':
      handlers.onError?.(event.message);
      break;
    case 'retrying':
      handlers.onRetrying?.(event.attempt, event.reason);
      break;
    case 'fallback':
      handlers.onFallback?.(event.from, event.to, event.reason);
      break;
    case 'usage':
      handlers.onUsage?.(event.inputTokens, event.outputTokens, event.profileId, event.model);
      break;
    case 'done':
      break;
  }
}
