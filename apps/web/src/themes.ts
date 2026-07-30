import {
  definePlugin,
  type SparkApi,
  type ThemeDefinition,
  type ThemeScheme,
  type ThemeTokens,
} from '@spark/plugin-sdk';

/**
 * The built-in themes.
 *
 * Twelve palettes, each in light and dark, each paired with one of the font
 * packs from `fonts.ts` — so choosing a theme and then choosing **Curated** on
 * either font picker gets you the whole look the theme was designed as, and
 * choosing Sans instead keeps the palette and drops the voice.
 *
 * ## Why these are short
 *
 * A full token set is about forty values, and forty values times two schemes
 * times twelve themes is not something anybody keeps consistent by hand. So a
 * theme states the ten colours that are actually decisions — page, panel,
 * raised, sunken, ink, accent, what sits on the accent, tags, highlighter, and
 * the colour its shadows are cast in — and `tokens()` derives the rest with
 * `color-mix()`: the text ramp, the rules, the code chips, the scrollbar.
 *
 * The derivation is *CSS*, not arithmetic done here, which matters twice over.
 * A derived token stays correct if something later overrides the token it was
 * derived from, and the theme gallery can scope a whole palette to one card and
 * have every mix resolve inside it (see `previewCss` in `lib/theme.ts`).
 *
 * ## What is deliberately absent
 *
 * - **Syntax, danger and success colours**, unless a theme has an opinion.
 *   Omitting them falls through to `tokens.css`, which already has a set drawn
 *   for the scheme in play. Restating them in every theme would be twelve copies
 *   of a decision made once.
 * - **The Spark theme's own palette.** It has none: the app's palette lives in
 *   `tokens.css`, because that is what has to be right before any plugin has
 *   loaded, and a second copy here would be a second thing to keep true. The
 *   Spark theme is the app as it ships, plus the font pairing it ships with.
 */

/** The colours a theme actually decides. Everything else follows from these. */
interface Ink {
  /** The page. */
  bg: string;
  /** Panels, cards, tab strips — anything sitting on the page. */
  surface: string;
  /** A panel above a panel: menus, floating windows, the palette. */
  raised: string;
  /** A well: code blocks, the segmented control's trough, inputs. */
  sunken: string;
  /** Body text at full strength. The whole ramp is mixed out of this and `bg`. */
  text: string;
  accent: string;
  /** Text and glyphs *on* the accent, e.g. inside a primary button. */
  accentContrast: string;
  /** `#tags`, and the one warm note most of these palettes keep in reserve. */
  tag: string;
  /** The highlighter pen — `==like this==` — and search matches. */
  highlight: string;
  /** `R G B` for shadows, unmixed: a shadow is not a colour from the palette. */
  shadow: string;
  /** Only when the theme has an opinion; otherwise `tokens.css` decides. */
  syn?: Partial<Record<'keyword' | 'string' | 'number' | 'function' | 'type' | 'property', string>>;
  danger?: string;
  success?: string;
  /** Anything else, verbatim — a radius, a measure, a font stack. */
  extra?: ThemeTokens;
}

/**
 * One scheme's worth of tokens.
 *
 * The percentages are the same in light and dark on purpose: they are mixes
 * toward the *page*, so a ramp that reads correctly against paper reads
 * correctly against ink without a second set of numbers.
 */
