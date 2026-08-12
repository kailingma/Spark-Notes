import type { FileSpace } from './space.js';

/**
 * First-run content.
 *
 * Written only when the space is completely empty, so it can never overwrite
 * anyone's notes. The welcome page doubles as a live demo — every feature it
 * describes is visible in the page itself as you read it.
 */
export async function seedSpace(space: FileSpace): Promise<boolean> {
  const existing = await space.list();
  if (existing.length > 0) return false;

  await space.write('Welcome', WELCOME, null);
  await space.write('_plugins/word-count.js', EXAMPLE_PLUGIN, null);
  // A skill, for the same reason there is an example plugin: `_skills/` is a
  // folder nobody will guess at, and one real file in it is worth a paragraph of
  // documentation about it.
  //
  // No `.md` on the name. `pathFor` adds the extension to anything that is not
  // one of the verbatim types, so `SKILL.md` here would land on disk as
  // `SKILL.md.md` — which the skill loader then does not find, silently.
  await space.write('_skills/weekly-review/SKILL', EXAMPLE_SKILL, null);
  return true;
}

const WELCOME = `# Welcome to Spark

This is a markdown file on disk. So is every other page — no database, no export
step, nothing to escape from if you ever want to leave.

Put your cursor on the next line and watch the asterisks come back.

Markdown **hides its own syntax** until you edit it, so notes read like *prose*
and stay ~~plain text~~ underneath.

## Tasks live everywhere, and gather in one place

- [ ] Try checking this box 📅 ${new Date().toISOString().slice(0, 10)}
- [ ] Write a task on any page — they all collect on the Tasks view
- [x] Ship a notes app that gets out of the way

Any \`- [ ]\` line, on any page, shows up under Tasks. Check it there and the
line in the original page is rewritten. Tasks are markdown, not records.

## Getting around

- \`⌘K\` — search pages, or type \`>\` for commands
- \`/\` in the editor — snippets, dates, AI
- \`[[Welcome]]\` — link to another page; click it to follow, or ⌘-click a URL
- \`⌘⇧C\` — quick capture from anywhere

On a phone Spark opens straight into a prompt with a mode switcher, so a thought
takes one tap instead of four. There's a voice button there too — talk, and it
transcribes as you go.

## Plugins

\`_plugins/word-count.js\` in this space is a working plugin. Edit it, reload, and
it changes. Plugins live in your notes folder, so they sync with everything else.

## Spark learns as you go

Ask Spark something in the right-hand panel. Correct it once — "meeting notes go
in \`meetings/\`" — and it writes that down in \`memory/conventions\`, which is a
markdown file you can read, edit or delete like any other. [[Memory]] shows
everything it thinks it knows.

\`_skills/weekly-review/SKILL.md\` is a **skill**: a job you want done a particular
way, written once. Spark is told what each skill is for and reads the
instructions when the job comes up. Write your own by copying that folder, or
just tell Spark how you want something done and ask it to remember.

## Sync

You're in **online mode**: every keystroke saves to the server, and what's on
screen is what's on disk. Connect a GitHub repository in the sync panel to also
push your notes on a schedule — Spark merges edits from other devices line by
line, so two people writing in different paragraphs never conflict.

---

Delete this page whenever you like. Nothing depends on it.
`;

/**
 * An example skill.
 *
 * Written as instructions addressed to Spark, not as documentation about Spark,
 * because that is the thing a skill *is* — and a person opening this file to copy
 * it should see the register they are meant to write in.
 */
const EXAMPLE_SKILL = `---
name: weekly-review
description: Gathers the week into one page — what got done, what slipped, what is next.
when: they ask for a weekly review, or say it is time to look back at the week
---

# Weekly review

## Gather first, write second

1. Read the journal pages for the last seven days.
2. List every task closed in that window, and every one still open.
3. Only then start writing. A review assembled while you are still reading it
   turns into a list of everything you found.

## The page

Create \\\`reviews/YYYY-MM-DD\\\` for the Sunday that ends the week, with:

- **What happened** — two or three sentences of prose, in their voice. Not a
  bulleted digest of the journal; they already have the journal.
- **Closed** — the tasks finished, as plain lines.
- **Still open** — the tasks that did not move, with the page each lives on.
- **Next week** — only what the notes actually support. Do not invent goals.

## Rules

Never edit the journal pages you read. A review is a new page that points at
them, so re-running it is always safe.

If a week is nearly empty, say so in one line and stop. A thin week padded into a
full page is worse than an honest short one.
`;

const EXAMPLE_PLUGIN = `import { definePlugin } from '@spark/plugin-sdk';

/**
 * An example plugin. It lives in your space, so it travels with your notes.
 *
 * Edit this file and reload the app to see your changes. Everything the
 * built-in features use is available here too — commands, slash commands,
 * inline widgets, storage, and AI.
 */
export default definePlugin({
  id: 'example.word-count',
  name: 'Word count',
  description: 'Reports the size of the current page.',

  activate(spark) {
    spark.commands.register({
      id: 'example.word-count.show',
      name: 'Count words on this page',
      category: 'Example',
      run() {
        const text = spark.editor.text().trim();
        const words = text ? text.split(/\\s+/).length : 0;
        const minutes = Math.max(1, Math.round(words / 220));
        spark.ui.toast(\`\${words} words · about \${minutes} min to read\`);
      },
    });

    // A slash command that inserts something computed.
    spark.slash.register({
      name: 'wordcount',
      description: 'Insert the current word count',
      run(editor) {
        const words = editor.text().trim().split(/\\s+/).filter(Boolean).length;
        editor.replaceSelection(\`\${words} words\`);
      },
    });

    // An inline widget: renders "!!important" as a badge, and shows the raw
    // text again whenever the cursor moves into it.
    spark.markdown.inline({
      pattern: /!!important/g,
      render() {
        const badge = document.createElement('span');
        badge.textContent = 'IMPORTANT';
        badge.style.cssText =
          'background:var(--danger);color:#fff;border-radius:4px;' +
          'padding:0.05em 0.4em;font-size:0.75em;letter-spacing:0.04em';
        return badge;
      },
    });
  },
});
`;
