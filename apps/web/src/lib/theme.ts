import type {
  FontFaceDeclaration,
  FontPackDefinition,
  FontRoles,
  ThemeDefinition,
  ThemeScheme,
  ThemeToken,
  ThemeTokens,
} from '@spark/plugin-sdk';
import type { Appearance } from './appearance';

/**
 * Themes, as one generated stylesheet.
 *
 * A theme is data — a bag of design tokens, plus the typography it was designed
 * with — and this is the only thing that turns it into CSS. It is the sole
 * writer of `<style id="spark-theme">`, the way `applyAppearance` is the sole
 * writer of the document element's attributes. Between them those two functions
 * are the whole of "what the app looks like"; nothing else touches either.
 *
 * Three decisions carry most of the weight:
 *
 * - **Tokens are whitelisted and values are sanitised.** A plugin already runs
 *   arbitrary JavaScript, so this is not a security boundary — it is a
 *   *robustness* one. One stray `}` in a token value would swallow every rule
 *   after it and leave the app looking broken with nothing in the console to
 *   explain it, and a mistyped token name would silently do nothing. Both are
 *   now caught and reported.
 * - **The generated rules out-specify `tokens.css` rather than relying on
 *   document order.** See `SCOPE` below.
 * - **The result is cached in `localStorage` for the inline script in
 *   `index.html` to re-inject before first paint.** Themes arrive with the
 *   plugins, which is hundreds of milliseconds after the first frame; without
 *   the cache every reload flashes the default palette on the way to yours.
 */

/** Where the cached stylesheet lives, and the element that carries it. */
const CACHE_KEY = 'spark:app.themeCss';
const STYLE_ELEMENT_ID = 'spark-theme';

/** Beyond this a cached stylesheet is not worth a synchronous read at boot. */
const CACHE_LIMIT = 256 * 1024;

/**
 * The document element, three times over.
 *
 * `tokens.css` reaches `(0,2,0)` at its most specific (`:root[data-theme]`), and
 * a generated stylesheet appended to `<head>` at runtime is *not* reliably after
 * the bundle's own `<link>` — the inline script in `index.html` injects the
 * cached copy before Vite's stylesheet exists at all. Repeating `:root` lifts
 * every generated rule clear of that whole file, so the outcome no longer
 * depends on which stylesheet happens to land second.
 *
 * The four blocks below then keep `tokens.css`'s own ordering among themselves:
 * default, OS-dark, explicit-light, explicit-dark, each beating the last exactly
 * where it should.
 */
const SCOPE = ':root:root:root';

// ---------------------------------------------------------------------------
// The token whitelist
// ---------------------------------------------------------------------------

/**
 * Every token a theme may set. Kept as a `Set` of the SDK's own union so the
 * two cannot drift: a token added to `ThemeToken` and not to this list fails to
 * typecheck.
 */
const THEME_TOKENS: ReadonlySet<ThemeToken> = new Set<ThemeToken>([
  'bg',
  'surface',
  'surface-raised',
  'surface-sunken',
  'text',
  'text-muted',
  'text-faint',
  'text-faintest',
  'rule',
  'rule-strong',
  'accent',
  'accent-soft',
  'accent-faint',
  'accent-contrast',
  'selection',
  'selection-match',
  'highlight-bg',
  'tag',
  'tag-soft',
  'search-match',
  'search-match-active',
  'code-bg',
  'code-text',
  'code-inline-bg',
  'code-inline-border',
  'danger',
  'success',
  'syn-keyword',
  'syn-string',
  'syn-number',
  'syn-function',
  'syn-type',
  'syn-property',
  'syn-operator',
  'scrollbar',
  'scrollbar-hover',
  'shadow-sm',
  'shadow-md',
  'shadow-lg',
  'radius-sm',
  'radius',
  'radius-lg',
  'gutter',
  'editor-line-height',
  'font-sans',
  'font-serif',
  'font-mono',
  'font-display',
  'font-ui-sans',
  'font-ui-serif',
]);

