import {
  definePlugin,
  type FontFaceDeclaration,
  type FontPackDefinition,
  type SparkApi,
} from '@spark/plugin-sdk';

/**
 * The default font packs.
 *
 * A pack is a *pairing*, not a font: a title face, a reading face, an interface
 * face and a monospace chosen to sit together, plus the handful of numbers that
 * make the title behave like one — weight, width, tracking, and how much bigger
 * than the body it wants to be. Thirteen of them, reached through the
 * **Curated** option on either font picker.
 *
 * Three things this file is careful about:
 *
 * - **A pack declares the faces it needs**, and the generated stylesheet
 *   de-duplicates them. So removing a pack removes its downloads with it, and
 *   nothing depends on a shared list staying in step with thirteen role sets.
 * - **Declaring a face costs nothing.** All thirteen packs' `@font-face` rules
 *   are emitted whether or not you wear any of them, because a browser fetches
 *   a font file only when something on the page matches the rule. That is also
 *   what lets the settings panel show each pack's name in its own face.
 * - **Weight and width ranges are the files' real axes**, read out of the fonts
 *   rather than assumed. A range wider than the axis is clamped silently, so a
 *   wrong number does not fail — it quietly stops a title being as heavy or as
 *   wide as it was meant to be, which is the kind of bug nobody finds.
 *
 * Fonts are fetched, not committed (`npm run fonts` — see that script for where
 * each file comes from). Every role resolves through a stack ending in a
 * generic, so a face that was never downloaded is a different typeface rather
 * than a broken page.
 */

/** One file, one cut. A variable file carries a range in `weight`/`stretch`. */
const cut = (
  family: string,
  file: string,
  weight: string,
  style: FontFaceDeclaration['style'] = 'normal',
  stretch?: string,
): FontFaceDeclaration => ({ family, src: `/fonts/${file}`, weight, style, stretch });

/**
 * The families, by name, with the cuts each one ships.
 *
 * The seven faces behind Sans, Serif and Mono are absent on purpose: those are
 * declared in `tokens.css`, because the three named modes have to work before
 * any plugin has loaded. Fraunces appears here for its *italic* only, for the
 * same reason — the upright is already there for serif mode.
 */
const FAMILIES: Record<string, FontFaceDeclaration[]> = {
  // Display serifs. The italics are the point: a high-contrast italic at 1.2×
  // body size is the cheapest way for a title to have a voice.
  'Playfair Display': [
    cut('Playfair Display', 'PlayfairDisplay.ttf', '400 900'),
    cut('Playfair Display', 'PlayfairDisplay-Italic.ttf', '400 900', 'italic'),
  ],
  'Instrument Serif': [
    cut('Instrument Serif', 'InstrumentSerif-Regular.ttf', '400'),
    cut('Instrument Serif', 'InstrumentSerif-Italic.ttf', '400', 'italic'),
  ],
  'Bodoni Moda': [
    cut('Bodoni Moda', 'BodoniModa.ttf', '400 900'),
    cut('Bodoni Moda', 'BodoniModa-Italic.ttf', '400 900', 'italic'),
  ],
  'DM Serif Display': [
    cut('DM Serif Display', 'DMSerifDisplay-Regular.ttf', '400'),
    cut('DM Serif Display', 'DMSerifDisplay-Italic.ttf', '400', 'italic'),
  ],
  Fraunces: [cut('Fraunces', 'Fraunces-Italic.ttf', '100 900', 'italic')],

  // Reading serifs. Both carry an optical-size axis, which the browser drives
  // from the font size on its own — `font-optical-sizing: auto` is the default.
  Newsreader: [
    cut('Newsreader', 'Newsreader.ttf', '200 800'),
    cut('Newsreader', 'Newsreader-Italic.ttf', '200 800', 'italic'),
  ],
  'EB Garamond': [
    cut('EB Garamond', 'EBGaramond.ttf', '400 800'),
    cut('EB Garamond', 'EBGaramond-Italic.ttf', '400 800', 'italic'),
  ],

  // Grotesks. Archivo, Instrument Sans and Bricolage carry a width axis, which
  // is the difference between a title that is stretched and one merely bolder.
  Archivo: [
    cut('Archivo', 'Archivo.ttf', '100 900', 'normal', '62% 125%'),
    cut('Archivo', 'Archivo-Italic.ttf', '100 900', 'italic', '62% 125%'),
  ],
  'Instrument Sans': [
    cut('Instrument Sans', 'InstrumentSans.ttf', '400 700', 'normal', '75% 100%'),
    cut('Instrument Sans', 'InstrumentSans-Italic.ttf', '400 700', 'italic', '75% 100%'),
  ],
  'Bricolage Grotesque': [
    cut('Bricolage Grotesque', 'BricolageGrotesque.ttf', '200 800', 'normal', '75% 100%'),
  ],
  'Space Grotesk': [cut('Space Grotesk', 'SpaceGrotesk.ttf', '300 700')],
  'Work Sans': [
    cut('Work Sans', 'WorkSans.ttf', '100 900'),
    cut('Work Sans', 'WorkSans-Italic.ttf', '100 900', 'italic'),
  ],
  'Libre Franklin': [
    cut('Libre Franklin', 'LibreFranklin.ttf', '100 900'),
    cut('Libre Franklin', 'LibreFranklin-Italic.ttf', '100 900', 'italic'),
  ],
  Manrope: [cut('Manrope', 'Manrope.ttf', '200 800')],

  // Poster weight, for the two packs that shout.
  Anton: [cut('Anton', 'Anton-Regular.ttf', '400')],
  Unbounded: [cut('Unbounded', 'Unbounded.ttf', '200 900')],

  // Drawn for legibility rather than for style, and the reason the Legible pack
  // is a pack rather than a slider.
  'Atkinson Hyperlegible': [
    cut('Atkinson Hyperlegible', 'AtkinsonHyperlegible-Regular.ttf', '400'),
    cut('Atkinson Hyperlegible', 'AtkinsonHyperlegible-Bold.ttf', '700'),
    cut('Atkinson Hyperlegible', 'AtkinsonHyperlegible-Italic.ttf', '400', 'italic'),
  ],
  Lexend: [cut('Lexend', 'Lexend.ttf', '100 900')],

  // Monospaces, for the packs that want a different one from iA Writer Mono.
  'JetBrains Mono': [
    cut('JetBrains Mono', 'JetBrainsMono.ttf', '100 800'),
    cut('JetBrains Mono', 'JetBrainsMono-Italic.ttf', '100 800', 'italic'),
  ],
  'Space Mono': [
    cut('Space Mono', 'SpaceMono-Regular.ttf', '400'),
    cut('Space Mono', 'SpaceMono-Italic.ttf', '400', 'italic'),
    cut('Space Mono', 'SpaceMono-Bold.ttf', '700'),
  ],
  'IBM Plex Mono': [
    cut('IBM Plex Mono', 'IBMPlexMono-Regular.woff2', '400'),
    cut('IBM Plex Mono', 'IBMPlexMono-Italic.woff2', '400', 'italic'),
    cut('IBM Plex Mono', 'IBMPlexMono-SemiBold.woff2', '600 700'),
  ],
};