function tokens(ink: Ink, scheme: ThemeScheme): ThemeTokens {
  const toBg = (colour: string, percent: number) =>
    `color-mix(in oklab, ${colour} ${percent}%, var(--bg))`;
  const ofText = (percent: number) => toBg('var(--text)', percent);

  // A shadow in a dark scheme is not a darker version of a light one — it is
  // black, and much more of it, because there is no ambient light to soften it.
  const shadows: ThemeTokens =
    scheme === 'dark'
      ? {
          'shadow-sm': `0 1px 2px rgb(${ink.shadow} / 0.45)`,
          'shadow-md': `0 8px 28px -8px rgb(${ink.shadow} / 0.65), 0 2px 6px rgb(${ink.shadow} / 0.35)`,
          'shadow-lg': `0 24px 60px -16px rgb(${ink.shadow} / 0.75)`,
        }
      : {
          'shadow-sm': `0 1px 2px rgb(${ink.shadow} / 0.06)`,
          'shadow-md': `0 8px 28px -8px rgb(${ink.shadow} / 0.18), 0 2px 6px rgb(${ink.shadow} / 0.06)`,
          'shadow-lg': `0 24px 60px -16px rgb(${ink.shadow} / 0.28)`,
        };

  return {
    bg: ink.bg,
    surface: ink.surface,
    'surface-raised': ink.raised,
    'surface-sunken': ink.sunken,

    text: ink.text,
    'text-muted': ofText(72),
    'text-faint': ofText(50),
    'text-faintest': ofText(30),
    rule: ofText(12),
    'rule-strong': ofText(26),

    accent: ink.accent,
    'accent-soft': toBg(ink.accent, 14),
    'accent-faint': toBg(ink.accent, 42),
    'accent-contrast': ink.accentContrast,

    // Selection is mixed from the accent rather than given: it has to sit under
    // live text at any weight, so it is the one colour that must not be chosen
    // for how it looks on its own.
    selection: toBg(ink.accent, 30),
    'selection-match': toBg(ink.highlight, 55),
    'highlight-bg': ink.highlight,
    tag: ink.tag,
    'tag-soft': toBg(ink.tag, 14),
    'search-match': toBg(ink.highlight, 55),
    'search-match-active': ink.highlight,

    'code-bg': ink.sunken,
    'code-text': ofText(88),
    'code-inline-bg': ofText(7),
    'code-inline-border': ofText(15),

    scrollbar: ofText(20),
    'scrollbar-hover': ofText(36),

    ...(ink.danger ? { danger: ink.danger } : {}),
    ...(ink.success ? { success: ink.success } : {}),
    ...(ink.syn
      ? {
          ...(ink.syn.keyword ? { 'syn-keyword': ink.syn.keyword } : {}),
          ...(ink.syn.string ? { 'syn-string': ink.syn.string } : {}),
          ...(ink.syn.number ? { 'syn-number': ink.syn.number } : {}),
          ...(ink.syn.function ? { 'syn-function': ink.syn.function } : {}),
          ...(ink.syn.type ? { 'syn-type': ink.syn.type } : {}),
          ...(ink.syn.property ? { 'syn-property': ink.syn.property } : {}),
          'syn-operator': ofText(72),
        }
      : {}),
    ...shadows,
    ...ink.extra,
  };
}

/** A theme from two inks. The `fontPack` is the pairing Curated will wear. */
function theme(
  id: string,
  name: string,
  description: string,
  fontPack: string,
  light: Ink,
  dark: Ink,
): ThemeDefinition {
  return {
    id,
    name,
    description,
    author: 'Spark',
    fontPack,
    light: tokens(light, 'light'),
    dark: tokens(dark, 'dark'),
  };
}

