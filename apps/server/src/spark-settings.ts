import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import {
  SEARCH_PROVIDERS,
  emptySearchProviders,
  providerReady,
  type SearchProviderConfig,
  type SearchProviderId,
  type SearchProviderMeta,
  type SearchProviders,
} from './search-providers.js';

/**
 * The half of Spark's configuration that is about *you* rather than about a
 * provider.
 *
 * Kept apart from `ai-settings.ts` on purpose. That file holds a credential and
 * is redacted on the way out; this one holds your name, your standing
 * instructions and the model presets you named, all of which the browser is
 * meant to read back and edit. Merging them would mean either sending a key to
 * the settings page or making the settings page unable to show what it saved.
 *
 * It still lives in `.spark/` rather than in the space: custom instructions are
 * configuration of the app, not a note, and a file the page list would show is a
 * file that turns up in search results for its own contents. Memory is the
 * opposite call for the opposite reason — see `memory.ts`.
 */

/** How a mode is represented in the switcher. */
export type IconKind = 'emoji' | 'lucide';

export interface SparkMode {
  /** Stable across renames, because a preference stores this. */
  id: string;
  label: string;
  /**
   * An emoji, or the name of an icon in the app's own set.
   *
   * Two kinds rather than one because neither covers the other: an emoji is
   * instantly personal and needs no vocabulary, and a lucide glyph is the only
   * thing that will sit in a row of chrome without looking pasted on.
   */
  icon: string;
  iconKind: IconKind;
  /** Model id, exactly as the provider names it. Empty means the default one. */
  model: string;
  /**
   * Thinking budget in tokens, for models that support it. Zero means off.
   *
   * Part of the mode rather than a separate switch because it is the same
   * decision: "quality" means a bigger model *and* room to think, and asking
   * someone to set two controls in step is asking them to get it wrong.
   */
  thinking: number;
  enabled: boolean;
  /**
   * Which configured AI provider profile answers this mode — an id into
   * `ai-settings.ts`'s `AiProviderProfile` list. Empty means the profile
   * marked default, the same "absence is a real state" rule the rest of
   * this file follows: a mode that has never been pointed anywhere
   * explicit should keep working exactly as it did before profiles
   * existed, which is "whatever is configured."
   */
  providerId: string;
  /**
   * A second profile to try if the primary fails before any content has
   * streamed — a dropped connection, a rate limit exhausted after retrying,
   * the profile itself deleted. Empty means no fallback: the turn fails
   * outright, the same as today. See `runSpark`'s round-0 fallback in
   * `spark.ts`.
   */
  fallbackProviderId: string;
}

/**
 * A background pass that runs without a live turn — see `proactive.ts`.
 *
 * Off by default, the same reasoning as `deepMemory`: this is the one place
 * the app is allowed to look at your notes without being asked, so opting in
 * has to be a real, deliberate choice rather than a shipped default.
 */
export interface ProactiveScanSettings {
  enabled: boolean;
  /** How long since the last scan before another is due. */
  intervalHours: number;
}

export interface SparkSettings {
  /** What Spark should call you. Empty means it does not use a name. */
  userName: string;
  /** Standing instructions, injected at the top of the system prompt. */
  instructions: string;
  modes: SparkMode[];
  /** Id of the mode in force. Falls back to the first enabled one. */
  activeMode: string;
  /** Whether the web search tool is offered at all. */
  webSearch: boolean;
  /** Which engine web search uses, when it is on. */
  activeSearchProvider: SearchProviderId;
  /**
   * A second engine to try if the active one errors or rate-limits — the
   * same "primary, then fallback" shape `SparkMode.fallbackProviderId` gives
   * the AI provider. Empty means no fallback: a search failure is reported
   * as one, same as before this existed. See `web-search.ts`'s `webSearch`.
   */
  fallbackSearchProvider: SearchProviderId | '';
  /** Per-engine keys and endpoints. The keys never leave the server. */
  searchProviders: SearchProviders;
  /**
   * Whether the memory consolidation pass also searches *other*
   * conversations for material related to the current one, promoting what
   * it finds into the pass's own prompt. Off by default — it changes what
   * an automatic pass does, so it isn't silently on. BM25 only, never
   * embeddings, so opting in never adds a cost to a pass that already runs
   * synchronously inside a turn. See `memory.ts`'s `consolidate()`.
   */
  deepMemory: boolean;
  /** A narrow, opt-in background scan for overdue threads and unresolved questions. See `proactive.ts`. */
  proactiveScan: ProactiveScanSettings;
}

