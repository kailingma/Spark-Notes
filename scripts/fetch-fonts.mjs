#!/usr/bin/env node
/**
 * Downloads iA Writer Quattro and Mono into the web app's public folder.
 *
 * These are the typefaces SilverBullet uses, and they're released by iA under
 * the SIL Open Font License, so they can ship with the app. They're fetched
 * rather than committed to keep the repository free of binaries — run
 * `npm run fonts` once after cloning.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'apps', 'web', 'public', 'fonts');

const BASE = 'https://raw.githubusercontent.com/iaolo/iA-Fonts/master';

const FONTS = [
  ['iA Writer Quattro/Webfonts/iAWriterQuattroS-Regular.woff2', 'iAWriterQuattroS-Regular.woff2'],
  ['iA Writer Quattro/Webfonts/iAWriterQuattroS-Italic.woff2', 'iAWriterQuattroS-Italic.woff2'],
  ['iA Writer Quattro/Webfonts/iAWriterQuattroS-Bold.woff2', 'iAWriterQuattroS-Bold.woff2'],
  ['iA Writer Quattro/Webfonts/iAWriterQuattroS-BoldItalic.woff2', 'iAWriterQuattroS-BoldItalic.woff2'],
  ['iA Writer Mono/Webfonts/iAWriterMonoS-Regular.woff2', 'iAWriterMonoS-Regular.woff2'],
  ['iA Writer Mono/Webfonts/iAWriterMonoS-Bold.woff2', 'iAWriterMonoS-Bold.woff2'],
];

await mkdir(outDir, { recursive: true });

let failed = 0;
await Promise.all(
  FONTS.map(async ([remote, local]) => {
    const url = `${BASE}/${remote.split('/').map(encodeURIComponent).join('/')}`;
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
