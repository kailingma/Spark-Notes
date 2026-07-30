import type { SettingsApi } from '@spark/plugin-sdk';

/**
 * Appearance, as a single piece of device-local state.
 *
 * Kept together rather than as six unrelated settings because they are read
 * and written together: the settings page edits one object, and `applyAppearance`
 * is the only thing that touches the document element. Nothing here is synced —
 * the font you read in is a property of the screen you're at, not of the notes.
 */

export type ThemeMode = 'system' | 'light' | 'dark';

/**
 * A face, chosen twice: once for the document and once for everything around
 * it. Code stays monospaced in every one of them.
 *
 * Sans and serif resolve to different typefaces on the two sides — the reading
 * modes get faces drawn for prose, the interface gets IBM Plex, which was drawn
 * for chrome. Mono is the one face both sides share, because there is only one
 * good reason to set an interface in a monospace and it is that you want the
 * whole screen to look like the editor.
 */
export type FontMode = 'sans' | 'serif' | 'mono';

/**
 * The three named faces, plus the one that defers.
 *
 * **Curated** means "whatever this was designed to be read in": the theme's own
 * pairing, or a font pack chosen beside it. It is the only mode in which a
 * theme's typography — a display face, a stretched italic title, an optical
 * axis — reaches the page, and that is deliberate. Choosing Sans is a person
 * saying they want a sans, and a theme overruling that would make the named
 * modes mean nothing.
 */
export type FontChoice = FontMode | 'curated';

/**
 * How much workbench there is.
 *
 * `workbench` is the full thing: tabs, splits, floating windows, drag and snap.
 * `classic` keeps two of the four surfaces — one `tab` filling the editor area
 * and the `sidebar` rails either side of it — plus `modal` for Settings, which
 * has nowhere else to go. Everything you open replaces what you were reading,
 * the way a single-document editor has always worked.
 *
 * It lives in appearance rather than preferences because it is a property of
 * the screen you are at, and because it changes the shape of the app before
 * anything is rendered into it.
 */
export type LayoutMode = 'workbench' | 'classic';

export interface Appearance {
  /** Light, dark, or whatever the machine says. */
  theme: ThemeMode;
  /**
   * The palette, by theme id. A theme that is not registered — its plugin is
   * gone, or has not loaded yet — leaves the app on its own tokens *without*
   * this being rewritten, so a theme comes back when its plugin does.
   */
  themeId: string;
  /** The face a document is set in. */
  font: FontChoice;
  /**
   * Which curated set the document draws from: `null` is the theme's own
   * pairing, a string names a registered font pack. Kept while another mode is
   * selected, so switching to Curated and back does not lose the choice.
   */
  fontPack: string | null;
  /** Editor text size in px. */
  fontSize: number;
  /** The face everything outside a document is set in. */
  uiFont: FontChoice;
  /** The curated set the chrome draws from. Independent of `fontPack`. */
  uiFontPack: string | null;
  /** The root font size in px, which every other rem in the app follows. */
  uiFontSize: number;
  layout: LayoutMode;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'system',
  themeId: 'spark',
  font: 'sans',
  fontPack: null,
  fontSize: 17,
  uiFont: 'sans',
  uiFontPack: null,
  uiFontSize: 16,
  layout: 'workbench',
};

export const FONT_SIZE_RANGE = { min: 13, max: 24, step: 1 } as const;

/**
 * A fifth of a pixel, because the interface is sized in rem: a step that looks
 * absurdly fine on the number is a normal step on a 0.75rem label, and the
 * distance between a chrome that feels right and one that feels off is smaller
 * than a whole pixel at the root.
 */
export const UI_FONT_SIZE_RANGE = { min: 12, max: 20, step: 0.2 } as const;

/**
 * Pushes the appearance onto `:root`, where both the React shell and the
 * CodeMirror theme read it. This is the only writer of the document element —
 * everything else changes the object and lets this run.
 *
 * The palette itself is a generated stylesheet rather than attributes, and lives
 * in `lib/theme.ts`. The two are the only things that decide how the app looks,
 * and they touch nothing of each other's: this one owns `:root`'s attributes and
 * the two sizes, that one owns `<style id="spark-theme">`.
 */
