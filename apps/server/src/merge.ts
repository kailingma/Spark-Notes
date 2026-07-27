/**
 * Line-level three-way merge.
 *
 * This is what makes sync safe on the server. When two devices edit the same
 * page, the common case is that they touched different paragraphs — a merge
 * driver that understands that resolves it silently instead of asking the user
 * to pick a winner and lose half their writing. Only genuinely overlapping
 * edits produce conflict markers, and even then the merge keeps both sides.
 */

export interface MergeResult {
  text: string;
  /** Number of regions both sides changed incompatibly. */
  conflicts: number;
  clean: boolean;
}

export interface MergeLabels {
  ours: string;
  theirs: string;
}

/** Beyond this, quadratic LCS stops being worth it. Notes never get this big. */
const MAX_LINES = 20_000;

export function merge3(
  base: string,
  ours: string,
  theirs: string,
  labels: MergeLabels = { ours: 'local', theirs: 'remote' },
): MergeResult {
  if (ours === theirs) return { text: ours, conflicts: 0, clean: true };
  if (base === ours) return { text: theirs, conflicts: 0, clean: true };
  if (base === theirs) return { text: ours, conflicts: 0, clean: true };

  const baseLines = splitLines(base);
  const ourLines = splitLines(ours);
  const theirLines = splitLines(theirs);

  if (
    baseLines.length > MAX_LINES ||
    ourLines.length > MAX_LINES ||
    theirLines.length > MAX_LINES
  ) {
    return conflictWholeFile(ours, theirs, labels);
  }

  const ourChanges = changedRegions(baseLines, ourLines);
  const theirChanges = changedRegions(baseLines, theirLines);

  const out: string[] = [];
  let conflicts = 0;
  let baseIndex = 0;

  while (ourChanges.length > 0 || theirChanges.length > 0 || baseIndex < baseLines.length) {
    const nextOur = ourChanges[0]?.baseStart ?? Number.POSITIVE_INFINITY;
    const nextTheir = theirChanges[0]?.baseStart ?? Number.POSITIVE_INFINITY;
    const nextChange = Math.min(nextOur, nextTheir);

    // Stable run: neither side touched these base lines.
    if (nextChange > baseIndex) {
      const stop = Math.min(nextChange, baseLines.length);
      for (let i = baseIndex; i < stop; i++) out.push(baseLines[i]);
      baseIndex = stop;
      if (baseIndex >= baseLines.length && !Number.isFinite(nextChange)) break;
      if (nextChange > baseLines.length) break;
      continue;
    }

    // Collect every region from either side that overlaps this one, so an edit
    // spanning two of the other side's edits is treated as a single decision.
    let regionEnd = baseIndex;
    const oursTaken: Region[] = [];
    const theirsTaken: Region[] = [];

    // Seed with whichever side starts here.
    if (ourChanges[0]?.baseStart === baseIndex) {
      const region = ourChanges.shift()!;
      oursTaken.push(region);
      regionEnd = Math.max(regionEnd, region.baseStart + region.baseLength);
    }
    if (theirChanges[0]?.baseStart === baseIndex) {
      const region = theirChanges.shift()!;
      theirsTaken.push(region);
      regionEnd = Math.max(regionEnd, region.baseStart + region.baseLength);
    }

    let grew = true;
    while (grew) {
      grew = false;
      while (ourChanges.length > 0 && ourChanges[0].baseStart <= regionEnd) {
        const region = ourChanges.shift()!;
        oursTaken.push(region);
        const end = region.baseStart + region.baseLength;
        if (end > regionEnd) {
          regionEnd = end;
          grew = true;
        }
      }
      while (theirChanges.length > 0 && theirChanges[0].baseStart <= regionEnd) {
        const region = theirChanges.shift()!;
        theirsTaken.push(region);
        const end = region.baseStart + region.baseLength;
        if (end > regionEnd) {
          regionEnd = end;
          grew = true;
        }
      }
    }

    const ourText = sideText(oursTaken, ourLines, baseLines, baseIndex, regionEnd);
    const theirText = sideText(theirsTaken, theirLines, baseLines, baseIndex, regionEnd);

    if (oursTaken.length === 0) {
      out.push(...theirText);
    } else if (theirsTaken.length === 0) {
      out.push(...ourText);
    } else if (sameLines(ourText, theirText)) {
      // Both sides made the same edit — take it once.
      out.push(...ourText);
    } else {
      conflicts++;
      out.push(
        `<<<<<<< ${labels.ours}`,
        ...ourText,
        '=======',
        ...theirText,
        `>>>>>>> ${labels.theirs}`,
      );
    }

    baseIndex = regionEnd;
  }

  return {
    text: out.join('\n'),
    conflicts,
    clean: conflicts === 0,
  };
}

/** True when a file on disk still carries unresolved conflict markers. */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7} /m.test(text) && /^>{7} /m.test(text);
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

interface Region {
  baseStart: number;
  baseLength: number;
  otherStart: number;
  otherLength: number;
}

/**
 * The regions where `other` differs from `base`, derived from the longest
 * common subsequence of lines.
 */
function changedRegions(base: string[], other: string[]): Region[] {
  const matches = lcsMatches(base, other);
  const regions: Region[] = [];

  let baseAt = 0;
  let otherAt = 0;

  for (const [b, o] of [...matches, [base.length, other.length] as [number, number]]) {
    if (b > baseAt || o > otherAt) {
      regions.push({
        baseStart: baseAt,
        baseLength: b - baseAt,
        otherStart: otherAt,
        otherLength: o - otherAt,
      });
    }
    baseAt = b + 1;
    otherAt = o + 1;
  }

  return regions;
}

/** Index pairs of a longest common subsequence of lines. */
function lcsMatches(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];

  // Full O(n·m) table — bounded by MAX_LINES, and notes are far below it.
  const lengths: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i][j] =
        a[i] === b[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      matches.push([i, j]);
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return matches;
}

/**
 * The lines one side contributes for a base range. Regions carry their own
 * mapping; base lines the side left alone are copied through.
 */
function sideText(
  regions: Region[],
  otherLines: string[],
  baseLines: string[],
  baseStart: number,
  baseEnd: number,
): string[] {
  if (regions.length === 0) {
    return baseLines.slice(baseStart, baseEnd);
  }

  const first = regions[0];
  const last = regions[regions.length - 1];

  // Base lines before the first change and after the last one are untouched by
  // this side, so they translate 1:1.
  const leading = baseLines.slice(baseStart, first.baseStart);
  const trailing = baseLines.slice(last.baseStart + last.baseLength, baseEnd);

  const from = first.otherStart;
  const to = last.otherStart + last.otherLength;
  const changed = otherLines.slice(Math.max(0, from), Math.max(0, to));

  return [...leading, ...changed, ...trailing];
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function splitLines(text: string): string[] {
  return text.split('\n');
}

function conflictWholeFile(ours: string, theirs: string, labels: MergeLabels): MergeResult {
  return {
    text: [
      `<<<<<<< ${labels.ours}`,
      ours,
      '=======',
      theirs,
      `>>>>>>> ${labels.theirs}`,
    ].join('\n'),
    conflicts: 1,
    clean: false,
  };
}
