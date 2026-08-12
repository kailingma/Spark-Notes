import { skills } from './skills.js';

/**
 * Slash commands.
 *
 * A command is a phrasing you would otherwise have to type out in full every
 * time, so it expands into instructions and disappears: the model never sees
 * `/journal`, it sees the paragraph `/journal` stands for. That keeps the whole
 * feature out of the agent loop — there is no command dispatcher, no branch per
 * command, and a command that expands into nothing behaves exactly like a message
 * that had no command in it.
 *
 * **Every skill is also a command.** Skills already carry a name, a description
 * and a `when` line, which is precisely what a command palette needs, and the
 * alternative — a second list of the same procedures — is two things to keep in
 * step. So `/weekly-review` is offered the moment `_skills/weekly-review/` exists,
 * and it expands into "read this skill and follow it", which is the instruction
 * that would otherwise have to be given by hand.
 *
 * The expansion is done on the server rather than in the browser so that the
 * prompt for a command is written once, next to the rest of the prompts, and a
 * conversation replayed from disk shows what the person typed rather than the
 * paragraph it turned into.
 */

export interface CommandInfo {
  /** Without the slash. */
  name: string;
  /** One line, shown in the menu. */
  description: string;
  /** What the argument means, when the command takes one. */
  argument?: string;
  /** Skills are listed apart from the built-ins, because they are yours. */
  kind: 'builtin' | 'skill';
}

interface Builtin extends CommandInfo {
  kind: 'builtin';
  /** The instruction the command stands for. `$ARG` is replaced by the argument. */
  expand: string;
}

const BUILTINS: Builtin[] = [
  {
    name: 'journal',
    kind: 'builtin',
    description: "Add this to today's journal page",
    argument: 'what to write',
    expand:
      'Write what follows into the daily journal page for today, in their own voice and as ordinary prose or list items — not as a report about what they said. Append rather than rewriting, create the page with its date heading if it does not exist yet, and then present it. Say in one sentence what you added and nothing else.',
  },
  {
    name: 'task',
    kind: 'builtin',
    description: 'Capture this as a task',
    argument: 'what needs doing',
    expand:
      'Turn what follows into "- [ ]" task lines and append them to the daily journal page for today, unless the wording names a better page, in which case use that one. One line per distinct thing. Do not editorialise and do not add tasks that were not said.',
  },
  {
    name: 'find',
    kind: 'builtin',
    description: 'Search the notes by meaning',
    argument: 'a phrase or a question',
    expand:
      'Search their notes for what follows, using `find` so that meaning counts as well as wording, and answer from what you find. Quote the passages that matter and name the pages they are on. If nothing matches, say so plainly rather than reasoning around the gap.',
  },
  {
    name: 'summarise',
    kind: 'builtin',
    description: 'Summarise a page, a folder or a stretch of time',
    argument: 'what to summarise',
    expand:
      'Summarise what follows. Read the pages first rather than working from what you remember of them. Give the summary in the conversation, in prose, and do not write it into a page unless you are asked to.',
  },
  {
    name: 'tasks',
    kind: 'builtin',
    description: 'What is open, across the whole space',
    expand:
      'List every open task in the space, grouped by the page it lives on, and say which ones look overdue or stale. Read them with `list_tasks` rather than searching for the text.',
  },
  {
    name: 'tidy',
    kind: 'builtin',
    description: 'Clean up a page without changing what it says',
    argument: 'which page',
    expand:
      'Tidy the page named below: fix heading levels so they nest properly, make list markers consistent, close unbalanced formatting, and remove duplicate blank lines. Do not reword anything, do not reorder sections, and do not delete content. Read the page, make the smallest set of edits that does it, and say what you changed.',
  },
  {
    name: 'plan',
    kind: 'builtin',
    description: 'Think it through before touching anything',
    argument: 'what to plan',
    expand:
      'Work out how you would do what follows and tell them, without changing anything yet. Read whatever you need in order to be concrete about which pages are involved. End with the one question whose answer would change the plan, if there is one.',
  },
  {
    name: 'web',
    kind: 'builtin',
    description: 'Look it up on the web, then answer',
    argument: 'what to look up',
    expand:
      'Look what follows up on the web with `web_search` before answering, and say where each claim came from. If web search is not available to you, say so rather than answering from memory.',
  },
  {
    name: 'remember',
    kind: 'builtin',
    description: 'Commit something to memory',
    argument: 'what to remember',
    expand:
      'Record what follows in your memory, choosing between an essential, a convention and a thread by what it actually is. Confirm it in one clause.',
  },
  {
    name: 'skills',
    kind: 'builtin',
    description: 'What procedures you have taught Spark',
    expand:
      'List the skills you have, with what each one is for and when you would reach for it, and say plainly if there are none.',
  },
];

/**
 * Everything offered in the menu, built-ins first.
 *
 * Skills come second and keep their own kind, so the UI can head them
 * differently: one list is the app's vocabulary and the other is yours, and
 * flattening them would make a procedure you wrote look like a feature you were
 * given.
 */
export async function listCommands(): Promise<CommandInfo[]> {
  const catalogue = await skills.list();
  const taken = new Set(BUILTINS.map((command) => command.name));

  return [
    ...BUILTINS.map(({ expand: _expand, ...info }) => info),
    ...catalogue
      // A skill that collides with a built-in keeps its name in the catalogue but
      // not in the menu, because the two would expand to different things and the
      // menu cannot say which you meant.
      .filter((skill) => !taken.has(skill.name))
      .map((skill): CommandInfo => ({
        name: skill.name,
        description: skill.description,
        argument: 'anything else to say',
        kind: 'skill',
      })),
  ];
}

export interface Expansion {
  /** The message as the model should read it. */
  message: string;
  /** The command that was used, for the transcript. */
  command?: string;
}

/**
 * Turns a leading `/command` into the instruction it stands for.
 *
 * Only a *leading* command, and only on the first line: `/` is a perfectly
 * ordinary character in the middle of a sentence about `journal/2026-07-29`, and
 * a parser that went looking for commands anywhere would eat page names.
 *
 * An unknown command is left exactly as typed rather than reported as an error.
 * The person may well mean it literally, and a turn that refuses to start because
 * it did not recognise a word is worse than one that passes the word along.
 */
export async function expandCommand(message: string): Promise<Expansion> {
  const match = /^\/([a-z][a-z0-9-]*)[ \t]*([\s\S]*)$/i.exec(message.trimStart());
  if (!match) return { message };

  const name = match[1].toLowerCase();
  const argument = match[2].trim();

  const builtin = BUILTINS.find((command) => command.name === name);
  if (builtin) {
    return {
      command: name,
      message: [
        `<instruction>${builtin.expand}</instruction>`,
        argument || '(no further detail was given — use your judgement, or ask one question.)',
      ].join('\n\n'),
    };
  }

  // A skill, checked against the folder rather than against the catalogue, so a
  // skill added a second ago works without anything having been re-listed.
  const catalogue = await skills.list();
  if (catalogue.some((skill) => skill.name === name)) {
    return {
      command: name,
      message: [
        `<instruction>Read the "${name}" skill with \`read_skill\` before doing anything else, then follow it. It is the procedure they want followed here, so where it disagrees with your instincts, it wins.</instruction>`,
        argument || '(no further detail was given — follow the skill as written.)',
      ].join('\n\n'),
    };
  }

  return { message };
}
