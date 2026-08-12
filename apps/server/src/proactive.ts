import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import type { MemoryStore } from './memory.js';
import { sparkSettings } from './spark-settings.js';
import type { FileSpace } from './space.js';

/**
 * A background pass that runs without a live turn — off by default, and
 * narrow on purpose even once it is on.
 *
 * Everywhere else in this app, "Spark speaks first" is a rule, not a bug: a
 * turn only exists because someone asked for it. This is the one deliberate
 * exception, so it earns its keep by staying small in every direction that
 * matters:
 *
 * - **No timer.** The process does not wake itself up. A scan only happens
 *   inside a request that was already going to happen anyway — piggybacked
 *   on `/api/config`, which the client fetches on every app open — so a
 *   space that is never opened is never scanned, the same as a personal
 *   server that is not always running would want.
 * - **One narrow question, not a summary.** The scan does not read
 *   everything and decide what is "interesting" — that is a much bigger
 *   promise than this feature makes, and it is the one that would turn
 *   Spark into something that talks at you. It checks exactly two concrete
 *   things: a `memory/threads` entry with a due date that has passed, and a
 *   recently-edited page whose newest line reads like an open question. If
 *   neither is true, it finds nothing, and it says nothing.
 * - **A badge, never a message.** A finding is surfaced as a quiet mark on
 *   the panel's own toggle — see `SparkView.tsx` — never injected into a
 *   conversation, never a system notification. It is shown once and then
 *   acknowledged; it does not return once seen, and it never accumulates
 *   into a queue of things to catch up on.
 */

export interface ProactiveStatus {
  enabled: boolean;
  intervalHours: number;
  /** Epoch ms of the last scan, or 0 if none has run yet. */
  lastScan: number;
  /** Epoch ms the next scan becomes due. */
  nextDue: number;
}

interface ProactiveState {
  lastScan: number;
  /** The finding from the last scan that has not been shown yet. */
  pendingFinding: string | null;
}

/** How many of the most recently modified pages a question-scan will read. Cheap on purpose — this runs inside a bootstrap request. */
const RECENT_PAGE_SCAN_LIMIT = 15;

export class ProactiveScanner {
  #state: ProactiveState = { lastScan: 0, pendingFinding: null };
  #loaded = false;

  constructor(
    private readonly space: FileSpace,
    private readonly memory: MemoryStore,
  ) {}

  get #file(): string {
    return join(config.stateDir, 'proactive.json');
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as Partial<ProactiveState>;
      this.#state = {
        lastScan: Number(parsed.lastScan) || 0,
        pendingFinding: typeof parsed.pendingFinding === 'string' ? parsed.pendingFinding : null,
      };
    } catch {
      /* no state yet: an empty state is the same as "never scanned" */
    }
  }

  async #save(): Promise<void> {
    await mkdir(config.stateDir, { recursive: true });
    await writeFile(this.#file, JSON.stringify(this.#state, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  /** For Settings' "Scheduled" section — when this last ran and when it is next due, regardless of whether it is on. */
  async status(): Promise<ProactiveStatus> {
    await this.#load();
    const { enabled, intervalHours } = sparkSettings.get().proactiveScan;
    return {
      enabled,
      intervalHours,
      lastScan: this.#state.lastScan,
      nextDue: this.#state.lastScan + intervalHours * 60 * 60 * 1000,
    };
  }

  /**
   * Called on every `/api/config` bootstrap. Runs a scan if the setting is
   * on and one is due; either way, returns whatever finding is still
   * pending and unseen, for the panel toggle's badge.
   */
  async checkIn(): Promise<string | null> {
    const settings = sparkSettings.get().proactiveScan;
    if (!settings.enabled) return null;
    await this.#load();

    const due = Date.now() - this.#state.lastScan > settings.intervalHours * 60 * 60 * 1000;
    if (due) {
      const finding = await this.#scan(this.#state.lastScan).catch(() => null);
      this.#state = { lastScan: Date.now(), pendingFinding: finding };
      await this.#save();
    }
    return this.#state.pendingFinding;
  }

  /** The person opened the panel and (if there was one) saw the badge — it does not come back. */
  async acknowledge(): Promise<void> {
    await this.#load();
    if (this.#state.pendingFinding === null) return;
    this.#state.pendingFinding = null;
    await this.#save();
  }

  async #scan(since: number): Promise<string | null> {
    const overdue = (await this.memory.snapshot()).threads.bullets.filter(
      (bullet) => !bullet.done && bullet.due && bullet.due < today(),
    );
    if (overdue.length > 0) {
      return overdue.length === 1
        ? `An open thread is overdue: ${overdue[0].text}`
        : `${overdue.length} open threads are overdue.`;
    }

    return this.#findUnresolvedQuestion(since);
  }

  /**
   * A recently-edited page whose text still ends on a question — a
   * lightweight, honestly-limited heuristic rather than anything that reads
   * for meaning: it does not know a fenced code block from prose, and a
   * rhetorical "why?" reads the same as a real open one. What it catches is
   * narrow enough to be worth catching anyway, and what it misses just
   * means no badge, never a wrong one dressed up as a real finding.
   */
  async #findUnresolvedQuestion(since: number): Promise<string | null> {
    const pages = (await this.space.list())
      .filter((page) => page.modified > since)
      .slice(0, RECENT_PAGE_SCAN_LIMIT);

    for (const page of pages) {
      let text: string;
      try {
        text = (await this.space.read(page.name)).text;
      } catch {
        continue;
      }
      const line = [...text.split('\n')].reverse().find(isOpenQuestion);
      if (line) return `"${page.name}" still ends on a question: ${stripMarkup(line)}`;
    }
    return null;
  }
}

function isOpenQuestion(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 8 || !trimmed.endsWith('?')) return false;
  if (trimmed.startsWith('#')) return false;
  if (/^[-*+]\s*\[[ xX]\]/.test(trimmed)) return false; // a task, not a question — Tasks already covers this
  return true;
}

/** Strips a leading list marker, so a bulleted question reads as the sentence it is rather than as a stray "- ". */
function stripMarkup(line: string): string {
  return line.trim().replace(/^[-*+]\s+/, '');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
