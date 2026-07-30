import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { streamCompletion } from './ai.js';
import type { ChatMessage } from './chats.js';
import { config } from './config.js';
import { RevisionConflict, type FileSpace } from './space.js';

/**
 * What Spark knows about the person it is talking to.
 *
 * The design question is not "how do we store memory" but "what is memory for,
 * given that this app already has a folder of the person's own writing". The
 * notes are already the record of what happened, what they think and who is in
 * their life; a second knowledge graph over the top of it would be an index that
 * can go stale, which is the one thing this app refuses to build. So memory here
 * holds only what the notes cannot:
 *
 * - **essentials** — facts about the person that would be embarrassing to
 *   forget, and which nothing in the notes says outright.
 * - **conventions** — how *this* space works and how they want Spark to behave.
 *   Where meeting notes go, what they call things, that they never want emoji.
 *   This is the memory that most improves a notes assistant, because otherwise
 *   Spark re-guesses the same house style every single turn.
 * - **threads** — open loops between the person and Spark. Written as markdown
 *   tasks, deliberately: that means they appear in the Tasks view like any other
 *   task, and ticking one there is how you tell Spark it is finished. No new
 *   mechanism, no second place to look.
 * - **buffer** — raw observations, not yet judged. Written during a turn, drained
 *   by consolidation.
 *
 * Four decisions worth keeping:
 *
 * 1. **Memory lives in the space, not in `.spark/`.** Conversations are kept
 *    outside the space because a chat is not a note; memory is the opposite. It
 *    is a claim about you, so you have to be able to read it, edit it in vim,
 *    delete a line you disagree with, sync it to your other machine and see its
 *    whole history in `git log memory/`. A memory you cannot audit is a memory
 *    you cannot trust, and an unauditable one in a private JSON file would be
 *    exactly the stale index the app exists to avoid.
 * 2. **Each file is a list of bullets.** Parsing is "lines starting with `- `",
 *    so a person editing one by hand cannot break the format. Anything they
 *    write that is *not* a bullet is preserved verbatim below the list, because
 *    someone will absolutely write a paragraph in there and losing it on the
 *    next pass would be unforgivable.
 * 3. **Consolidation is a user action with a lazy trigger.** It never runs on a
 *    timer. The product principle is that Spark does not speak first, and a
 *    background model call is speaking first even when nobody hears it. So the
 *    pass runs at the *end of a turn you asked for*, when the buffer has grown
 *    past a threshold or enough time has gone by, and there is a button for
 *    running it deliberately.
 * 4. **Consolidation never touches your notes.** It moves things between the
 *    four memory files and nothing else. An unattended pass that edits the pages
 *    you write in is a different and much larger promise than the one this
 *    feature makes; if something belongs in a note, Spark says so and you
 *    decide.
 */

export type MemoryKind = 'essentials' | 'conventions' | 'threads';

const PAGE_OF: Record<MemoryKind | 'buffer', string> = {
  essentials: 'memory/essentials',
  conventions: 'memory/conventions',
  threads: 'memory/threads',
  buffer: 'memory/buffer',
};

/** The generated preamble of each file, and what the file is for. */
const ABOUT: Record<MemoryKind | 'buffer', { title: string; blurb: string }> = {
  essentials: {
    title: 'Essentials',
    blurb:
      'Facts about you that Spark should never have to be told twice. Spark keeps this list; edit or delete any line and it will not be put back.',
  },
  conventions: {
    title: 'Conventions',
    blurb:
      'How this space works and how you want Spark to behave. These read as instructions, so a line you disagree with is worth deleting.',
  },
  threads: {
    title: 'Threads',
    blurb:
      'Open loops between you and Spark. They are ordinary markdown tasks, so they appear in Tasks — tick one there and Spark treats it as closed.',
  },
  buffer: {
    title: 'Buffer',
    blurb:
      'Raw observations Spark has not judged yet. Consolidation empties this into the other three files, or throws it away.',
  },
};

/** Caps. A memory that grows without bound stops being a memory. */
const LIMITS: Record<MemoryKind | 'buffer', number> = {
  essentials: 120,
  conventions: 80,
  threads: 60,
  buffer: 200,
};