export function applyAppearance(appearance: Appearance): void {
  const root = document.documentElement;

  // Absent means "follow the OS", which is what the media query already does.
  if (appearance.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = appearance.theme;

  root.dataset.font = appearance.font;
  root.dataset.uiFont = appearance.uiFont;
  root.dataset.layout = appearance.layout;
  // Not read by any rule the app ships. It is here so a theme can hang its own
  // CSS off `:root[data-theme-id='…']`, and so what you are wearing is visible
  // in the inspector without going through local storage.
  root.dataset.themeId = appearance.themeId;
  root.style.setProperty('--editor-font-size', `${clamp(appearance.fontSize, FONT_SIZE_RANGE)}px`);
  root.style.setProperty('--ui-font-size', `${snapUiFontSize(appearance.uiFontSize)}px`);
}

/** The interface size as it is written: clamped, and snapped to whole steps. */
export function snapUiFontSize(value: number): number {
  const clamped = clamp(value, UI_FONT_SIZE_RANGE);
  // A fifth is not a binary fraction: 78 × 0.2 is 15.600000000000001, and the
  // label would show every digit of it. One decimal place is the whole grid.
  return Number((Math.round(clamped / UI_FONT_SIZE_RANGE.step) * UI_FONT_SIZE_RANGE.step).toFixed(1));
}

/** Reads the stored appearance, filling in anything missing or out of range. */
export function loadAppearance(settings: SettingsApi): Appearance {
  const stored = settings.get<Partial<Appearance> & { uiScale?: unknown }>('app.appearance', {});

  // The theme predates this object and was stored on its own; honour the old
  // key so nobody's setting is quietly reset by upgrading.
  const legacyTheme = settings.get<ThemeMode | null>('app.theme', null);

  // The interface used to be sized as a multiplier on a 16px root, and to be
  // set in whatever face the document was. Carry both forward: an interface
  // that silently resizes or reletters itself on upgrade is the one change a
  // reader notices immediately and cannot explain.
  const legacyScale = typeof stored.uiScale === 'number' ? stored.uiScale * 16 : null;

  return {
    theme: isTheme(stored.theme) ? stored.theme : (legacyTheme ?? DEFAULT_APPEARANCE.theme),
    themeId: isId(stored.themeId) ? stored.themeId : DEFAULT_APPEARANCE.themeId,
    font: isFont(stored.font) ? stored.font : DEFAULT_APPEARANCE.font,
    fontPack: isId(stored.fontPack) ? stored.fontPack : null,
    fontSize: clamp(numberOr(stored.fontSize, DEFAULT_APPEARANCE.fontSize), FONT_SIZE_RANGE),
    uiFont: isFont(stored.uiFont)
      ? stored.uiFont
      : isFont(stored.font)
        ? stored.font
        : DEFAULT_APPEARANCE.uiFont,
    uiFontPack: isId(stored.uiFontPack) ? stored.uiFontPack : null,
    uiFontSize: snapUiFontSize(
      numberOr(stored.uiFontSize, legacyScale ?? DEFAULT_APPEARANCE.uiFontSize),
    ),
    layout: isLayout(stored.layout) ? stored.layout : DEFAULT_APPEARANCE.layout,
  };
}

export function saveAppearance(settings: SettingsApi, appearance: Appearance): void {
  settings.set('app.appearance', appearance);
  // Kept in step for the sake of anything still reading the original key.
  settings.set('app.theme', appearance.theme);
}

function isTheme(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isFont(value: unknown): value is FontChoice {
  return value === 'sans' || value === 'serif' || value === 'mono' || value === 'curated';
}

/**
 * A theme or font pack id, as stored.
 *
 * Only the shape is checked, never whether anything by that name is registered:
 * plugins load after the appearance does, and a boot that "corrected" the id to
 * the default would lose the theme every time a space plugin was a moment slow.
 */
function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 120;
}

function isLayout(value: unknown): value is LayoutMode {
  return value === 'workbench' || value === 'classic';
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(Math.max(value, range.min), range.max);
}
