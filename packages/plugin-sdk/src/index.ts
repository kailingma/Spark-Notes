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
// Windows
// ---------------------------------------------------------------------------

/**
 * The workbench.
 *
 * Everything on screen is a *view*, and a view lives on exactly one of four
 * **surfaces**. They are named rather than lumped together as "windows" because
 * they behave differently enough that a plugin has to say which it means:
 *
 * - **`tab`** — a tab in a tile of the split tree. Documents live here. Tabs can
 *   be split, snapped, dragged between tiles and torn out into windows.
 * - **`sidebar`** — a fixed rail at an edge. The navigator is the left one, the
 *   Spark chat the right one. A rail is not part of the tile tree, so it
 *   survives every split, and it can never be snapped or tabbed away.
 * - **`window`** — a free rectangle above the tiles, with a z-order. Movable,
 *   resizable, and snappable back into the tree.
 * - **`modal`** — centred, immovable, scrimmed, and everything under it inert.
 *   A *place* you go rather than a rectangle you arrange, which is why Settings
 *   is one. Not to be confused with an action's dialog (the sync panel, a
 *   prompt), which belongs to the action that raised it and is not a view at
 *   all — see `ActionDialog` in the shell.
 *
 * Classic mode narrows this to two: `tab` (one at a time, filling the editor
 * area) and `sidebar`, plus `modal` for Settings.
 */
export type Surface = 'tab' | 'sidebar' | 'window' | 'modal';

/** Where a view is put when it opens. */
export type WindowMode =
  /** A tab in the focused tile, or focus it if already open. */
  | 'tab'
  /** Split the focused tile and put it beside / below. */
  | 'split-right'
  | 'split-left'
  | 'split-down'
  | 'split-up'
  /** A free-floating, movable, snappable window. */
  | 'window'
  /** Centred, immovable, and blocking: a place rather than a rectangle. */
  | 'modal'
  /** One of the fixed rails at an edge, alongside the navigator. */
  | 'sidebar-left'
  | 'sidebar-right'
  | 'sidebar-bottom';

export interface ViewDefinition {
  /** Unique, namespaced by convention: `my-plugin.inspector`. */
  id: string;
  /** Shown on the tab and in the window's title bar. */
  title: string;
  /**
   * Inline SVG markup for the tab and the sidebar rail, drawn at 24×24 with
   * `currentColor`. Omit for a text-only tab.
   */
  icon?: string;
  /** Preferred size in px when the view opens as a floating window. */
  size?: { width: number; height: number };
  /** True when more than one instance may be open at a time. Defaults to false. */
  multiple?: boolean;
  /**
   * Renders the view into a container that belongs to it. Return a cleanup
   * function; it runs when the view closes or moves to another window.
   */
  mount(el: HTMLElement, ctx: ViewContext): void | (() => void);
}

export interface ViewContext {
  /** Id of this open instance, for `windows.close()`. */
  instanceId: string;
  /** Whatever the view was opened with. */
  params: Record<string, string>;
  /** Closes this view. */
  close(): void;
  /** Renames the tab and the title bar. */
  setTitle(title: string): void;
  /** Fires when the view is moved, resized, or (un)focused. */
  onLayout(fn: (state: ViewLayoutState) => void): Unsubscribe;
}

export interface ViewLayoutState {
  /** True when this view is the one the workbench considers focused. */
  focused: boolean;
  /** Which of the four surfaces it is currently on. */
  surface: Surface;
  width: number;
  height: number;
}

/** A view that is currently on screen. */
export interface OpenView {
  instanceId: string;
  /** The registered view id — `spark.page` for an open note. */
  type: string;
  title: string;
  params: Record<string, string>;
  surface: Surface;
  focused: boolean;
}

export interface OpenOptions {
  mode?: WindowMode;
  params?: Record<string, string>;
  /** Overrides the definition's title for this instance. */
  title?: string;
}

