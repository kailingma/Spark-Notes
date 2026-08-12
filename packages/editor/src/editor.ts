import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  completionStatus,
} from '@codemirror/autocomplete';
import {
  defaultKeymap,
  history,
  historyKeymap,
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  SearchQuery,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
} from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  dropCursor,
  keymap,
  placeholder as placeholderExt,
  type KeyBinding,
} from '@codemirror/view';
import type {
  EditorApi,
  EditorSelection as SparkSelection,
  InlineDecorator,
  SlashCommand,
  Unsubscribe,
} from '@spark/plugin-sdk';
import { emojiCompletion, slashCompletion, wikiLinkCompletion } from './completions.js';
import { livePreview, livePreviewConfig } from './live-preview.js';
import { marginMetrics } from './metrics.js';
import { sparkMarkdownExtensions } from './markdown-extensions.js';
import {
  continueList,
  indentListItems,
  insertSnippet,
  insertText,
  setHeadingLevel,
  toggleTaskLine,
  toggleWrap,
} from './markdown-actions.js';
import { moveItemUp, moveItemDown, indentItem, outdentItem } from './outline.js';
import { sparkHighlighting, sparkSelection, sparkTheme } from './theme.js';

export interface SparkEditorOptions {
  parent: HTMLElement;
  doc?: string;
  page?: string | null;
  placeholder?: string;
  /** Fires on every document change. */
  onChange?: (text: string) => void;
  /** Explicit save request (⌘S). Autosave is the caller's business. */
  onSave?: () => void;
  onWikiLink?: (target: string) => void;
  onLink?: (url: string) => void;
  /** Called when a `#tag` is clicked. */
  onTag?: (tag: string) => void;
  /** Slash commands offered in the `/` menu. */
  slashCommands?: () => SlashCommand[];
  /** Invoked when a slash command is chosen. */
  runSlash?: (command: SlashCommand) => void;
  /** Inline widget renderers from plugins. */
  decorators?: () => InlineDecorator[];
  /** Page names offered for `[[` completion. */
  pages?: () => string[];
  /** The curated emoji set offered for `:shortcode` completion. */
  emoji?: () => Array<{ glyph: string; keywords: string }>;
  /** Start with the cursor in the document. */
  autofocus?: boolean;
  /** Typing behaviours the settings panel can turn off. */
  behaviour?: Partial<EditorBehaviour>;
  /**
   * Turns a path written in the document into one the browser can fetch.
   *
   * `![](files/scan.png)` is relative to the *space*, not to the URL the app
   * happens to be at, so resolving it is the shell's business — the editor
   * has no idea where the space is served from.
   */
  resolveAsset?: (src: string) => string;
  /**
   * Files dropped onto the editor, with the document position they landed at.
   *
   * Uploading is the shell's business for the same reason as `resolveAsset`.
   * Providing a handler also takes over from CodeMirror's built-in file-drop
   * behaviour, which would read a dropped file as text and paste it in.
   */
  onDropFiles?: (files: File[], pos: number) => void;
}

/**
 * The typing behaviours that are a matter of taste rather than of correctness.
 *
 * Held in a compartment so changing one takes effect in every open editor
 * immediately: rebuilding the view instead would drop the cursor, and a setting
 * that costs you your place is a setting nobody touches twice.
 */
export interface EditorBehaviour {
  /** Return inside a list carries the marker onto the next line. */
  continueLists: boolean;
  /** Brackets and quotes close themselves, and wrap the selection. */
  autoPairs: boolean;
  /** The browser's own spelling underline. */
  spellcheck: boolean;
}

/** What the shell's find bar sends down. Every flag defaults to off. */
export interface FindQuery {
  search: string;
  caseSensitive?: boolean;
  regexp?: boolean;
  wholeWord?: boolean;
  replace?: string;
}

export interface FindStatus {
  total: number;
  /** 1-based index of the selected match, or 0 when none is selected. */
  current: number;
}

