#!/usr/bin/env node
/**
 * Downloads the typefaces the appearance settings can switch between.
 *
 * All are under the SIL Open Font License, so they can ship with the app.
 *
 * **The three named modes** — what Sans, Serif and Mono mean:
 *
 *   iA Writer Mono    monospace — code, tables, and the mono mode of both fonts
 *   iA Writer Quattro the original reading face, kept as the sans fallback
 *   Inter             sans-serif reading mode
 *   Source Serif 4    serif reading mode
 *   Fraunces          titles in serif mode, so a heading looks like a heading
 *   IBM Plex Sans     sans-serif interface mode
 *   IBM Plex Serif    serif interface mode
 *
 * The reading faces and the interface faces are deliberately different: Plex
 * was drawn as a system family for labels, buttons and dense rows, and an
 * interface set in the same face as the prose stops reading as chrome.
 *
 * **The curated packs** — the rest of the list, which the built-in fonts
 * extension (`apps/web/src/fonts.ts`) arranges into twelve pairings the Curated
 * font mode can wear. Variable wherever a variable version exists: one file
 * covers a whole weight axis, and for Archivo, Instrument Sans and Bricolage
 * Grotesque it covers a *width* axis too, which is what a stretched title is
 * actually made of. Italics are downloaded for the families whose italic is a
 * separate drawing rather than a slant, because that is where the expressive
 * titles come from.
 *
 * It is one command rather than two — around 12 MB, once — because a font that
 * has to be fetched separately is a font the Curated mode silently falls back
 * from, and "why does this pack look like Inter" is not a question anybody
 * should have to answer twice.
 *
 * They're fetched rather than committed to keep the repository free of
 * binaries — run `npm run fonts` once after cloning. Anything that fails to
 * download simply falls back to a system face; nothing here is required for the
 * app to run.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'apps', 'web', 'public', 'fonts');

const IA = 'https://raw.githubusercontent.com/iaolo/iA-Fonts/master';
const INTER = 'https://raw.githubusercontent.com/rsms/inter/master/docs/font-files';
const SOURCE_SERIF =
  'https://raw.githubusercontent.com/adobe-fonts/source-serif/release/WOFF2/TTF';
const GOOGLE = 'https://raw.githubusercontent.com/google/fonts/main/ofl';
const PLEX = 'https://raw.githubusercontent.com/IBM/plex/master/packages';

const FONTS = [
  [`${IA}/iA Writer Quattro/Webfonts/iAWriterQuattroS-Regular.woff2`, 'iAWriterQuattroS-Regular.woff2'],
  [`${IA}/iA Writer Quattro/Webfonts/iAWriterQuattroS-Italic.woff2`, 'iAWriterQuattroS-Italic.woff2'],
  [`${IA}/iA Writer Quattro/Webfonts/iAWriterQuattroS-Bold.woff2`, 'iAWriterQuattroS-Bold.woff2'],
  [`${IA}/iA Writer Quattro/Webfonts/iAWriterQuattroS-BoldItalic.woff2`, 'iAWriterQuattroS-BoldItalic.woff2'],
  [`${IA}/iA Writer Mono/Webfonts/iAWriterMonoS-Regular.woff2`, 'iAWriterMonoS-Regular.woff2'],
  [`${IA}/iA Writer Mono/Webfonts/iAWriterMonoS-Bold.woff2`, 'iAWriterMonoS-Bold.woff2'],

  [`${INTER}/Inter-Regular.woff2`, 'Inter-Regular.woff2'],
  [`${INTER}/Inter-Italic.woff2`, 'Inter-Italic.woff2'],
  [`${INTER}/Inter-Bold.woff2`, 'Inter-Bold.woff2'],
  [`${INTER}/Inter-BoldItalic.woff2`, 'Inter-BoldItalic.woff2'],

  [`${SOURCE_SERIF}/SourceSerif4-Regular.ttf.woff2`, 'SourceSerif4-Regular.woff2'],
  [`${SOURCE_SERIF}/SourceSerif4-It.ttf.woff2`, 'SourceSerif4-Italic.woff2'],
  [`${SOURCE_SERIF}/SourceSerif4-Bold.ttf.woff2`, 'SourceSerif4-Bold.woff2'],
  [`${SOURCE_SERIF}/SourceSerif4-BoldIt.ttf.woff2`, 'SourceSerif4-BoldItalic.woff2'],

  // A variable font: one file covers every weight the headings ask for.
  [`${GOOGLE}/fraunces/Fraunces[SOFT,WONK,opsz,wght].ttf`, 'Fraunces.ttf'],

  // The interface faces: four cuts each, taken from IBM's own repository
  // because Google's copy of Plex is TTF only and the sans one is a 540 kB
  // variable file — five times what the chrome's default face should cost.
  // Bold is SemiBold on purpose: Plex Bold is too much ink for a 12px label.
  ...['Regular', 'Italic', 'SemiBold', 'SemiBoldItalic'].flatMap((cut) => [
    [`${PLEX}/plex-sans/fonts/complete/woff2/IBMPlexSans-${cut}.woff2`, `IBMPlexSans-${cut}.woff2`],
    [`${PLEX}/plex-serif/fonts/complete/woff2/IBMPlexSerif-${cut}.woff2`, `IBMPlexSerif-${cut}.woff2`],
  ]),

  // --- The curated packs -------------------------------------------------
  //
  // Display and reading faces chosen as pairings rather than as a catalogue.
  // The italic of a high-contrast serif is the whole reason several of these
  // are here: it is the one thing a title can do that body text cannot.

  // Scotch-modern display with a dramatic italic — the Editorial pack's titles.
  [`${GOOGLE}/playfairdisplay/PlayfairDisplay[wght].ttf`, 'PlayfairDisplay.ttf'],
  [`${GOOGLE}/playfairdisplay/PlayfairDisplay-Italic[wght].ttf`, 'PlayfairDisplay-Italic.ttf'],

  // A news serif with a real optical-size axis, so it holds at reading size.
  [`${GOOGLE}/newsreader/Newsreader[opsz,wght].ttf`, 'Newsreader.ttf'],
  [`${GOOGLE}/newsreader/Newsreader-Italic[opsz,wght].ttf`, 'Newsreader-Italic.ttf'],

  // Tight, high-contrast, one weight. A headline face and nothing else.
  [`${GOOGLE}/instrumentserif/InstrumentSerif-Regular.ttf`, 'InstrumentSerif-Regular.ttf'],
  [`${GOOGLE}/instrumentserif/InstrumentSerif-Italic.ttf`, 'InstrumentSerif-Italic.ttf'],

  // Grotesks. Instrument Sans and Archivo both carry a width axis.
  [`${GOOGLE}/instrumentsans/InstrumentSans[wdth,wght].ttf`, 'InstrumentSans.ttf'],
  [`${GOOGLE}/instrumentsans/InstrumentSans-Italic[wdth,wght].ttf`, 'InstrumentSans-Italic.ttf'],
  [`${GOOGLE}/spacegrotesk/SpaceGrotesk[wght].ttf`, 'SpaceGrotesk.ttf'],
  [`${GOOGLE}/archivo/Archivo[wdth,wght].ttf`, 'Archivo.ttf'],
  [`${GOOGLE}/archivo/Archivo-Italic[wdth,wght].ttf`, 'Archivo-Italic.ttf'],
  [`${GOOGLE}/bricolagegrotesque/BricolageGrotesque[opsz,wdth,wght].ttf`, 'BricolageGrotesque.ttf'],
  [`${GOOGLE}/worksans/WorkSans[wght].ttf`, 'WorkSans.ttf'],
  [`${GOOGLE}/worksans/WorkSans-Italic[wght].ttf`, 'WorkSans-Italic.ttf'],
  [`${GOOGLE}/librefranklin/LibreFranklin[wght].ttf`, 'LibreFranklin.ttf'],
  [`${GOOGLE}/librefranklin/LibreFranklin-Italic[wght].ttf`, 'LibreFranklin-Italic.ttf'],
  [`${GOOGLE}/manrope/Manrope[wght].ttf`, 'Manrope.ttf'],

  // Didone and book serifs.
  [`${GOOGLE}/bodonimoda/BodoniModa[opsz,wght].ttf`, 'BodoniModa.ttf'],
  [`${GOOGLE}/bodonimoda/BodoniModa-Italic[opsz,wght].ttf`, 'BodoniModa-Italic.ttf'],
  [`${GOOGLE}/ebgaramond/EBGaramond[wght].ttf`, 'EBGaramond.ttf'],
  [`${GOOGLE}/ebgaramond/EBGaramond-Italic[wght].ttf`, 'EBGaramond-Italic.ttf'],
  [`${GOOGLE}/dmserifdisplay/DMSerifDisplay-Regular.ttf`, 'DMSerifDisplay-Regular.ttf'],
  [`${GOOGLE}/dmserifdisplay/DMSerifDisplay-Italic.ttf`, 'DMSerifDisplay-Italic.ttf'],

  // The italic half of Fraunces, whose WONK axis is a title with an opinion.
  // The upright is already above, for serif mode.
  [`${GOOGLE}/fraunces/Fraunces-Italic[SOFT,WONK,opsz,wght].ttf`, 'Fraunces-Italic.ttf'],

  // Poster weight: one very heavy condensed face, and one geometric.
  [`${GOOGLE}/anton/Anton-Regular.ttf`, 'Anton-Regular.ttf'],
  [`${GOOGLE}/unbounded/Unbounded[wght].ttf`, 'Unbounded.ttf'],

  // Legibility-first, for the pack of the same name.
  [`${GOOGLE}/atkinsonhyperlegible/AtkinsonHyperlegible-Regular.ttf`, 'AtkinsonHyperlegible-Regular.ttf'],
  [`${GOOGLE}/atkinsonhyperlegible/AtkinsonHyperlegible-Bold.ttf`, 'AtkinsonHyperlegible-Bold.ttf'],
  [`${GOOGLE}/atkinsonhyperlegible/AtkinsonHyperlegible-Italic.ttf`, 'AtkinsonHyperlegible-Italic.ttf'],
  [`${GOOGLE}/lexend/Lexend[wght].ttf`, 'Lexend.ttf'],

  // Monospaces, for the packs that want a different one from iA Writer Mono.
  [`${GOOGLE}/jetbrainsmono/JetBrainsMono[wght].ttf`, 'JetBrainsMono.ttf'],
  [`${GOOGLE}/jetbrainsmono/JetBrainsMono-Italic[wght].ttf`, 'JetBrainsMono-Italic.ttf'],
  [`${GOOGLE}/spacemono/SpaceMono-Regular.ttf`, 'SpaceMono-Regular.ttf'],
  [`${GOOGLE}/spacemono/SpaceMono-Italic.ttf`, 'SpaceMono-Italic.ttf'],
  [`${GOOGLE}/spacemono/SpaceMono-Bold.ttf`, 'SpaceMono-Bold.ttf'],
  ...['Regular', 'Italic', 'SemiBold'].map((cut) => [
    `${PLEX}/plex-mono/fonts/complete/woff2/IBMPlexMono-${cut}.woff2`,
    `IBMPlexMono-${cut}.woff2`,
  ]),
];

await mkdir(outDir, { recursive: true });

let failed = 0;
await Promise.all(
  FONTS.map(async ([remote, local]) => {
    // Only the path is escaped — the origin is already a valid URL.
    const cut = remote.indexOf('/', 'https://'.length);
    const url =
      remote.slice(0, cut) +
      remote
        .slice(cut)
        .split('/')
        .map(encodeURIComponent)
        .join('/');
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await writeFile(join(outDir, local), Buffer.from(await res.arrayBuffer()));
      console.log(`  ✓ ${local}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${local} — ${err.message}`);
    }
  }),
);

if (failed > 0) {
  console.error(
    `\n${failed} font(s) could not be downloaded. Spark falls back to system fonts until they are present.`,
  );
  process.exitCode = 1;
} else {
  console.log(`\nFonts written to ${outDir}`);
}