/**
 * The tokens a theme card is drawn with.
 *
 * A card is a *miniature of the theme*, not a row of swatches beside its name:
 * the only way to choose between twelve palettes is to see each one behaving as
 * a page with text and an accent on it. So the theme's own values for these are
 * scoped to the card, and the card's CSS then reads `var(--bg)` and `var(--text)`
 * exactly as the app does.
 *
 * A subset, because the whole set four times over is 60 kB of generated CSS for
 * a preview. It is closed under the built-in themes' own derivations, which is
 * what matters: a `color-mix(… var(--text) …)` inside a card still resolves
 * against the card's theme. A third-party theme deriving a listed token from an
 * unlisted one gets the active theme's value for that one in its preview only.
 */
const PREVIEW_TOKENS: readonly ThemeToken[] = [
  'bg',
  'surface',
  'surface-raised',
  'surface-sunken',
  'text',
  'text-muted',
  'text-faint',
  'text-faintest',
  'rule',
  'rule-strong',
  'accent',
  'accent-soft',
  'accent-faint',
  'accent-contrast',
  'tag',
  'tag-soft',
  'code-bg',
  'code-inline-bg',
  'radius-sm',
  'radius',
  'radius-lg',
];

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

export interface ResolvedFonts extends FontRoles {
  /** Where these roles came from, for the settings panel to name. */
  source: string;
}

/**
 * The tokens a theme contributes for one scheme.
 *
 * A theme that provides only one scheme wears it in both. The alternative —
 * falling through to the app's own palette for the missing half — mixes a dark
 * background with light text and produces something neither the theme's author
 * nor the reader asked for. A single-scheme theme ignoring the light/dark
 * toggle is at least a thing you can see and understand.
 */
function schemeTokens(theme: ThemeDefinition, scheme: ThemeScheme): ThemeTokens {
  const own = scheme === 'dark' ? theme.dark : theme.light;
  const other = scheme === 'dark' ? theme.light : theme.dark;
  return { ...theme.tokens, ...(own ?? other ?? {}) };
}

/**
 * What "Curated" resolves to for one half of the app.
 *
 * `null` means the theme's own pairing; anything else names a registered pack.
 * A theme may both name a pack and override roles on top of it, so the layering
 * is pack → theme roles, and an explicitly chosen pack replaces the theme's
 * choice of pack while still letting the theme's own overrides through.
 */
export function resolveFonts(
  theme: ThemeDefinition | undefined,
  packs: FontPackDefinition[],
  chosenPack: string | null,
): ResolvedFonts | null {
  const byId = (id: string | undefined) =>
    id === undefined ? undefined : packs.find((pack) => pack.id === id);

  if (chosenPack !== null) {
    const pack = byId(chosenPack);
    // A pack that has gone away (its plugin was removed) must not silently
    // become a different pack's typography.
    if (!pack) return null;
    return { ...pack.roles, source: pack.name };
  }

  if (!theme) return null;
  const base = byId(theme.fontPack);
  const roles = { ...base?.roles, ...theme.fonts };
  if (Object.keys(roles).length === 0) return null;
  return { ...roles, source: base && !theme.fonts ? base.name : theme.name };
}

