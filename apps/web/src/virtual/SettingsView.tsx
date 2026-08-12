import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AiModelInfo, AiProvider, AiProviderProfile, GitHubAppConfig, GitStatus } from '@spark/core';
import type { FontPackDefinition, ThemeDefinition } from '@spark/plugin-sdk';
import { useApp } from '../app-context';
import {
  AppearanceIcon,
  AttachIcon,
  CloseIcon,
  CuratedIcon,
  GeneralIcon,
  GripIcon,
  InfoIcon,
  KeyboardIcon,
  MonoIcon,
  PenIcon,
  PluginIcon,
  SansIcon,
  SerifIcon,
  SparkIcon,
  SyncIcon,
  TrashIcon,
} from '../components/Icons';
import { EmojiPicker, IconPicker } from '../components/pickers';
import { anchorElement, PopoverMenu, usePopover } from '../components/Popover';
import { modKey } from '../lib/device';
import { startPointerDrag } from '../windows/drag';
import {
  DEFAULT_JOURNAL_FOLDER,
  DEFAULT_TEMPLATES_FOLDER,
  journalFolder,
  setJournalFolder,
  setTemplatesFolder,
  templatesFolder,
} from '../lib/dirs';
import { MODE_ICON_NAMES, ModeGlyph } from '../lib/mode-icons';
import {
  filesApi,
  memoryApi,
  sparkApi,
  type MemorySnapshot,
  type ModelInfo,
  type ProactiveStatus,
  type SearchProvider,
  type SearchProviderId,
  type SparkMode,
  type SparkSettings,
  type StoredFile,
} from '../lib/spark-client';
import { CAPTURE_MODES } from '../lib/modes';
import { AUTOSAVE_RANGE, HISTORY_RANGE, MEASURE_RANGE } from '../lib/preferences';
import { chooseFiles } from '../lib/uploads';
import {
  FONT_SIZE_RANGE,
  UI_FONT_SIZE_RANGE,
  snapUiFontSize,
  type FontChoice,
  type LayoutMode,
  type ThemeMode,
} from '../lib/appearance';
import { resolveFonts } from '../lib/theme';

/**
 * Settings.
 *
 * A modal window rather than a page: it acts on the app, not on your notes, and
 * it should not cost you the tile you were reading. It is still `[[Settings]]`
 * and still bookmarkable, because the workbench opens virtual pages marked
 * `presentation: 'modal'` above itself instead of inside a tab.
 *
 * The rail is icons only. Eight labelled tabs down the left of a modal is a
 * column of text competing with the settings themselves, and a settings panel
 * is somewhere you return to knowing roughly where the thing you want lives.
 * Every one carries its name as a tooltip and as its accessible label.
 *
 * Everything applies as you change it. There is no Save button because every
 * control shows you its own result, with one exception: the provider settings
 * live on the server, so they are saved explicitly.
 */

interface SettingsSection {
  id: string;
  title: string;
  hint: string;
  icon: ReactNode;
  render: () => ReactNode;
}

export function SettingsView() {
  const sections = useSections();
  const [active, setActive] = useState(sections[0].id);
  const current = sections.find((section) => section.id === active) ?? sections[0];
  const bodyRef = useRef<HTMLDivElement>(null);

  /**
   * A new tab starts at its top.
   *
   * The panel is one scroller behind eight different documents, so it kept
   * whatever offset the last one left — arriving at Keyboard from the bottom of
   * Appearance put you in the middle of the shortcut table, which reads as a
   * page that has lost its heading. A layout effect rather than an ordinary one
   * so it is never seen scrolled and then corrected.
   */
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [active]);

  return (
    <div className="settings">
      <nav className="settings-rail" aria-label="Settings sections">
        {sections.map((section) => (
          <button
            key={section.id}
            className="settings-rail-tab"
            aria-pressed={section.id === active}
            aria-label={section.title}
            title={`${section.title} — ${section.hint}`}
            onClick={() => setActive(section.id)}
          >
            {section.icon}
          </button>
        ))}
      </nav>

      <div className="settings-panel">
        <header className="settings-panel-head">
          <h2>{current.title}</h2>
          <p>{current.hint}</p>
        </header>
        <div className="settings-panel-body" ref={bodyRef}>
          {current.render()}
        </div>
      </div>
    </div>
  );
}