/** One bullet may not be longer than this. Prose belongs in a note. */
const MAX_LINE = 400;

/** Observations that trigger a pass at the end of the next turn. */
const CONSOLIDATE_AFTER = 12;

/** …or this long since the last one, whichever comes first. */
const CONSOLIDATE_EVERY_MS = 4 * 60 * 60 * 1000;

export interface MemoryBullet {
  text: string;
  /** ISO date the line was written, when it carries one. */
  learned?: string;
  /** Threads only: whether the task is ticked. */
  done?: boolean;
  /** Threads only: an ISO date the person or Spark attached to it. */
  due?: string;
}

export interface MemoryFile {
  kind: MemoryKind | 'buffer';
  page: string;
  bullets: MemoryBullet[];
  /** Whatever a human wrote in the file that is not a bullet. */
  extra: string;
}

export interface MemorySnapshot {
  essentials: MemoryFile;
  conventions: MemoryFile;
  threads: MemoryFile;
  buffer: MemoryFile;
  /** When the last consolidation finished, or 0. */
  lastPass: number;
  /** Whether a pass is due, by either trigger. */
  due: boolean;
}

export interface ConsolidationReport {
  ran: boolean;
  /** Why it did not run, when it did not. */
  skipped?: string;
  promoted: number;
  merged: number;
  closed: number;
  discarded: number;
  /** One line for the transcript. */
  summary: string;
}

interface MemoryState {
  lastPass: number;
  passes: number;
  /** Chat message timestamp the last pass had already seen. */
  readThrough: number;
}

export class MemoryStore {
  #state: MemoryState = { lastPass: 0, passes: 0, readThrough: 0 };
  #loaded = false;

  constructor(private readonly space: FileSpace) {}