function buildQuery(query: FindQuery): SearchQuery {
  return new SearchQuery({
    search: query.search,
    caseSensitive: query.caseSensitive ?? false,
    regexp: query.regexp ?? false,
    wholeWord: query.wholeWord ?? false,
    replace: query.replace ?? '',
  });
}

const DEFAULT_BEHAVIOUR: EditorBehaviour = {
  continueLists: true,
  autoPairs: true,
  spellcheck: true,
};

/**
 * A mounted markdown editor.
 *
 * Implements the plugin-facing `EditorApi` directly, so a plugin and the app
 * shell drive the editor through exactly the same surface — there is no
 * privileged internal API that plugins are locked out of.
 */
export class SparkEditor implements EditorApi {
  readonly view: EditorView;

  #page: string | null;
  #changeHandlers = new Set<(text: string) => void>();
  #keymapCompartment = new Compartment();
  #behaviourCompartment = new Compartment();
  #behaviour: EditorBehaviour;
  #options: SparkEditorOptions;

  constructor(options: SparkEditorOptions) {
    this.#options = options;
    this.#page = options.page ?? null;
    this.#behaviour = { ...DEFAULT_BEHAVIOUR, ...options.behaviour };

    this.view = new EditorView({
      parent: options.parent,
      state: EditorState.create({
        doc: options.doc ?? '',
        extensions: this.#extensions(),
      }),
    });

    if (options.autofocus) this.view.focus();
  }

  // -- lifecycle ------------------------------------------------------------

  destroy(): void {
    this.view.destroy();
    this.#changeHandlers.clear();
  }