/** The cuts for a list of families. Unknown names are the ones `tokens.css` owns. */
const faces = (...families: string[]): FontFaceDeclaration[] =>
  families.flatMap((family) => FAMILIES[family] ?? []);

/**
 * The packs, roughly from quietest to loudest.
 *
 * `headingScale` is a multiplier on every heading size — how a display face gets
 * the size it was drawn for without the body text moving. Anything with an
 * italic in its titles relies on a separate italic drawing rather than a slant,
 * which is why those families were downloaded in pairs.
 */
const PACKS: FontPackDefinition[] = [
  {
    id: 'spark',
    name: 'Spark',
    description: 'The app’s own pairing: Inter to read in, Fraunces on the titles.',
    faces: faces('Fraunces'),
    roles: {
      editor: 'Inter',
      heading: 'Fraunces',
      headingWeight: 600,
      headingTracking: '-0.02em',
      ui: 'IBM Plex Sans',
      mono: 'iA Writer Mono',
    },
  },
  {
    id: 'editorial',
    name: 'Editorial',
    description: 'Playfair italics over a news serif. A long-form magazine page.',
    faces: faces('Newsreader', 'Playfair Display', 'Instrument Sans', 'JetBrains Mono'),
    roles: {
      editor: 'Newsreader',
      lineHeight: 1.7,
      heading: 'Playfair Display',
      headingWeight: 700,
      headingStyle: 'italic',
      headingTracking: '-0.03em',
      headingScale: 1.16,
      ui: 'Instrument Sans',
      mono: 'JetBrains Mono',
    },
  },
  {
    id: 'masthead',
    name: 'Masthead',
    description: 'A tight, high-contrast serif italic on top of a plain grotesk.',
    faces: faces('Instrument Sans', 'Instrument Serif', 'IBM Plex Mono'),
    roles: {
      editor: 'Instrument Sans',
      heading: 'Instrument Serif',
      headingWeight: 400,
      headingStyle: 'italic',
      headingTracking: '-0.02em',
      headingScale: 1.3,
      ui: 'Instrument Sans',
      mono: 'IBM Plex Mono',
    },
  },
  {
    id: 'wonk',
    name: 'Wonk',
    description: 'Fraunces with its wonk turned all the way up, in italic.',
    faces: faces('Newsreader', 'Fraunces', 'Work Sans', 'JetBrains Mono'),
    roles: {
      editor: 'Newsreader',
      lineHeight: 1.68,
      heading: 'Fraunces',
      headingWeight: 700,
      headingStyle: 'italic',
      // The two axes that make Fraunces itself rather than another old-style
      // serif: SOFT rounds the terminals, WONK swaps in the odd letterforms.
      headingVariation: "'SOFT' 90, 'WONK' 1",
      headingTracking: '-0.02em',
      headingScale: 1.14,
      ui: 'Work Sans',
      mono: 'JetBrains Mono',
    },
  },
  {
    id: 'didone',
    name: 'Didone',
    description: 'Bodoni italic titles, Garamond underneath. Hairlines and air.',
    faces: faces('EB Garamond', 'Bodoni Moda', 'Libre Franklin', 'Space Mono'),
    roles: {
      editor: 'EB Garamond',
      lineHeight: 1.72,
      heading: 'Bodoni Moda',
      headingWeight: 600,
      headingStyle: 'italic',
      headingTracking: '-0.015em',
      headingScale: 1.24,
      ui: 'Libre Franklin',
      mono: 'Space Mono',
    },
  },
  {
    id: 'bookish',
    name: 'Bookish',
    description: 'A printed page: Garamond set generously, DM Serif on the titles.',
    faces: faces('EB Garamond', 'DM Serif Display', 'Libre Franklin', 'IBM Plex Mono'),
    roles: {
      editor: 'EB Garamond',
      lineHeight: 1.75,
      heading: 'DM Serif Display',
      headingWeight: 400,
      headingTracking: '-0.01em',
      headingScale: 1.2,
      ui: 'Libre Franklin',
      mono: 'IBM Plex Mono',
    },
  },
  {
    id: 'grotesk',
    name: 'Grotesk',
    description: 'Space Grotesk titles, Inter body. Swiss, with the corners off.',
    faces: faces('Space Grotesk', 'JetBrains Mono'),
    roles: {
      editor: 'Inter',
      heading: 'Space Grotesk',
      headingWeight: 700,
      headingTracking: '-0.035em',
      headingScale: 1.05,
      ui: 'Space Grotesk',
      mono: 'JetBrains Mono',
    },
  },
  {
    id: 'stretch',
    name: 'Stretch',
    description: 'Archivo pulled out to 125% and slanted. Titles that lean.',
    faces: faces('Archivo', 'JetBrains Mono'),
    roles: {
      editor: 'Archivo',
      heading: 'Archivo',
      headingWeight: 800,
      headingStyle: 'italic',
      // The width axis, not a transform: the letterforms are drawn wide rather
      // than scaled, so the strokes keep their weight.
      headingStretch: '125%',
      headingTracking: '-0.025em',
      headingScale: 1.12,
      ui: 'Archivo',
      mono: 'JetBrains Mono',
    },
  },
  {
    id: 'condensed',
    name: 'Condensed',
    description: 'Bricolage squeezed to 75% and set in caps. A broadsheet deck.',
    faces: faces('Instrument Sans', 'Bricolage Grotesque', 'IBM Plex Mono'),
    roles: {
      editor: 'Instrument Sans',
      heading: 'Bricolage Grotesque',
      headingWeight: 800,
      headingStretch: '75%',
      headingTransform: 'uppercase',
      headingTracking: '0.005em',
      headingScale: 1.2,
      ui: 'Instrument Sans',
      mono: 'IBM Plex Mono',
    },
  },
  {
    id: 'poster',
    name: 'Poster',
    description: 'Anton in caps. Every heading is a headline.',
    faces: faces('Work Sans', 'Anton', 'Space Mono'),
    roles: {
      editor: 'Work Sans',
      heading: 'Anton',
      headingWeight: 400,
      headingTransform: 'uppercase',
      headingTracking: '0.01em',
      headingScale: 1.28,
      ui: 'Work Sans',
      mono: 'Space Mono',
    },
  },
  {
    id: 'neo',
    name: 'Neo',
    description: 'Unbounded titles over Manrope. Geometric, and very now.',
    faces: faces('Manrope', 'Unbounded', 'JetBrains Mono'),
    roles: {
      editor: 'Manrope',
      heading: 'Unbounded',
      headingWeight: 700,
      headingTracking: '-0.05em',
      headingScale: 1.02,
      ui: 'Manrope',
      mono: 'JetBrains Mono',
    },
  },
  {
    id: 'typewriter',
    name: 'Typewriter',
    description: 'Space Mono headings, letterspaced. The whole screen is a draft.',
    faces: faces('Space Mono'),
    roles: {
      editor: 'iA Writer Quattro',
      heading: 'Space Mono',
      headingWeight: 700,
      headingTransform: 'uppercase',
      headingTracking: '0.08em',
      ui: 'Space Mono',
      mono: 'Space Mono',
    },
  },
  {
    id: 'legible',
    name: 'Legible',
    description: 'Atkinson Hyperlegible and Lexend, set with more air than usual.',
    faces: faces('Atkinson Hyperlegible', 'Lexend', 'JetBrains Mono'),
    roles: {
      editor: 'Atkinson Hyperlegible',
      lineHeight: 1.78,
      heading: 'Lexend',
      headingWeight: 700,
      headingTracking: '-0.01em',
      headingScale: 1.08,
      ui: 'Atkinson Hyperlegible',
      mono: 'JetBrains Mono',
    },
  },
];

export const fontsPlugin = definePlugin({
  id: 'core.fonts',
  name: 'Font packs',
  description: 'Thirteen curated typeface pairings, for the Curated font option.',

  activate(spark: SparkApi) {
    for (const pack of PACKS) spark.themes.registerFonts(pack);
  },
});