  get #file(): string {
    return join(config.stateDir, 'memory.json');
  }

  /**
   * Bookkeeping only — when the last pass ran, and how far through the chat log
   * it had read. The memory itself is in the space; this is the derived state
   * that says what has already been looked at, and losing it costs one
   * redundant pass rather than any content.
   */
  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as Partial<MemoryState>;
      this.#state = {
        lastPass: Number(parsed.lastPass) || 0,
        passes: Number(parsed.passes) || 0,
        readThrough: Number(parsed.readThrough) || 0,
      };
    } catch {
      /* no state yet: a first pass will do the work of one */
    }
  }

  async #saveState(): Promise<void> {
    await mkdir(config.stateDir, { recursive: true });
    await writeFile(this.#file, JSON.stringify(this.#state, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async snapshot(): Promise<MemorySnapshot> {
    await this.load();
    const [essentials, conventions, threads, buffer] = await Promise.all([
      this.#readFile('essentials'),
      this.#readFile('conventions'),
      this.#readFile('threads'),
      this.#readFile('buffer'),
    ]);

    return {
      essentials,
      conventions,
      threads,
      buffer,
      lastPass: this.#state.lastPass,
      due:
        buffer.bullets.length >= CONSOLIDATE_AFTER ||
        (buffer.bullets.length > 0 && Date.now() - this.#state.lastPass > CONSOLIDATE_EVERY_MS),
    };
  }

  async #readFile(kind: MemoryKind | 'buffer'): Promise<MemoryFile> {
    const page = PAGE_OF[kind];
    let text = '';
    try {
      text = (await this.space.read(page)).text;
    } catch {
      /* nothing learned yet */
    }
    return { kind, page, ...parseMemory(text) };
  }

  /**
   * The part of the system prompt that carries what Spark knows.
   *
   * Everything is labelled as notes rather than as orders, with one deliberate
   * exception: conventions *are* orders, because the person wrote them or
   * approved them. That distinction is the whole reason they are two files and
   * not one — a fact and a rule want different treatment, and collapsing them
   * would mean either ignoring the rules or obeying the facts.
   */
  promptSection(snapshot: MemorySnapshot): string | null {
    const parts: string[] = [];

    if (snapshot.essentials.bullets.length > 0) {
      parts.push(
        'Things you have learned about this person. Treat them as true unless what they say now contradicts one, in which case believe them and record the correction.',
        '',
        ...snapshot.essentials.bullets.map((bullet) => `- ${bullet.text}`),
      );
    }

    if (snapshot.conventions.bullets.length > 0) {
      parts.push(
        '',
        'How they want you to work. These are their instructions and they outrank your own defaults.',
        '',
        ...snapshot.conventions.bullets.map((bullet) => `- ${bullet.text}`),
      );
    }

    const open = snapshot.threads.bullets.filter((bullet) => !bullet.done);
    if (open.length > 0) {
      parts.push(
        '',
        'Open threads between you and them. Do not raise these unprompted unless they are relevant to what is being asked.',
        '',
        ...open.map((bullet) => `- ${bullet.text}${bullet.due ? ` (due ${bullet.due})` : ''}`),
      );
    }

    if (parts.length === 0) return null;

    return [
      '## What you know',
      '',
      "This is your own memory of them, kept in their space at \"memory/\" so they can read and edit it. When you learn something durable, record it with the `remember` tool rather than trusting it to this conversation, which ends.",
      '',
      ...parts,
    ].join('\n');
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Adds a line, refusing a near-duplicate.
   *
   * Dedup is on normalised text rather than anything cleverer: the failure this
   * prevents is the same fact arriving in slightly different words on twenty
   * consecutive turns, and comparing letters catches nearly all of it for
   * nothing. Genuine rewording gets merged by consolidation, which can read.
   */
  async add(
    kind: MemoryKind,
    text: string,
    options: { due?: string } = {},
  ): Promise<{ added: boolean; reason?: string }> {
    const clean = tidy(text);
    if (!clean) return { added: false, reason: 'the text was empty' };

    type Outcome = { added: boolean; reason?: string };
    const { result } = await this.#update<Outcome>(kind, (bullets) => {
      if (bullets.some((bullet) => normalise(bullet.text) === normalise(clean))) {
        return { bullets, result: { added: false, reason: 'that is already recorded' } };
      }
      const next = [
        ...bullets,
        {
          text: clean,
          learned: today(),
          ...(kind === 'threads' ? { done: false, due: options.due } : {}),
        },
      ];
      return { bullets: next, result: { added: true } };
    });
    return result;
  }

  /**
   * Removes every line matching a phrase, case-insensitively.
   *
   * Substring rather than exact, because the person asking Spark to forget
   * something will quote the gist of it, not the line as stored.
   */
  async forget(kind: MemoryKind, match: string): Promise<number> {
    const needle = normalise(match);
    if (!needle) return 0;

    const { result } = await this.#update(kind, (bullets) => {
      const kept = bullets.filter((bullet) => !normalise(bullet.text).includes(needle));
      return { bullets: kept, result: bullets.length - kept.length };
    });
    return result;
  }

  /** Ticks a thread off. */
  async closeThread(match: string): Promise<number> {
    const needle = normalise(match);
    if (!needle) return 0;

    const { result } = await this.#update('threads', (bullets) => {
      let closed = 0;
      const next = bullets.map((bullet) => {
        if (bullet.done || !normalise(bullet.text).includes(needle)) return bullet;
        closed += 1;
        return { ...bullet, done: true };
      });
      return { bullets: next, result: closed };
    });
    return result;
  }

  /**
   * Records something Spark noticed but has not judged.
   *
   * The buffer is where the cheap half of learning happens: appending is one
   * file write and no model call, so Spark can be liberal about it, and the
   * expensive judgement — is this durable, does it contradict something, is it
   * worth keeping at all — is deferred to one pass over the lot.
   */
  async observe(text: string, source = 'conversation'): Promise<void> {
    const clean = tidy(text);
    if (!clean) return;
    await this.#update('buffer', (bullets) => {
      if (bullets.some((bullet) => normalise(bullet.text) === normalise(clean))) {
        return { bullets, result: undefined };
      }
      return {
        bullets: [...bullets, { text: `${clean} (${source}, ${today()})` }],
        result: undefined,
      };
    });
  }

  /**
   * Reads, transforms and writes one memory file.
   *
   * The write carries the revision that was just read, so a person editing
   * `memory/essentials` in the editor while Spark writes to it gets the ordinary
   * conflict machinery rather than a silent clobber. One retry, because the
   * likeliest cause of a conflict is Spark's own previous write in the same turn
   * and retrying resolves that immediately; a second failure is a real
   * concurrent edit and belongs to the person, so it is reported.
   */
  async #update<T>(
    kind: MemoryKind | 'buffer',
    change: (bullets: MemoryBullet[]) => { bullets: MemoryBullet[]; result: T },
  ): Promise<{ result: T }> {
    const page = PAGE_OF[kind];

    for (let attempt = 0; attempt < 2; attempt++) {
      let text = '';
      let rev = '';
      try {
        const current = await this.space.read(page);
        text = current.text;
        rev = current.rev;
      } catch {
        text = '';
        rev = '';
      }

      const parsed = parseMemory(text);
      const { bullets, result } = change(parsed.bullets);
      const capped = capBullets(kind, bullets);

      try {
        await this.space.write(page, renderMemory(kind, capped, parsed.extra), rev);
        return { result };
      } catch (err) {
        if (!(err instanceof RevisionConflict) || attempt === 1) throw err;
      }
    }

    throw new Error(`"${page}" is being edited right now. Try again in a moment.`);
  }

  // -------------------------------------------------------------------------
  // Consolidation
  // -------------------------------------------------------------------------

  /**
   * The pass that turns observations into memory.
   *
   * One model call. It is handed the current three lists, the buffer, and the
   * turns of conversation the last pass had not seen, and it answers with the
   * *new* contents of the three lists plus a count of what it threw away. It
   * returns whole lists rather than a stream of edit operations for two reasons:
   * the lists are short enough that rewriting one costs nothing, and a diff is
   * something a person can read in `git log memory/` afterwards, which is a
   * better audit trail than a log of operations nobody will open.
   *
   * `readThrough` moves whether or not the model found anything, so a pass that
   * decides everything was noise does not reconsider the same noise in four
   * hours' time.
   */
  async consolidate(
    recent: ChatMessage[],
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<ConsolidationReport> {
    await this.load();
    const snapshot = await this.snapshot();

    const unseen = recent.filter((message) => message.at > this.#state.readThrough);
    if (!options.force && !snapshot.due) {
      return quiet('nothing new to consolidate');
    }
    if (snapshot.buffer.bullets.length === 0 && unseen.length === 0) {
      return quiet('nothing new to consolidate');
    }

    const prompt = consolidationPrompt(snapshot, unseen);

    let raw = '';
    for await (const chunk of streamCompletion({
      prompt,
      system: CONSOLIDATE_SYSTEM,
      signal: options.signal,
    })) {
      raw += chunk;
      // A model that ignores "answer with JSON only" can produce an essay. The
      // cap is generous enough for the largest legitimate answer and small
      // enough that a runaway generation is not paid for in full.
      if (raw.length > 60_000) break;
    }

    const decision = parseDecision(raw);
    if (!decision) {
      return {
        ran: false,
        skipped: 'the consolidation reply could not be read',
        promoted: 0,
        merged: 0,
        closed: 0,
        discarded: 0,
        summary: 'Memory was left alone: the consolidation reply could not be read.',
      };
    }

    const before = {
      essentials: snapshot.essentials.bullets.length,
      conventions: snapshot.conventions.bullets.length,
      threads: snapshot.threads.bullets.filter((bullet) => !bullet.done).length,
    };

    await this.#replace('essentials', decision.essentials, snapshot.essentials);
    await this.#replace('conventions', decision.conventions, snapshot.conventions);
    await this.#replaceThreads(decision.threads, snapshot.threads);
    // The buffer is emptied whatever the outcome. Anything worth keeping is now
    // in one of the three lists; anything not is what "discarded" means.
    await this.#drainBuffer();

    const after = await this.snapshot();
    const promoted =
      Math.max(0, after.essentials.bullets.length - before.essentials) +
      Math.max(0, after.conventions.bullets.length - before.conventions);
    const openAfter = after.threads.bullets.filter((bullet) => !bullet.done).length;
    const closed = Math.max(0, before.threads - openAfter);

    this.#state.lastPass = Date.now();
    this.#state.passes += 1;
    this.#state.readThrough = Math.max(
      this.#state.readThrough,
      ...unseen.map((message) => message.at),
      0,
    );
    await this.#saveState();

    const discarded = Math.max(0, snapshot.buffer.bullets.length - promoted);

    return {
      ran: true,
      promoted,
      merged: decision.merged ?? 0,
      closed,
      discarded,
      summary:
        decision.summary?.trim() ||
        `Consolidated memory: ${promoted} kept, ${closed} thread${closed === 1 ? '' : 's'} closed, ${discarded} discarded.`,
    };
  }

  /** True when the next turn should finish with a pass. */
  async isDue(): Promise<boolean> {
    return (await this.snapshot()).due;
  }

  async #replace(kind: 'essentials' | 'conventions', lines: string[], current: MemoryFile): Promise<void> {
    const existing = new Map(current.bullets.map((bullet) => [normalise(bullet.text), bullet]));
    const next: MemoryBullet[] = [];
    const seen = new Set<string>();

    for (const line of lines) {
      const clean = tidy(line);
      if (!clean) continue;
      const key = normalise(clean);
      if (seen.has(key)) continue;
      seen.add(key);
      // A line that survived keeps the date it was first learned. Otherwise
      // every pass would reset the whole file to today and the dates would stop
      // meaning anything.
      next.push({ text: clean, learned: existing.get(key)?.learned ?? today() });
    }

    await this.#update(kind, () => ({ bullets: next, result: undefined }));
  }

  /**
   * Threads, where the person's own ticks have to survive the pass.
   *
   * A thread ticked off in the Tasks view is the person saying "done", and a
   * consolidation that handed back the same line unticked would silently reopen
   * it. So the stored `done` wins over anything the model says about a line it
   * already knew, and only genuinely new lines start open.
   */
  async #replaceThreads(lines: string[], current: MemoryFile): Promise<void> {
    const existing = new Map(current.bullets.map((bullet) => [normalise(bullet.text), bullet]));
    const next: MemoryBullet[] = [];
    const seen = new Set<string>();

    for (const line of lines) {
      // The model is asked for "(due …)" inline, so it is split off here for the
      // same reason it is split off when parsing a file: one representation.
      const { text: clean, due } = splitDue(tidy(line.replace(/^\[[ xX]\]\s*/, '')));
      if (!clean) continue;
      const key = normalise(clean);
      if (seen.has(key)) continue;
      seen.add(key);

      const was = existing.get(key);
      next.push({
        text: clean,
        learned: was?.learned ?? today(),
        done: was?.done ?? false,
        due: was?.due ?? due,
      });
    }

    // A thread the person already ticked is kept even if the model dropped it,
    // so "what did I finish" stays answerable for as long as the file does.
    for (const bullet of current.bullets) {
      if (bullet.done && !seen.has(normalise(bullet.text))) next.push(bullet);
    }

    await this.#update('threads', () => ({ bullets: next, result: undefined }));
  }

  async #drainBuffer(): Promise<void> {
    await this.#update('buffer', () => ({ bullets: [], result: undefined }));
  }
}

