import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDownIcon,
  CloseIcon,
  FolderIcon,
  HandIcon,
  HideIcon,
  MicIcon,
  MoreIcon,
  PageIcon,
  PenIcon,
  PlusIcon,
  RocketIcon,
  SendIcon,
  ShowIcon,
  SlashIcon,
  StopIcon,
  TerminalIcon,
  WebIcon,
} from './Icons';
import { NotePicker } from './pickers';
import { anchorElement, PopoverMenu, usePopover, type MenuEntry } from './Popover';
import { useApp } from '../app-context';
import { useFittedText } from '../lib/fit-text';
import { ModeGlyph } from '../lib/mode-icons';
import { PERMISSION_MODES, PERMISSION_MODE_LABELS, type Preferences } from '../lib/preferences';
import type { CommandInfo, SparkMode, SparkSettings, StoredFile } from '../lib/spark-client';
import type { UploadHandle } from '../lib/uploads';
import { useVoiceCapture } from '../lib/voice';

/**
 * The composer.
 *
 * Rebuilt around one observation: the text is the point and everything else is
 * an adjustment to it, so the text gets the whole box and the adjustments get a
 * strip underneath. The old shape put a bordered input in a row *between* two
 * icon buttons, which made a message look like a field on a form — three things
 * of equal weight, none of them the reason you are here.
 *
 * The shape:
 *
 * ```
 * ┌──────────────────────────────────────────┐
 * │  Ask about your notes                🎤  │
 * │ ──────────────────────────────────────── │
 * │  +  /  │  Improvements      ⚡ Fast   ↑  │
 * └──────────────────────────────────────────┘
 * ```
 *
 * One box with one border. The textarea has none of its own — a box inside a box
 * is the thing that made the old composer look like a form — and a hairline
 * divides the writing from the controls. The bottom bar reads left to right as
 * *what is going with this message* (add, commands, then the chips themselves)
 * and then, after the gap, *how it will be answered* (model, permissions) and
 * send.
 *
 * Three details that look small and are not:
 *
 * - **The chips are in the bar, not above it.** They are part of the sentence
 *   you are composing, so they sit in the row that describes it. A separate row
 *   above the text made the composer grow upward every time you attached
 *   something, shifting the transcript you were reading.
 * - **The placeholder shortens rather than wrapping.** See `useFittedText`. A
 *   composer that changes height when the rail is narrowed reads as broken.
 * - **The controls are always visible.** An earlier draft revealed them on
 *   focus, which meant the model in force was invisible exactly when you were
 *   deciding whether to send something to it.
 */

/** Longest first. `useFittedText` takes the best one that fits the box. */
const PLACEHOLDERS = [
  'Ask about your notes, or ask for a change',
  'Ask about your notes, or for a change',
  'Ask anything about your notes',
  'Ask about your notes',
  'Ask Spark',
  'Ask',
];

const NO_PROVIDER = [
  'Add a provider in Settings to use Spark',
  'Add a provider in Settings',
  'No provider yet',
  'No provider',
];

export interface ContextItem {
  /** Page name, or the file name for an upload. */
  name: string;
  /**
   * `neighbour` is the note beside the chat, sent automatically whenever
   * `sparkSeesContext` is on and there is exactly one sibling — see
   * **Context** in `AGENTS.md`. It is its own kind rather than an automatic
   * `page` because it cannot be removed the way one can: there is always
   * either a neighbour or there isn't, so the chip can only be hidden.
   */
  kind: 'page' | 'selection' | 'file' | 'neighbour';
  /** For a page or a selection: the text that will travel. */
  text?: string;
  /** For a file: what the server stored. */
  file?: StoredFile;
  /**
   * Whether this was added by the app rather than chosen.
   *
   * An automatic chip is removable but reappears when its reason returns — you
   * dismiss *this* selection, not the feature — which is why it has to be
   * distinguishable from one you picked deliberately.
   */
  automatic?: boolean;
  /**
   * Excluded from the message without being removed. The only lever a
   * `neighbour` chip has — greyed out and marked with an eye-off glyph rather
   * than gone, because being beside the chat is a fact about the screen, not
   * a choice that can be taken back.
   */
  hidden?: boolean;
}

export interface ComposerProps {
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  busy: boolean;
  enabled: boolean;

  context: ContextItem[];
  onRemoveContext: (item: ContextItem) => void;
  /** Toggles a `neighbour` chip between travelling with the message and not. */
  onToggleContextHidden: (item: ContextItem) => void;
  onAttachFiles: (files: FileList | File[] | null) => void;
  onAttachPage: (name: string) => void;
  /**
   * Saves free text as a note under `Spark/projects/` and attaches it — the
   * "Attach text" entry's whole job.
   */
  onAttachText: (title: string, text: string) => Promise<void> | void;
  /** Attaches a whole project's instructions and attachments as context. */
  onAttachProject: (name: string) => Promise<void> | void;
  /** Project page names, for the "Add a project" entry. */
  projects: string[];
  /** Uploads currently in flight — each cancellable on its own. */
  uploads: UploadHandle[];
  /** Whether the files already attached add up to more than one turn can carry. */
  overAttachmentBudget: boolean;
  /** Every page in the space, for the note picker. */
  pages: Array<{ name: string }>;

