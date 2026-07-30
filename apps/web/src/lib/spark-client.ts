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
}

export interface ChatToolCall {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  tools?: ChatToolCall[];
  at: number;
}

export interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: ChatMessage[];
}

export interface SparkTurn {
  chatId?: string;
  message: string;
  context: {
    neighbour?: { name: string; text: string };
    openPages?: string[];
  };
  permissions: { write: boolean; destroy: boolean; remember: boolean; run: boolean };
  historyDepth: number;
  /** Names of files already uploaded, travelling with this message. */
  attachments?: string[];
}

export interface SparkHandlers {
  onChat?(id: string): void;
  onText?(chunk: string): void;
  onTool?(id: string, name: string, input: Record<string, unknown>): void;
  onToolResult?(id: string, ok: boolean, summary: string): void;
  onAction?(action: { kind: 'open'; page: string }): void;
  /** A consolidation pass ran at the end of the turn. */
  onMemory?(summary: string): void;
  onSaved?(title: string): void;
  onError?(message: string): void;
}

type ServerEvent =
  | { type: 'chat'; id: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool-result'; id: string; ok: boolean; summary: string }
  | { type: 'action'; action: { kind: 'open'; page: string } }
  | { type: 'memory'; summary: string }
  | { type: 'saved'; title: string }
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

export const sparkApi = {
  async chats(): Promise<ChatSummary[]> {
    const res = await fetch('/api/spark/chats');
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
    await fetch(`/api/spark/chats/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    });
  },

  async remove(id: string): Promise<void> {
    await fetch(`/api/spark/chats/${id}`, { method: 'DELETE' });
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

  async upload(file: File): Promise<StoredFile> {
    const body = new FormData();
    body.append('file', file);
    const res = await fetch('/api/files', { method: 'POST', body });
    if (!res.ok) throw new Error((await res.text()) || `Could not upload ${file.name}.`);
    return (await res.json()) as StoredFile;
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
    return;
  }

  switch (event.type) {
    case 'chat':
      handlers.onChat?.(event.id);
      break;
    case 'text':
      handlers.onText?.(event.text);
      break;
    case 'tool':
      handlers.onTool?.(event.id, event.name, event.input);
      break;
    case 'tool-result':
      handlers.onToolResult?.(event.id, event.ok, event.summary);
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
    case 'done':
      break;
  }
}
