import { useEffect, useMemo, useRef, useState } from 'react';
import { isValidPageName, normalizePageName, pageBasename } from '@spark/core';
import type { Command } from '@spark/plugin-sdk';
import { useApp } from '../app-context';
import { modKey } from '../lib/device';

interface Entry {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  run: () => void | Promise<void>;
}

/**
 * One palette for everything: jump to a page, run a command, create a page.
 *
 * Splitting "open file" and "run command" into two shortcuts makes people
 * remember which is which. Here the query decides — a `>` prefix means
 * commands, anything else searches pages first and falls through to commands,
 * and a query that matches nothing offers to create that page.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { workspace, pages, openPage, registryVersion, toast } = useApp();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const commandsOnly = query.startsWith('>');
  const search = (commandsOnly ? query.slice(1) : query).trim().toLowerCase();

  const commands = useMemo(
    () => workspace.registry.availableCommands(),
    // Recomputed whenever a plugin registers or unregisters something.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace, registryVersion],
  );

  const entries = useMemo<Entry[]>(() => {
    const result: Entry[] = [];

    if (!commandsOnly) {
      const matches = pages
        .filter((page) => !search || fuzzyMatch(page.name.toLowerCase(), search))
        .slice(0, 30);

      for (const page of matches) {
        result.push({
          id: `page:${page.name}`,
          label: pageBasename(page.name),
          hint: page.name.includes('/') ? page.name : undefined,
          run: () => openPage(page.name),
        });
      }
    }

    const commandMatches = commands.filter(
      (command) => !search || fuzzyMatch(commandLabel(command).toLowerCase(), search),
    );

    for (const command of commandMatches.slice(0, 30)) {
      result.push({
        id: `cmd:${command.id}`,
        label: command.name,
        hint: command.category,
        shortcut: command.key ? prettyKey(command.key) : undefined,
        run: () => command.run(),
      });
    }

    // Nothing matched, but the query is a usable page name — offer to make it.
    const name = normalizePageName(commandsOnly ? '' : query);
    if (
      !commandsOnly &&
      name &&
      isValidPageName(name) &&
      !pages.some((page) => page.name.toLowerCase() === name.toLowerCase())
    ) {
      result.push({
        id: 'create',
        label: `Create “${name}”`,
        hint: 'New page',
        run: () => openPage(name),
      });
    }

    return result;
  }, [commandsOnly, search, query, pages, commands, openPage]);

  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = async (entry: Entry | undefined) => {
    if (!entry) return;
    onClose();
    try {
      await entry.run();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((n) => (entries.length ? (n + 1) % entries.length : 0));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((n) => (entries.length ? (n - 1 + entries.length) % entries.length : 0));
        break;
      case 'Enter':
        event.preventDefault();
        void choose(entries[active]);
        break;
      case 'Escape':
        event.preventDefault();
        onClose();
        break;
    }
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          className="palette-input"
          autoFocus
          value={query}
          placeholder={`Search pages, or type > for commands`}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Search pages and commands"
        />

        {entries.length === 0 ? (
          <p className="palette-empty">Nothing matches “{search}”.</p>
        ) : (
          <ul className="palette-list" ref={listRef}>
            {entries.map((entry, index) => (
              <li key={entry.id}>
                <button
                  className="palette-item"
                  data-active={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => void choose(entry)}
                >
                  <span>{entry.label}</span>
                  {entry.hint && <em>{entry.hint}</em>}
                  {entry.shortcut && <small>{entry.shortcut}</small>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function commandLabel(command: Command): string {
  return command.category ? `${command.category} ${command.name}` : command.name;
}

/** Subsequence match: "opn tsk" finds "Open tasks". */
function fuzzyMatch(haystack: string, needle: string): boolean {
  let index = 0;
  for (const char of needle) {
    if (char === ' ') continue;
    index = haystack.indexOf(char, index);
    if (index === -1) return false;
    index++;
  }
  return true;
}

function prettyKey(key: string): string {
  return key
    .replace(/Mod/g, modKey)
    .replace(/Shift/g, '⇧')
    .replace(/Alt/g, '⌥')
    .replace(/Enter/g, '↵')
    .replace(/-/g, '');
}