  settings: SparkSettings | null;
  preferences: Preferences;
  setPreferences: (patch: Partial<Preferences>) => void;
  /** Server capability, not preference: whether search can actually run. */
  webSearchReady: boolean;

  commands: CommandInfo[];
}

export function SparkComposer(props: ComposerProps) {
  const {
    draft,
    onDraft,
    onSend,
    onStop,
    busy,
    enabled,
    context,
    onRemoveContext,
    onToggleContextHidden,
    onAttachFiles,
    onAttachPage,
    onAttachText,
    onAttachProject,
    projects,
    uploads,
    overAttachmentBudget,
    pages,
    settings,
    preferences,
    setPreferences,
    webSearchReady,
    commands,
  } = props;

  const { toast } = useApp();
  const input = useRef<HTMLTextAreaElement>(null);
  const placeholder = useFittedText(input, enabled ? PLACEHOLDERS : NO_PROVIDER);

  // There is at most one `neighbour` chip, always last in `context` — see
  // `SparkView`. Split out so it can be measured and collapsed on its own
  // track instead of scrolling away with the chips someone actually chose.
  const neighbourItem = context.find((item) => item.kind === 'neighbour');
  const chosenContext = context.filter((item) => item.kind !== 'neighbour');

  /**
   * The button bar collapses in priority order rather than all at once: the
   * model dial goes first, because which model answered is the thing you
   * look up occasionally, not the thing you watch; the permission dial goes
   * next; the neighbour chip sheds its name down to just the eye after that,
   * because it says something you can already see on screen; and only past
   * that does the eye itself go, since whether the note beside you is
   * actually reaching Spark is the last thing you want to lose track of.
   * `+`, `/`, the chips you *chose*, and send never collapse — those are the
   * message itself.
   *
   * `level` counts how many of those four steps have been taken. Each one
   * folds away from a *measurement* of the bar's own overflow, not a guessed
   * pixel breakpoint — a static width is either too eager (hiding something
   * you had room for) or too late (letting the row spill), because the room
   * a step needs depends on its label text, not a constant. Hidden,
   * always-mounted probes (`.spark-actions-measure`) report each step's true
   * rendered width, and the bar is asked directly — `scrollWidth` against
   * `clientWidth` — whether the current step still fits. Showing a step
   * again needs slack, not a bare fit, or the row would flicker open and
   * shut right at the boundary.
   */
  const bar = useRef<HTMLDivElement>(null);
  // The value itself is unused below — its only job is to force a re-render
  // (and so re-run the layout effect) when the panel is resized without any
  // other state changing.
  const [, setBarResizeTick] = useState(0);

  useEffect(() => {
    const host = bar.current;
    if (!host) return;
    const observer = new ResizeObserver(() => setBarResizeTick((n) => n + 1));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  function useProbeWidth() {
    const ref = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);
    useEffect(() => {
      const el = ref.current;
      if (!el) return;
      const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
      observer.observe(el);
      return () => observer.disconnect();
    }, []);
    return [ref, width] as const;
  }

  const [modeProbe, modeWidth] = useProbeWidth();
  const [permissionProbe, permissionWidth] = useProbeWidth();
  // The neighbour chip's full width and its icon-only width, so the step
  // that sheds the name can be costed as their difference, and the step that
  // drops the chip entirely can be costed as what icon-only was still using.
  const [neighbourFullProbe, neighbourFullWidth] = useProbeWidth();
  const [neighbourIconProbe, neighbourIconWidth] = useProbeWidth();

  const MAX_LEVEL = 4;
  const [level, setLevel] = useState(0);
  /** Per step, the rest-of-row width recorded at the moment it collapsed
   *  (`clientWidth` net of that step's own width) — see the effect below. */
  const collapsedAt = useRef<number[]>([0, 0, 0, 0]);

  /**
   * Re-checked after every render — including the one this itself causes
   * when it changes `level` — for the same reason the single-dial version of
   * this used to: toggling a step changes the bar's own `scrollWidth`
   * without changing its `clientWidth`, which is the one change a
   * `ResizeObserver` on the bar cannot see for itself.
   *
   * The two directions are deliberately asymmetric. **Collapsing one more
   * step** trusts the live DOM outright — the step is actually there, so
   * `scrollWidth > clientWidth` is a plain fact, not an estimate.
   * **Re-expanding** cannot do the same, because the thing being asked about
   * (would this step fit again?) is not currently in the DOM to measure — so
   * it estimates the rest of the row's width as whatever didn't fit
   * alongside that step last time (`collapsedAt`, recorded net of the step's
   * width), and adds the step's current natural width from its hidden probe
   * back on top. A step only ever re-expands one at a time, from the
   * narrowest step inward, so a stale estimate for a deeper step can cost an
   * extra round trip but cannot loop.
   */
  useLayoutEffect(() => {
    const host = bar.current;
    if (!host) return;
    const available = host.clientWidth;
    const stepWidth = [modeWidth, permissionWidth, Math.max(neighbourFullWidth - neighbourIconWidth, 0), neighbourIconWidth];

    setLevel((current) => {
      if (current < MAX_LEVEL && host.scrollWidth > available) {
        // Recorded net of this step's own width, so it reflects what the
        // rest of the row alone needs — not the full, already-overflowing
        // row. Adding the (possibly since-changed) step width back below is
        // then one count of it, not two.
        collapsedAt.current[current] = available - stepWidth[current];
        return current + 1;
      }
      if (current > 0) {
        const width = stepWidth[current - 1];
        // A little slack before bringing a step back, so a resize that
        // lands exactly on the boundary doesn't show-then-hide on every
        // pixel.
        if (available >= collapsedAt.current[current - 1] + width + 8) return current - 1;
      }
      return current;
    });
  });

  // Voice writes into the same box as the keyboard, so dictating a sentence and
  // then fixing a word by hand is one act — the same call the capture screen
  // makes, for the same reason.
  const voice = useVoiceCapture(
    useCallback(
      (chunk: string) => {
        onDraft(draft ? `${draft} ${chunk}` : chunk);
      },
      [draft, onDraft],
    ),
  );

  // A denied mic permission or a recognition failure otherwise has no visible
  // effect beyond the mic icon quietly stopping — the same signal `Capture.tsx`
  // already surfaces for the same hook.
  useEffect(() => {
    if (voice.error) toast(voice.error, 'error');
  }, [voice.error, toast]);

  const modes = useMemo(() => (settings?.modes ?? []).filter((mode) => mode.enabled), [settings]);
  const mode =
    modes.find((entry) => entry.id === preferences.sparkModeId) ?? modes[0] ?? null;

  /**
   * The slash menu.
   *
   * Open only while the draft *is* a command being typed — one token, at the
   * very start, nothing after it. `/` in the middle of `journal/2026-07-30` is an
   * ordinary character and a menu that appeared there would be in the way of the
   * commonest thing anyone types into this box.
   */
  const slash = /^\/([a-z0-9-]*)$/i.exec(draft);
  const matches = useMemo(() => {
    if (!slash) return [];
    const query = slash[1].toLowerCase();
    return commands.filter((command) => command.name.toLowerCase().startsWith(query)).slice(0, 8);
  }, [slash, commands]);
  const [highlight, setHighlight] = useState(0);
  // Unique per mounted composer (the project panel embeds a second one), so
  // the textarea's `aria-controls`/`aria-activedescendant` never point at
  // another instance's menu.
  const slashId = useId();

  useEffect(() => {
    setHighlight(0);
  }, [slash?.[1]]);

  const runCommand = (command: CommandInfo) => {
    // A trailing space, because every command that takes an argument wants one
    // and the one that does not is unharmed by it.
    onDraft(`/${command.name} `);
    input.current?.focus();
  };

  const send = () => {
    if (voice.recording) voice.stop();
    onSend();
  };

  const canSend = Boolean(draft.trim()) || context.some((item) => item.kind === 'file');

  return (
    <div className="spark-composer" data-busy={busy || undefined}>
      {matches.length > 0 && (
        <SlashMenu
          id={slashId}
          commands={matches}
          active={highlight}
          onHover={setHighlight}
          onPick={runCommand}
        />
      )}

      <form
        className="spark-composer-form"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        // The whole composer takes a drop rather than a target you have to aim
        // for. No drag-over styling, because it is already the one place in the
        // panel that takes input.
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          onAttachFiles(event.dataTransfer?.files ?? null);
        }}
      >
        <div className="spark-composer-text">
          <textarea
            ref={input}
            className="spark-input"
            value={voice.interim ? `${draft ? `${draft} ` : ''}${voice.interim}` : draft}
            rows={1}
            placeholder={placeholder}
            aria-label="Message Spark"
            // Only meaningful while the slash menu is actually open — the box
            // is an ordinary multi-line field the rest of the time, and
            // claiming a listbox popup it isn't currently showing would be
            // its own kind of lie to a screen reader.
            aria-autocomplete={matches.length > 0 ? 'list' : undefined}
            aria-expanded={matches.length > 0 ? true : undefined}
            aria-controls={matches.length > 0 ? slashId : undefined}
            aria-activedescendant={matches.length > 0 ? `${slashId}-option-${highlight}` : undefined}
            // Interim speech is what the recogniser currently believes it heard,
            // not text yet; editing it would fight the recogniser.
            readOnly={Boolean(voice.interim)}
            onChange={(event) => onDraft(event.target.value)}
            onPaste={(event) => {
              // A screenshot on the clipboard arrives as a file with no name,
              // which is the commonest attachment there is. Only intercept when
              // there genuinely are files, so pasting text is untouched.
              const files = [...(event.clipboardData?.files ?? [])];
              if (files.length === 0) return;
              event.preventDefault();
              onAttachFiles(files);
            }}
            onKeyDown={(event) => {
              if (matches.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setHighlight((n) => (n + 1) % matches.length);
                  return;
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setHighlight((n) => (n - 1 + matches.length) % matches.length);
                  return;
                }
                if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                  event.preventDefault();
                  runCommand(matches[highlight] ?? matches[0]);
                  return;
                }
              }
              // Enter sends, Shift-Enter breaks the line. The composer is for
              // asking, and most asks are one line.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />

          {/* In the writing area rather than the button bar, because dictating
              *is* writing — it fills this box, and the bar below is about what
              happens to what is in it. */}
          {voice.supported && (
            <button
              className="icon-button spark-mic"
              type="button"
              data-recording={voice.recording || undefined}
              aria-label={voice.recording ? 'Stop dictating' : 'Dictate a message'}
              aria-pressed={voice.recording}
              title={voice.recording ? 'Stop dictating' : 'Dictate a message'}
              onClick={() => (voice.recording ? voice.stop() : voice.start())}
            >
              {voice.recording ? <StopIcon /> : <MicIcon />}
            </button>
          )}
        </div>

        <div className="spark-actions" ref={bar}>
          <AddButton
            pages={pages}
            chosen={context.map((item) => item.name)}
            projects={projects}
            onFiles={onAttachFiles}
            onPage={onAttachPage}
            onText={onAttachText}
            onProject={onAttachProject}
          />

          <button
            className="icon-button"
            type="button"
            aria-label="Commands"
            title="Commands"
            // Not a menu of its own: it types the slash, and the menu that
            // already watches for one appears. Two ways in, one implementation.
            onClick={() => {
              onDraft('/');
              input.current?.focus();
            }}
          >
            <SlashIcon />
          </button>

          {(chosenContext.length > 0 || uploads.length > 0 || (neighbourItem && level < 4)) && (
            <span className="spark-actions-rule" aria-hidden="true" />
          )}

          <ContextRow items={chosenContext} uploads={uploads} onRemove={onRemoveContext} />

          {overAttachmentBudget && (
            <span className="spark-attachment-warning" role="status" title="Everything past that limit will be left out when you send.">
              Attachments are over Spark's per-message limit
            </span>
          )}

          {neighbourItem && level < 4 && (
            <ul className="spark-context spark-neighbour">
              <NeighbourChip
                item={neighbourItem}
                iconOnly={level >= 3}
                onToggleHidden={onToggleContextHidden}
              />
            </ul>
          )}

          <span className="spark-actions-gap" />

          {level < 1 && mode && (
            <ModeButton
              mode={mode}
              modes={modes}
              onPick={(id) => setPreferences({ sparkModeId: id })}
            />
          )}

          {level < 2 && (
            <PermissionButton
              value={preferences.sparkPermissionMode}
              onPick={(sparkPermissionMode) => setPreferences({ sparkPermissionMode })}
            />
          )}

          <OverflowButton
            preferences={preferences}
            setPreferences={setPreferences}
            webSearchReady={webSearchReady}
            collapsedMode={
              level >= 1 && mode
                ? { mode, modes, onPick: (id) => setPreferences({ sparkModeId: id }) }
                : undefined
            }
            collapsedPermission={
              level >= 2
                ? {
                    value: preferences.sparkPermissionMode,
                    onPick: (sparkPermissionMode) => setPreferences({ sparkPermissionMode }),
                  }
                : undefined
            }
            neighbour={neighbourItem && level >= 4 ? neighbourItem : undefined}
            onToggleContextHidden={onToggleContextHidden}
          />

          {busy ? (
            <button
              className="icon-button spark-send"
              type="button"
              aria-label="Stop"
              title="Stop"
              onClick={onStop}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              className="icon-button spark-send"
              type="submit"
              aria-label="Send"
              title="Send"
              data-ready={canSend || undefined}
              disabled={!canSend}
            >
              <SendIcon />
            </button>
          )}
        </div>

        {/* Never shown — laid out (`visibility: hidden`, not `display: none`)
            so each wrapper's `scrollWidth` is that step's true width in this
            exact panel, at this exact font, for this exact label. That is
            what lets the collapse above react to reality instead of a
            guessed constant. Each wrapper stays mounted even when its
            content is absent (no modes configured, no neighbour) so the
            `ResizeObserver` attached to it never has to be re-attached. */}
        <div className="spark-actions-measure" aria-hidden="true">
          <div ref={modeProbe}>{mode && <ModeButton mode={mode} modes={modes} onPick={() => {}} />}</div>
          <div ref={permissionProbe}>
            <PermissionButton value={preferences.sparkPermissionMode} onPick={() => {}} />
          </div>
          <div ref={neighbourFullProbe}>
            {neighbourItem && (
              <ul className="spark-context spark-neighbour">
                <NeighbourChip item={neighbourItem} iconOnly={false} onToggleHidden={() => {}} />
              </ul>
            )}
          </div>
          <div ref={neighbourIconProbe}>
            {neighbourItem && (
              <ul className="spark-context spark-neighbour">
                <NeighbourChip item={neighbourItem} iconOnly onToggleHidden={() => {}} />
              </ul>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

/**
 * The chips someone actually chose, in the button bar.
 *
 * One strip for everything the turn is carrying beyond the automatic
 * `neighbour` — a note picked, a passage selected, a file dropped, a page
 * Spark presented. They are the same kind of object — "this is part of the
 * question" — and separating them by provenance would make the person do the
 * merging. `neighbour` renders on its own, protected track right after this
 * one; see `SparkComposer`.
 *
 * It scrolls sideways rather than wrapping. The bar is one row by design, and a
 * fifth attachment must not be able to push the send button onto a second line.
 */
function ContextRow({
  items,
  uploads,
  onRemove,
}: {
  items: ContextItem[];
  uploads: UploadHandle[];
  onRemove: (item: ContextItem) => void;
}) {
  if (items.length === 0 && uploads.length === 0) return null;

  return (
    <ul className="spark-context">
      {items.map((item) => (
        <li key={`${item.kind}:${item.name}`} data-kind={item.kind} data-hidden={item.hidden || undefined}>
          <span className="spark-context-glyph" aria-hidden="true">
            {item.hidden ? <HideIcon /> : item.kind === 'selection' ? <ShowIcon /> : <PageIcon />}
          </span>
          <span className="spark-context-name">
            {lastSegment(item.name.replace(/^files\//, ''))}
            {item.kind === 'selection' && <small> selection</small>}
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label={`Remove ${item.name}`}
            title={item.kind === 'file' ? 'Remove — the file stays in your space' : 'Remove'}
            onClick={() => onRemove(item)}
          >
            <CloseIcon />
          </button>
        </li>
      ))}
      {uploads.map((handle) => (
        <li key={handle.id} data-pending="true">
          <span className="spark-context-name">Uploading {lastSegment(handle.name)}…</span>
          <button
            className="icon-button"
            type="button"
            aria-label={`Cancel uploading ${handle.name}`}
            title="Cancel"
            onClick={handle.cancel}
          >
            <CloseIcon />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The `neighbour` chip: the note beside the chat, automatic rather than
 * chosen — see `ContextItem.kind`. It has nothing to remove, only to hide,
 * so the eye is the whole control: what it shows *is* what a click on it
 * does, the same one glyph doing both jobs rather than a mute status icon
 * paired with a separate button beside it.
 *
 * `iconOnly` narrows the chip to just that eye — as if the name were never
 * drawn rather than merely truncated — one step before the chip leaves the
 * bar entirely. Shared between the real chip and the two hidden probes that
 * measure it, so the measured width is always the width of exactly this
 * markup.
 */
function NeighbourChip({
  item,
  iconOnly,
  onToggleHidden,
}: {
  item: ContextItem;
  iconOnly: boolean;
  onToggleHidden: (item: ContextItem) => void;
}) {
  if (iconOnly) {
    return (
      <li data-kind="neighbour" data-hidden={item.hidden || undefined} data-icon-only="true">
        <button
          className="icon-button spark-context-eye"
          type="button"
          aria-label={item.hidden ? `Show ${item.name} to Spark` : `Hide ${item.name} from Spark`}
          title={
            item.hidden
              ? 'Hidden from Spark — click to include it again'
              : `${item.name} — beside you, click to hide`
          }
          onClick={() => onToggleHidden(item)}
        >
          {item.hidden ? <HideIcon /> : <ShowIcon />}
        </button>
      </li>
    );
  }

  return (
    <li data-kind="neighbour" data-hidden={item.hidden || undefined}>
      <button
        className="icon-button spark-context-glyph"
        type="button"
        aria-label={item.hidden ? `Show ${item.name} to Spark` : `Hide ${item.name} from Spark`}
        title={item.hidden ? 'Hidden from Spark — click to include it again' : 'Hide from Spark'}
        onClick={() => onToggleHidden(item)}
      >
        {item.hidden ? <HideIcon /> : <ShowIcon />}
      </button>
      <span className="spark-context-name">{lastSegment(item.name.replace(/^files\//, ''))}</span>
    </li>
  );
}

/** `projects/spark/notes` is `notes` on a chip; the folder is in the tooltip. */
function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

// ---------------------------------------------------------------------------
// What is travelling with the message
// ---------------------------------------------------------------------------

/**
 * Adding something to the message.
 *
 * A plus rather than a paperclip, because it no longer means "attach a file": a
 * file, a note out of the space, the passage you have selected, a whole
 * project and raw text all arrive through here, and a paperclip would describe
 * one of the five.
 */
function AddButton({
  pages,
  chosen,
  projects,
  onFiles,
  onPage,
  onText,
  onProject,
}: {
  pages: Array<{ name: string }>;
  chosen: string[];
  projects: string[];
  onFiles: (files: File[] | null) => void;
  onPage: (name: string) => void;
  onText: (title: string, text: string) => Promise<void> | void;
  onProject: (name: string) => Promise<void> | void;
}) {
  const popover = usePopover();
  const ref = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  const openMenu = () => {
    popover.open({
      label: 'Add to this message',
      anchor: anchorElement(ref.current),
      side: 'above',
      align: 'start',
      role: 'menu',
      render: ({ close }) => (
        <PopoverMenu
          close={close}
          entries={[
            {
              id: 'file',
              label: 'Attach a file',
              hint: 'or drop one',
              run: () => picker.current?.click(),
            },
            {
              id: 'note',
              label: 'Add a note as context',
              // The disposer is discarded rather than returned: `run` is a
              // command, and handing a function back from it would make the
              // menu think the action produced a value.
              run: () => {
                popover.open({
                  label: 'Choose a note',
                  anchor: anchorElement(ref.current),
                  side: 'above',
                  align: 'start',
                  className: 'popover-picker',
                  render: ({ close: closePicker }) => (
                    <NotePicker
                      pages={pages}
                      exclude={chosen}
                      emptyLabel="Every page is already attached."
                      onPick={(name) => {
                        onPage(name);
                        closePicker();
                      }}
                    />
                  ),
                });
              },
            },
            ...(projects.length > 0
              ? [
                  {
                    id: 'project',
                    label: 'Add a project as context',
                    hint: 'notes, files and instructions',
                    run: () => {
                      popover.open({
                        label: 'Choose a project',
                        anchor: anchorElement(ref.current),
                        side: 'above',
                        align: 'start',
                        role: 'menu',
                        render: ({ close: closeProjects }) => (
                          <PopoverMenu
                            close={closeProjects}
                            entries={projects.map(
                              (name): MenuEntry => ({
                                id: name,
                                label: name.slice('Spark/projects/'.length),
                                icon: <FolderIcon />,
                                run: () => {
                                  closeProjects();
                                  void onProject(name);
                                },
                              }),
                            )}
                          />
                        ),
                      });
                    },
                  } satisfies MenuEntry,
                ]
              : []),
            {
              id: 'text',
              label: 'Attach text as a note',
              hint: 'saved under Spark/projects/',
              run: () => {
                popover.open({
                  label: 'Attach text',
                  anchor: anchorElement(ref.current),
                  side: 'above',
                  align: 'start',
                  className: 'popover-picker',
                  render: ({ close: closeText }) => (
                    <AttachTextForm
                      onAttach={(title, text) => {
                        void onText(title, text);
                        closeText();
                      }}
                    />
                  ),
                });
              },
            },
          ]}
        />
      ),
    });
  };

  return (
    <>
      <input
        ref={picker}
        className="spark-file-input"
        type="file"
        multiple
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          // Cleared so choosing the same file twice in a row still fires.
          event.target.value = '';
        }}
      />
      <button
        ref={ref}
        className="icon-button"
        type="button"
        aria-label="Add to this message"
        title="Add a file, a note, a project, or text"
        onClick={openMenu}
      >
        <PlusIcon />
      </button>
    </>
  );
}

/**
 * Title and text, saved as a note under `Spark/projects/`.
 *
 * Shared by the composer and the project panel — same fields, same write,
 * differing only in what the note is added to afterwards. The title defaults
 * to the first line of the text, because naming a paste is the part people
 * skip.
 */
export function AttachTextForm({
  onAttach,
}: {
  onAttach: (title: string, text: string) => void | Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const canSave = Boolean(text.trim());

  return (
    <div className="spark-attach-text">
      <input
        ref={field}
        className="spark-attach-text-title"
        value={title}
        placeholder="Note title (defaults to the first line)"
        aria-label="Note title"
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && canSave && !busy) {
            event.preventDefault();
            void onAttach(title, text);
          }
        }}
      />
      <textarea
        className="spark-attach-text-body"
        value={text}
        placeholder="Paste or write the text…"
        aria-label="Text to attach"
        rows={6}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        className="button"
        data-variant="primary"
        disabled={!canSave || busy}
        onClick={() => {
          setBusy(true);
          void Promise.resolve(onAttach(title, text)).finally(() => setBusy(false));
        }}
      >
        Attach
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The two dials
// ---------------------------------------------------------------------------

/** Shared with `OverflowButton`, which opens the same picker from a nested menu once the dial itself has collapsed. */
function modeEntries(modes: SparkMode[], onPick: (id: string) => void): MenuEntry[] {
  return modes.map(
    (entry): MenuEntry => ({
      id: entry.id,
      label: entry.label,
      icon: <ModeGlyph icon={entry.icon} kind={entry.iconKind} />,
      // The model id is the hint rather than the label: you choose
      // "Quality", and which model that is today is a detail you
      // want available and not in your way.
      hint: entry.model || 'default model',
      run: () => onPick(entry.id),
    }),
  );
}

/**
 * One glyph per rung of the ladder, read at a glance beside the label rather
 * than in place of it — `ModeButton` already pairs an icon with its text, and
 * the permission dial follows the same shape rather than the opposite one.
 */
const PERMISSION_MODE_ICONS: Record<Preferences['sparkPermissionMode'], typeof HandIcon> = {
  manual: HandIcon,
  code: TerminalIcon,
  edit: PenIcon,
  auto: RocketIcon,
};

function permissionIcon(mode: Preferences['sparkPermissionMode']) {
  const Icon = PERMISSION_MODE_ICONS[mode];
  return <Icon />;
}

/** Shared with `OverflowButton`; see `modeEntries`. */
function permissionEntries(onPick: (mode: Preferences['sparkPermissionMode']) => void): MenuEntry[] {
  return PERMISSION_MODES.map(
    (id): MenuEntry => ({
      id,
      label: PERMISSION_MODE_LABELS[id].label,
      icon: permissionIcon(id),
      hint: PERMISSION_MODE_LABELS[id].hint,
      run: () => onPick(id),
    }),
  );
}

function ModeButton({
  mode,
  modes,
  onPick,
}: {
  mode: SparkMode;
  modes: SparkMode[];
  onPick: (id: string) => void;
}) {
  const popover = usePopover();
  const ref = useRef<HTMLButtonElement>(null);

  return (
    <button
      ref={ref}
      className="spark-dial"
      type="button"
      title={`Answering with ${mode.label}${mode.model ? ` (${mode.model})` : ''}`}
      aria-label={`Model: ${mode.label}`}
      onClick={() =>
        popover.open({
          label: 'Model',
          anchor: anchorElement(ref.current),
          side: 'above',
          align: 'start',
          role: 'menu',
          render: ({ close }) => <PopoverMenu close={close} entries={modeEntries(modes, onPick)} />,
        })
      }
    >
      <ModeGlyph icon={mode.icon} kind={mode.iconKind} />
      <span>{mode.label}</span>
      <ChevronDownIcon />
    </button>
  );
}

function PermissionButton({
  value,
  onPick,
}: {
  value: Preferences['sparkPermissionMode'];
  onPick: (mode: Preferences['sparkPermissionMode']) => void;
}) {
  const popover = usePopover();
  const ref = useRef<HTMLButtonElement>(null);
  const current = PERMISSION_MODE_LABELS[value];

  return (
    <button
      ref={ref}
      className="spark-dial"
      type="button"
      data-mode={value}
      title={current.hint}
      aria-label={`Permissions: ${current.label}`}
      onClick={() =>
        popover.open({
          label: 'Permissions',
          anchor: anchorElement(ref.current),
          side: 'above',
          align: 'start',
          role: 'menu',
          render: ({ close }) => <PopoverMenu close={close} entries={permissionEntries(onPick)} />,
        })
      }
    >
      {permissionIcon(value)}
      <span>{current.label}</span>
      <ChevronDownIcon />
    </button>
  );
}

/** What the model dial hands `OverflowButton` to rebuild its picker in a nested menu, once it has collapsed. */
interface CollapsedMode {
  mode: SparkMode;
  modes: SparkMode[];
  onPick: (id: string) => void;
}

/** Same, for the permission dial. Collapses independently and one step later — see `SparkComposer`. */
interface CollapsedPermission {
  value: Preferences['sparkPermissionMode'];
  onPick: (mode: Preferences['sparkPermissionMode']) => void;
}

/**
 * Everything that is a preference rather than a decision about this message,
 * plus — once the bar is too narrow to hold them — the model and permission
 * dials and the neighbour chip's hide toggle.
 *
 * Behind an ellipsis because none of it changes turn to turn: whether you want
 * to watch the model think is a thing you decide once and then forget, and a
 * toggle in the row would spend a permanent slot on it. A dial that has
 * collapsed into here is a different reason to be behind the ellipsis — not
 * "rarely touched" but "no room" — so it still opens the exact same picker the
 * standalone button would, just one menu deeper.
 */
function OverflowButton({
  preferences,
  setPreferences,
  webSearchReady,
  collapsedMode,
  collapsedPermission,
  neighbour,
  onToggleContextHidden,
}: {
  preferences: Preferences;
  setPreferences: (patch: Partial<Preferences>) => void;
  webSearchReady: boolean;
  /** Present once the bar has collapsed the model dial — the first thing to give. */
  collapsedMode?: CollapsedMode;
  /** Present once the bar has collapsed the permission dial too. */
  collapsedPermission?: CollapsedPermission;
  /** Present once the bar has collapsed the neighbour chip out of the strip entirely. */
  neighbour?: ContextItem;
  onToggleContextHidden: (item: ContextItem) => void;
}) {
  const popover = usePopover();
  const ref = useRef<HTMLButtonElement>(null);

  const tick = (on: boolean) => (on ? '✓' : '');

  const dialEntries: MenuEntry[] = [];
  if (collapsedMode) {
    dialEntries.push({
      id: 'model',
      label: 'Model',
      icon: <ModeGlyph icon={collapsedMode.mode.icon} kind={collapsedMode.mode.iconKind} />,
      hint: collapsedMode.mode.label,
      run: () => {
        popover.open({
          label: 'Model',
          anchor: anchorElement(ref.current),
          side: 'above',
          align: 'end',
          role: 'menu',
          render: ({ close: closeSub }) => (
            <PopoverMenu close={closeSub} entries={modeEntries(collapsedMode.modes, collapsedMode.onPick)} />
          ),
        });
      },
    });
  }
  if (collapsedPermission) {
    dialEntries.push({
      id: 'permission',
      label: 'Permissions',
      icon: permissionIcon(collapsedPermission.value),
      hint: PERMISSION_MODE_LABELS[collapsedPermission.value].label,
      run: () => {
        popover.open({
          label: 'Permissions',
          anchor: anchorElement(ref.current),
          side: 'above',
          align: 'end',
          role: 'menu',
          render: ({ close: closeSub }) => (
            <PopoverMenu close={closeSub} entries={permissionEntries(collapsedPermission.onPick)} />
          ),
        });
      },
    });
  }
  if (dialEntries.length > 0) dialEntries.push({ kind: 'separator', id: 'sep-dial' });

  return (
    <button
      ref={ref}
      className="icon-button"
      type="button"
      aria-label="Chat options"
      title="Chat options"
      // A dial or the neighbour chip having collapsed into here is a fact
      // about the panel's width, not a preference — the dot says "there is
      // more here than usual" without spelling out why.
      data-overflowing={Boolean(collapsedMode || collapsedPermission || neighbour) || undefined}
      onClick={() =>
        popover.open({
          label: 'Chat options',
          anchor: anchorElement(ref.current),
          side: 'above',
          align: 'end',
          role: 'menu',
          render: ({ close }) => (
            <PopoverMenu
              close={close}
              entries={[
                ...dialEntries,
                ...(neighbour
                  ? [
                      {
                        id: 'neighbour',
                        label: lastSegment(neighbour.name),
                        icon: neighbour.hidden ? <HideIcon /> : <PageIcon />,
                        hint: neighbour.hidden ? 'Hidden — click to include it' : 'Beside you, sent with this message',
                        run: () => onToggleContextHidden(neighbour),
                      } satisfies MenuEntry,
                      { kind: 'separator', id: 'sep-neighbour' } satisfies MenuEntry,
                    ]
                  : []),
                {
                  id: 'thinking',
                  label: 'Show thinking',
                  hint: tick(preferences.sparkShowThinking),
                  run: () => setPreferences({ sparkShowThinking: !preferences.sparkShowThinking }),
                },
                {
                  id: 'actions',
                  label: 'Show actions',
                  hint: tick(preferences.sparkShowActions),
                  run: () => setPreferences({ sparkShowActions: !preferences.sparkShowActions }),
                },
                { kind: 'separator', id: 'sep-1' },
                {
                  id: 'current-file',
                  label: 'Send the note I am reading',
                  hint: tick(preferences.sparkSendsCurrentFile),
                  run: () =>
                    setPreferences({ sparkSendsCurrentFile: !preferences.sparkSendsCurrentFile }),
                },
                {
                  id: 'context',
                  label: 'See what else is on screen',
                  hint: tick(preferences.sparkSeesContext),
                  run: () => setPreferences({ sparkSeesContext: !preferences.sparkSeesContext }),
                },
                { kind: 'separator', id: 'sep-2' },
                {
                  id: 'web',
                  label: 'Search the web',
                  icon: <WebIcon />,
                  // Disabled rather than hidden: "why can it not search" is a
                  // question with an answer, and the answer is a key in Settings.
                  disabled: !webSearchReady,
                  hint: webSearchReady ? 'On — configure a key or engine in Settings' : 'Not configured in Settings',
                  run: () => {},
                },
              ]}
            />
          ),
        })
      }
    >
      <MoreIcon />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

/**
 * Drawn in the composer rather than in a popover.
 *
 * It is not tethered to a button — it belongs to the text being typed, moves
 * with nothing, and has to stay open while the textarea keeps focus and keeps
 * receiving keys. A popover takes focus when it opens, which is exactly wrong
 * here.
 */
function SlashMenu({
  id,
  commands,
  active,
  onHover,
  onPick,
}: {
  id: string;
  commands: CommandInfo[];
  active: number;
  onHover: (index: number) => void;
  onPick: (command: CommandInfo) => void;
}) {
  return (
    <div id={id} className="spark-slash" role="listbox" aria-label="Commands">
      {commands.map((command, index) => (
        <button
          key={command.name}
          id={`${id}-option-${index}`}
          className="spark-slash-row"
          type="button"
          role="option"
          aria-selected={index === active}
          data-active={index === active || undefined}
          onPointerEnter={() => onHover(index)}
          // The textarea must keep focus, or the menu closes under the pointer
          // on the way to the click.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(command)}
        >
          <span className="spark-slash-name">/{command.name}</span>
          <span className="spark-slash-hint">{command.description}</span>
          {command.kind === 'skill' && <small className="spark-slash-kind">skill</small>}
        </button>
      ))}
    </div>
  );
}
