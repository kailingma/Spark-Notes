import type { SpaceApi, Task } from '@spark/plugin-sdk';
import type { EventBus } from './events.js';
import { parseTasks, toggleTaskInText } from './markdown.js';

/**
 * The workspace-wide task index that backs the virtual Tasks page.
 *
 * The initial scan happens on the server, which can walk the markdown files
 * far faster than the browser can fetch them one by one. After that the index
 * is maintained incrementally: whenever a page's text changes we re-parse just
 * that page, so checking a box feels instant and never waits on a round trip.
 */
export class TaskIndex {
  #byPage = new Map<string, Task[]>();
  #loaded = false;

  constructor(
    private readonly space: SpaceApi,
    private readonly events: EventBus,
    private readonly endpoint = '/api/tasks',
  ) {}

  get loaded(): boolean {
    return this.#loaded;
  }

  /** Every task in the space, sorted for display. */
  all(): Task[] {
    const tasks: Task[] = [];
    for (const pageTasks of this.#byPage.values()) tasks.push(...pageTasks);
    return sortTasks(tasks);
  }

  byPage(page: string): Task[] {
    return this.#byPage.get(page) ?? [];
  }

  /** Full rescan from the server. */
  async refresh(): Promise<Task[]> {
    const res = await fetch(this.endpoint);
    if (!res.ok) throw new Error(`Task scan failed: ${res.status}`);
    const tasks = (await res.json()) as Task[];

    this.#byPage.clear();
    for (const task of tasks) {
      const list = this.#byPage.get(task.page);
      if (list) list.push(task);
      else this.#byPage.set(task.page, [task]);
    }
    this.#loaded = true;
    this.#emit();
    return this.all();
  }

  /**
   * Re-index a single page from text we already have in hand. Called on every
   * save so the Tasks page stays live while you type.
   */
  update(page: string, text: string): void {
    const tasks = parseTasks(page, text);
    const previous = this.#byPage.get(page);

    if (tasks.length === 0) {
      if (!previous) return;
      this.#byPage.delete(page);
    } else {
      if (previous && sameTasks(previous, tasks)) return;
      this.#byPage.set(page, tasks);
    }
    this.#emit();
  }

  remove(page: string): void {
    if (this.#byPage.delete(page)) this.#emit();
  }

  /**
   * Flips a task's checkbox and writes the page back. Returns the page's new
   * text so an open editor can adopt it without re-reading.
   */
  async toggle(task: Task, done = !task.done): Promise<string> {
    const page = await this.space.read(task.page);
    // Guard against the file having moved on underneath us: only write if the
    // line we are about to change still looks like the task we indexed.
    const currentLine = page.text.split('\n')[task.line];
    if (currentLine?.trim() !== task.raw.trim()) {
      await this.refresh();
      throw new Error(`"${task.page}" changed — the task list has been refreshed`);
    }

    const next = toggleTaskInText(page.text, task.line, done);
    await this.space.write(task.page, next);
    this.update(task.page, next);
    return next;
  }

  #emit(): void {
    this.events.emit('tasks:change', { tasks: this.all() });
  }
}

/** Open tasks first, then by due date, then by page and line. */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.due !== b.due) {
      if (a.due === undefined) return 1;
      if (b.due === undefined) return -1;
      return a.due - b.due;
    }
    if (a.page !== b.page) return a.page.localeCompare(b.page);
    return a.line - b.line;
  });
}

function sameTasks(a: Task[], b: Task[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((task, i) => task.raw === b[i].raw && task.line === b[i].line);
}