  /**
   * Swaps in a different page without tearing down the view. Reusing the DOM
   * keeps navigation instant and avoids a flash of empty editor.
   */
  setPage(page: string | null, text: string): void {
    // `setState` below rebuilds the state from scratch, which would throw away
    // the search field with it — and the find bar's query lives in React, so a
    // page swap would silently desync the two: the bar says "2 matches" while
    // the editor matches nothing. The query is re-applied after the swap.
    const previous = getSearchQuery(this.view.state);
    this.#page = page;
    this.view.setState(
      EditorState.create({ doc: text, extensions: this.#extensions() }),
    );
    if (previous.search) {
      this.view.dispatch({ effects: setSearchQuery.of(previous) });
    }

    // `setState` replaces the document wholesale, which CodeMirror does not
    // report as a doc change — so subscribers would keep showing the previous
    // page's derived state (word count, outline) forever. Notify them here.
    //
    // Deliberately *not* `options.onChange`: that one drives autosave, and
    // merely opening a page must never write it back to disk.
    this.#notifyChange(text);
  }

  // -- EditorApi ------------------------------------------------------------

  page(): string | null {
    return this.#page;
  }

  text(): string {
    return this.view.state.doc.toString();
  }

  selection(): SparkSelection {
    const range = this.view.state.selection.main;
    return { from: range.from, to: range.to };
  }

  selectedText(): string {
    const range = this.view.state.selection.main;
    return this.view.state.sliceDoc(range.from, range.to);
  }

  replaceSelection(text: string): void {
    insertText(this.view, text);
  }

  insert(text: string, at?: number): void {
    if (at === undefined) {
      insertText(this.view, text);
      return;
    }
    const pos = clamp(at, 0, this.view.state.doc.length);
    this.view.dispatch({
      changes: { from: pos, insert: text },
      selection: { anchor: pos + text.length },
    });
  }

  replaceRange(from: number, to: number, text: string): void {
    const length = this.view.state.doc.length;
    this.view.dispatch({
      changes: { from: clamp(from, 0, length), to: clamp(to, 0, length), insert: text },
    });
  }

  setSelection(from: number, to = from): void {
    const length = this.view.state.doc.length;
    this.view.dispatch({
      selection: { anchor: clamp(from, 0, length), head: clamp(to, 0, length) },
      scrollIntoView: true,
    });
  }

  setText(text: string): void {
    if (text === this.text()) return;
    const anchor = clamp(this.view.state.selection.main.anchor, 0, text.length);
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text },
      selection: { anchor },
    });
  }

  focus(): void {
    this.view.focus();
  }

  toggleWrap(before: string, after?: string): void {
    toggleWrap(this.view, before, after);
  }

  onChange(fn: (text: string) => void): Unsubscribe {
    this.#changeHandlers.add(fn);
    return () => this.#changeHandlers.delete(fn);
  }

  // -- convenience used by the app's toolbars --------------------------------

  insertSnippet(snippet: string): void {
    insertSnippet(this.view, snippet);
  }

  setHeading(level: number): void {
    setHeadingLevel(this.view, level);
  }

  toggleTask(): void {
    toggleTaskLine(this.view);
  }

  /** Moves the outline element at the cursor (heading, list item, paragraph, table row). dir: -1 up, 1 down. */
  moveItem(dir: -1 | 1): boolean {
    return dir < 0 ? moveItemUp(this.view) : moveItemDown(this.view);
  }
  /** Indents (outdent=false) or outdents (true) the list item or heading at the cursor. */
  indentItem(outdent = false): boolean {
    return outdent ? outdentItem(this.view) : indentItem(this.view);
  }

  /**
   * Puts the cursor on a zero-based line and scrolls it into view, centred.
   *
   * Used when you arrive at a page from somewhere that pointed at a specific
   * line — a task on the Tasks page, a backlink — where landing at the top and
   * leaving you to find it would defeat the point of the link.
   */
  goToLine(line: number): void {
    const clamped = clamp(line + 1, 1, this.view.state.doc.lines);
    const target = this.view.state.doc.line(clamped);
    this.view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
    });
    this.view.focus();
  }

  /** Appends text at the end of the document, adding a blank line if needed. */
  append(text: string): void {
    const doc = this.view.state.doc;
    const needsBreak = doc.length > 0 && !doc.sliceString(doc.length - 1).endsWith('\n');
    const insert = `${needsBreak ? '\n' : ''}${text}`;
    this.view.dispatch({
      changes: { from: doc.length, insert },
      selection: { anchor: doc.length + insert.length },
      scrollIntoView: true,
    });
  }

  // -- find -----------------------------------------------------------------
  //
  // The shell owns the find *bar* — it belongs to the view, not to the note, so
  // it cannot live in the document's own DOM. What it cannot own is the query
  // state and the match decorations, which are CodeMirror's. So the bar sends
  // its query down here and reads its counter back, and `@codemirror/search`
  // stays behind the package boundary along with the rest of CodeMirror.

  /** Sets the live query. An empty search clears the highlighting. */
  setFind(query: FindQuery): void {
    this.view.dispatch({ effects: setSearchQuery.of(buildQuery(query)) });
  }

  /**
   * Moves to the next match, wrapping.
   *
   * Returns false when there was nothing to move to, so the bar can say "no
   * results" rather than looking like it did nothing.
   */
  findNext(): boolean {
    return findNext(this.view);
  }

  findPrevious(): boolean {
    return findPrevious(this.view);
  }

  replaceNext(): boolean {
    return replaceNext(this.view);
  }

  replaceAll(): boolean {
    return replaceAll(this.view);
  }

  /**
   * How many matches there are, and which one is selected.
   *
   * `current` is 1-based and 0 means "none of them" — the state just after the
   * query changes but before anything has been stepped to.
   */
  findStatus(): FindStatus {
    const query = getSearchQuery(this.view.state);
    if (!query.search || !query.valid) return { total: 0, current: 0 };

    const selection = this.view.state.selection.main;
    const cursor = query.getCursor(this.view.state) as Iterator<{ from: number; to: number }>;

    let total = 0;
    let current = 0;
    // A note is not a log file, but a pathological regexp on a large paste
    // should not lock the tab up counting matches nobody will read.
    for (let step = cursor.next(); !step.done && total < 5000; step = cursor.next()) {
      total += 1;
      if (step.value.from === selection.from && step.value.to === selection.to) current = total;
    }
    return { total, current };
  }

  /**
   * Where the caret is on screen, for anything that has to appear beside it.
   *
   * Viewport coordinates, and null when the caret is scrolled out of the
   * rendered range — CodeMirror only builds DOM for what is visible, so there
   * is genuinely no answer in that case and guessing one puts the popup in the
   * wrong place.
   */
  caretRect(): { x: number; y: number; width: number; height: number } | null {
    const coords = this.view.coordsAtPos(this.view.state.selection.main.head);
    if (!coords) return null;
    return {
      x: coords.left,
      y: coords.top,
      width: Math.max(0, coords.right - coords.left),
      height: Math.max(1, coords.bottom - coords.top),
    };
  }

  // -- internals ------------------------------------------------------------

  /** Fans a new document out to `onChange` subscribers, isolating failures. */
  #notifyChange(text: string): void {
    for (const fn of [...this.#changeHandlers]) {
      try {
        fn(text);
      } catch (err) {
        console.error('[spark] editor change handler threw', err);
      }
    }
  }

  #extensions(): Extension[] {
    const options = this.#options;

    return [
      history(),
      drawSelection(),
      dropCursor(),

      // Files dropped on the editor are uploaded and linked by the shell —
      // the editor has no idea where the space is served from, so it cannot
      // be the one that stores the file. Intercepting the drop here also
      // stops CodeMirror's built-in handler, which would read the file as
      // text and paste its contents into the note. Returning `true` from the
      // `drop` handler is what suppresses that: CodeMirror treats it as
      // "handled" and skips its own. The `dragover` preventDefault is what
      // lets the browser *allow* the drop at all — without it the cursor
      // stays a "no drop" and the event never fires.
      EditorView.domEventHandlers({
        dragover: (event) => {
          if (!options.onDropFiles) return false;
          const types = event.dataTransfer?.types;
          if (types && Array.from(types).includes('Files')) event.preventDefault();
          return false;
        },
        drop: (event) => {
          const files = event.dataTransfer?.files;
          if (!options.onDropFiles || !files || files.length === 0) return false;
          const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos == null) return false;
          this.view.dispatch({ selection: { anchor: Math.min(pos, this.view.state.doc.length) } });
          this.view.focus();
          options.onDropFiles(Array.from(files), pos);
          return true;
        },
      }),

      EditorView.lineWrapping,
      this.#behaviourCompartment.of(this.#behaviourExtensions()),

      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: sparkMarkdownExtensions,
        // Spark supplies its own list and formatting keys.
        addKeymap: false,
      }),

      // The extension, never its panel. CodeMirror's own find bar is a child of
      // the content element, so it scrolls away with the note the moment the
      // document is longer than the tile — and here the tile scrolls the editor
      // rather than the editor scrolling itself, which makes it scroll away
      // immediately. The shell draws the find bar over the *view* instead and
      // drives it through the methods below; what is wanted from here is the
      // query state and the match highlighting.
      search(),

      livePreviewConfig.of({
        onWikiLink: options.onWikiLink,
        onLink: options.onLink,
        onTag: options.onTag,
        decorators: options.decorators,
        page: () => this.#page,
        resolveAsset: options.resolveAsset,
      }),
      livePreview,
      // Measures what the margin outdents have to match. Must be in the
      // extension set for headings and lists to line up on the first paint
      // after a font change.
      marginMetrics,

      sparkTheme,
      sparkSelection,
      sparkHighlighting,

      autocompletion({
        activateOnTyping: true,
        closeOnBlur: true,
        icons: false,
        override: [
          slashCompletion(
            () => options.slashCommands?.() ?? [],
            (command) => options.runSlash?.(command),
          ),
          wikiLinkCompletion(() => options.pages?.() ?? []),
          emojiCompletion(() => options.emoji?.() ?? []),
        ],
      }),

      options.placeholder ? placeholderExt(options.placeholder) : [],

      // Kept in a compartment so a future feature can swap the keymap without
      // rebuilding the editor. Plugin command keys are dispatched globally by
      // the app, not here — see `App`'s key dispatcher.
      this.#keymapCompartment.of(this.#keymap()),

      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const text = update.state.doc.toString();
        options.onChange?.(text);
        this.#notifyChange(text);
      }),
    ];
  }

  /**
   * Applies new typing behaviours to the live view.
   *
   * Both compartments are reconfigured, because two of the three settings are
   * partly keybindings: auto-pairing is an extension *and* a keymap, and list
   * continuation is only a keymap.
   */
  setBehaviour(behaviour: Partial<EditorBehaviour>): void {
    const next = { ...this.#behaviour, ...behaviour };
    if (
      next.continueLists === this.#behaviour.continueLists &&
      next.autoPairs === this.#behaviour.autoPairs &&
      next.spellcheck === this.#behaviour.spellcheck
    ) {
      return;
    }

    this.#behaviour = next;
    this.view.dispatch({
      effects: [
        this.#behaviourCompartment.reconfigure(this.#behaviourExtensions()),
        this.#keymapCompartment.reconfigure(this.#keymap()),
      ],
    });
  }

  #behaviourExtensions(): Extension[] {
    return [
      this.#behaviour.autoPairs ? closeBrackets() : [],
      EditorView.contentAttributes.of({
        spellcheck: String(this.#behaviour.spellcheck),
      }),
    ];
  }

  #keymap(): Extension {
    const view = () => this.view;

    const bindings: KeyBinding[] = [
      // Formatting.
      { key: 'Mod-b', run: () => (toggleWrap(view(), '**'), true) },
      { key: 'Mod-i', run: () => (toggleWrap(view(), '*'), true) },
      { key: 'Mod-e', run: () => (toggleWrap(view(), '`'), true) },
      { key: 'Mod-Shift-x', run: () => (toggleWrap(view(), '~~'), true) },
      { key: 'Mod-Shift-h', run: () => (toggleWrap(view(), '=='), true) },
      {
        // Not Mod-k: that belongs to the app's command palette, and a key bound
        // in both places fires in both places — the palette would open *and* a
        // link would be inserted into the document.
        key: 'Mod-Shift-k',
        run: () => {
          const selected = this.selectedText();
          insertSnippet(view(), selected ? `[${selected}](|)` : '[|]()');
          return true;
        },
      },
      { key: 'Mod-Enter', run: () => (toggleTaskLine(view()), true) },

      // Headings.
      ...[1, 2, 3, 4, 5, 6].map((level) => ({
        key: `Mod-${level}`,
        run: () => (setHeadingLevel(view(), level), true),
      })),
      { key: 'Mod-0', run: () => (setHeadingLevel(view(), 0), true) },

      // Lists. Without the setting, Enter falls through to the default keymap,
      // which inserts a plain newline.
      ...(this.#behaviour.continueLists ? [{ key: 'Enter', run: continueList }] : []),
      {
        key: 'Tab',
        run: (target) =>
          // Let the completion popup have Tab first, then list indentation.
          // Falling through when neither applies keeps Tab as a focus key,
          // so the editor is never a keyboard trap.
          (completionStatus(target.state) !== null && acceptCompletion(target)) ||
          indentListItems(target),
        shift: (target) => indentListItems(target, true),
      },

      // Outline moves. Mod-Alt keeps the plain arrow keys for caret motion;
      // Shift adds indentation. Returns false (falling through) when there is
      // nothing to move.
      { key: 'Mod-Alt-ArrowUp', run: () => moveItemUp(view()) },
      { key: 'Mod-Alt-ArrowDown', run: () => moveItemDown(view()) },
      { key: 'Mod-Alt-Shift-ArrowUp', run: () => outdentItem(view()) },
      { key: 'Mod-Alt-Shift-ArrowDown', run: () => indentItem(view()) },

      // Save.
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          this.#options.onSave?.();
          return true;
        },
      },

      ...(this.#behaviour.autoPairs ? closeBracketsKeymap : []),
      ...completionKeymap,
      // Deliberately no `searchKeymap`: ⌘F, ⌘G and their friends are commands
      // the app declares, and a key bound both here and in the global handler
      // fires in both places. See AGENTS → "Keybindings must be dispatched in
      // exactly one place".
      ...historyKeymap,
      ...defaultKeymap,
    ];

    return keymap.of(bindings);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