/** The view the browser gets: exactly one omitted field — the keys. */
export interface PublicSparkSettings extends Omit<SparkSettings, 'searchProviders'> {
  searchProviders: Array<SearchProviderMeta & { hasKey: boolean; endpoint: string }>;
  /** True when web search can actually run with the current selection. */
  webSearchReady: boolean;
}

/**
 * The three modes the app ships with.
 *
 * Named for what you get rather than for a model, because the model behind
 * "quality" changes every few months and the reason you reached for it does not.
 * Models are left blank for the OpenAI-compatible provider, where the long tail
 * of servers makes any guess wrong for most people; on Anthropic the ids are
 * known, so they are filled in and the preset works the moment you see it.
 */
export function defaultModes(provider: 'anthropic' | 'openai'): SparkMode[] {
  const anthropic = provider === 'anthropic';
  return [
    {
      id: 'fast',
      label: 'Fast',
      icon: 'Zap',
      iconKind: 'lucide',
      model: anthropic ? 'claude-haiku-4-5-20251001' : '',
      thinking: 0,
      enabled: true,
      providerId: '',
      fallbackProviderId: '',
    },
    {
      id: 'balanced',
      label: 'Balanced',
      icon: 'Scale',
      iconKind: 'lucide',
      model: anthropic ? 'claude-sonnet-5' : '',
      thinking: 0,
      enabled: true,
      providerId: '',
      fallbackProviderId: '',
    },
    {
      id: 'quality',
      label: 'Quality',
      icon: 'Gem',
      iconKind: 'lucide',
      model: anthropic ? 'claude-opus-5' : '',
      thinking: 8192,
      enabled: true,
      providerId: '',
      fallbackProviderId: '',
    },
  ];
}

const MAX_MODES = 12;
const MAX_INSTRUCTIONS = 8000;

export class SparkSettingsStore {
  #stored: SparkSettings | null = null;
  #loaded = false;