/** Which scheme is on screen right now, with `system` settled against the OS. */
export function activeScheme(theme: Appearance['theme']): ThemeScheme {
  if (theme === 'light' || theme === 'dark') return theme;
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// ---------------------------------------------------------------------------
// Generating
// ---------------------------------------------------------------------------

export interface ThemeInput {
  themes: ThemeDefinition[];
  packs: FontPackDefinition[];
  appearance: Appearance;
}

/**
 * The whole stylesheet: faces first, then the samples the settings panel reads,
 * then the tokens.
 *
 * Pure, and exported separately from `applyTheme` so it can be reasoned about
 * (and diffed) without a document.
 */
function buildThemeCss({ themes, packs, appearance }: ThemeInput): string {
  const theme = themes.find((entry) => entry.id === appearance.themeId);
  const blocks: string[] = [];

  blocks.push(faceCss(themes, packs));
  blocks.push(sampleCss(themes, packs));

  const light = tokenCss(theme ? schemeTokens(theme, 'light') : {});
  const dark = tokenCss(theme ? schemeTokens(theme, 'dark') : {});
  const fonts = fontCss(theme, packs, appearance);

  // Default and light in one block; the fonts ride along because they do not
  // depend on the scheme, and a later block only overrides what it declares.
  if (light || fonts) blocks.push(`${SCOPE} {\n${light}${fonts}}`);
  if (dark) {
    blocks.push(`@media (prefers-color-scheme: dark) {\n  ${SCOPE} {\n${indent(dark)}  }\n}`);
    blocks.push(`${SCOPE}[data-theme='light'] {\n${light}}`);
    blocks.push(`${SCOPE}[data-theme='dark'] {\n${dark}}`);
  }

  // The cards follow the scheme as well, in the same four blocks and for the
  // same reason: a gallery showing every theme's light palette in the dark is
  // showing you something you cannot choose.
  const previewDark = previewCss(themes, 'dark', ':root');
  blocks.push(previewCss(themes, 'light', ':root'));
  if (previewDark) {
    blocks.push(`@media (prefers-color-scheme: dark) {\n${indent(previewDark)}}`);
    blocks.push(previewCss(themes, 'light', `:root[data-theme='light']`));
    blocks.push(previewCss(themes, 'dark', `:root[data-theme='dark']`));
  }

  return blocks.filter((block) => block.trim() !== '').join('\n\n');
}

/**
 * `@font-face` for every registered pack and theme, whether or not it is worn.
 *
 * An unused face costs nothing — a browser fetches a font file only when
 * something on the page actually matches the rule — and declaring them all is
 * what lets the settings panel render each pack's name in that pack's own face
 * without the app having to load anything up front.
 */
function faceCss(themes: ThemeDefinition[], packs: FontPackDefinition[]): string {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const faces of [...packs, ...themes].map((entry) => entry.faces ?? [])) {
    for (const face of faces) {
      const rule = faceRule(face);
      if (!rule) continue;
      if (seen.has(rule)) continue;
      seen.add(rule);
      out.push(rule);
    }
  }
  return out.join('\n');
}

function faceRule(face: FontFaceDeclaration): string | null {
  const family = cssValue(face.family, 120);
  const src = faceSrc(face.src);
  if (!family || !src) {
    warn(`ignoring an unusable @font-face for "${face.family}"`);
    return null;
  }

  const lines = [`  font-family: ${quoteFamily(family)};`, `  src: ${src};`];
  const add = (property: string, value: string | undefined, max = 60) => {
    const clean = value === undefined ? null : cssValue(value, max);
    if (clean) lines.push(`  ${property}: ${clean};`);
  };
  add('font-weight', face.weight);
  add('font-style', face.style);
  add('font-stretch', face.stretch);
  // `swap` rather than the CSS default: a reading face that arrives late should
  // arrive into text you were already reading, not into a blank column.
  add('font-display', face.display ?? 'swap');
  add('unicode-range', face.unicodeRange, 400);

  return `@font-face {\n${lines.join('\n')}\n}`;
}

/**
 * A face's file, as a `src` value.
 *
 * Deliberately narrow: a same-origin path, an `https:` URL or a `data:` URI, and
 * nothing that could carry a second declaration out of the string. The format
 * hint comes from the extension, because a browser that can't tell the format
 * downloads the file to find out.
 */