// ---------------------------------------------------------------------------
// The file format
// ---------------------------------------------------------------------------

const BULLET_RE = /^\s*[-*+]\s+(.*)$/;
const TASK_RE = /^\[([ xX])\]\s*(.*)$/;
const LEARNED_RE = /\s*\((?:learned\s+)?(\d{4}-\d{2}-\d{2})\)\s*$/;
const DUE_RE = /\(due\s+(\d{4}-\d{2}-\d{2})\)/;

/**
 * Reads a memory file.
 *
 * Bullets are the memory; everything else is the person's, and it comes back
 * out in `extra` so it can be written straight back. The generated preamble is
 * recognised and dropped rather than preserved, because it is regenerated — and
 * a heading or a blockquote that happens to look like ours is not worth
 * defending against, since the worst case is one duplicated line in a file the
 * person can see.
 */
export function parseMemory(text: string): { bullets: MemoryBullet[]; extra: string } {
  const bullets: MemoryBullet[] = [];
  const extra: string[] = [];

  for (const line of text.split('\n')) {
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      const parsed = parseBullet(bullet[1]);
      if (parsed) bullets.push(parsed);
      continue;
    }
    if (isGenerated(line)) continue;
    extra.push(line);
  }

  return { bullets, extra: extra.join('\n').trim() };
}