  get #file(): string {
    return join(config.stateDir, 'spark.json');
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as Partial<SparkSettings>;
      this.#stored = normalize(parsed);
    } catch {
      this.#stored = null;
    }
  }

  /** The settings in force. Defaults are computed, never written on read. */
  get(provider: 'anthropic' | 'openai' = 'openai'): SparkSettings {
    if (this.#stored) {
      // Modes are defaulted here rather than in `normalize`, because the right
      // default depends on the provider and the provider can change after this
      // file was written.
      return this.#stored.modes.length > 0
        ? this.#stored
        : { ...this.#stored, modes: defaultModes(provider) };
    }
    const providers = emptySearchProviders();
    // The one thing an env var can seed: the Exa key, for the default engine.
    providers.exa.key = config.spark.exaKey;
    return {
      userName: config.spark.userName,
      instructions: config.spark.instructions,
      modes: defaultModes(provider),
      activeMode: 'balanced',
      webSearch: true,
      activeSearchProvider: 'exa',
      fallbackSearchProvider: '',
      searchProviders: providers,
      deepMemory: false,
      proactiveScan: { enabled: false, intervalHours: DEFAULT_SCAN_INTERVAL_HOURS },
    };
  }

  /** The mode in force, resolved through "enabled" and through a stale id. */
  modeFor(provider: 'anthropic' | 'openai', id?: string): SparkMode | null {
    const settings = this.get(provider);
    const enabled = settings.modes.filter((mode) => mode.enabled);
    if (enabled.length === 0) return null;
    return (
      enabled.find((mode) => mode.id === (id ?? settings.activeMode)) ??
      enabled.find((mode) => mode.id === settings.activeMode) ??
      enabled[0]
    );
  }

  publicView(provider: 'anthropic' | 'openai' = 'openai'): PublicSparkSettings {
    const settings = this.get(provider);
    const { searchProviders, ...rest } = settings;
    return {
      ...rest,
      webSearchReady:
        settings.webSearch && providerReady(searchProviders, settings.activeSearchProvider),
      searchProviders: SEARCH_PROVIDERS.map((meta) => ({
        ...meta,
        // The browser learns *that* a key exists, never the key itself.
        hasKey: searchProviders[meta.id].key.trim().length > 0,
        endpoint: searchProviders[meta.id].endpoint,
      })),
    };
  }

  /**
   * Writes new settings.
   *
   * The same rule as `ai-settings.ts`: an absent field means "leave it alone",
   * and an empty string is a real value. Merged field by field rather than with a
   * spread, because a spread copies keys whose value is `undefined` and that is
   * how a partial save silently wipes something.
   */
  async save(patch: Partial<SparkSettings>, provider: 'anthropic' | 'openai' = 'openai'): Promise<void> {
    const current = this.get(provider);
    const next = normalize({
      userName: patch.userName ?? current.userName,
      instructions: patch.instructions ?? current.instructions,
      modes: patch.modes ?? current.modes,
      activeMode: patch.activeMode ?? current.activeMode,
      webSearch: patch.webSearch ?? current.webSearch,
      activeSearchProvider: patch.activeSearchProvider ?? current.activeSearchProvider,
      fallbackSearchProvider: patch.fallbackSearchProvider ?? current.fallbackSearchProvider,
      deepMemory: patch.deepMemory ?? current.deepMemory,
      proactiveScan: patch.proactiveScan ?? current.proactiveScan,
      // Merged against current, so saving one provider's key never wipes the
      // keys of the other four the panel happened not to touch.
      searchProviders: normalizeSearchProviders(patch.searchProviders, current.searchProviders),
    });

    this.#stored = next;
    await mkdir(config.stateDir, { recursive: true });
    await writeFile(this.#file, JSON.stringify(next, null, 2), {
      encoding: 'utf8',
      // Mode 0600 because search keys live in here, alongside the same
      // reasoning as every other file in this directory.
      mode: 0o600,
    });
  }

  /** Forgets everything stored — used by the settings reset. */
  async clear(): Promise<void> {
    this.#stored = null;
    try {
      await writeFile(this.#file, 'null', { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* nothing to clear */
    }
  }
}

export const sparkSettings = new SparkSettingsStore();

// ---------------------------------------------------------------------------

function normalize(raw: Partial<SparkSettings>): SparkSettings {
  const modes = Array.isArray(raw.modes)
    ? raw.modes.slice(0, MAX_MODES).map(normalizeMode).filter((mode): mode is SparkMode => mode !== null)
    : [];

  return {
    userName: oneLine(raw.userName ?? '', 80),
    instructions: (raw.instructions ?? '').slice(0, MAX_INSTRUCTIONS).trimEnd(),
    modes,
    activeMode: oneLine(raw.activeMode ?? '', 40),
    webSearch: raw.webSearch !== false,
    activeSearchProvider: isProviderId(raw.activeSearchProvider) ? raw.activeSearchProvider : 'exa',
    fallbackSearchProvider: isProviderId(raw.fallbackSearchProvider) ? raw.fallbackSearchProvider : '',
    searchProviders: normalizeSearchProviders(raw.searchProviders),
    deepMemory: raw.deepMemory === true,
    proactiveScan: normalizeProactiveScan(raw.proactiveScan),
  };
}