export interface WindowsApi {
  /** Registers a view type. Returns a disposer. */
  register(view: ViewDefinition): Unsubscribe;
  /** Opens a registered view. Returns the instance id. */
  open(viewId: string, options?: OpenOptions): string;
  close(instanceId: string): void;
  /** Moves an open view to another surface — a rail, a window, its own split. */
  move(instanceId: string, mode: WindowMode): void;
  /** Every view currently on screen, in no particular order. */
  visible(): OpenView[];
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
// Theming
// ---------------------------------------------------------------------------

/**
 * Theming, as two separable things.
 *
 * A **theme** is a palette (plus the shape tokens that go with it) and,
 * optionally, the typography it was designed with. A **font pack** is a set of
 * faces and the roles they play, with no colour in it at all. They are separate
 * because they are chosen separately: somebody who likes a palette should be
 * able to read it in the face they prefer, and somebody who wants expressive
 * titles should not have to accept the palette they arrived with.
 *
 * Both are registered by plugins, which is the whole point — the app's own
 * themes come through `spark.themes.register()` like anybody else's.
 */

export type ThemeScheme = 'light' | 'dark';

/**
 * The design tokens a theme may set, named as they are in `tokens.css` without
 * the `--` prefix. Anything not listed is ignored, so a typo cannot quietly
 * poison the stylesheet; anything a theme leaves out keeps the app's own value
 * for the scheme in play.
 *
 * Values are CSS, so `color-mix(in oklab, var(--text) 60%, var(--bg))` is a
 * legitimate way to derive one token from another and is how the built-in
 * themes stay short. `url()` is refused: a theme is a palette, not a loader.
 */
export type ThemeToken =
  // Surfaces and text
  | 'bg'
  | 'surface'
  | 'surface-raised'
  | 'surface-sunken'
  | 'text'
  | 'text-muted'
  | 'text-faint'
  | 'text-faintest'
  | 'rule'
  | 'rule-strong'
  // Accent
  | 'accent'
  | 'accent-soft'
  | 'accent-faint'
  | 'accent-contrast'
  // Marks on text
  | 'selection'
  | 'selection-match'
  | 'highlight-bg'
  | 'tag'
  | 'tag-soft'
  | 'search-match'
  | 'search-match-active'
  // Code
  | 'code-bg'
  | 'code-text'
  | 'code-inline-bg'
  | 'code-inline-border'
  // States
  | 'danger'
  | 'success'
  // Syntax, inside a fenced block
  | 'syn-keyword'
  | 'syn-string'
  | 'syn-number'
  | 'syn-function'
  | 'syn-type'
  | 'syn-property'
  | 'syn-operator'
  // Furniture
  | 'scrollbar'
  | 'scrollbar-hover'
  | 'shadow-sm'
  | 'shadow-md'
  | 'shadow-lg'
  // Shape
  | 'radius-sm'
  | 'radius'
  | 'radius-lg'
  | 'gutter'
  | 'editor-line-height'
  | 'editor-measure'
  /**
   * The three built-in reading modes, and the two interface ones. Overriding
   * these changes what Sans / Serif / Mono *mean*, so a theme can re-letter the
   * app without anybody choosing Curated.
   */
  | 'font-sans'
  | 'font-serif'
  | 'font-mono'
  | 'font-display'
  | 'font-ui-sans'
  | 'font-ui-serif';

export type ThemeTokens = Partial<Record<ThemeToken, string>>;

/** A webfont a theme or a font pack brings with it. */
export interface FontFaceDeclaration {
  /** The family name the roles below refer to. */
  family: string;
  /** Same-origin path, `https:` URL or `data:` URI. */
  src: string;
  /** `400`, or a range like `100 900` for a variable font. */
  weight?: string;
  style?: 'normal' | 'italic' | 'oblique';
  /** A range like `75% 125%` for a face with a width axis. */
  stretch?: string;
  display?: 'auto' | 'block' | 'swap' | 'fallback' | 'optional';
  unicodeRange?: string;
}

/**
 * Who wears which face.
 *
 * Applied when the reading or interface font is set to **Curated** — the mode
 * that means "whatever this theme or pack was designed with". The document half
 * (`editor`, `heading…`) and the interface half (`ui`, `uiHeading…`) are chosen
 * independently, so one pack can dress the prose and another the chrome.
 *
 * `mono` is shared: code, tables and frontmatter are monospaced everywhere, and
 * there is only one good reason to change that face — you want *that* monospace.
 */
export interface FontRoles {
  /** The document body. */
  editor?: string;
  /** Titles in the document. Defaults to `editor`. */
  heading?: string;
  headingWeight?: number | string;
  /** `italic` is how a title gets a voice without a second family. */
  headingStyle?: 'normal' | 'italic' | 'oblique';
  /** For a face with a width axis: `125%` stretches, `78%` condenses. */
  headingStretch?: string;
  headingTracking?: string;
  /** Multiplier on every heading size. 1.15 makes a title announce itself. */
  headingScale?: number;
  headingTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
  /** Raw `font-variation-settings`, e.g. `'WONK' 1, 'SOFT' 80` for Fraunces. */
  headingVariation?: string;
  /** Everything that is not a document. */
  ui?: string;
  uiHeading?: string;
  uiHeadingWeight?: number | string;
  /** The one monospace, shared by the document and the chrome. */
  mono?: string;
  /** Body line height, for a face that wants more or less air than 1.65. */
  lineHeight?: number;
}

export interface FontPackDefinition {
  /** Unique, namespaced by convention for a third-party pack. */
  id: string;
  name: string;
  description?: string;
  /**
   * Faces the pack needs. Emitted for *every* registered pack, not just the
   * chosen one — an unused `@font-face` costs nothing until something matches
   * it, and having them all declared is what lets the settings panel show each
   * pack in its own face.
   */
  faces?: FontFaceDeclaration[];
  roles: FontRoles;
}

export interface ThemeDefinition {
  /** Unique, namespaced by convention for a third-party theme. */
  id: string;
  name: string;
  description?: string;
  author?: string;
  /**
   * A theme should provide both schemes. When it provides one, that one is used
   * for the other as well — the alternative is a dark palette showing through
   * light defaults, which is worse than a theme that ignores the toggle.
   */
  light?: ThemeTokens;
  dark?: ThemeTokens;
  /** Tokens applied to both schemes, before the scheme's own. */
  tokens?: ThemeTokens;
  /** Faces the theme brings, if it does not lean on a pack for them. */
  faces?: FontFaceDeclaration[];
  /** A registered pack this theme is designed to be read in. */
  fontPack?: string;
  /** Roles layered over that pack — or used alone. */
  fonts?: FontRoles;
}

export interface ThemesApi {
  /** Registers a theme. Returns a disposer. */
  register(theme: ThemeDefinition): Unsubscribe;
  /** Registers a font pack. Returns a disposer. */
  registerFonts(pack: FontPackDefinition): Unsubscribe;
  /** Every registered theme, in registration order. */
  list(): ThemeDefinition[];
  /** Every registered font pack, in registration order. */
  fontPacks(): FontPackDefinition[];
  /** Id of the theme in use. */
  active(): string;
  /** Which scheme that resolves to right now, with `system` settled. */
  scheme(): ThemeScheme;
  /** Switches theme. Unknown ids are refused rather than blanking the app. */
  use(themeId: string): void;
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
  /**
   * A page's text changed (debounced, after save).
   *
   * `rev` is the revision the server produced. It travels with the event so
   * anything else holding that page open can adopt it without a second read —
   * and, more importantly, so it *does* adopt it. A view that keeps a stale
   * revision after someone else's write is a 409 waiting for the next
   * keystroke, whether or not its text happens to match.
   */
  'page:save': { page: string; text: string; rev?: string };
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
  /** Views, tiles and floating windows. */
  readonly windows: WindowsApi;
  /** Palettes and typefaces. */
  readonly themes: ThemesApi;
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