function parseBullet(body: string): MemoryBullet | null {
  let rest = body.trim();
  if (!rest) return null;

  let done: boolean | undefined;
  const task = TASK_RE.exec(rest);
  if (task) {
    done = task[1].toLowerCase() === 'x';
    rest = task[2].trim();
  }

  let learned: string | undefined;
  const stamp = LEARNED_RE.exec(rest);
  if (stamp) {
    learned = stamp[1];
    rest = rest.slice(0, stamp.index).trim();
  }

  // The due date is lifted *out* of the text, not just read from it, so `text` is
  // the statement alone. Leaving it in place would show the date twice on the
  // Memory page — once in the line and once in its own chip — and would send it
  // to the model twice as well.
  const { text, due } = splitDue(rest);

  if (!text) return null;
  return { text: text.slice(0, MAX_LINE), learned, done, due };
}

/** Pulls `(due YYYY-MM-DD)` off a line, wherever in it the writer put it. */
function splitDue(line: string): { text: string; due?: string } {
  const match = DUE_RE.exec(line);
  if (!match) return { text: line.trim() };
  return {
    text: `${line.slice(0, match.index)}${line.slice(match.index + match[0].length)}`
      .replace(/\s{2,}/g, ' ')
      .trim(),
    due: match[1],
  };
}

