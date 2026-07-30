import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AiConfig, AiProvider, GitHubAppConfig, GitStatus } from '@spark/core';
import type { FontPackDefinition, ThemeDefinition } from '@spark/plugin-sdk';
import { useApp } from '../app-context';
import {
  AppearanceIcon,
  CuratedIcon,
  GeneralIcon,
  InfoIcon,
  KeyboardIcon,
  MonoIcon,
  PenIcon,
  PluginIcon,
  SansIcon,
  SerifIcon,
  SparkIcon,
  SyncIcon,
} from '../components/Icons';
import { modKey } from '../lib/device';
import { CAPTURE_MODES } from '../lib/modes';
import { AUTOSAVE_RANGE, HISTORY_RANGE, MEASURE_RANGE } from '../lib/preferences';
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
        <div className="settings-panel-body">{current.render()}</div>
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
  const { preferences, setPreferences } = useApp();

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

      <Group title="Windows">
        <Note>
          Tiles and floating windows belong to the session that built them. A reload always returns
          you to a single tile showing the page in the address bar, which is also what makes
          reloading a reliable way out of a layout that has got away from you. If you would rather
          not have them at all, Appearance → Layout has a classic mode.
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
  const {
    workspace,
    toast,
    refreshConfig,
    preferences,
    setPreferences,
    config: server,
  } = useApp();

  const [config, setConfig] = useState<AiConfig | null>(null);
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState('');
  const [endpoint, setEndpoint] = useState('');
  // Empty means "leave the stored key alone" — the real one is never sent here,
  // so there is nothing to prefill it with.
  const [apiKey, setApiKey] = useState('');
  const [embedModel, setEmbedModel] = useState('');
  const [embedEndpoint, setEmbedEndpoint] = useState('');
  const [embedKey, setEmbedKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    void workspace.ai
      .config()
      .then((loaded) => {
        if (cancelled) return;
        setConfig(loaded);
        setProvider(loaded.provider);
        setModel(loaded.model);
        setEndpoint(loaded.endpoint);
        setEmbedModel(loaded.embedModel);
        setEmbedEndpoint(loaded.embedEndpoint);
      })
      .catch(() => {
        /* the server is unreachable; the form stays on its defaults */
      });

    void fetch('/api/spark/tools')
      .then((res) => (res.ok ? (res.json() as Promise<ToolInfo[]>) : []))
      .then((loaded) => {
        if (!cancelled) setTools(loaded);
      })
      .catch(() => setTools([]));

    return () => {
      cancelled = true;
    };
  }, [workspace]);

  const save = async () => {
    setBusy(true);
    setTest(null);
    try {
      const saved = await workspace.ai.saveConfig({
        provider,
        model: model.trim(),
        endpoint: endpoint.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        embedModel: embedModel.trim(),
        embedEndpoint: embedEndpoint.trim(),
        ...(embedKey.trim() ? { embedKey: embedKey.trim() } : {}),
      });
      setConfig(saved);
      setApiKey('');
      setEmbedKey('');
      // Spark is gated on the server's own view of whether a key exists, so the
      // app has to re-ask rather than assume.
      await refreshConfig();
      toast('Saved.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Tests what is in the form, not what is on disk.
   *
   * Pressing this is how you find out whether the model and key in front of you
   * work — usually *before* they replace ones that already do. Testing the
   * stored settings would answer the opposite question, and would force people
   * to save an untested credential over a working one to find out.
   */
  const runTest = async () => {
    setBusy(true);
    setTest('Asking…');
    try {
      const result = await workspace.ai.test({
        provider,
        model: model.trim(),
        endpoint: endpoint.trim(),
        // Empty means "I did not retype it"; the server keeps the stored key.
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setTest(result.ok ? `Working — ${result.model} replied.` : (result.error ?? 'Failed.'));
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    const confirmed = await workspace.ui.select('Forget the stored key?', ['Forget', 'Cancel']);
    if (confirmed !== 'Forget') return;
    setBusy(true);
    try {
      const cleared = await workspace.ai.clearConfig();
      setConfig(cleared);
      setProvider(cleared.provider);
      setModel(cleared.model);
      setEndpoint(cleared.endpoint);
      setEmbedModel(cleared.embedModel);
      setEmbedEndpoint(cleared.embedEndpoint);
      setEmbedKey('');
      setTest(null);
      await refreshConfig();
      toast('Forgotten.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const allowed = (tool: ToolInfo) =>
    tool.needs === null ||
    (tool.needs === 'write' && preferences.sparkCanWrite) ||
    (tool.needs === 'destroy' && preferences.sparkCanDestroy) ||
    (tool.needs === 'remember' && preferences.sparkRemembers) ||
    (tool.needs === 'run' && preferences.sparkCanRun);

  return (
    <>
      <Group title="What Spark may do">
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

      <Group title="Provider">
        <Note>
          The key is stored on the server, in <code>.spark/ai.json</code> at mode 0600 — outside
          the space, so it is never committed or pushed by sync. The browser is only ever told
          that a key exists, never what it is.
        </Note>

        <Field label="Provider" hint={PROVIDERS.find((entry) => entry.value === provider)?.hint}>
          <Segmented options={PROVIDERS} value={provider} onChange={setProvider} />
        </Field>

        <Field label="Model">
          <input
            className="field"
            value={model}
            placeholder={provider === 'anthropic' ? 'claude-opus-5' : 'gpt-5'}
            onChange={(event) => setModel(event.target.value)}
            aria-label="Model"
            spellCheck={false}
          />
        </Field>

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
            config?.hasKey
              ? `A key ending …${config.keyHint} is set${config.source === 'env' ? ', from the server environment' : ''}. Type a new one to replace it.`
              : 'No key set. A local runtime may not need one.'
          }
        >
          <input
            className="field"
            type="password"
            value={apiKey}
            placeholder={config?.hasKey ? '••••••••' : 'sk-…'}
            onChange={(event) => setApiKey(event.target.value)}
            aria-label="API key"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

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
          {config?.source === 'stored' && (
            <button className="button" data-variant="ghost" disabled={busy} onClick={() => void forget()}>
              Forget key
            </button>
          )}
        </div>

        {test && <p className="settings-result">{test}</p>}
      </Group>

      <Group title="Search by meaning">
        <Note>
          Spark can always search your notes by <em>words</em>; that needs nothing set up. Naming an
          embedding model here lets it also search by <em>meaning</em>, so &ldquo;what did I decide
          about pricing&rdquo; finds the paragraph that never says pricing. Anthropic serves no
          embeddings, so this is a separate model even when Claude is answering — an OpenAI one, or a
          local runtime, whichever you would rather your notes went to.
        </Note>

        <Field
          label="Embedding model"
          hint={
            server.embeddings
              ? 'On. Passages are embedded as they are searched and cached in .spark/embeddings.json.'
              : 'Blank means text matching only, which is a perfectly good state to leave this in.'
          }
        >
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
            config?.hasEmbedKey
              ? 'A separate key is set. Type a new one to replace it.'
              : 'Blank reuses the API key above.'
          }
        >
          <input
            className="field"
            type="password"
            value={embedKey}
            placeholder={config?.hasEmbedKey ? '••••••••' : 'same as above'}
            onChange={(event) => setEmbedKey(event.target.value)}
            aria-label="Embedding key"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <div className="settings-actions">
          <button className="button" data-variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Working…' : 'Save'}
          </button>
          <button
            className="button"
            data-variant="ghost"
            disabled={busy}
            title="The vectors are keyed by the text they describe, so nothing is lost — the next search re-embeds what it needs."
            onClick={async () => {
              await fetch('/api/ai/embeddings/clear', { method: 'POST' });
              toast('Cached vectors cleared.', 'success');
            }}
          >
            Clear cache
          </button>
        </div>
      </Group>
    </>
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
          An empty repository is fine — the first sync pushes what is already in your space. A
          private one is the usual choice.
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
    </>
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