const BUILT_IN: ThemeDefinition[] = [
  {
    id: 'spark',
    name: 'Spark',
    description: 'The palette the app ships with — warm paper, one quiet blue.',
    author: 'Spark',
    fontPack: 'spark',
  },

  theme(
    'paper',
    'Paper',
    'Cream stock and brick red. A page that has been to press.',
    'editorial',
    {
      bg: '#f7f3ea',
      surface: '#fffdf7',
      raised: '#fffdf7',
      sunken: '#ece4d2',
      text: '#23201a',
      accent: '#a8341f',
      accentContrast: '#fff7ef',
      tag: '#7a6320',
      highlight: '#f4dc8a',
      shadow: '92 74 46',
    },
    {
      bg: '#171512',
      surface: '#1e1b17',
      raised: '#26221c',
      sunken: '#12100d',
      text: '#ece4d4',
      accent: '#e2755c',
      accentContrast: '#1a1210',
      tag: '#cfa85f',
      highlight: '#584723',
      shadow: '0 0 0',
    },
  ),

  theme(
    'ink',
    'Ink',
    'Almost monochrome. Hairline rules, and blue only where it means something.',
    'masthead',
    {
      bg: '#ffffff',
      surface: '#ffffff',
      raised: '#ffffff',
      sunken: '#f2f2f4',
      text: '#101013',
      accent: '#0b57d0',
      accentContrast: '#ffffff',
      tag: '#4a4a52',
      highlight: '#e4e4ff',
      shadow: '16 16 20',
    },
    {
      bg: '#0b0b0d',
      surface: '#121216',
      raised: '#1a1a20',
      sunken: '#07070a',
      text: '#f4f4f7',
      accent: '#7ea6ff',
      accentContrast: '#0b0b0d',
      tag: '#b6b6c2',
      highlight: '#2b2b52',
      shadow: '0 0 0',
    },
  ),

  theme(
    'fjord',
    'Fjord',
    'Cold blue-grey, the colour of a screen at four in the afternoon.',
    'grotesk',
    {
      bg: '#eceff4',
      surface: '#f7f9fc',
      raised: '#ffffff',
      sunken: '#dee3ec',
      text: '#2e3440',
      accent: '#5e81ac',
      accentContrast: '#f7f9fc',
      tag: '#a3707f',
      highlight: '#e8d296',
      shadow: '46 52 64',
      syn: {
        keyword: '#5e81ac',
        string: '#6d8f52',
        number: '#c1663c',
        function: '#4a8f9e',
        type: '#4f8a86',
        property: '#9c6a92',
      },
    },
    {
      bg: '#2e3440',
      surface: '#353d4c',
      raised: '#3b4252',
      sunken: '#272c36',
      text: '#e5e9f0',
      accent: '#88c0d0',
      accentContrast: '#2e3440',
      tag: '#d08770',
      highlight: '#59512f',
      shadow: '0 0 0',
      syn: {
        keyword: '#81a1c1',
        string: '#a3be8c',
        number: '#d08770',
        function: '#88c0d0',
        type: '#8fbcbb',
        property: '#b48ead',
      },
    },
  ),

  theme(
    'ember',
    'Ember',
    'Retro terminal warmth: toasted background, orange on top.',
    'poster',
    {
      bg: '#fbf1c7',
      surface: '#f9f5d7',
      raised: '#fffdf3',
      sunken: '#ebdbb2',
      text: '#3c3836',
      accent: '#af3a03',
      accentContrast: '#fbf1c7',
      tag: '#b57614',
      highlight: '#e8ce6a',
      shadow: '80 66 40',
      syn: {
        keyword: '#9d0006',
        string: '#79740e',
        number: '#8f3f71',
        function: '#427b58',
        type: '#076678',
        property: '#b57614',
      },
    },
    {
      bg: '#1d2021',
      surface: '#282828',
      raised: '#32302f',
      sunken: '#171818',
      text: '#ebdbb2',
      accent: '#fe8019',
      accentContrast: '#1d2021',
      tag: '#d3869b',
      highlight: '#544625',
      shadow: '0 0 0',
      syn: {
        keyword: '#fb4934',
        string: '#b8bb26',
        number: '#d3869b',
        function: '#8ec07c',
        type: '#83a598',
        property: '#fabd2f',
      },
    },
  ),

  theme(
    'solar',
    'Solar',
    'The old solarized pair, kept for the people who never left it.',
    'wonk',
    {
      bg: '#fdf6e3',
      surface: '#fffbf0',
      raised: '#fffdf7',
      sunken: '#eee8d5',
      text: '#073642',
      accent: '#268bd2',
      accentContrast: '#fdf6e3',
      tag: '#cb4b16',
      highlight: '#e6d59a',
      shadow: '7 54 66',
      syn: {
        keyword: '#859900',
        string: '#2aa198',
        number: '#d33682',
        function: '#268bd2',
        type: '#b58900',
        property: '#cb4b16',
      },
    },
    {
      bg: '#002b36',
      surface: '#073642',
      raised: '#0c4553',
      sunken: '#00212b',
      text: '#eee8d5',
      accent: '#2aa198',
      accentContrast: '#002b36',
      tag: '#b58900',
      highlight: '#414a1c',
      shadow: '0 0 0',
      syn: {
        keyword: '#859900',
        string: '#2aa198',
        number: '#d33682',
        function: '#268bd2',
        type: '#b58900',
        property: '#cb4b16',
      },
    },
  ),

  theme(
    'rose',
    'Rosé',
    'Dusty plum and pink. Quiet, and not at all grey.',
    'didone',
    {
      bg: '#faf4ed',
      surface: '#fffaf3',
      raised: '#fffefa',
      sunken: '#f0e6dd',
      text: '#575279',
      accent: '#907aa9',
      accentContrast: '#fffaf3',
      tag: '#b4637a',
      highlight: '#f0dcbe',
      shadow: '87 82 121',
      syn: {
        keyword: '#907aa9',
        string: '#286983',
        number: '#b4637a',
        function: '#56949f',
        type: '#d7827e',
        property: '#ea9d34',
      },
    },
    {
      bg: '#191724',
      surface: '#1f1d2e',
      raised: '#26233a',
      sunken: '#14121f',
      text: '#e0def4',
      accent: '#c4a7e7',
      accentContrast: '#191724',
      tag: '#eb6f92',
      highlight: '#4b3a55',
      shadow: '0 0 0',
      syn: {
        keyword: '#c4a7e7',
        string: '#f6c177',
        number: '#eb6f92',
        function: '#9ccfd8',
        type: '#6fa8bd',
        property: '#ebbcba',
      },
    },
  ),

  theme(
    'sepia',
    'Sepia',
    'A second-hand paperback. Low contrast, on purpose.',
    'bookish',
    {
      bg: '#f0e6d3',
      surface: '#f7efe0',
      raised: '#fbf5e9',
      sunken: '#e2d5bc',
      text: '#3a2f21',
      accent: '#7a4a1e',
      accentContrast: '#f7efe0',
      tag: '#6b5a2a',
      highlight: '#ddc383',
      shadow: '86 68 40',
    },
    {
      bg: '#1a1510',
      surface: '#221c15',
      raised: '#2b241a',
      sunken: '#14100c',
      text: '#e8dcc6',
      accent: '#c9925a',
      accentContrast: '#1a1510',
      tag: '#b9a468',
      highlight: '#4e4022',
      shadow: '0 0 0',
    },
  ),

  theme(
    'slate',
    'Slate',
    'Cool neutral greys and a working blue. Stretched italic titles.',
    'stretch',
    {
      bg: '#f6f7f9',
      surface: '#ffffff',
      raised: '#ffffff',
      sunken: '#e9ecf1',
      text: '#14181f',
      accent: '#2563eb',
      accentContrast: '#ffffff',
      tag: '#0f766e',
      highlight: '#fbe08a',
      shadow: '20 24 31',
    },
    {
      bg: '#0f1319',
      surface: '#161b23',
      raised: '#1e242e',
      sunken: '#0a0d12',
      text: '#e7eaf0',
      accent: '#60a5fa',
      accentContrast: '#0b0f14',
      tag: '#2dd4bf',
      highlight: '#4c4620',
      shadow: '0 0 0',
    },
  ),

  theme(
    'terminal',
    'Terminal',
    'Phosphor green on black, and a monospace everywhere.',
    'typewriter',
    {
      bg: '#f1f4ee',
      surface: '#fbfdf9',
      raised: '#ffffff',
      sunken: '#e2e8dd',
      text: '#16240f',
      accent: '#1f7a33',
      accentContrast: '#fbfdf9',
      tag: '#7a5a1f',
      highlight: '#cbe6a6',
      shadow: '22 36 15',
      syn: {
        keyword: '#1f7a33',
        string: '#3f6d1f',
        number: '#7a5a1f',
        function: '#166b52',
        type: '#1d6b6b',
        property: '#4a6b16',
      },
    },
    {
      bg: '#06100a',
      surface: '#0b1a10',
      raised: '#112417',
      sunken: '#030b06',
      text: '#b8f2c0',
      accent: '#3ff07a',
      accentContrast: '#04120a',
      tag: '#9ad86f',
      highlight: '#2c4c22',
      shadow: '0 0 0',
      syn: {
        keyword: '#5ef08f',
        string: '#a8e86a',
        number: '#e0d16a',
        function: '#4fe0c0',
        type: '#6ee0e0',
        property: '#9ad86f',
      },
    },
  ),

  theme(
    'bloom',
    'Bloom',
    'High chroma, no apology. Magenta, violet, and a lot of light.',
    'neo',
    {
      bg: '#fdf7ff',
      surface: '#ffffff',
      raised: '#ffffff',
      sunken: '#f4e8fb',
      text: '#2a1633',
      accent: '#b5179e',
      accentContrast: '#ffffff',
      tag: '#7209b7',
      highlight: '#fbd0f0',
      shadow: '60 22 74',
      syn: {
        keyword: '#7209b7',
        string: '#0f8a6a',
        number: '#c1121f',
        function: '#3a86ff',
        type: '#0891b2',
        property: '#b5179e',
      },
    },
    {
      bg: '#140a1c',
      surface: '#1c1026',
      raised: '#251733',
      sunken: '#0e0614',
      text: '#f2e6fb',
      accent: '#ff5ecb',
      accentContrast: '#16081a',
      tag: '#b98bff',
      highlight: '#4d1a52',
      shadow: '0 0 0',
      syn: {
        keyword: '#c78bff',
        string: '#5eead4',
        number: '#ff8fa3',
        function: '#7aa2ff',
        type: '#67e8f9',
        property: '#ff5ecb',
      },
    },
  ),

  theme(
    'noir',
    'Noir',
    'Black, white, one red. Condensed capitals for titles.',
    'condensed',
    {
      bg: '#ffffff',
      surface: '#ffffff',
      raised: '#ffffff',
      sunken: '#efefef',
      text: '#000000',
      accent: '#d81e1e',
      accentContrast: '#ffffff',
      tag: '#171717',
      highlight: '#ffe94d',
      shadow: '0 0 0',
      // A brutalist palette wants corners, not radii.
      extra: { 'radius-sm': '2px', radius: '3px', 'radius-lg': '4px' },
    },
    {
      bg: '#000000',
      surface: '#0b0b0b',
      raised: '#151515',
      sunken: '#000000',
      text: '#ffffff',
      accent: '#ff4d4d',
      accentContrast: '#000000',
      tag: '#d4d4d4',
      highlight: '#4d4600',
      shadow: '0 0 0',
      extra: { 'radius-sm': '2px', radius: '3px', 'radius-lg': '4px' },
    },
  ),
];