function useSections(): SettingsSection[] {
  return useMemo(
    () => [
      {
        id: 'general',
        title: 'General',
        hint: 'How the app behaves when you open it and move around it.',
        icon: <GeneralIcon />,
        render: () => <GeneralSection />,
      },
      {
        id: 'appearance',
        title: 'Appearance',
        hint: 'Theme, typeface and the size of everything.',
        icon: <AppearanceIcon />,
        render: () => <AppearanceSection />,
      },
      {
        id: 'editor',
        title: 'Editor',
        hint: 'Writing, saving and the small behaviours while you type.',
        icon: <PenIcon />,
        render: () => <EditorSection />,
      },
      {
        id: 'spark',
        title: 'Spark',
        hint: 'The provider behind Spark, and what it is allowed to do.',
        icon: <SparkIcon />,
        render: () => <SparkSection />,
      },
      {
        id: 'sync',
        title: 'Sync',
        hint: 'Git, GitHub, and where your notes live.',
        icon: <SyncIcon />,
        render: () => <SyncSection />,
      },
      {
        id: 'files',
        title: 'Uploads',
        hint: 'Everything attached to a chat or dropped into a note, in one list.',
        icon: <AttachIcon />,
        render: () => <FilesSection />,
      },
      {
        id: 'plugins',
        title: 'Plugins',
        hint: 'What is loaded, and where to put your own.',
        icon: <PluginIcon />,
        render: () => <PluginsSection />,
      },
      {
        id: 'keyboard',
        title: 'Keyboard',
        hint: 'Every command, and the keys that reach it.',
        icon: <KeyboardIcon />,
        render: () => <KeyboardSection />,
      },
      {
        id: 'about',
        title: 'About',
        hint: 'What this is and where it keeps things.',
        icon: <InfoIcon />,
        render: () => <AboutSection />,
      },
    ],
    [],
  );
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

function GeneralSection() {
  const { preferences, setPreferences, appearance, setAppearance, workspace } = useApp();

  const [journal, setJournal] = useState(() => journalFolder(workspace));
  const [templates, setTemplates] = useState(() => templatesFolder(workspace));

  return (
    <>
      <Group title="Starting up">
        <Toggle
          label="Open capture on a phone"
          hint="On a touch device, launch straight into quick capture instead of the editor."
          value={preferences.captureOnLaunch}
          onChange={(captureOnLaunch) => setPreferences({ captureOnLaunch })}
        />
        <Field label="Capture starts in" hint="The mode the capture screen opens on.">
          <Segmented
            options={CAPTURE_MODES.map((mode) => ({ value: mode.id, label: mode.label }))}
            value={preferences.captureMode}
            onChange={(captureMode) => setPreferences({ captureMode })}
          />
        </Field>
      </Group>

      {/*
        Layout lives here rather than under Appearance, where it used to be.
        Appearance is what the app *looks* like — palette, typeface, sizes — and
        this is what it can *do*: whether there are tabs, splits and floating
        windows at all. Somebody turning the workbench off is not restyling
        anything, and looking for it under Appearance meant reading two panels.
      */}
      <Group title="Layout">
        <Field
          label="Window mode"
          hint={
            appearance.layout === 'classic'
              ? 'One page at a time, filling the editor. No tabs, no splits, no floating windows.'
              : 'Tabs, splits, floating windows, and dragging any of them anywhere.'
          }
        >
          <Segmented
            options={LAYOUTS}
            value={appearance.layout}
            onChange={(layout) => setAppearance({ layout })}
          />
        </Field>
        <Note>
          Classic keeps the two side panels — the navigator on the left, Spark on the right — and
          everything you open replaces what you were reading, the way a single-document editor
          always has. Settings still opens in front of everything, because it has nowhere else to
          go. Switching either way resets the workspace to one page, since the two modes disagree
          about what can be on screen.
        </Note>
        <Note>
          Tiles and floating windows belong to the session that built them. A reload always returns
          you to a single tile showing the page in the address bar, which is also what makes
          reloading a reliable way out of a layout that has got away from you.
        </Note>
        <Toggle
          label="Confirm before closing unsaved work"
          hint="Ask before a tab with pending changes goes away."
          value={preferences.confirmClose}
          onChange={(confirmClose) => setPreferences({ confirmClose })}
        />
      </Group>

      <Group title="On the page">
        <Toggle
          label="Show backlinks"
          hint="The list of pages that link here, under the note."
          value={preferences.showBacklinks}
          onChange={(showBacklinks) => setPreferences({ showBacklinks })}
        />
        <Toggle
          label="Show keyboard hints"
          hint="The quiet line on an empty page reminding you what the keys are."
          value={preferences.showHints}
          onChange={(showHints) => setPreferences({ showHints })}
        />
      </Group>

      <Group title="Folders">
        <Field
          label="Journal folder"
          hint="Where a day's page lives — `journal/2026-07-30` by default. Renaming this does not move existing pages."
        >
          <input
            className="field"
            value={journal}
            placeholder={DEFAULT_JOURNAL_FOLDER}
            aria-label="Journal folder"
            onChange={(event) => setJournal(event.target.value)}
            onBlur={() => setJournalFolder(workspace, journal)}
          />
        </Field>
        <Field
          label="Templates folder"
          hint="Where the pages `/template` and `Use template` offer come from."
        >
          <input
            className="field"
            value={templates}
            placeholder={DEFAULT_TEMPLATES_FOLDER}
            aria-label="Templates folder"
            onChange={(event) => setTemplates(event.target.value)}
            onBlur={() => setTemplatesFolder(workspace, templates)}
          />
        </Field>
        <Note>
          A template is an ordinary page under this folder. Its text can use{' '}
          <code>{'{{date}}'}</code>, <code>{'{{isoDate}}'}</code>, <code>{'{{time}}'}</code>,{' '}
          <code>{'{{weekday}}'}</code> and <code>{'{{page}}'}</code>, filled in at the moment it is
          inserted. Add <code>journal: true</code> to a template's frontmatter to let it seed new
          journal pages automatically, and <code>days: monday</code> (or{' '}
          <code>weekday</code>/<code>weekend</code>, or a list) to restrict which days it applies
          to — a template with no <code>days</code> is the default for whichever day nothing more
          specific matches.
        </Note>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

const THEMES: Array<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

interface FontOption {
  value: FontChoice;
  label: string;
  hint: string;
  icon: ReactNode;
}

/**
 * Three named faces and one that defers.
 *
 * **Curated** is the fourth on both pickers, and its hint is filled in at render
 * time with whatever it currently resolves to — the whole point of the option is
 * that it is not a face, it is a *deferral*, so a static label would be the one
 * thing it must not have.
 */
const FONTS: FontOption[] = [
  { value: 'sans', label: 'Sans', hint: 'Inter', icon: <SansIcon /> },
  { value: 'serif', label: 'Serif', hint: 'Source Serif, Fraunces titles', icon: <SerifIcon /> },
  { value: 'mono', label: 'Mono', hint: 'iA Writer Mono', icon: <MonoIcon /> },
  { value: 'curated', label: 'Curated', hint: 'From the theme', icon: <CuratedIcon /> },
];

/*
 * The same words, different faces.
 *
 * Sans and serif are Plex here rather than the reading faces: Plex was drawn
 * as a system family and holds together in a 12px label, where Inter is a
 * touch neutral and Source Serif is prose asked to be a button. Mono is shared,
 * because wanting a monospaced interface means wanting *that* monospace.
 */
const UI_FONTS: FontOption[] = [
  { value: 'sans', label: 'Sans', hint: 'IBM Plex Sans', icon: <SansIcon /> },
  { value: 'serif', label: 'Serif', hint: 'IBM Plex Serif', icon: <SerifIcon /> },
  { value: 'mono', label: 'Mono', hint: 'iA Writer Mono', icon: <MonoIcon /> },
  { value: 'curated', label: 'Curated', hint: 'From the theme', icon: <CuratedIcon /> },
];

const LAYOUTS: Array<{ value: LayoutMode; label: string }> = [
  { value: 'workbench', label: 'Workbench' },
  { value: 'classic', label: 'Classic' },
];

function AppearanceSection() {
  const { appearance, setAppearance, preferences, setPreferences, workspace, registryVersion } =
    useApp();

  // Read during render, so keying on the registry version is right here — the
  // rule against it applies to callbacks reachable from an effect that
  // registers something, which this is not.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const themes = useMemo(() => workspace.registry.themes(), [workspace, registryVersion]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const packs = useMemo(() => workspace.registry.fontPacks(), [workspace, registryVersion]);

  const theme = themes.find((entry) => entry.id === appearance.themeId);
  const documentFonts = resolveFonts(theme, packs, appearance.fontPack);
  const uiFonts = resolveFonts(theme, packs, appearance.uiFontPack);

  /** A picker's hint: the face for a named mode, the source for a curated one. */
  const hintFor = (options: FontOption[], value: FontChoice, source: string | undefined) => {
    if (value !== 'curated') return options.find((entry) => entry.value === value)?.hint;
    return source === undefined
      ? 'Nothing curated to draw from — reading as Sans until a theme or pack provides a face.'
      : `${source} — the pairing this was designed with.`;
  };

  return (
    <>
      <Group title="Theme">
        <Field label="Colour scheme">
          <Segmented
            options={THEMES}
            value={appearance.theme}
            onChange={(theme) => setAppearance({ theme })}
          />
        </Field>

        <Note>
          A theme is a palette and the typeface pairing it was designed with. The colours apply
          whatever else you have set; the typography waits for <strong>Curated</strong> on one of the
          two font pickers below, so choosing Sans still means a sans. Themes come from extensions —
          the twelve here are a built-in one, and a file in <code>_plugins/</code> can add its own
          through the same API.
        </Note>

        {themes.length === 0 ? (
          <Note>No themes are installed.</Note>
        ) : (
          <ThemeGallery
            themes={themes}
            active={appearance.themeId}
            onChange={(themeId) => setAppearance({ themeId })}
          />
        )}

        {themes.length > 0 && !theme && (
          <Note>
            The theme this device is set to (<code>{appearance.themeId}</code>) is not installed, so
            the app is on its own palette. It is remembered rather than reset, in case the extension
            that provides it comes back.
          </Note>
        )}
      </Group>

      <Group title="Document type">
        <Field
          label="Reading font"
          hint={hintFor(FONTS, appearance.font, documentFonts?.source)}
        >
          <FontPicker
            label="Reading font"
            options={FONTS}
            value={appearance.font}
            onChange={(font) => setAppearance({ font })}
          />
        </Field>

        {appearance.font === 'curated' && (
          <CuratedPicker
            label="Curated set"
            theme={theme}
            packs={packs}
            value={appearance.fontPack}
            onChange={(fontPack) => setAppearance({ fontPack })}
          />
        )}

        <Field label="Text size" hint={`${appearance.fontSize}px`}>
          <Slider
            range={FONT_SIZE_RANGE}
            value={appearance.fontSize}
            label="Editor text size"
            onChange={(fontSize) => setAppearance({ fontSize })}
          />
        </Field>

        <Field
          label="Reading width"
          hint={`${preferences.measure}rem — how wide a line of text runs before it wraps.`}
        >
          <Slider
            range={MEASURE_RANGE}
            value={preferences.measure}
            label="Reading width"
            onChange={(measure) => setPreferences({ measure })}
          />
        </Field>

        {/* Shows the reading face, the display face and the code face at once,
            which is the only honest way to choose between them. */}
        <div className="type-preview">
          <h3>The quick brown fox</h3>
          <p>
            Body text at the size you will actually read it, with <em>emphasis</em>, a{' '}
            <code>const value</code> in code, and enough of a line to see how it wraps.
          </p>
        </div>
      </Group>

      <Group title="Interface type">
        <Note>
          Everything that is not a document: tabs and titles, the navigator, Spark, the status bar,
          and this page. It is set separately from your notes because chrome and prose want
          different things from a face — and because this panel is the one place you can watch the
          change happen as you make it.
        </Note>

        <Field
          label="Interface font"
          hint={hintFor(UI_FONTS, appearance.uiFont, uiFonts?.source)}
        >
          <FontPicker
            label="Interface font"
            options={UI_FONTS}
            value={appearance.uiFont}
            onChange={(uiFont) => setAppearance({ uiFont })}
          />
        </Field>

        {appearance.uiFont === 'curated' && (
          <CuratedPicker
            label="Curated set"
            theme={theme}
            packs={packs}
            value={appearance.uiFontPack}
            onChange={(uiFontPack) => setAppearance({ uiFontPack })}
          />
        )}

        <Field label="Interface text size" hint={`${appearance.uiFontSize.toFixed(1)}px`}>
          <Slider
            range={UI_FONT_SIZE_RANGE}
            value={appearance.uiFontSize}
            label="Interface text size"
            onChange={(value) => setAppearance({ uiFontSize: snapUiFontSize(value) })}
          />
        </Field>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function EditorSection() {
  const { preferences, setPreferences } = useApp();

  return (
    <>
      <Group title="Saving">
        <Field
          label="Autosave delay"
          hint={`${preferences.autosaveDelay}ms after you stop typing. There is no save button; this is how long the pause has to be.`}
        >
          <Slider
            range={AUTOSAVE_RANGE}
            value={preferences.autosaveDelay}
            label="Autosave delay"
            onChange={(autosaveDelay) => setPreferences({ autosaveDelay })}
          />
        </Field>
        <Note>
          A page also saves when the window loses focus and when the tab is hidden, whatever this
          is set to. The delay only decides how eager the ordinary case is.
        </Note>
      </Group>

      <Group title="While you type">
        <Toggle
          label="Continue lists"
          hint="Pressing Return inside a list carries the bullet, the number or the checkbox onto the next line."
          value={preferences.continueLists}
          onChange={(continueLists) => setPreferences({ continueLists })}
        />
        <Toggle
          label="Wrap the selection"
          hint="Typing a quote, bracket or asterisk with text selected wraps it instead of replacing it."
          value={preferences.autoPairs}
          onChange={(autoPairs) => setPreferences({ autoPairs })}
        />
        <Toggle
          label="Spell check"
          hint="The browser's own dictionary, underlining as you write."
          value={preferences.spellcheck}
          onChange={(spellcheck) => setPreferences({ spellcheck })}
        />
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Spark: you, and the presets
// ---------------------------------------------------------------------------

/**
 * Your name and your standing instructions.
 *
 * Both are saved on **blur** rather than on every keystroke. Custom instructions
 * are a paragraph, and a `PUT` per character would be a request per character;
 * blur is also when a person has finished the thought, which is the moment the
 * value is worth keeping.
 */
function SparkAboutYou() {
  const { toast } = useApp();
  const [settings, setSettings] = useState<SparkSettings | null>(null);
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  /** The engine the fields below are editing, right now. */
  const [providerId, setProviderId] = useState<SearchProviderId>('exa');
  const [key, setKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [busy, setBusy] = useState(false);

  const providers = settings?.searchProviders ?? [];
  const selected = providers.find((p) => p.id === providerId) ?? providers[0];

  useEffect(() => {
    void sparkApi.settings().then((loaded) => {
      if (!loaded) return;
      setSettings(loaded);
      setName(loaded.userName);
      setInstructions(loaded.instructions);
      setProviderId(loaded.activeSearchProvider);
    });
  }, []);

  // The endpoint field shows the *selected* engine's stored endpoint, so it
  // re-seeds when the selection changes or when a save lands a new value.
  // Keys never come back from the server, so the key field is always blank and
  // needs no seeding. Keyed on the stored string rather than the `selected`
  // object, whose identity changes with every `setSettings` — an unrelated
  // save elsewhere in the panel must not clobber an endpoint being typed.
  const storedEndpoint = selected?.endpoint ?? '';
  useEffect(() => {
    setEndpoint(storedEndpoint);
  }, [providerId, storedEndpoint]);

  /** "Can this engine run a search right now?" — mirrors the server's check. */
  const ready = (p: SearchProvider): boolean =>
    p.keyless || (p.needsEndpoint ? p.endpoint.trim().length > 0 : p.hasKey);

  const save = async (patch: Parameters<typeof sparkApi.saveSettings>[0]) => {
    try {
      setSettings(await sparkApi.saveSettings(patch));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  /**
   * The web-search group's one explicit save: the selected engine's key and
   * endpoint, in one button press.
   *
   * Keys live on the server, so unlike the name and instructions fields they
   * are saved when told, never on blur — and typing survives defocusing,
   * because neither the input nor the server touches the field until Save.
   * An empty key field means "I did not retype it", the same rule the AI key
   * follows: the patch omits the key so the stored one survives, and the
   * field clears only once the server confirms.
   */
  const saveEngine = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      setSettings(
        await sparkApi.saveSettings({
          activeSearchProvider: providerId,
          // Keyed by engine id, matching the server's merge — see
          // `normalizeSearchProviders` in spark-settings.ts.
          searchProviders: {
            [providerId]: {
              // Empty key = "leave the stored one alone", never "clear it".
              ...(key.trim() ? { key: key.trim() } : {}),
              // Endpoints are visible and re-seeded, so they round-trip whole.
              ...(selected.needsEndpoint ? { endpoint: endpoint.trim() } : {}),
            },
          },
        }),
      );
      setKey('');
      toast(`${selected.label} saved.`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Group title="You">
        <Field label="Your name" hint="Used the way a colleague would: rarely, and never to open a sentence.">
          <input
            className="field"
            value={name}
            placeholder="Not set"
            aria-label="Your name"
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void save({ userName: name.trim() })}
          />
        </Field>

        <Note>
          Custom instructions go at the <em>top</em> of Spark&rsquo;s system prompt and are declared
          to outrank everything after them, house style included. This is the place for a rule you
          want obeyed rather than weighed &mdash; &ldquo;British English&rdquo;, &ldquo;never bullet
          points in a journal entry&rdquo;, &ldquo;always ask before making a new folder&rdquo;.
        </Note>

        <textarea
          className="field settings-textarea"
          value={instructions}
          rows={5}
          placeholder="How do you want Spark to work?"
          aria-label="Custom instructions"
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={() => void save({ instructions })}
        />
      </Group>

      <Group title="Web search">
        <Note>
          Spark can look something up and answer from what the engine returns rather than from
          memory. The engine is a choice, not a fact: whichever one is selected decides whether the
          tool is offered at all &mdash; a search Spark cannot run is a tool never handed to the
          model, not a model that promises to search and then apologises.
        </Note>

        <Field
          label="Search engine"
          hint="Which engine `web_search` uses. Switch to the one you have a key for."
        >
          <select
            className="field select"
            value={providerId}
            aria-label="Search engine"
            onChange={(event) => {
              const id = event.target.value as SearchProviderId;
              setProviderId(id);
              setKey('');
              void save({ activeSearchProvider: id });
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        {selected && (
          <Note>
            {selected.hint}{' '}
            {selected.keyless
              ? 'No key needed &mdash; it just works.'
              : ready(selected)
                ? 'Configured and ready to run.'
                : selected.needsEndpoint
                  ? 'Needs an endpoint below before it can run.'
                  : 'Needs a key below before it can run.'}
          </Note>
        )}

        {providers.some((p) => p.id !== providerId && ready(p)) && (
          <Field
            label="Fallback engine"
            hint="Tried if the engine above errors or rate-limits. Only engines that are already configured and ready are offered."
          >
            <select
              className="field select"
              value={settings?.fallbackSearchProvider ?? ''}
              aria-label="Fallback search engine"
              onChange={(event) =>
                void save({ fallbackSearchProvider: event.target.value as SearchProviderId | '' })
              }
            >
              <option value="">None</option>
              {providers
                .filter((p) => p.id !== providerId && ready(p))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
            </select>
          </Field>
        )}

        <Toggle
          label="Let Spark search the web"
          hint={
            selected && (selected.keyless || ready(selected))
              ? `${selected.label} is ready to run.`
              : 'Needs configuring below before it can do anything.'
          }
          value={settings?.webSearch ?? true}
          onChange={(webSearch) => void save({ webSearch })}
        />

        {selected && !selected.keyless && selected.needsKey && (
          <Field
            label={selected.id === 'custom' ? 'API key (optional)' : 'API key'}
            hint={
              selected.hasKey
                ? 'A key is set for this engine. Type a new one to replace it.'
                : 'Not set.'
            }
          >
            <input
              className="field"
              type="password"
              value={key}
              placeholder={selected.hasKey ? '••••••••' : 'Paste a key'}
              aria-label={`${selected.label} API key`}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
        )}

        {selected?.needsEndpoint && (
          <Field label="Endpoint" hint="The base URL of the search service.">
            <input
              className="field"
              type="url"
              value={endpoint}
              placeholder={
                selected.id === 'custom'
                  ? 'https://example.com/v1/search'
                  : 'https://search.example.com'
              }
              aria-label={`${selected.label} endpoint`}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setEndpoint(event.target.value)}
            />
          </Field>
        )}

        {selected && !selected.keyless && (
          <div className="settings-actions">
            <button
              className="button"
              data-variant="primary"
              disabled={busy}
              onClick={() => void saveEngine()}
            >
              {busy ? 'Working…' : `Save ${selected.label}`}
            </button>
          </div>
        )}
      </Group>

      <Group title="Memory">
        <Toggle
          label="Also search past conversations"
          hint="When memory is tidied, it also looks for related material in other conversations and hands it to the pass as background — text search only, so it never adds an extra cost. Off by default."
          value={settings?.deepMemory ?? false}
          onChange={(deepMemory) => void save({ deepMemory })}
        />
      </Group>
    </>
  );
}

const SCAN_INTERVAL_OPTIONS = [6, 12, 24, 48, 72];

/**
 * What runs without a live turn, made legible in one place.
 *
 * Memory consolidation has always run this way — quietly, at the end of a
 * turn you asked for — but had no settings surface of its own. The
 * background scan below is the one thing in the app that is allowed to look
 * without being asked, so both belong together here rather than the scan
 * getting a home and consolidation staying invisible.
 */
function ScheduledSection() {
  const { toast } = useApp();
  const [settings, setSettings] = useState<SparkSettings | null>(null);
  const [proactive, setProactive] = useState<ProactiveStatus | null>(null);
  const [memorySnapshot, setMemorySnapshot] = useState<MemorySnapshot | null>(null);

  useEffect(() => {
    void sparkApi.settings().then(setSettings);
    void sparkApi.proactiveStatus().then(setProactive);
    void memoryApi.read().then(setMemorySnapshot);
  }, []);

  const scan = settings?.proactiveScan;

  const save = async (proactiveScan: { enabled: boolean; intervalHours: number }) => {
    try {
      setSettings(await sparkApi.saveSettings({ proactiveScan }));
      setProactive(await sparkApi.proactiveStatus());
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <Group title="Scheduled">
      <Note>
        The only things Spark does without being asked. Both stay off your notes and never start a
        conversation on their own — memory tidies its own four files, and the scan below only ever
        leaves a quiet mark on the &ldquo;Ask Spark&rdquo; button.
      </Note>

      <ul className="settings-list">
        <li>
          <div>
            <div className="settings-list-main">
              <strong>Memory consolidation</strong>
              <span className="settings-tag">every few hours, or sooner if there is a lot to tidy</span>
            </div>
            <small>{memorySnapshot ? agoText(memorySnapshot.lastPass) : 'Loading…'}</small>
          </div>
        </li>
        <li>
          <div>
            <div className="settings-list-main">
              <strong>Background scan</strong>
              <span className="settings-tag">{scan?.enabled ? `every ${scan.intervalHours}h` : 'off'}</span>
            </div>
            <small>
              {!scan?.enabled
                ? 'Off — turn it on below.'
                : proactive
                  ? `${agoText(proactive.lastScan)} · next due ${dueText(proactive.nextDue)}`
                  : 'Loading…'}
            </small>
          </div>
        </li>
      </ul>

      <Toggle
        label="Also run a background scan"
        hint="Checks memory/threads for anything overdue, and recently-edited pages for a line that still reads like an open question. Never touches a conversation — a finding only ever shows as a quiet mark on the “Ask Spark” button, once, until you open it."
        value={scan?.enabled ?? false}
        onChange={(enabled) => void save({ enabled, intervalHours: scan?.intervalHours ?? 24 })}
      />

      {scan?.enabled && (
        <Field label="How often">
          <select
            className="field select"
            value={scan.intervalHours}
            aria-label="Scan interval"
            onChange={(event) => void save({ enabled: true, intervalHours: Number(event.target.value) })}
          >
            {SCAN_INTERVAL_OPTIONS.map((hours) => (
              <option key={hours} value={hours}>
                Every {hours < 24 ? `${hours} hours` : `${hours / 24} day${hours === 24 ? '' : 's'}`}
              </option>
            ))}
          </select>
        </Field>
      )}
    </Group>
  );
}

/** "3h ago", "just now" — never a raw timestamp, since what matters here is only "how stale". */
function agoText(at: number): string {
  if (!at) return 'has not run yet';
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function dueText(at: number): string {
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/**
 * The model presets.
 *
 * Named for what you get rather than for a model, because the model behind
 * "Quality" changes every few months and the reason you reached for it does not.
 * Each carries a glyph, a model id and a thinking budget — one decision rather
 * than three, since "quality" means a bigger model *and* room to think, and
 * keeping two controls in step by hand is how they end up disagreeing.
 *
 * The list is editable because three presets is a guess about how someone works.
 * Somebody who only ever wants one should be able to switch two off, and
 * somebody with a local model and a hosted one wants those two named after the
 * machines they run on.
 */
function ModePresets({ profiles }: { profiles: AiProviderProfile[] }) {
  const { toast } = useApp();
  const popover = usePopover();
  const [modes, setModes] = useState<SparkMode[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const defaultProfile = profiles.find((profile) => profile.isDefault) ?? profiles[0] ?? null;
  /** Which profile "Fetch models" (and "Add one per model") reads from. */
  const [browseId, setBrowseId] = useState<string>('');
  const browseProfileId = browseId || defaultProfile?.id || '';
  /** The preset currently being dragged to a new position. */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** The order the drag started from, restored if the drag is cancelled. */
  const dragOriginal = useRef<SparkMode[] | null>(null);
  /** Each row's element, for measuring where the pointer is during a drag. */
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  /** The live list, read from inside the drag handlers. */
  const modesRef = useRef<SparkMode[]>([]);
  modesRef.current = modes;

  useEffect(() => {
    void sparkApi.settings().then((loaded) => loaded && setModes(loaded.modes));
  }, []);

  /** Writes the whole list. It is short, and a per-field patch is not worth it. */
  const commit = (next: SparkMode[]) => {
    setModes(next);
    void sparkApi.saveSettings({ modes: next }).catch((err: unknown) => {
      toast(err instanceof Error ? err.message : String(err), 'error');
    });
  };

  const update = (id: string, patch: Partial<SparkMode>) =>
    commit(modes.map((mode) => (mode.id === id ? { ...mode, ...patch } : mode)));

  /**
   * Dragging a preset to a new position in the order.
   *
   * The handle's press means nothing on its own, so the drag is live from the
   * first pixel — no click to preserve. The row the pointer is over is
   * measured from the live DOM on every move (the list re-renders as the
   * order changes under the drag), and the reorder itself updates local state
   * only: the whole list is saved once, on release, so a fast drag is one
   * write rather than one per row crossed. Escape restores the order the drag
   * started from.
   */
  const startReorder = (id: string, row: HTMLLIElement, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const host = row.parentElement as HTMLUListElement | null;
    if (!host) return;
    dragOriginal.current = modes;
    setDraggingId(id);

    startPointerDrag(event, {
      onMove: (native) => {
        const rows = [...host.children] as HTMLLIElement[];
        const from = modesRef.current.findIndex((mode) => mode.id === id);
        if (from < 0) return;
        let to = from;
        // The row whose vertical middle the pointer has crossed. `>=` the
        // middle, so dragging downward past a row's centre puts the dragged
        // row *below* it — the order the pointer is actually describing.
        for (let i = 0; i < rows.length; i++) {
          const rect = rows[i].getBoundingClientRect();
          if (native.clientY >= rect.top + rect.height / 2) to = i;
        }
        if (to === from) return;
        setModes((current) => {
          const next = [...current];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          return next;
        });
      },
      onEnd: (_native, _delta, cancelled) => {
        setDraggingId(null);
        const original = dragOriginal.current;
        dragOriginal.current = null;
        if (cancelled) {
          setModes(original ?? modesRef.current);
          return;
        }
        const moved = modesRef.current;
        if (moved !== original) commit(moved);
      },
    });
  };

  /**
   * Fetching the browsed provider's own list — one of the configured
   * profiles, chosen below, rather than a form typed here: the settings
   * page's own provider forms (`ProviderEditor`) already have their own
   * "Browse models" against what's typed there, so this one is about
   * picking from a profile that's *already saved*, to fill mode presets.
   */
  const loadModels = async () => {
    if (!browseProfileId) return;
    setLoadingModels(true);
    setModelsNote(null);
    const result = await sparkApi.models({ id: browseProfileId });
    setModels(result.models);
    setModelsNote(
      result.ok
        ? `${result.models.length} model${result.models.length === 1 ? '' : 's'} from the provider.`
        : (result.error ?? 'Could not reach the provider.'),
    );
    setLoadingModels(false);
  };

  /**
   * Every model as its own preset, in one go.
   *
   * The reason this is worth a button: somebody pointing Spark at a local runtime
   * has four models with names like `qwen3:30b-a3b`, and creating four presets by
   * hand to reach them is four rounds of the same form. Existing presets are kept
   * — this adds what is missing rather than replacing what you set up.
   */
  const insertAll = () => {
    const have = new Set(modes.map((mode) => mode.model));
    const additions = models
      .filter((model) => !have.has(model.id))
      .slice(0, 12 - modes.length)
      .map(
        (model): SparkMode => ({
          id: model.id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40),
          label: model.label ?? shortModelName(model.id),
          icon: 'CircleDot',
          iconKind: 'lucide',
          model: model.id,
          thinking: 0,
          enabled: true,
          // Explicit, not left to fall through to the default: these presets
          // were built from *this* profile's model list, so that's the
          // profile they should answer with even if the default changes later.
          providerId: browseProfileId,
          fallbackProviderId: '',
        }),
      );

    if (additions.length === 0) {
      toast('Every model already has a preset.', 'info');
      return;
    }
    commit([...modes, ...additions]);
    toast(`Added ${additions.length} preset${additions.length === 1 ? '' : 's'}.`, 'success');
  };

  const addBlank = () => {
    const id = `mode-${Date.now().toString(36)}`;
    commit([
      ...modes,
      {
        id,
        label: 'New mode',
        icon: 'CircleDot',
        iconKind: 'lucide',
        model: '',
        thinking: 0,
        enabled: true,
        providerId: '',
        fallbackProviderId: '',
      },
    ]);
  };

  return (
    <Group title="Model presets">
      <Note>
        What the switcher in the chat offers. A preset is a name, a glyph, a model and how much room
        it gets to think &mdash; so &ldquo;Quality&rdquo; means one thing you choose once, rather
        than two settings you have to keep in step. Leave the model blank to use whichever one the
        provider is already configured with.
        {profiles.length > 1 &&
          ' More than one provider is configured, so each preset can also pick which one answers it, and a second to try if the first is down.'}
      </Note>

      <ul className="settings-modes">
        {modes.map((mode) => (
          <li
            key={mode.id}
            data-off={!mode.enabled || undefined}
            data-dragging={draggingId === mode.id || undefined}
            ref={(el) => {
              if (el) rowRefs.current.set(mode.id, el);
              else rowRefs.current.delete(mode.id);
            }}
          >
            <div className="settings-mode-row">
              <button
                className="mode-grip"
                aria-label={`Reorder the ${mode.label} preset`}
                title="Drag to reorder"
                onPointerDown={(event) => {
                  const row = rowRefs.current.get(mode.id);
                  if (row) startReorder(mode.id, row, event);
                }}
              >
                <GripIcon />
              </button>

              <IconButton
                mode={mode}
                onPick={(icon, iconKind) => update(mode.id, { icon, iconKind })}
                popover={popover}
              />

              <input
                className="field settings-mode-label"
                value={mode.label}
                aria-label={`Name of the ${mode.label} preset`}
                onChange={(event) => update(mode.id, { label: event.target.value })}
              />

              <input
                className="field settings-mode-model"
                value={mode.model}
                list="spark-model-list"
                placeholder="default model"
                aria-label={`Model for ${mode.label}`}
                spellCheck={false}
                onChange={(event) => update(mode.id, { model: event.target.value })}
              />

              <label className="settings-mode-think" title="Thinking budget, in tokens. Zero is off.">
                <span>Think</span>
                <input
                  className="field"
                  type="number"
                  min={0}
                  max={32000}
                  step={1024}
                  value={mode.thinking}
                  aria-label={`Thinking budget for ${mode.label}`}
                  onChange={(event) => update(mode.id, { thinking: Number(event.target.value) || 0 })}
                />
              </label>

              <button
                className="switch"
                role="switch"
                aria-checked={mode.enabled}
                aria-label={`Show ${mode.label} in the switcher`}
                title={mode.enabled ? 'Shown in the switcher' : 'Hidden'}
                onClick={() => update(mode.id, { enabled: !mode.enabled })}
              >
                <span className="switch-knob" />
              </button>

              <button
                className="icon-button"
                aria-label={`Delete the ${mode.label} preset`}
                title="Delete"
                onClick={() => commit(modes.filter((entry) => entry.id !== mode.id))}
              >
                <CloseIcon />
              </button>
            </div>

            {profiles.length > 1 && (
              <div className="settings-mode-providers">
                <label>
                  <span>Provider</span>
                  <select
                    className="field"
                    value={mode.providerId}
                    aria-label={`Provider for ${mode.label}`}
                    onChange={(event) => update(mode.id, { providerId: event.target.value })}
                  >
                    <option value="">
                      Default{defaultProfile ? ` (${defaultProfile.label})` : ''}
                    </option>
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Fallback</span>
                  <select
                    className="field"
                    value={mode.fallbackProviderId}
                    aria-label={`Fallback provider for ${mode.label}`}
                    onChange={(event) => update(mode.id, { fallbackProviderId: event.target.value })}
                  >
                    <option value="">None</option>
                    {profiles
                      .filter((profile) => profile.id !== mode.providerId)
                      .map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.label}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Feeds every model field at once, so a fetched list is offered as
          completions wherever you are typing rather than in one chosen row. */}
      <datalist id="spark-model-list">
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label ?? ''}
          </option>
        ))}
      </datalist>

      <div className="settings-actions">
        <button className="button" onClick={addBlank} disabled={modes.length >= 12}>
          Add a preset
        </button>
        {profiles.length > 1 && (
          <select
            className="field"
            value={browseProfileId}
            aria-label="Provider to browse models from"
            onChange={(event) => setBrowseId(event.target.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
        )}
        <button className="button" onClick={() => void loadModels()} disabled={loadingModels || !browseProfileId}>
          {loadingModels ? 'Fetching…' : 'Fetch models'}
        </button>
        {models.length > 0 && (
          <button className="button" data-variant="ghost" onClick={insertAll}>
            Add one per model
          </button>
        )}
      </div>

      {modelsNote && <p className="settings-result">{modelsNote}</p>}
    </Group>
  );
}

/**
 * The glyph, from either set.
 *
 * Two pickers behind one button rather than a kind-switch and then a picker: the
 * question in someone's head is "what should this look like", not "which
 * taxonomy am I choosing from", and making them answer the second one first is
 * the interface getting in the way of the decision.
 */
function IconButton({
  mode,
  onPick,
  popover,
}: {
  mode: SparkMode;
  onPick: (icon: string, kind: SparkMode['iconKind']) => void;
  popover: ReturnType<typeof usePopover>;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  const openPicker = (kind: SparkMode['iconKind']) =>
    popover.open({
      label: kind === 'emoji' ? 'Choose an emoji' : 'Choose an icon',
      anchor: anchorElement(ref.current),
      side: 'below',
      align: 'start',
      className: 'popover-picker',
      render: ({ close }) =>
        kind === 'emoji' ? (
          <EmojiPicker
            onPick={(emoji) => {
              onPick(emoji, 'emoji');
              close();
            }}
          />
        ) : (
          <IconPicker
            names={MODE_ICON_NAMES}
            render={(name) => <ModeGlyph icon={name} kind="lucide" size={16} />}
            onPick={(name) => {
              onPick(name, 'lucide');
              close();
            }}
          />
        ),
    });

  return (
    <button
      ref={ref}
      className="settings-mode-icon"
      aria-label={`Icon for ${mode.label}`}
      title="Choose an icon or an emoji"
      onClick={() =>
        popover.open({
          label: 'Icon',
          anchor: anchorElement(ref.current),
          side: 'below',
          align: 'start',
          role: 'menu',
          render: ({ close }) => (
            <PopoverMenu
              close={close}
              entries={[
                // The disposer is discarded: `run` is a command, and returning a
                // function from it would make the menu think it produced a value.
                { id: 'icon', label: 'An icon', run: () => void openPicker('lucide') },
                { id: 'emoji', label: 'An emoji', run: () => void openPicker('emoji') },
              ]}
            />
          ),
        })
      }
    >
      <ModeGlyph icon={mode.icon} kind={mode.iconKind} size={16} />
    </button>
  );
}

/** `claude-sonnet-5-20260101` reads better as `Sonnet 5` on a preset. */
function shortModelName(id: string): string {
  const trimmed = id
    .replace(/^(anthropic|openai|google|meta-llama)\//, '')
    .replace(/-\d{8}$/, '')
    .replace(/^claude-/, '');
  const words = trimmed.split(/[-_.:]/).filter(Boolean).slice(0, 3);
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ').slice(0, 40);
}

// ---------------------------------------------------------------------------
// Spark
// ---------------------------------------------------------------------------

const PROVIDERS: Array<{ value: AiProvider; label: string; hint: string }> = [
  {
    value: 'openai',
    label: 'OpenAI-compatible',
    hint: 'OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio, vLLM',
  },
  { value: 'anthropic', label: 'Anthropic', hint: 'The Claude Messages API' },
];

const PLACEHOLDER_ENDPOINT: Record<AiProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

interface ToolInfo {
  name: string;
  description: string;
  needs: 'write' | 'destroy' | 'remember' | 'run' | null;
}

function SparkSection() {
  const { workspace, preferences, setPreferences, config: server } = useApp();

  const [profiles, setProfiles] = useState<AiProviderProfile[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);

  const loadProfiles = () =>
    workspace.ai
      .profiles()
      .then(setProfiles)
      .catch(() => {
        /* the server is unreachable; the list stays empty */
      });

  useEffect(() => {
    let cancelled = false;
    void loadProfiles();

    void fetch('/api/spark/tools')
      .then((res) => (res.ok ? (res.json() as Promise<ToolInfo[]>) : []))
      .then((loaded) => {
        if (!cancelled) setTools(loaded);
      })
      .catch(() => setTools([]));

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  const allowed = (tool: ToolInfo) =>
    tool.needs === null ||
    (tool.needs === 'write' && preferences.sparkCanWrite) ||
    (tool.needs === 'destroy' && preferences.sparkCanDestroy) ||
    (tool.needs === 'remember' && preferences.sparkRemembers) ||
    (tool.needs === 'run' && preferences.sparkCanRun);

  return (
    <>
      <SparkAboutYou />

      <ModePresets profiles={profiles} />

      <Group title="What Spark may do">
        <Note>
          These are the ceiling — what Spark may <em>ever</em> do. How much of it happens without
          being asked about is the mode switcher in the chat itself, next to the model, because that
          is a decision you change from one job to the next.
        </Note>
        <Toggle
          label="Change pages"
          hint="Create pages, add to them, edit a passage, tick a task off."
          value={preferences.sparkCanWrite}
          onChange={(sparkCanWrite) => setPreferences({ sparkCanWrite })}
        />
        <Toggle
          label="Delete, rename and overwrite"
          hint="The edits you cannot undo by reading the result. Off unless you want it."
          value={preferences.sparkCanDestroy}
          onChange={(sparkCanDestroy) => setPreferences({ sparkCanDestroy })}
        />
        <Toggle
          label="See what is on screen"
          hint="The full text of the note beside the chat, and the names of anything else open."
          value={preferences.sparkSeesContext}
          onChange={(sparkSeesContext) => setPreferences({ sparkSeesContext })}
        />
        <Toggle
          label="Remember what it learns"
          hint="Keep facts, your conventions and open threads between conversations. Everything it keeps is markdown in memory/ — read it on the Memory page."
          value={preferences.sparkRemembers}
          onChange={(sparkRemembers) => setPreferences({ sparkRemembers })}
        />
        {/* Only offered when the server actually has a sandbox. A toggle for
            something the machine cannot do is a toggle that lies. */}
        {server.sandbox && (
          <Toggle
            label="Run code"
            hint={`For totals, counts and dates, which a model should compute rather than estimate. ${server.sandbox.describe}`}
            value={preferences.sparkCanRun}
            onChange={(sparkCanRun) => setPreferences({ sparkCanRun })}
          />
        )}
        <Field
          label="Conversation memory"
          hint={`${preferences.sparkHistoryDepth} earlier messages travel with each new one.`}
        >
          <Slider
            range={HISTORY_RANGE}
            value={preferences.sparkHistoryDepth}
            label="Conversation memory"
            onChange={(sparkHistoryDepth) => setPreferences({ sparkHistoryDepth })}
          />
        </Field>

        {tools.length > 0 && (
          <details className="settings-details">
            <summary>The {tools.length} things Spark can do</summary>
            <ul className="settings-tools">
              {tools.map((tool) => (
                <li key={tool.name} data-off={!allowed(tool) || undefined}>
                  <code>{tool.name}</code>
                  <span>{tool.description}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Group>

      <ProviderProfiles profiles={profiles} onChange={loadProfiles} embeddingsOn={server.embeddings} />

      <ScheduledSection />
    </>
  );
}

/**
 * Every configured AI provider — Anthropic, an OpenAI-compatible endpoint, a
 * local runtime, as many as you want — each named and kept independently, so
 * a mode preset (`ModePresets`) can point at any of them and fall back to a
 * second if the first is down. One is marked default for a preset that names
 * none, same as before there was more than one to choose from.
 */
function ProviderProfiles({
  profiles,
  onChange,
  embeddingsOn,
}: {
  profiles: AiProviderProfile[];
  onChange: () => void;
  embeddingsOn: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);

  const done = () => {
    setEditingId(null);
    onChange();
  };

  return (
    <Group title="Providers">
      <Note>
        Where Spark's model presets get their answers. A key is stored on the server, in{' '}
        <code>.spark/ai.json</code> at mode 0600 — outside the space, so it is never committed or
        pushed by sync. The browser is only ever told that a key exists, never what it is.
      </Note>

      <ul className="settings-providers">
        {profiles.map((profile) =>
          editingId === profile.id ? (
            <ProviderEditor
              key={profile.id}
              profile={profile}
              embeddingsOn={embeddingsOn}
              onDone={done}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <ProviderCard
              key={profile.id}
              profile={profile}
              onEdit={() => setEditingId(profile.id)}
              onChange={onChange}
            />
          ),
        )}
        {editingId === 'new' && (
          <ProviderEditor embeddingsOn={embeddingsOn} onDone={done} onCancel={() => setEditingId(null)} />
        )}
      </ul>

      {editingId !== 'new' && (
        <div className="settings-actions">
          <button className="button" onClick={() => setEditingId('new')}>
            Add a provider
          </button>
        </div>
      )}
    </Group>
  );
}

function ProviderCard({
  profile,
  onEdit,
  onChange,
}: {
  profile: AiProviderProfile;
  onEdit: () => void;
  onChange: () => void;
}) {
  const { workspace, toast } = useApp();
  const [busy, setBusy] = useState(false);

  const setDefault = async () => {
    setBusy(true);
    try {
      await workspace.ai.setDefaultProfile(profile.id);
      onChange();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const confirmed = await workspace.ui.select(`Remove "${profile.label}"?`, ['Remove', 'Cancel']);
    if (confirmed !== 'Remove') return;
    setBusy(true);
    try {
      await workspace.ai.deleteProfile(profile.id);
      onChange();
      toast('Removed.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      setBusy(false);
    }
  };

  return (
    <li className="settings-provider-card">
      <div className="settings-provider-head">
        <span className="settings-provider-label">{profile.label}</span>
        {profile.isDefault && <span className="settings-provider-badge">Default</span>}
      </div>
      <div className="settings-provider-meta">
        <span>{PROVIDERS.find((entry) => entry.value === profile.provider)?.label ?? profile.provider}</span>
        <span>{profile.model || 'default model'}</span>
        <span>
          {profile.hasKey
            ? `Key …${profile.keyHint}${profile.source === 'env' ? ' (environment)' : ''}`
            : profile.endpoint
              ? 'No key'
              : 'Not set up'}
        </span>
        {profile.embedModel && <span>{profile.embedModel}</span>}
      </div>
      <div className="settings-actions">
        <button className="button" disabled={busy} onClick={onEdit}>
          Edit
        </button>
        {!profile.isDefault && (
          <button className="button" disabled={busy} onClick={() => void setDefault()}>
            Make default
          </button>
        )}
        <button className="button" data-variant="ghost" disabled={busy} onClick={() => void remove()}>
          Remove
        </button>
      </div>
    </li>
  );
}

/** The add/edit form — a blank one when `profile` is absent. */
function ProviderEditor({
  profile,
  embeddingsOn,
  onDone,
  onCancel,
}: {
  profile?: AiProviderProfile;
  embeddingsOn: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { workspace, toast } = useApp();
  const [label, setLabel] = useState(profile?.label ?? '');
  const [provider, setProvider] = useState<AiProvider>(profile?.provider ?? 'anthropic');
  const [model, setModel] = useState(profile?.model ?? '');
  const [endpoint, setEndpoint] = useState(profile?.endpoint ?? '');
  // Empty means "leave the stored key alone" — the real one is never sent here,
  // so there is nothing to prefill it with.
  const [apiKey, setApiKey] = useState('');
  const [embedModel, setEmbedModel] = useState(profile?.embedModel ?? '');
  const [embedEndpoint, setEmbedEndpoint] = useState(profile?.embedEndpoint ?? '');
  const [embedKey, setEmbedKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const draft = (): Parameters<typeof workspace.ai.saveProfile>[0] => ({
    ...(profile ? { id: profile.id } : {}),
    label: label.trim() || undefined,
    provider,
    model: model.trim(),
    endpoint: endpoint.trim(),
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
  });

  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      await workspace.ai.saveProfile({
        ...draft(),
        embedModel: embedModel.trim(),
        embedEndpoint: embedEndpoint.trim(),
        ...(embedKey.trim() ? { embedKey: embedKey.trim() } : {}),
      });
      toast('Saved.', 'success');
      onDone();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Tests what is in the form, not what is on disk — the whole reason to
   * press this is to find out whether the model and key in front of you
   * work, usually *before* they replace ones that already do.
   */
  const runTest = async () => {
    setBusy(true);
    setNote('Asking…');
    try {
      const result = await workspace.ai.test(draft());
      setNote(result.ok ? `Working — ${result.model} replied.` : (result.error ?? 'Failed.'));
    } finally {
      setBusy(false);
    }
  };

  const loadModels = async () => {
    setLoadingModels(true);
    setNote(null);
    const result = await workspace.ai.models(draft());
    setModels(result.models);
    setNote(
      result.ok
        ? `${result.models.length} model${result.models.length === 1 ? '' : 's'} from the provider.`
        : (result.error ?? 'Could not reach the provider.'),
    );
    setLoadingModels(false);
  };

  return (
    <li className="settings-provider-card settings-provider-editing">
      <Field label="Name">
        <input
          className="field"
          value={label}
          placeholder={PROVIDERS.find((entry) => entry.value === provider)?.label}
          onChange={(event) => setLabel(event.target.value)}
          aria-label="Provider name"
        />
      </Field>

      <Field label="Provider" hint={PROVIDERS.find((entry) => entry.value === provider)?.hint}>
        <Segmented options={PROVIDERS} value={provider} onChange={setProvider} />
      </Field>

      <Field label="Model">
        <input
          className="field"
          list="settings-provider-models"
          value={model}
          placeholder={provider === 'anthropic' ? 'claude-opus-5' : 'gpt-5'}
          onChange={(event) => setModel(event.target.value)}
          aria-label="Model"
          spellCheck={false}
        />
      </Field>
      <datalist id="settings-provider-models">
        {models.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label ?? ''}
          </option>
        ))}
      </datalist>

      <Field
        label="Endpoint"
        hint="Leave blank for the provider's own. Point it at a local runtime to keep everything on your machine."
      >
        <input
          className="field"
          value={endpoint}
          placeholder={PLACEHOLDER_ENDPOINT[provider]}
          onChange={(event) => setEndpoint(event.target.value)}
          aria-label="API endpoint"
          spellCheck={false}
        />
      </Field>

      <Field
        label="API key"
        hint={
          profile?.hasKey
            ? `A key ending …${profile.keyHint} is set${profile.source === 'env' ? ', from the server environment' : ''}. Type a new one to replace it.`
            : 'No key set. A local runtime may not need one.'
        }
      >
        <input
          className="field"
          type="password"
          value={apiKey}
          placeholder={profile?.hasKey ? '••••••••' : 'sk-…'}
          onChange={(event) => setApiKey(event.target.value)}
          aria-label="API key"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <details className="settings-details" open={Boolean(profile?.embedModel)}>
        <summary>Search by meaning (optional)</summary>
        <Note>
          Spark can always search your notes by <em>words</em>; that needs nothing set up. Naming an
          embedding model here lets a mode pointed at this provider also search by <em>meaning</em>.
          Anthropic serves no embeddings, so this is a separate model even when Claude answers —
          an OpenAI one, or a local runtime.{' '}
          {embeddingsOn && "Currently on for the default provider's own embedding model."}
        </Note>
        <Field label="Embedding model">
          <input
            className="field"
            value={embedModel}
            placeholder="text-embedding-3-small"
            onChange={(event) => setEmbedModel(event.target.value)}
            aria-label="Embedding model"
            spellCheck={false}
          />
        </Field>
        <Field label="Embedding endpoint" hint="Blank uses the endpoint above, or OpenAI's.">
          <input
            className="field"
            value={embedEndpoint}
            placeholder="http://localhost:11434/v1"
            onChange={(event) => setEmbedEndpoint(event.target.value)}
            aria-label="Embedding endpoint"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Embedding key"
          hint={
            profile?.hasEmbedKey
              ? 'A separate key is set. Type a new one to replace it.'
              : 'Blank reuses the API key above.'
          }
        >
          <input
            className="field"
            type="password"
            value={embedKey}
            placeholder={profile?.hasEmbedKey ? '••••••••' : 'same as above'}
            onChange={(event) => setEmbedKey(event.target.value)}
            aria-label="Embedding key"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      </details>

      <div className="settings-actions">
        <button className="button" data-variant="primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Working…' : 'Save'}
        </button>
        <button
          className="button"
          disabled={busy}
          onClick={() => void runTest()}
          title="Tries the model and key as typed here, without saving them."
        >
          Test connection
        </button>
        <button className="button" disabled={busy || loadingModels} onClick={() => void loadModels()}>
          {loadingModels ? 'Fetching…' : 'Browse models'}
        </button>
        <button className="button" data-variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>

      {note && <p className="settings-result">{note}</p>}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Sync, set up from beginning to end.
 *
 * All of it lives here now, including the GitHub OAuth app, which used to be
 * two environment variables and a server restart. That is a setup step the app
 * cannot walk anyone through, and it is the *first* step — so the one feature
 * that needs the most explaining was the one with no explanation anywhere near
 * it. The four things it takes are laid out in the order they have to happen,
 * and each one says whether it is done.
 */
function SyncSection() {
  const { workspace, config, sync, gitDirty, toast, refreshConfig } = useApp();

  const [app, setApp] = useState<GitHubAppConfig | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [origin, setOrigin] = useState('');
  const [remote, setRemote] = useState('');
  const [git, setGit] = useState<GitStatus | null>(workspace.sync.git);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void workspace.sync
      .githubApp()
      .then((loaded) => {
        if (cancelled) return;
        setApp(loaded);
        setClientId(loaded.clientId);
        setOrigin(loaded.origin);
      })
      .catch(() => {
        /* an older server has no endpoint for this; the form stays empty */
      });
    void workspace.sync.refresh().then((status) => {
      if (!cancelled) setGit(status);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const guard = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveApp = () =>
    guard(async () => {
      const saved = await workspace.sync.saveGitHubApp({
        clientId: clientId.trim(),
        origin: origin.trim(),
        // Empty means "I did not retype it" — the browser never receives the
        // stored secret, so it cannot send it back.
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      });
      setApp(saved);
      setClientSecret('');
      // `/api/config` carries whether sign-in is possible, and the app read it
      // once at boot, so it has to be re-asked.
      await refreshConfig();
      toast('GitHub app saved.', 'success');
    });

  const forgetApp = () =>
    guard(async () => {
      const confirmed = await workspace.ui.select('Forget the GitHub app?', ['Forget', 'Cancel']);
      if (confirmed !== 'Forget') return;
      const cleared = await workspace.sync.clearGitHubApp();
      setApp(cleared);
      setClientId(cleared.clientId);
      setOrigin(cleared.origin);
      setClientSecret('');
      await refreshConfig();
      toast('Forgotten.', 'success');
    });

  // A popup keeps the editor mounted; the server posts back when it's done.
  const connect = () => window.open('/api/auth/github', 'spark-github', 'width=680,height=760');

  const attachRemote = () =>
    guard(async () => {
      const url = remote.trim();
      if (!url) return;
      setGit(await workspace.sync.attachRemote(url));
      toast('Repository connected.', 'success');
    });

  // Pulls an existing repository in. The server refuses when the space already
  // has notes, so the failure lands here as a toast with the reason, not as a
  // half-cloned space.
  const cloneIntoSpace = () =>
    guard(async () => {
      const url = remote.trim();
      if (!url) return;
      setGit(await workspace.sync.cloneRepo(url));
      toast('Repository cloned.', 'success');
    });

  const toggleSync = () =>
    guard(async () => {
      if (sync.mode === 'sync') {
        workspace.sync.disableSyncMode();
        toast('Back to online mode.', 'info');
        return;
      }
      const ok = await workspace.sync.enableSyncMode();
      toast(ok ? 'Sync mode on.' : 'Connect GitHub and a repository first.', ok ? 'success' : 'error');
      setGit(workspace.sync.git);
    });

  const syncNow = () =>
    guard(async () => {
      setGit(await workspace.sync.syncNow());
    });

  const signedIn = Boolean(config.user);
  const hasRemote = Boolean(git?.configured);
  const ready = Boolean(git?.configured && git?.authenticated);

  return (
    <>
      <Group title="How this works">
        <Note>
          Spark runs in <strong>online mode</strong> by default: every keystroke saves straight to
          the server and what you see is the file on disk. <strong>Sync mode</strong> additionally
          runs git in the background — pull, commit, push on a timer — against a repository you own.
          It is opt-in, because pushing to somebody's repository on their behalf should be a choice
          they made rather than a default they discover later. Conflicts are merged line by line,
          and when two edits genuinely overlap both versions are kept in the page with markers
          rather than one being chosen for you.
        </Note>
        <Fact label="Space" value={config.spaceName} />
        <Fact
          label="Mode"
          value={sync.mode === 'online' ? 'Online — straight to the server' : 'Sync mode — git in the background'}
        />
        <Fact label="Uncommitted changes" value={gitDirty ? 'Yes' : 'No'} />
      </Group>

      <Group title={`Step 1 · A GitHub app${app?.configured ? ' ✓' : ''}`}>
        <Note>
          Sync pushes on your behalf, so GitHub needs to know who is asking. Create an OAuth app
          once — it belongs to you, not to Spark, and no credential ever leaves this server.
        </Note>
        <Steps>
          <li>
            Open{' '}
            <a href="https://github.com/settings/developers" target="_blank" rel="noreferrer">
              github.com/settings/developers
            </a>{' '}
            → <strong>OAuth Apps</strong> → <strong>New OAuth App</strong>.
          </li>
          <li>
            Name it anything. Set <strong>Homepage URL</strong> to{' '}
            <CopyValue label="the homepage URL" value={app?.origin ?? origin} />.
          </li>
          <li>
            Set <strong>Authorization callback URL</strong> to exactly{' '}
            <CopyValue label="the callback URL" value={app?.callbackUrl ?? ''} /> — GitHub compares
            it character for character, and a mismatch is the usual reason sign-in fails.
          </li>
          <li>
            Register it, then <strong>Generate a new client secret</strong> and paste both values
            below.
          </li>
        </Steps>

        <Field
          label="Public address"
          hint="Where this server is reached from. The callback URL above is built from it."
        >
          <input
            className="field"
            value={origin}
            placeholder="http://localhost:3001"
            onChange={(event) => setOrigin(event.target.value)}
            aria-label="Public address"
            spellCheck={false}
          />
        </Field>

        <Field label="Client ID">
          <input
            className="field"
            value={clientId}
            placeholder="Iv1.0123456789abcdef"
            onChange={(event) => setClientId(event.target.value)}
            aria-label="GitHub client ID"
            spellCheck={false}
          />
        </Field>

        <Field
          label="Client secret"
          hint={
            app?.hasSecret
              ? `A secret ending …${app.secretHint} is set${app.source === 'env' ? ', from the server environment' : ''}. Type a new one to replace it.`
              : 'GitHub shows this once, when you generate it.'
          }
        >
          <input
            className="field"
            type="password"
            value={clientSecret}
            placeholder={app?.hasSecret ? '••••••••' : ''}
            onChange={(event) => setClientSecret(event.target.value)}
            aria-label="GitHub client secret"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Note>
          Both are written to <code>.spark/github.json</code> at mode 0600 — outside the space, so
          they are never committed or pushed. The browser is only ever told that a secret exists.
        </Note>

        <div className="settings-actions">
          <button
            className="button"
            data-variant="primary"
            disabled={busy || !clientId.trim()}
            onClick={() => void saveApp()}
          >
            {busy ? 'Working…' : 'Save'}
          </button>
          {app?.source === 'stored' && (
            <button className="button" data-variant="ghost" disabled={busy} onClick={() => void forgetApp()}>
              Forget app
            </button>
          )}
        </div>
      </Group>

      <Group title={`Step 2 · Your account${signedIn ? ' ✓' : ''}`}>
        <Note>
          Signing in gives Spark a token with the <code>repo</code> scope and nothing broader. It is
          stored beside the app's credentials and never sent to the browser.
        </Note>
        <Fact label="GitHub" value={config.user ? `Connected as ${config.user.login}` : 'Not connected'} />
        <div className="settings-actions">
          <button
            className="button"
            data-variant={signedIn ? undefined : 'primary'}
            disabled={!app?.configured}
            title={app?.configured ? undefined : 'Save a client ID and secret first.'}
            onClick={connect}
          >
            {signedIn ? 'Reconnect GitHub' : 'Connect GitHub'}
          </button>
        </div>
      </Group>

      <Group title={`Step 3 · A repository${hasRemote ? ' ✓' : ''}`}>
        <Note>
          Two ways in, decided by where the notes are. <strong>Use this repository</strong> points the
          space at a remote and pushes what is already here — an empty repository is fine. <strong>Clone
          this repository</strong> pulls an existing one in, but only into a space that is still empty:
          nothing is ever overwritten. A private repository is the usual choice.
        </Note>
        <Fact label="Repository" value={git?.remote ?? '—'} />
        <Fact label="Branch" value={git?.branch ?? '—'} />
        <Field label="Repository URL">
          <input
            className="field"
            value={remote}
            placeholder="https://github.com/you/notes.git"
            onChange={(event) => setRemote(event.target.value)}
            aria-label="Repository URL"
            spellCheck={false}
          />
        </Field>
        <div className="settings-actions">
          <button
            className="button"
            data-variant={hasRemote ? undefined : 'primary'}
            disabled={busy || !remote.trim() || !signedIn}
            title={signedIn ? undefined : 'Connect GitHub first.'}
            onClick={() => void attachRemote()}
          >
            {busy ? 'Connecting…' : hasRemote ? 'Use this repository instead' : 'Use this repository'}
          </button>
          {!hasRemote && (
            <button
              className="button"
              data-variant="ghost"
              disabled={busy || !remote.trim() || !signedIn}
              title={signedIn ? undefined : 'Connect GitHub first.'}
              onClick={() => void cloneIntoSpace()}
            >
              {busy ? 'Cloning…' : 'Clone this repository'}
            </button>
          )}
        </div>
      </Group>

      <Group title={`Step 4 · Turn it on${sync.mode === 'sync' ? ' ✓' : ''}`}>
        <Fact label="Ahead / behind" value={`${git?.ahead ?? 0} / ${git?.behind ?? 0}`} />
        <Fact label="Last sync" value={git?.lastSync ? new Date(git.lastSync).toLocaleString() : '—'} />

        {git && git.conflicts.length > 0 && (
          <div className="banner banner-inline" data-kind="warning">
            <p>
              {git.conflicts.length} page{git.conflicts.length === 1 ? '' : 's'} need a manual fix:{' '}
              {git.conflicts.slice(0, 3).join(', ')}
              {git.conflicts.length > 3 ? '…' : ''}. Open them and delete the{' '}
              <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> markers.
            </p>
          </div>
        )}

        <div className="settings-actions">
          <button
            className="button"
            data-variant={sync.mode === 'sync' ? undefined : 'primary'}
            disabled={busy || (sync.mode !== 'sync' && !ready)}
            title={ready || sync.mode === 'sync' ? undefined : 'Finish the steps above first.'}
            onClick={() => void toggleSync()}
          >
            {sync.mode === 'sync' ? 'Turn off sync mode' : 'Turn on sync mode'}
          </button>
          {sync.mode === 'sync' && (
            <button className="button" data-variant="primary" disabled={busy} onClick={() => void syncNow()}>
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
          )}
        </div>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Every upload in `files/`, in one list.
 *
 * A delete button on a chat bubble was tempting and wrong: an upload is a
 * real file that a note's own markdown may still link to, so removing it has
 * to be a deliberate visit here, not a stray click on the message that
 * happened to attach it first. Same reasoning `AGENTS.md` gives for why
 * `files/` has no separate id-keyed store — the file is the only record,
 * so this list is just `filesApi.list()`, not a second source of truth.
 */
function FilesSection() {
  const { toast } = useApp();
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void filesApi.list().then((list) => {
      if (!cancelled) setFiles(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = async (name: string) => {
    setBusy(name);
    try {
      await filesApi.remove(name);
      setFiles((current) => current?.filter((file) => file.name !== name) ?? current);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const total = files?.reduce((sum, file) => sum + file.size, 0) ?? 0;

  return (
    <Group title="Uploads">
      {files === null ? (
        <Note>Loading…</Note>
      ) : files.length === 0 ? (
        <Note>Nothing uploaded yet — a file attached to Spark or dropped into a note shows up here.</Note>
      ) : (
        <>
          <ul className="settings-list settings-files">
            {files.map((file) => (
              <li key={file.name}>
                <div>
                  <div className="settings-list-main">
                    <strong>{file.name.replace(/^files\//, '')}</strong>
                    <span className="settings-tag">{formatBytes(file.size)}</span>
                  </div>
                  <small>{new Date(file.modified).toLocaleString()}</small>
                </div>
                <button
                  className="icon-button"
                  aria-label={`Remove ${file.name}`}
                  title="Remove — any note still linking to it will show a broken link"
                  disabled={busy === file.name}
                  onClick={() => void remove(file.name)}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
          <Note>
            {files.length} file{files.length === 1 ? '' : 's'}, {formatBytes(total)} total.
          </Note>
        </>
      )}
    </Group>
  );
}

/** `1.2 MB`, `340 KB`, `128 B` — always one decimal past kilobytes, never more precision than the number needs. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

function PluginsSection() {
  const { workspace, registryVersion } = useApp();
  const plugins = useMemo(() => workspace.plugins.list(), [workspace, registryVersion]);
  const views = useMemo(() => workspace.registry.views(), [workspace, registryVersion]);

  return (
    <>
      <Group title="Loaded">
        {plugins.length === 0 ? (
          <Note>Nothing loaded.</Note>
        ) : (
          <ul className="settings-list">
            {plugins.map((plugin) => (
              <li key={plugin.definition.id} data-error={Boolean(plugin.error) || undefined}>
                <div className="settings-list-main">
                  <strong>{plugin.definition.name}</strong>
                  <span className="settings-tag">{plugin.origin}</span>
                </div>
                <small>{plugin.error ?? plugin.definition.description ?? plugin.definition.id}</small>
              </li>
            ))}
          </ul>
        )}
      </Group>

      {views.length > 0 && (
        <Group title="Views contributed">
          <ul className="settings-list">
            {views.map((view) => (
              <li key={view.id}>
                <div className="settings-list-main">
                  <strong>{view.title}</strong>
                  <span className="settings-tag">{view.id}</span>
                </div>
              </li>
            ))}
          </ul>
        </Group>
      )}

      <Group title="Writing one">
        <Note>
          A plugin is a single ES module in <code>_plugins/</code> inside the space, so it travels
          with your notes. It can register commands, slash completions, inline markdown widgets and
          whole views, which the workbench will tile, window or rail exactly like the built-in ones.
          Save a file there and reload.
        </Note>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

function KeyboardSection() {
  const { workspace, registryVersion } = useApp();

  const grouped = useMemo(() => {
    const byCategory = new Map<string, Array<{ name: string; key?: string }>>();
    for (const command of workspace.registry.commands()) {
      const category = command.category ?? 'Other';
      const list = byCategory.get(category) ?? [];
      list.push({ name: command.name, key: command.key });
      byCategory.set(category, list);
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, registryVersion]);

  return (
    <>
      <Group title="Always available">
        <ul className="settings-keys">
          <Key combo={`${modKey}K`} name="Search pages and commands" />
          <Key combo="/" name="Slash commands, at the start of a line" />
          <Key combo="Esc" name="Dismiss whatever is in front" />
        </ul>
      </Group>

      {grouped.map(([category, commands]) => (
        <Group title={category} key={category}>
          <ul className="settings-keys">
            {commands.map((command) => (
              <Key
                key={command.name}
                name={command.name}
                combo={command.key ? prettyKey(command.key) : undefined}
              />
            ))}
          </ul>
        </Group>
      ))}
    </>
  );
}

function Key({ name, combo }: { name: string; combo?: string }) {
  return (
    <li>
      <span>{name}</span>
      {combo ? <kbd>{combo}</kbd> : <span className="settings-unbound">unbound</span>}
    </li>
  );
}

/** `Mod-Shift-t` reads as `⌘⇧T`, or `Ctrl+Shift+T` away from a Mac. */
function prettyKey(key: string): string {
  const parts = key.split('-');
  const main = parts.pop() ?? '';
  const mods = parts.map((part) => {
    const lower = part.toLowerCase();
    if (lower === 'mod' || lower === 'cmd' || lower === 'ctrl') return modKey;
    if (lower === 'shift') return modKey === '⌘' ? '⇧' : 'Shift+';
    if (lower === 'alt') return modKey === '⌘' ? '⌥' : 'Alt+';
    return part;
  });
  return `${mods.join('')}${main.length === 1 ? main.toUpperCase() : main}`;
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function AboutSection() {
  const { config, pages } = useApp();

  return (
    <>
      <Group title="Spark Notes">
        <Note>
          A folder of markdown files with an editor around it. Every page is a real file you can
          open in anything, and nothing about the app is needed to read your notes later.
        </Note>
        <Fact label="Space" value={config.spaceName} />
        <Fact label="Pages" value={String(pages.length)} />
      </Group>

      <Group title="Where things are kept">
        <Fact label="Notes" value="The space folder, as .md files" />
        <Fact label="Credentials" value=".spark/ — outside the space, never committed" />
        <Fact label="Conversations" value=".spark/chats/ — beside the credentials, not in your notes" />
        <Fact label="Preferences" value="This browser, in local storage" />
      </Group>

      <SettingsBackup />
    </>
  );
}

/**
 * Export, import and reset of the server-stored settings.
 *
 * What lives where: the AI configuration and keys, the Spark settings (your
 * name, instructions, presets), the GitHub OAuth app and the connected
 * account's token are all files in `.spark/` on the server — outside the
 * space, so they do not sync or commit with the notes. Moving to a new
 * machine therefore means re-entering them by hand, which is exactly what an
 * export is for: one JSON file with all four, secrets included, restored by
 * an import or read by hand.
 *
 * The export is deliberately raw — the stored files, as stored. There is no
 * redaction, because the point is a complete backup; handle the file the way
 * you would handle the key it contains.
 */
function SettingsBackup() {
  const { workspace, toast, refreshConfig } = useApp();
  const [busy, setBusy] = useState(false);

  const guard = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  // Reads the server's export and hands it to the browser's download
  // machinery. A download rather than a `navigator.clipboard` write because
  // the file is the artifact — a backup that lives in the paste buffer is
  // one keystroke away from being replaced by a URL.
  const exportSettings = () =>
    guard(async () => {
      const res = await fetch('/api/settings/export');
      if (!res.ok) throw new Error(`Could not export (${res.status}).`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `spark-settings-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast('Settings exported.', 'success');
    });

  const importSettings = () =>
    guard(async () => {
      const [file] = await chooseFiles({ accept: 'application/json,.json', multiple: false });
      if (!file) return;

      const confirmed = await workspace.ui.select(
        'Importing replaces the server\'s stored settings — AI configuration and keys, Spark settings, the GitHub app and the connected account. Continue?',
        ['Import', 'Cancel'],
      );
      if (confirmed !== 'Import') return;

      const parsed = JSON.parse(await file.text()) as object;
      const res = await fetch('/api/settings/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      if (!res.ok) throw new Error((await res.text()) || `Could not import (${res.status}).`);
      const report = (await res.json()) as { applied?: string[] };
      await refreshConfig();
      await workspace.sync.refresh();
      toast(
        report.applied?.length
          ? `Imported: ${report.applied.join(', ')}.`
          : 'Imported — nothing new to apply.',
        'success',
      );
    });

  const resetSettings = () =>
    guard(async () => {
      const confirmed = await workspace.ui.select(
        'Reset every server-stored setting? The AI configuration and keys, Spark settings, the GitHub app and the connected account are all forgotten. Your notes are untouched.',
        ['Reset', 'Cancel'],
      );
      if (confirmed !== 'Reset') return;
      await fetch('/api/settings/reset', { method: 'POST' });
      await refreshConfig();
      await workspace.sync.refresh();
      toast('Every server setting was reset.', 'success');
    });

  return (
    <Group title="Server settings">
      <Note>
        The provider configuration, keys, Spark settings and GitHub credentials live in{' '}
        <code>.spark/</code> on the server — outside the space, so they never sync with the notes
        or commit to git. An export bundles all four into one JSON file so a new machine is one
        import away; secrets are included, so keep the file the way you keep the key.
      </Note>
      <div className="settings-actions">
        <button className="button" data-variant="primary" disabled={busy} onClick={() => void exportSettings()}>
          {busy ? 'Working…' : 'Export settings'}
        </button>
        <button className="button" data-variant="ghost" disabled={busy} onClick={() => void importSettings()}>
          {busy ? 'Working…' : 'Import settings'}
        </button>
        <button className="button" data-variant="ghost" disabled={busy} onClick={() => void resetSettings()}>
          {busy ? 'Working…' : 'Reset settings'}
        </button>
      </div>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3 className="settings-group-title">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Prose that explains a group.
 *
 * It used to be a filled, bordered box, which read as a control — a preview, or
 * a disabled text field — sitting among the real ones. It is neither: it is the
 * paragraph you read before deciding. So it is set as prose, marked only by a
 * rule down its left edge, and it no longer competes with the things it is
 * describing.
 */
function Note({ children }: { children: ReactNode }) {
  return <p className="settings-note">{children}</p>;
}

/** Numbered setup steps, for the two places that need somebody walked through. */
function Steps({ children }: { children: ReactNode }) {
  return <ol className="settings-steps">{children}</ol>;
}

/**
 * A value the person has to copy somewhere else, shown as a value rather than
 * described in a sentence. Selecting it on click, because that is what it is for.
 */
function CopyValue({ label, value }: { label: string; value: string }) {
  const { toast } = useApp();
  return (
    <button
      className="settings-copy"
      title={`Copy ${label}`}
      aria-label={`Copy ${label}: ${value}`}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => toast('Copied.', 'success'))
          .catch(() => toast('Could not copy — select it by hand.', 'error'));
      }}
    >
      <code>{value}</code>
    </button>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-field">
      <div className="settings-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="settings-field">
      <div className="settings-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="settings-control">
        <button
          className="switch"
          role="switch"
          aria-checked={value}
          aria-label={label}
          onClick={() => onChange(!value)}
        >
          <span className="switch-knob" />
        </button>
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          className="segment"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The faces as icons.
 *
 * Not `Segmented`: the choice is about type, and four words set in the same
 * face as everything else say nothing about it. The glyph carries the idea and
 * the label underneath carries the name, which is what the tooltip repeats in
 * full for anyone who wants the typeface itself.
 */
function FontPicker({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: FontOption[];
  value: FontChoice;
  onChange: (value: FontChoice) => void;
}) {
  return (
    <div className="segmented" data-icons="true" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          className="segment"
          aria-pressed={value === option.value}
          aria-label={option.label}
          title={`${option.label} — ${option.hint}`}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          <span className="segment-label">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The themes, as miniatures.
 *
 * Not a dropdown of names: a palette is not a word, and twelve of them is not a
 * list you read. Each card is a small page in the theme it stands for — its
 * background, its ink, its rules, its accent, and its title face — which is the
 * only honest way to choose. The colours come from `[data-theme-swatch]` blocks
 * in the generated stylesheet, so a card is styled by exactly the pipeline that
 * styles the real thing rather than by a second one that can disagree with it.
 *
 * The name and the description sit *outside* the swatch, in the app's own
 * colours, because a label you cannot read is not a label.
 */
function ThemeGallery({
  themes,
  active,
  onChange,
}: {
  themes: ThemeDefinition[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="theme-gallery" role="radiogroup" aria-label="Theme">
      {themes.map((theme) => (
        <button
          key={theme.id}
          className="theme-card"
          role="radio"
          aria-checked={theme.id === active}
          title={theme.description ?? theme.name}
          onClick={() => onChange(theme.id)}
        >
          <span
            className="theme-card-page"
            data-theme-swatch={theme.id}
            data-font-sample={`theme:${theme.id}`}
            aria-hidden="true"
          >
            <span className="theme-card-title">Heading</span>
            <span className="theme-card-body">
              The quick brown fox jumps over the lazy dog, and keeps going.
            </span>
            <span className="theme-card-marks">
              <span className="theme-card-tag">#tag</span>
              <span className="theme-card-accent" />
            </span>
          </span>
          <span className="theme-card-name">{theme.name}</span>
          {theme.description && <small className="theme-card-hint">{theme.description}</small>}
        </button>
      ))}
    </div>
  );
}

/**
 * Which curated set a side of the app draws from.
 *
 * A native `<select>` rather than another gallery, and deliberately: this is a
 * *refinement* of a choice already made — you are in Curated, the question is
 * only whose pairing — and the result is already visible in the panel and in the
 * preview below it the moment you pick. The first entry defers to the theme,
 * which is what Curated means when nobody has said otherwise.
 *
 * Each option is set in its own face. `option` is one of the few elements a
 * browser will not let a stylesheet reach into on every platform, so this is a
 * hint rather than a guarantee — the name is there either way.
 */
function CuratedPicker({
  label,
  theme,
  packs,
  value,
  onChange,
}: {
  label: string;
  theme: ThemeDefinition | undefined;
  packs: FontPackDefinition[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const chosen = value === null ? undefined : packs.find((pack) => pack.id === value);
  const missing = value !== null && !chosen;

  return (
    <Field
      label={label}
      hint={
        missing
          ? `The pack this was set to (${value}) is not installed.`
          : (chosen?.description ??
            (theme
              ? `Whatever ${theme.name} was designed with. Pick a pack to override it.`
              : 'Pick a pack — no theme is installed to defer to.'))
      }
    >
      <select
        className="field select"
        value={value ?? ''}
        aria-label={label}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">
          {theme ? `From the theme — ${theme.name}` : 'From the theme'}
        </option>
        {missing && <option value={value}>{value} (not installed)</option>}
        {packs.map((pack) => (
          <option key={pack.id} value={pack.id} data-font-sample={`pack:${pack.id}`}>
            {pack.name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Slider({
  range,
  value,
  label,
  onChange,
}: {
  range: { min: number; max: number; step: number };
  value: number;
  label: string;
  onChange: (value: number) => void;
}) {
  return (
    <input
      className="slider"
      type="range"
      min={range.min}
      max={range.max}
      step={range.step}
      value={value}
      aria-label={label}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