function isGenerated(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#')) return true;
  if (trimmed.startsWith('<!--')) return true;
  return Object.values(ABOUT).some((about) => trimmed === about.blurb);
}

/** Writes a memory file: fixed preamble, the bullets, then whatever was theirs. */
export function renderMemory(
  kind: MemoryKind | 'buffer',
  bullets: MemoryBullet[],
  extra: string,
): string {
  const about = ABOUT[kind];
  const lines = [`# ${about.title}`, '', about.blurb, ''];

  if (bullets.length === 0) {
    lines.push('<!-- Nothing yet. -->');
  } else {
    for (const bullet of bullets) {
      const box = kind === 'threads' ? `[${bullet.done ? 'x' : ' '}] ` : '';
      // The due date is written back out because it is only ever *held* in the
      // text: `text` is the pure statement and `due` is parsed off it, so a
      // renderer that forgot this dropped the date on the first write and the
      // thread quietly lost its deadline.
      const when = bullet.due ? ` (due ${bullet.due})` : '';
      const stamp = bullet.learned ? ` (${bullet.learned})` : '';
      lines.push(`- ${box}${bullet.text}${when}${stamp}`);
    }
  }

  if (extra.trim()) lines.push('', extra.trim());
  return `${lines.join('\n')}\n`;
}

/**
 * Keeps a list under its cap, oldest first out.
 *
 * Threads are the exception: a ticked one is dropped before an open one, since
 * an open loop is the only kind that still has work in it.
 */
function capBullets(kind: MemoryKind | 'buffer', bullets: MemoryBullet[]): MemoryBullet[] {
  const limit = LIMITS[kind];
  if (bullets.length <= limit) return bullets;
  if (kind !== 'threads') return bullets.slice(bullets.length - limit);

  const open = bullets.filter((bullet) => !bullet.done);
  const done = bullets.filter((bullet) => bullet.done);
  const keptDone = done.slice(Math.max(0, done.length - Math.max(0, limit - open.length)));
  return [...open.slice(Math.max(0, open.length - limit)), ...keptDone];
}

// ---------------------------------------------------------------------------
// The consolidation prompt
// ---------------------------------------------------------------------------