function faceSrc(src: string): string | null {
  const trimmed = src.trim();
  if (!/^(\/[^\s"'()]*|https:\/\/[^\s"'()]+|data:font\/[\w+.-]+;base64,[\w+/=]+)$/.test(trimmed)) {
    return null;
  }
  const format = trimmed.endsWith('.woff2')
    ? 'woff2'
    : trimmed.endsWith('.woff')
      ? 'woff'
      : trimmed.endsWith('.ttf')
        ? 'truetype'
        : trimmed.endsWith('.otf')
          ? 'opentype'
          : null;
  return `url("${trimmed}")${format ? ` format("${format}")` : ''}`;
}

/** Tokens as declarations, skipping anything unknown or unusable. */
function tokenCss(tokens: ThemeTokens): string {
  let out = '';
  for (const [key, value] of Object.entries(tokens)) {
    if (!THEME_TOKENS.has(key as ThemeToken)) {
      warn(`theme token "${key}" is not one this version knows about — ignored`);
      continue;
    }
    if (value === undefined) continue;
    const clean = cssValue(value, 320);
    if (clean === null) {
      warn(`theme token "${key}" has a value CSS cannot safely carry — ignored`);
      continue;
    }
    out += `  --${key}: ${clean};\n`;
  }
  return out;
}

/**
 * The font role variables, and only in Curated mode.
 *
 * In the three named modes `tokens.css` already answers the question through
 * `data-font` / `data-ui-font`, and emitting anything here would out-specify it
 * and pin the app to one face. Curated is the mode that means "ask the theme",
 * so it is the only one that writes these.
 */
function fontCss(
  theme: ThemeDefinition | undefined,
  packs: FontPackDefinition[],
  appearance: Appearance,
): string {
  const document =
    appearance.font === 'curated' ? resolveFonts(theme, packs, appearance.fontPack) : null;
  const ui =
    appearance.uiFont === 'curated' ? resolveFonts(theme, packs, appearance.uiFontPack) : null;

  let out = '';
  const set = (property: string, value: string | number | undefined, max = 300) => {
    if (value === undefined) return;
    const clean = cssValue(String(value), max);
    if (clean === null) {
      warn(`a font role carried a value CSS cannot safely carry — ignored`);
      return;
    }
    out += `  ${property}: ${clean};\n`;
  };

  if (document) {
    set('--font-editor', stack(document.editor));
    set('--font-heading', stack(document.heading ?? document.editor));
    set('--heading-weight', document.headingWeight, 20);
    set('--heading-style', document.headingStyle, 20);
    set('--heading-stretch', document.headingStretch, 20);
    set('--heading-scale', document.headingScale, 20);
    set('--heading-transform', document.headingTransform, 20);
    set('--heading-variation', document.headingVariation, 200);
    set('--editor-line-height', document.lineHeight, 20);
    // Tracking is three variables, because the two largest headings are tracked
    // in tighter than the rest by default and a pack asking for `-0.03em` means
    // it for the whole scale, not as something to add to what is already there.
    set('--heading-tracking', document.headingTracking, 20);
    set('--heading-tracking-1', document.headingTracking, 20);
    set('--heading-tracking-2', document.headingTracking, 20);
  }

  if (ui) {
    set('--font-ui', stack(ui.ui ?? ui.editor));
    set('--font-ui-heading', stack(ui.uiHeading ?? ui.ui ?? ui.editor));
    set('--ui-heading-weight', ui.uiHeadingWeight, 20);
  }

  // One monospace for the whole app, resolved in the order of who is most
  // likely to have meant it: the reading pack, then the interface pack, then
  // the theme. Code, tables and frontmatter are monospaced on both sides of the
  // app, so two answers here would only ever be a disagreement.
  const mono = document?.mono ?? ui?.mono;
  if (mono) set('--font-mono', stack(mono, MONO_FALLBACK));

  return out;
}

/**
 * Per-theme and per-pack custom properties the settings panel draws with.
 *
 * This exists because the alternative is an inline `style` on every card in the
 * gallery — a font stack is data, not a class, and there are as many of them as
 * there are installed themes. Emitting them into the stylesheet that already
 * has to exist keeps the rule that a React component never carries a style
 * attribute, and it means a preview is styled by the same pipeline as the real
 * thing rather than by a second one that can disagree with it.
 */
function sampleCss(themes: ThemeDefinition[], packs: FontPackDefinition[]): string {
  const out: string[] = [];

  const block = (key: string, roles: FontRoles | null) => {
    if (!roles) return;
    const lines: string[] = [];
    const set = (property: string, value: string | number | undefined, max = 300) => {
      if (value === undefined) return;
      const clean = cssValue(String(value), max);
      if (clean !== null) lines.push(`  ${property}: ${clean};`);
    };
    set('--sample-editor', stack(roles.editor));
    set('--sample-heading', stack(roles.heading ?? roles.editor));
    set('--sample-heading-weight', roles.headingWeight, 20);
    set('--sample-heading-style', roles.headingStyle, 20);
    set('--sample-heading-stretch', roles.headingStretch, 20);
    set('--sample-heading-tracking', roles.headingTracking, 20);
    set('--sample-heading-transform', roles.headingTransform, 20);
    set('--sample-heading-variation', roles.headingVariation, 200);
    set('--sample-ui', stack(roles.ui ?? roles.editor));
    set('--sample-mono', stack(roles.mono, MONO_FALLBACK));
    if (lines.length > 0) out.push(`[data-font-sample='${key}'] {\n${lines.join('\n')}\n}`);
  };

  for (const pack of packs) block(`pack:${escapeId(pack.id)}`, pack.roles);
  for (const theme of themes) block(`theme:${escapeId(theme.id)}`, resolveFonts(theme, packs, null));

  return out.join('\n');
}

/**
 * A theme's own palette, scoped to any element that names it.
 *
 * Scoped rather than prefixed (`--swatch-bg`) because the card is then a real
 * fragment of the theme: `var(--text)` inside it means *that* theme's text, so
 * a derived token like `color-mix(in oklab, var(--text) 68%, var(--bg))` comes
 * out right, and the card needs no vocabulary of its own.
 */
function previewCss(themes: ThemeDefinition[], scheme: ThemeScheme, selector: string): string {
  const out: string[] = [];
  for (const theme of themes) {
    const tokens = schemeTokens(theme, scheme);
    const lines: string[] = [];
    for (const token of PREVIEW_TOKENS) {
      const value = tokens[token];
      const clean = value === undefined ? null : cssValue(value, 320);
      if (clean !== null) lines.push(`  --${token}: ${clean};`);
    }
    if (lines.length > 0) {
      out.push(
        `${selector} [data-theme-swatch='${escapeId(theme.id)}'] {\n${lines.join('\n')}\n}`,
      );
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Pushes the generated stylesheet into the document, caches it for the next
 * boot, and tells the editor its typography moved.
 *
 * The only writer of `<style id="spark-theme">`.
 */
export function applyTheme(input: ThemeInput): void {
  const css = buildThemeCss(input);

  let style = document.getElementById(STYLE_ELEMENT_ID);
  if (!(style instanceof HTMLStyleElement)) {
    style = document.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    document.head.appendChild(style);
  }
  /*
   * Both writes are gated on the text having actually changed, and that matters
   * more than it looks. This runs on *every* appearance change, including each
   * frame of a drag on the text-size slider — and neither size is part of this
   * stylesheet. Ungated, that is a fifty-kilobyte string re-parsed and written
   * synchronously to local storage sixty times a second.
   */
  if (style.textContent !== css) {
    style.textContent = css;
    try {
      if (css.length <= CACHE_LIMIT) globalThis.localStorage?.setItem(CACHE_KEY, css);
      else globalThis.localStorage?.removeItem(CACHE_KEY);
    } catch {
      // Private browsing or a full quota. The cost is a flash of the default
      // palette on the next reload, which is not worth failing a theme change
      // for.
    }
  }

  // Announced even when the stylesheet did not change, because the *mode* may
  // have: Sans to Serif is a `data-font` swap that this file has no part in, and
  // the editor still has to remeasure. Cheap either way — the measurement
  // itself is skipped when the font state turns out to be identical.
  notifyTypographyChanged();
}

/**
 * Announces that the page's typography has changed.
 *
 * The editor measures the real rendered width of `# ` and of every list prefix
 * to work out its margin outdents, and nothing in CodeMirror's own state says
 * that a stylesheet swapped the heading face out from under it. A window event
 * is the right shape for this for the same reason `document.fonts`'
 * `loadingdone` is: it is a fact about the page, and every editor alive needs to
 * hear it, not just the focused one.
 */
function notifyTypographyChanged(): void {
  globalThis.dispatchEvent?.(new Event('spark:typography'));
}

// ---------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------

/**
 * A CSS value that cannot escape its declaration.
 *
 * Not a security boundary — a plugin runs JavaScript in this page already. It
 * is there because the failure mode of one unbalanced brace is *the whole
 * stylesheet after it*, which looks like the app being broken rather than like
 * a theme having a bug. `url()` is refused outright: a palette has no business
 * fetching anything, and a face that needs a file declares it as a face.
 */
function cssValue(value: string, max: number): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) return null;
  if (/[;{}<>\\]|@|\/\*|\*\/|url\(|expression\(/i.test(trimmed)) return null;
  // Parentheses are legitimate — `color-mix()`, `var()`, `rgb()` — but they have
  // to balance, or the declaration runs on into the next one.
  let depth = 0;
  for (const character of trimmed) {
    if (character === '(') depth++;
    else if (character === ')' && --depth < 0) return null;
  }
  return depth === 0 ? trimmed : null;
}

/**
 * A family name as it appears in `@font-face`. Quoted unless it is a single
 * bare word, because `font-family: Space Grotesk` is not the same declaration
 * as `font-family: "Space Grotesk"`.
 */
function quoteFamily(family: string): string {
  return /^[\w-]+$/.test(family) ? family : `'${family.replace(/'/g, '')}'`;
}

/**
 * A role's family, with fallbacks appended.
 *
 * Fonts are fetched rather than committed (`npm run fonts`), so a face may
 * simply not be there — and a stack ending in a generic keeps a missing file
 * looking like a different typeface instead of like a broken app.
 *
 * A pack that already wrote a stack of its own is left alone: the comma is the
 * signal, and second-guessing an author who listed their own fallbacks would
 * append ours after the generic, where nothing can ever reach it.
 */
function stack(family: string | undefined, fallback = SANS_FALLBACK): string | undefined {
  if (family === undefined) return undefined;
  return family.includes(',') ? family : `${quoteFamily(family.trim())}, ${fallback}`;
}

/**
 * The fallbacks, spelled out rather than borrowed from `var(--font-sans)`.
 *
 * Two reasons, and the second one is the load-bearing one:
 *
 * - A monospace cannot fall back to `var(--font-mono)` at all — that is the
 *   property being defined, and a self-referential custom property is cyclic,
 *   which CSS resolves by throwing the declaration away. It must not fall back
 *   to a sans either: code that quietly stops being monospaced loses the column
 *   alignment that is half of what a code block means.
 * - **A `var()` in the fallback makes the whole declaration conditional on that
 *   variable existing.** An unresolvable `var()` is invalid at computed-value
 *   time, and the property does not degrade — it becomes *empty*. The generated
 *   stylesheet is replayed from cache by the inline script in `index.html`,
 *   which runs before the bundle's own CSS exists, so a stack written as
 *   `'Bodoni Moda', var(--font-sans)` is empty for exactly as long as it takes
 *   `tokens.css` to arrive. Spelled out, it is correct from the first byte.
 */
const SANS_FALLBACK = "ui-sans-serif, -apple-system, 'Segoe UI', sans-serif";
const MONO_FALLBACK = "ui-monospace, 'SF Mono', Menlo, monospace";

/** An id inside an attribute selector, restricted to what needs no escaping. */
function escapeId(id: string): string {
  return id.replace(/[^\w.:-]/g, '');
}

function indent(block: string): string {
  return block.replace(/^(?=.)/gm, '  ');
}

/**
 * Once per message, per session.
 *
 * The stylesheet is rebuilt on every appearance change, so a theme with one bad
 * token would otherwise print the same warning every time somebody moved a
 * slider — which buries the other things in the console under a defect that has
 * already been reported.
 */
const warned = new Set<string>();

function warn(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[spark] ${message}`);
}
