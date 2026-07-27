import { useEffect, useMemo, useState } from 'react';
import type { Task } from '@spark/plugin-sdk';
import { useApp } from '../app-context';

type Filter = 'open' | 'done' | 'all';

/**
 * The Tasks page — a view, not a file.
 *
 * Every `- [ ]` anywhere in the space appears here, and checking a box rewrites
 * the line in the page it came from. There is no task database and no task
 * object: a task is a line of markdown that happens to look like one, so tasks
 * stay attached to the thinking around them and survive this app entirely.
 */
export function TasksView() {
  const { tasks, refreshTasks, workspace, openPage, toast } = useApp();
  const [filter, setFilter] = useState<Filter>('open');
  const [tag, setTag] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // The index is maintained incrementally as pages save; a full rescan on open
  // catches anything changed outside the app (an editor, a git pull).
  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      if (task.done) continue;
      for (const name of task.tags) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [tasks]);

  const visible = useMemo(
    () =>
      tasks.filter((task) => {
        if (filter === 'open' && task.done) return false;
        if (filter === 'done' && !task.done) return false;
        if (tag && !task.tags.includes(tag)) return false;
        return true;
      }),
    [tasks, filter, tag],
  );

  const groups = useMemo(() => groupByDue(visible), [visible]);
  const openCount = tasks.filter((task) => !task.done).length;

  const toggle = async (task: Task) => {
    setBusy(task.id);
    try {
      await workspace.tasks.toggle(task);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="tasks">
      <div className="tasks-inner">
        <h1>Tasks</h1>
        <p className="tasks-sub">
          {openCount === 0
            ? 'Nothing open. Anything you write as “- [ ] …” shows up here.'
            : `${openCount} open across ${new Set(tasks.map((t) => t.page)).size} page${
                new Set(tasks.map((t) => t.page)).size === 1 ? '' : 's'
              }`}
        </p>

        <div className="tasks-filters">
          {(['open', 'done', 'all'] as Filter[]).map((option) => (
            <button
              key={option}
              className="mode"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
            >
              {option === 'open' ? 'Open' : option === 'done' ? 'Done' : 'All'}
            </button>
          ))}

          {tags.map(([name, count]) => (
            <button
              key={name}
              className="mode"
              aria-pressed={tag === name}
              onClick={() => setTag(tag === name ? null : name)}
            >
              #{name}
              <span className="mode-count">{count}</span>
            </button>
          ))}
        </div>

        {groups.length === 0 ? (
          <p className="palette-empty">Nothing here.</p>
        ) : (
          groups.map(([title, groupTasks]) => (
            <section className="tasks-group" key={title}>
              <h2 className="tasks-group-title">{title}</h2>
              {groupTasks.map((task) => (
                <div className="task" key={task.id} data-done={task.done}>
                  <input
                    type="checkbox"
                    checked={task.done}
                    disabled={busy === task.id}
                    onChange={() => void toggle(task)}
                    aria-label={task.text}
                  />
                  <div className="task-text">
                    <div>{task.text || '(empty task)'}</div>
                    <div className="task-meta">
                      <button className="task-source" onClick={() => openPage(task.page)}>
                        {task.page}
                      </button>
                      {task.due !== undefined && (
                        <span className="task-due" data-overdue={isOverdue(task)}>
                          {formatDue(task.due)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function isOverdue(task: Task): boolean {
  return !task.done && task.due !== undefined && task.due < startOfToday();
}

/** Due dates drive the grouping; undated work sits below it, by page. */
function groupByDue(tasks: Task[]): Array<[string, Task[]]> {
  const today = startOfToday();
  const tomorrow = today + 86_400_000;
  const weekEnd = today + 7 * 86_400_000;

  const buckets = new Map<string, Task[]>();
  const push = (key: string, task: Task) => {
    const list = buckets.get(key);
    if (list) list.push(task);
    else buckets.set(key, [task]);
  };

  for (const task of tasks) {
    if (task.done) push('Done', task);
    else if (task.due === undefined) push('No date', task);
    else if (task.due < today) push('Overdue', task);
    else if (task.due < tomorrow) push('Today', task);
    else if (task.due < weekEnd) push('This week', task);
    else push('Later', task);
  }

  const order = ['Overdue', 'Today', 'This week', 'Later', 'No date', 'Done'];
  return order
    .filter((key) => buckets.has(key))
    .map((key) => [key, buckets.get(key)!] as [string, Task[]]);
}

function formatDue(due: number): string {
  return new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
