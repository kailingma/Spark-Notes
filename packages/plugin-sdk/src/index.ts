/**
 * Spark Notes plugin SDK.
 *
 * A plugin is a single ES module that default-exports the result of
 * `definePlugin()`. Plugins live as `.js` files under `_plugins/` inside the
 * space itself, so they travel with your notes and are never locked into an
 * app store or a database.
 *
 * ```js
 * export default definePlugin({
 *   id: 'word-count',
 *   name: 'Word Count',
 *   activate(spark) {
 *     spark.commands.register({
 *       id: 'word-count.show',
 *       name: 'Show word count',
 *       run: () => spark.ui.toast(`${spark.editor.text().split(/\s+/).length} words`),
 *     });
 *   },
 * });
 * ```
 */

// ---------------------------------------------------------------------------
// Space (storage)
// ---------------------------------------------------------------------------

/** Metadata about a page, without its body. */
export interface PageMeta {
  /** Page name without extension, e.g. `projects/spark`. Always `/`-separated. */
  name: string;
  /** Last modified, epoch ms. */
  modified: number;
  /** Size in bytes of the markdown on disk. */
  size: number;
}

/** A page: metadata plus its markdown body. */
export interface Page extends PageMeta {
  text: string;
}

/** Read/write access to the markdown space. */
export interface SpaceApi {
  list(): Promise<PageMeta[]>;
  read(name: string): Promise<Page>;
  write(name: string, text: string): Promise<PageMeta>;
  delete(name: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(name: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** A `- [ ]` task discovered anywhere in the space. */
export interface Task {
  /** Stable id: `${page}:${line}`. */
  id: string;
  page: string;
  /** Zero-based line number within the page. */
  line: number;
  done: boolean;
  /** Task text with the `- [ ]` marker and trailing tags stripped. */
  text: string;
  /** Raw source line. */
  raw: string;
  /** `#tags` found in the task text. */
  tags: string[];
  /** Parsed from a `📅 YYYY-MM-DD` or `due:YYYY-MM-DD` marker, epoch ms. */
  due?: number;
  /** Indent depth, in nesting levels. */
  depth: number;
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

export interface EditorSelection {
  from: number;
  to: number;
}

/** Imperative handle on the editor currently on screen. */
export interface EditorApi {
  /** Name of the page being edited, or `null` when no editor is mounted. */
  page(): string | null;
  /** Full document text. */
  text(): string;
  /** Current primary selection as document offsets. */
  selection(): EditorSelection;
  /** Text covered by the current selection. */
  selectedText(): string;
  /** Replace the current selection (or insert at the cursor when empty). */
  replaceSelection(text: string): void;
  /** Insert text at a document offset, defaulting to the cursor. */
  insert(text: string, at?: number): void;
  /** Replace an arbitrary range. */
  replaceRange(from: number, to: number, text: string): void;
  /** Move the cursor / set the selection. */
  setSelection(from: number, to?: number): void;
  /** Replace the whole document, preserving the cursor where possible. */
  setText(text: string): void;
  /** Give the editor keyboard focus. */
  focus(): void;
  /** Wrap the selection in `before`/`after`, or unwrap if already wrapped. */
  toggleWrap(before: string, after?: string): void;
  /** Fires on every document change. */
  onChange(fn: (text: string) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface Command {
  /** Unique, namespaced by convention: `my-plugin.do-thing`. */
  id: string;
  /** Shown in the command palette. */
  name: string;
  /** Optional grouping label in the palette. */
  category?: string;
  /**
   * CodeMirror-style keybinding, e.g. `Mod-Shift-k` (`Mod` is ⌘ on macOS,
   * Ctrl elsewhere).
   */
  key?: string;
  /** Return false to hide the command from the palette in the current context. */
  available?: () => boolean;
  run: () => void | Promise<void>;
}

/** A `/`-triggered completion inside the editor. */
export interface SlashCommand {
  /** The word typed after `/`. */
  name: string;
  description?: string;
  /**
   * Replacement snippet. `|` marks where the cursor lands afterwards.
   * Omit to handle insertion yourself in `run`.
   */
  snippet?: string;
  run?: (editor: EditorApi) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export type ToastKind = 'info' | 'success' | 'error';

export interface PanelOptions {
  id: string;
  title: string;
  /** Where the panel docks. */
  position?: 'right' | 'bottom';
  /** Called with a container element to render into. */
  render: (el: HTMLElement) => void | (() => void);
}

export interface UiApi {
  toast(message: string, kind?: ToastKind): void;
  /** Adds a small item to the status bar. Returns a handle to update or remove it. */
  statusItem(initial?: string): StatusItem;
  /** Opens a docked panel. Returns a disposer. */
  panel(options: PanelOptions): Unsubscribe;
  /** Simple text prompt. Resolves to null if dismissed. */
  prompt(message: string, initial?: string): Promise<string | null>;
  /** Pick one of a list of options. Resolves to null if dismissed. */
  select<T extends string>(message: string, options: T[]): Promise<T | null>;
  /** Navigate the app to a page. */
  navigate(page: string): void;
}

export interface StatusItem {
  set(text: string): void;
  onClick(fn: () => void): void;
  remove(): void;
}

// ---------------------------------------------------------------------------
// Markdown decoration hooks
// ---------------------------------------------------------------------------

/**
 * Lets a plugin render its own inline widget in place of matched text, the way
 * the built-in renderers handle `[[wiki links]]` and checkboxes.
 */
export interface InlineDecorator {
  /** Global regex matched against each visible line. */
  pattern: RegExp;
  /**
   * Build the replacement element. Return null to leave the text alone.
   * `match` is the RegExp match; `edit` replaces the matched source range.
   */
  render: (match: RegExpExecArray, ctx: DecoratorContext) => HTMLElement | null;
  /**
   * When true (the default) the widget is hidden while the cursor is inside
   * the match, revealing the raw markdown for editing.
   */
  revealOnCursor?: boolean;
}

export interface DecoratorContext {
  page: string | null;
  /** Replace the matched source text. */
  replace: (text: string) => void;
  /** Document offsets of the match. */
  from: number;
  to: number;
}

export interface MarkdownApi {
  /** Register an inline widget renderer. Returns a disposer. */
  inline(decorator: InlineDecorator): Unsubscribe;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export interface AiApi {
  /** True when the server has an AI provider configured. */
  available(): boolean;
  /** One-shot completion. */
  complete(prompt: string, options?: AiOptions): Promise<string>;
  /** Streaming completion; `onToken` fires per chunk. */
  stream(
    prompt: string,
    onToken: (chunk: string) => void,
    options?: AiOptions,
  ): Promise<string>;
}

export interface AiOptions {
  system?: string;
  /** Abort the request early. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface SparkEvents {
  /** A page was opened in the editor. */
  'page:open': { page: string };
  /** A page's text changed (debounced, after save). */
  'page:save': { page: string; text: string };
  'page:delete': { page: string };
  /** The task index was rebuilt. */
  'tasks:change': { tasks: Task[] };
  /** Sync state changed. */
  'sync:change': { status: SyncStatus };
}

export type SyncStatus =
  | { mode: 'online' }
  | { mode: 'sync'; state: 'idle' | 'syncing' | 'error'; message?: string };

export type Unsubscribe = () => void;

export interface EventsApi {
  on<K extends keyof SparkEvents>(
    event: K,
    fn: (payload: SparkEvents[K]) => void,
  ): Unsubscribe;
  emit<K extends keyof SparkEvents>(event: K, payload: SparkEvents[K]): void;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsApi {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

// ---------------------------------------------------------------------------
// The plugin surface
// ---------------------------------------------------------------------------

/** Everything a plugin can touch. Scoped per plugin. */
export interface SparkApi {
  readonly pluginId: string;
  readonly space: SpaceApi;
  readonly editor: EditorApi;
  readonly commands: { register(command: Command): Unsubscribe };
  readonly slash: { register(command: SlashCommand): Unsubscribe };
  readonly ui: UiApi;
  readonly markdown: MarkdownApi;
  readonly ai: AiApi;
  readonly events: EventsApi;
  readonly settings: SettingsApi;
  /** All tasks currently indexed across the space. */
  tasks(): Task[];
  /** Register cleanup to run when the plugin is unloaded. */
  onUnload(fn: () => void): void;
}

export interface PluginDefinition {
  id: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  activate(spark: SparkApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

/** Identity helper that gives plugin authors type checking and autocomplete. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}
