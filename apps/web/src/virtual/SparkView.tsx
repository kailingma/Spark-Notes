import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../app-context';
import {
  AttachIcon,
  CloseIcon,
  HistoryIcon,
  MemoryIcon,
  PlusIcon,
  SendIcon,
  SparkIcon,
  StopIcon,
  TrashIcon,
} from '../components/Icons';
import { renderMarkdown } from '../lib/markdown-render';
import {
  filesApi,
  memoryApi,
  sparkApi,
  type ChatMessage,
  type ChatSummary,
  type ChatToolCall,
  type StoredFile,
} from '../lib/spark-client';
import { useViewInstance } from '../windows/instance';
import { useWindows } from '../windows/manager';

/**
 * Spark.
 *
 * A conversation about your notes that can act on them. Two shapes on purpose:
 * what you said is a bubble, because it is a remark; what Spark said is a full
 * column of prose, because it is an answer, and squeezing an answer into a
 * speech bubble makes it read like chatter.
 *
 * The view is an ordinary virtual page, so it tiles beside a note, floats in a
 * window, or takes the whole screen, and `[[Spark]]` links to it. What it knows
 * about its surroundings comes from the workbench: the name of everything on
 * screen, and the full text of the one note directly beside it.
 */
export function SparkView() {
  const { workspace, config, preferences, toast } = useApp();
  const { contextFor, openPageBeside, openPage } = useWindows();
  const instanceId = useViewInstance();

  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [reply, setReply] = useState<{ text: string; tools: ChatToolCall[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<StoredFile[]>([]);
  const [uploading, setUploading] = useState(0);
  /** What the last consolidation pass did, shown once and then replaced. */
  const [memoryNote, setMemoryNote] = useState<string | null>(null);
  /** Open threads, read from the memory file. No model call is involved. */
  const [openThreads, setOpenThreads] = useState(0);

  const abort = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const surroundings = useMemo(
    () => (instanceId ? contextFor(instanceId) : { openPages: [], neighbour: null }),
    // Recomputed on every render of the view rather than memoised against the
    // layout: it is three array operations, and a stale answer here would mean
    // Spark reading the wrong note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instanceId, contextFor, messages.length, reply],
  );

  const refreshChats = useCallback(async () => {
    setChats(await sparkApi.chats());
  }, []);

  useEffect(() => {
    void refreshChats();
  }, [refreshChats]);

  /**
   * Anything outstanding, on the empty screen.
   *
   * This is as close to being proactive as Spark gets, and it stays on the right
   * side of "never speaks first" because no model is asked anything: it is a
   * count of unticked lines in a markdown file. You are told there is something
   * waiting; whether to ask about it is yours.
   */
  useEffect(() => {
    if (!preferences.sparkRemembers) {
      setOpenThreads(0);
      return;
    }
    let cancelled = false;
    void memoryApi.read().then((snapshot) => {
      if (cancelled || !snapshot) return;
      setOpenThreads(snapshot.threads.bullets.filter((bullet) => !bullet.done).length);
    });
    return () => {
      cancelled = true;
    };
  }, [preferences.sparkRemembers, messages.length]);

  /**
   * Uploads, from any of the three ways a file arrives.
   *
   * The upload happens now rather than when the message is sent: the file lands
   * in `files/` immediately, so abandoning the message still leaves you with the
   * file, and the turn carries names instead of megabytes.
   */
  const attach = useCallback(
    async (incoming: FileList | File[] | null) => {
      const list = [...(incoming ?? [])];
      if (list.length === 0) return;

      setUploading((count) => count + list.length);
      for (const file of list) {
        try {
          const stored = await filesApi.upload(file);
          setAttached((current) =>
            current.some((entry) => entry.name === stored.name) ? current : [...current, stored],
          );
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'error');
        } finally {
          setUploading((count) => count - 1);
        }
      }
    },
    [toast],
  );

  // Follow the conversation as it grows, but only from the bottom: scrolling up
  // to reread something should not be undone by the next token arriving.
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 160;
    if (nearBottom) host.scrollTop = host.scrollHeight;
  }, [messages, reply]);

  const load = useCallback(async (id: string) => {
    const chat = await sparkApi.chat(id);
    if (!chat) return;
    setChatId(chat.id);
    setMessages(chat.messages);
    setReply(null);
    setError(null);
    setHistoryOpen(false);
  }, []);

  const startNew = useCallback(() => {
    abort.current?.abort();
    setChatId(null);
    setMessages([]);
    setReply(null);
    setError(null);
    setHistoryOpen(false);
    setAttached([]);
    setMemoryNote(null);
  }, []);

  const send = useCallback(async () => {
    const message = draft.trim();
    // A message with nothing but attachments is a real message — "what is this"
    // is implied by the act of attaching something — so the guard is on both
    // being empty rather than on the text alone.
    if ((!message && attached.length === 0) || reply) return;

    if (!config.ai) {
      toast('Spark needs a provider and a key. Add them in Settings → Spark.', 'error');
      return;
    }

    // Cleared now so the composer is empty while the reply arrives, and captured
    // first because the request needs them after the state is gone.
    const sending = attached.map((file) => file.name);
    setDraft('');
    setAttached([]);
    setError(null);
    setMemoryNote(null);
    setMessages((current) => [
      ...current,
      { role: 'user', text: withAttachments(message, sending), at: Date.now() },
    ]);
    setReply({ text: '', tools: [] });

    // The reply accumulates here rather than inside the `setReply` updaters.
    // React invokes an updater more than once (StrictMode does it deliberately,
    // to catch exactly this), so an updater that both derives state *and* does
    // something else runs that something else twice — which is how the finished
    // answer was landing in the transcript in duplicate.
    let text = '';
    const tools: ChatToolCall[] = [];
    const show = () => setReply({ text, tools: [...tools] });

    // The note beside the chat travels in full, and the live editor text beats
    // what is on disk: the question is usually about the paragraph just typed,
    // which is still inside the autosave debounce.
    let neighbour: { name: string; text: string } | undefined;
    if (preferences.sparkSeesContext && surroundings.neighbour) {
      const name = surroundings.neighbour;
      const live = workspace.editor.textOf(name);
      const text = live ?? (await workspace.space.read(name).then((page) => page.text).catch(() => ''));
      neighbour = { name, text };
    }

    const controller = new AbortController();
    abort.current = controller;
    /** Tool call id to its index in `tools`. */
    const pending = new Map<string, number>();

    try {
      await sparkApi.send(
        {
          chatId: chatId ?? undefined,
          message,
          context: preferences.sparkSeesContext
            ? { neighbour, openPages: surroundings.openPages }
            : {},
          permissions: {
            write: preferences.sparkCanWrite,
            destroy: preferences.sparkCanDestroy,
            remember: preferences.sparkRemembers,
            // The server checks this again against its own sandbox, so a stale
            // preference cannot turn on something the machine cannot do.
            run: preferences.sparkCanRun,
          },
          historyDepth: preferences.sparkHistoryDepth,
          ...(sending.length > 0 ? { attachments: sending } : {}),
        },
        {
          onChat: (id) => setChatId(id),
          onText: (chunk) => {
            text += chunk;
            show();
          },
          onTool: (id, name, input) => {
            // Placed by index so the result can find it again without matching
            // on a summary string.
            pending.set(id, tools.length);
            tools.push({ name, input, ok: true, summary: `${label(name)}…` });
            show();
          },
          onToolResult: (id, ok, summary) => {
            const index = pending.get(id);
            if (index !== undefined) tools[index] = { ...tools[index], ok, summary };
            show();
          },
          onAction: (action) => {
            if (action.kind !== 'open') return;
            if (instanceId) openPageBeside(instanceId, action.page);
            else openPage(action.page);
          },
          onMemory: (summary) => setMemoryNote(summary),
          onSaved: () => void refreshChats(),
          onError: (message) => setError(message),
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      abort.current = null;
      if (text.trim() || tools.length > 0) {
        setMessages((existing) => [
          ...existing,
          {
            role: 'assistant',
            text,
            tools: tools.length > 0 ? [...tools] : undefined,
            at: Date.now(),
          },
        ]);
      }
      setReply(null);
    }
  }, [
    draft,
    attached,
    reply,
    config.ai,
    toast,
    preferences,
    surroundings,
    workspace,
    chatId,
    instanceId,
    openPageBeside,
    openPage,
    refreshChats,
  ]);

  const empty = messages.length === 0 && !reply;

  return (
    <div className="spark">
      <header className="spark-head">
        <span className="spark-mark">
          <SparkIcon />
        </span>
        <span className="spark-title">Spark</span>

        <span className="header-spacer" />

        <button
          className="icon-button"
          aria-label="Conversation history"
          aria-pressed={historyOpen}
          title="Conversation history"
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <HistoryIcon />
        </button>
        <button className="icon-button" aria-label="New conversation" title="New conversation" onClick={startNew}>
          <PlusIcon />
        </button>
      </header>

      {historyOpen && (
        <div className="spark-history">
          {chats.length === 0 ? (
            <p className="nav-empty">No conversations yet.</p>
          ) : (
            chats.map((chat) => (
              <div className="spark-history-row" key={chat.id} data-current={chat.id === chatId || undefined}>
                <button className="spark-history-open" onClick={() => void load(chat.id)}>
                  <span>{chat.title}</span>
                  <small>{new Date(chat.updated).toLocaleDateString()}</small>
                </button>
                <button
                  className="icon-button"
                  aria-label={`Delete ${chat.title}`}
                  onClick={async () => {
                    await sparkApi.remove(chat.id);
                    if (chat.id === chatId) startNew();
                    void refreshChats();
                  }}
                >
                  <TrashIcon />
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <div className="spark-scroll" ref={scrollRef}>
        {empty && (
          <Welcome
            enabled={config.ai}
            openThreads={openThreads}
            onPick={setDraft}
            onThreads={() => openPage('Memory')}
          />
        )}

        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div className="spark-turn" data-role="user" key={index}>
              <div className="spark-bubble">{message.text}</div>
            </div>
          ) : (
            <div className="spark-turn" data-role="assistant" key={index}>
              <ToolTrail tools={message.tools} />
              <div className="spark-prose">{renderMarkdown(message.text)}</div>
            </div>
          ),
        )}

        {reply && (
          <div className="spark-turn" data-role="assistant">
            <ToolTrail tools={reply.tools} />
            {/* Between sending and the first token there is nothing to show,
                and an empty column reads as a hang. This is the only place the
                app admits to waiting. */}
            {reply.text.trim() === '' ? (
              <p className="spark-thinking" role="status">
                Thinking
                <span className="spark-dots" aria-hidden="true" />
              </p>
            ) : (
              <div className="spark-prose">
                {renderMarkdown(reply.text)}
                <span className="spark-cursor" aria-label="Spark is writing" />
              </div>
            )}
          </div>
        )}

        {/* What consolidation did, under the reply rather than inside it: it is
            Spark's own housekeeping, not part of the answer, and putting it in
            the prose would make every fourth reply end in a status line. */}
        {memoryNote && (
          <button className="spark-memory-note" onClick={() => openPage('Memory')}>
            <MemoryIcon />
            {memoryNote}
          </button>
        )}

        {error && (
          <div className="spark-error" role="alert">
            {error}
          </div>
        )}
      </div>

      <form
        className="spark-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        // Dropping onto the whole composer rather than a target you have to aim
        // for. There is no drag-over styling because the composer is already the
        // one place in the panel that takes input.
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void attach(event.dataTransfer?.files ?? null);
        }}
      >
        {(attached.length > 0 || uploading > 0) && (
          <ul className="spark-attachments">
            {attached.map((file) => (
              <li key={file.name}>
                <span>{file.name.replace(/^files\//, '')}</span>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  title="Remove — the file stays in your space"
                  onClick={() => setAttached((current) => current.filter((entry) => entry.name !== file.name))}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
            {uploading > 0 && <li data-pending="true">Uploading {uploading}…</li>}
          </ul>
        )}

        <input
          ref={picker}
          className="spark-file-input"
          type="file"
          multiple
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            void attach(event.target.files);
            // Cleared so choosing the same file twice in a row still fires.
            event.target.value = '';
          }}
        />

        <button
          className="icon-button"
          type="button"
          aria-label="Attach a file"
          title="Attach a file"
          onClick={() => picker.current?.click()}
        >
          <AttachIcon />
        </button>

        <textarea
          className="spark-input"
          value={draft}
          rows={1}
          placeholder={config.ai ? 'Ask about your notes, or ask for a change' : 'Add a provider in Settings to use Spark'}
          aria-label="Message Spark"
          onChange={(event) => setDraft(event.target.value)}
          onPaste={(event) => {
            // A screenshot on the clipboard arrives as a file with no name, which
            // is the commonest attachment there is. Only intercept when there
            // genuinely are files, so pasting text is untouched.
            const files = [...(event.clipboardData?.files ?? [])];
            if (files.length === 0) return;
            event.preventDefault();
            void attach(files);
          }}
          onKeyDown={(event) => {
            // Enter sends, Shift-Enter breaks the line. The composer is for
            // asking, and most asks are one line.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />

        {reply ? (
          <button
            className="icon-button"
            type="button"
            aria-label="Stop"
            title="Stop"
            onClick={() => abort.current?.abort()}
          >
            <StopIcon />
          </button>
        ) : (
          <button
            className="icon-button"
            type="submit"
            aria-label="Send"
            title="Send"
            disabled={!draft.trim() && attached.length === 0}
          >
            <SendIcon />
          </button>
        )}
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** What Spark did while it was answering, in the order it did it. */
function ToolTrail({ tools }: { tools?: ChatToolCall[] }) {
  if (!tools || tools.length === 0) return null;

  return (
    <ul className="spark-tools">
      {tools.map((tool, index) => (
        <li key={index} data-ok={tool.ok} data-pending={tool.summary.endsWith('…') || undefined}>
          {tool.ok ? null : <CloseIcon />}
          {tool.summary}
        </li>
      ))}
    </ul>
  );
}

const SUGGESTIONS = [
  'Summarise what I wrote this week',
  'Turn the notes beside this into a task list',
  'Find every mention of the launch date',
  'Draft a page for the meeting on Thursday',
];

function Welcome({
  enabled,
  openThreads,
  onPick,
  onThreads,
}: {
  enabled: boolean;
  openThreads: number;
  onPick: (text: string) => void;
  onThreads: () => void;
}) {
  return (
    <div className="spark-welcome">
      <p>
        Spark reads and writes the pages in this space. It can find things, draft a page, tick a
        task off, or work on the note beside this panel.
      </p>
      {!enabled && (
        <p className="spark-warning">
          No provider is configured yet. Open Settings and add one under Spark.
        </p>
      )}

      {/* The only unprompted thing on this screen, and it costs no model call:
          a count of unticked lines in a file. It tells you something is waiting
          without deciding that you want to hear about it now. */}
      {openThreads > 0 && (
        <button className="spark-threads" onClick={onThreads}>
          <MemoryIcon />
          {openThreads} open thread{openThreads === 1 ? '' : 's'} from earlier
        </button>
      )}
      <div className="spark-suggestions">
        {SUGGESTIONS.map((suggestion) => (
          <button key={suggestion} className="spark-suggestion" onClick={() => onPick(suggestion)}>
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

/** `create_page` reads as "Creating a page" while it is still running. */
function label(name: string): string {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What the transcript shows for a message that carried files.
 *
 * Written into the stored text as a markdown link rather than kept as separate
 * metadata, because the transcript then says what was sent when it is reread
 * next week — and because a chat that mentions `files/scan.png` is a chat whose
 * attachment is still findable from the page it was about.
 */
function withAttachments(message: string, names: string[]): string {
  if (names.length === 0) return message;
  const list = names.map((name) => `[${name.replace(/^files\//, '')}](${name})`).join(', ');
  return message ? `${message}\n\n(${list})` : `(${list})`;
}