const DEFAULT_SCAN_INTERVAL_HOURS = 24;

function normalizeProactiveScan(raw: unknown): ProactiveScanSettings {
  const value = raw && typeof raw === 'object' ? (raw as Partial<ProactiveScanSettings>) : {};
  const hours = Number(value.intervalHours);
  return {
    enabled: value.enabled === true,
    intervalHours: Number.isFinite(hours) && hours > 0 ? Math.min(Math.max(hours, 1), 24 * 30) : DEFAULT_SCAN_INTERVAL_HOURS,
  };
}

const SEARCH_MAX = 500;

function isProviderId(id: unknown): id is SearchProviderId {
  return typeof id === 'string' && SEARCH_PROVIDERS.some((p) => p.id === id);
}

/**
 * Normalise the per-provider key/endpoint map. Anything that is not a string,
 * or is garbage, becomes empty — a provider that gets configured is configured
 * deliberately, and a stray object must not half-wire itself.
 *
 * When `base` is given, providers the input does not mention are kept from it
 * rather than emptied — that is how a partial save of one provider leaves the
 * others alone.
 */
function normalizeSearchProviders(
  raw: unknown,
  base: SearchProviders = emptySearchProviders(),
): SearchProviders {
  const out = emptySearchProviders();
  for (const meta of SEARCH_PROVIDERS) {
    out[meta.id] = {
      key: (base[meta.id]?.key ?? '').trim(),
      endpoint: (base[meta.id]?.endpoint ?? '').trim(),
    };
  }
  if (raw && typeof raw === 'object') {
    const src = raw as Record<string, unknown>;
    for (const meta of SEARCH_PROVIDERS) {
      const entry = src[meta.id];
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Partial<SearchProviderConfig>;
      if (typeof e.key === 'string') out[meta.id].key = e.key.trim().slice(0, SEARCH_MAX);
      if (typeof e.endpoint === 'string') out[meta.id].endpoint = e.endpoint.trim().slice(0, SEARCH_MAX);
    }
    // Files written before providers existed carry a single Exa key; that key
    // now belongs to the Exa provider and exactly one of them.
    const legacy = src.exaKey;
    if (!out.exa.key && typeof legacy === 'string' && legacy.trim()) {
      out.exa.key = legacy.trim().slice(0, SEARCH_MAX);
    }
  }
  return out;
}

function normalizeMode(raw: unknown): SparkMode | null {
  if (!raw || typeof raw !== 'object') return null;
  const mode = raw as Partial<SparkMode>;
  const id = oneLine(mode.id ?? '', 40).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const label = oneLine(mode.label ?? '', 40);
  if (!id || !label) return null;

  return {
    id,
    label,
    // An emoji is trimmed to two code points: a mode is one glyph in a row of
    // chrome, and someone pasting a sentence in here should get a glyph, not a
    // broken layout.
    icon: mode.iconKind === 'emoji' ? [...oneLine(mode.icon ?? '', 16)].slice(0, 2).join('') : oneLine(mode.icon ?? '', 40),
    iconKind: mode.iconKind === 'emoji' ? 'emoji' : 'lucide',
    model: oneLine(mode.model ?? '', 120),
    thinking: clampThinking(Number(mode.thinking) || 0),
    enabled: mode.enabled !== false,
    providerId: oneLine(mode.providerId ?? '', 80),
    fallbackProviderId: oneLine(mode.fallbackProviderId ?? '', 80),
  };
}

/**
 * A thinking budget the providers will actually accept.
 *
 * Zero is off. Anything else is floored at 1024, which is Anthropic's minimum —
 * a budget of 200 is rejected outright, and silently sending it would turn
 * "think a bit" into a failed turn.
 */
function clampThinking(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.max(Math.round(value), 1024), 32_000);
}

function oneLine(text: string, limit: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, limit);
}