export const themesPlugin = definePlugin({
  id: 'core.themes',
  name: 'Themes',
  description: 'Twelve palettes, in light and dark, each with a typeface pairing.',

  activate(spark: SparkApi) {
    for (const entry of BUILT_IN) spark.themes.register(entry);

    // Both of these go through the same `spark.themes` a third-party plugin
    // gets — which is the point. Nothing about theming is reachable from the
    // shell and not from a file in `_plugins/`.
    spark.commands.register({
      id: 'theme.pick',
      name: 'Change theme…',
      category: 'Appearance',
      run: async () => {
        const installed = spark.themes.list();
        const chosen = await spark.ui.select(
          'Theme',
          installed.map((entry) => entry.name),
        );
        const match = installed.find((entry) => entry.name === chosen);
        if (match) spark.themes.use(match.id);
      },
    });

    spark.commands.register({
      id: 'theme.next',
      name: 'Next theme',
      category: 'Appearance',
      run: () => {
        const installed = spark.themes.list();
        if (installed.length === 0) return;
        const at = installed.findIndex((entry) => entry.id === spark.themes.active());
        // A theme that has been uninstalled leaves `at` at -1, and the next one
        // after "nothing" is sensibly the first.
        spark.themes.use(installed[(at + 1) % installed.length].id);
      },
    });
  },
});