const CONSOLIDATE_SYSTEM = `You maintain the long-term memory of Spark, an assistant that lives inside someone's markdown notes. You are not talking to anybody: you are tidying four lists, and your entire answer is one JSON object.

You are given three kept lists and a buffer of raw observations, plus any recent conversation the last pass had not read. Decide, for every item in the buffer and the conversation, exactly one of:

- **keep it** — it is durable and belongs in essentials, conventions or threads
- **merge it** — it says the same thing as a line already kept, in which case rewrite that line to hold both and do not add a second one
- **throw it away** — it was true only in the moment, or it is already obvious from the person's notes, or it is a detail nobody will need again

Throwing things away is the point. A memory of everything is a transcript, and they already have one. Be strict: if you would not want to read this line at the top of every future conversation, it does not go in.

What belongs where:

- **essentials** — facts about the person that would be embarrassing to forget and that their notes do not say outright. Their name and the people around them, their work, constraints that persist, standing preferences about their life. Not events; events are what their journal is for.
- **conventions** — how their space is organised and how they want Spark to behave. Where a kind of note goes, what they call things, how they want to be written to, a correction they have made about your behaviour. Phrase each as an instruction.
- **threads** — commitments and open loops, one line each, phrased as something to be done. Add "(due YYYY-MM-DD)" when a date is genuinely known. Drop a thread that has plainly been dealt with.

A **correction** — the person telling you that something you believed or did was wrong — is the highest-value thing you will see. It goes straight in, replacing whatever it contradicts.

Rules for the lists you return:
- Return each list in full, as it should now read. A line you omit is a line deleted.
- Keep every line that is still true, in its existing words unless you are merging.
- One fact per line, under 200 characters, no markdown formatting, no bullet marker, no leading checkbox.
- Never invent anything. If the material does not support a line, it does not exist.
- Never write anything the person would be alarmed to find written down about them.

Answer with this object and nothing else — no prose before it, no code fence:

{"essentials": ["…"], "conventions": ["…"], "threads": ["…"], "merged": 0, "summary": "one sentence, past tense, what you changed"}`;

function consolidationPrompt(snapshot: MemorySnapshot, unseen: ChatMessage[]): string {
  const list = (file: MemoryFile) =>
    file.bullets.length === 0
      ? '(empty)'
      : file.bullets
          .map(
            (bullet) =>
              `- ${file.kind === 'threads' && bullet.done ? '[done] ' : ''}${bullet.text}` +
              // The date goes back in, because the model is asked to hand these
              // lists back in full and a date it was never shown is a date it
              // cannot return.
              (bullet.due ? ` (due ${bullet.due})` : ''),
          )
          .join('\n');

  const conversation = unseen
    .slice(-30)
    .map((message) => `${message.role === 'user' ? 'Them' : 'You'}: ${message.text.slice(0, 1200)}`)
    .join('\n\n');

  return [
    '<essentials>',
    list(snapshot.essentials),
    '</essentials>',
    '',
    '<conventions>',
    list(snapshot.conventions),
    '</conventions>',
    '',
    '<threads>',
    list(snapshot.threads),
    '</threads>',
    '',
    '<buffer>',
    list(snapshot.buffer),
    '</buffer>',
    '',
    '<recent-conversation>',
    conversation || '(none since the last pass)',
    '</recent-conversation>',
    '',
    `Today is ${today()}.`,
  ].join('\n');
}

interface Decision {
  essentials: string[];
  conventions: string[];
  threads: string[];
  merged?: number;
  summary?: string;
}

/**
 * Reads the model's answer.
 *
 * A fenced block and a sentence of preamble are both common enough that
 * refusing them would make the pass fail for a reason nobody can act on, so the
 * first `{` to the last `}` is what gets parsed. A missing list is treated as
 * "unchanged" rather than "empty", because the cost of the two mistakes is not
 * remotely the same: one skips an update, the other deletes everything Spark
 * knows.
 */
function parseDecision(raw: string): Decision | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const strings = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null;

  const essentials = strings(parsed.essentials);
  const conventions = strings(parsed.conventions);
  const threads = strings(parsed.threads);
  if (!essentials && !conventions && !threads) return null;

  return {
    essentials: essentials ?? [],
    conventions: conventions ?? [],
    threads: threads ?? [],
    merged: Number(parsed.merged) || 0,
    summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
  };
}

// ---------------------------------------------------------------------------

function quiet(reason: string): ConsolidationReport {
  return { ran: false, skipped: reason, promoted: 0, merged: 0, closed: 0, discarded: 0, summary: '' };
}

/** One line, no newlines, no control characters, capped. */
function tidy(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[-*+]\s+/, '')
    .trim()
    .slice(0, MAX_LINE);
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export const MEMORY_PAGES = PAGE_OF;
