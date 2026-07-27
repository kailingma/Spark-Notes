# Spark

Markdown notes with as little friction as possible.

Spark is a notes platform built around one idea: the fastest path from a thought
to a saved note should be nearly zero. It opens as a blank editor. Markdown
hides its own syntax until you edit it. On a phone it opens straight into a
prompt. Everything is a `.md` file on disk — no database, no export step, and
nothing to escape from if you ever want to leave.

The editor is [CodeMirror 6](https://codemirror.net) with a live-preview layer
in the spirit of [SilverBullet](https://silverbullet.md), including its
typeface, [iA Writer Quattro](https://github.com/iaolo/iA-Fonts).

---

## Quick start

```bash
npm install
npm run fonts     # downloads iA Writer Quattro + Mono (SIL OFL)
npm run dev       # server on :3001, app on :3000
```

Open <http://localhost:3000>. An empty space is seeded with a welcome page and a
working example plugin.

**Production**

```bash
npm run build     # builds the client
NODE_ENV=production npm start   # server serves the API and the built client on :3001
```

---

## Configuration

Everything is environment variables; every one has a working default.

| Variable | Default | What it does |
| --- | --- | --- |
| `SPARK_SPACE` | `./space` | The notes directory. **This is the database.** Point it at any folder of markdown. |
| `SPARK_STATE` | `./.spark` | Server-side state (GitHub token). Never inside the space, never in git. |
| `PORT` | `3001` | Server port. |
| `SPARK_SPACE_NAME` | `Spark` | Display name. |
| `ANTHROPIC_API_KEY` | — | Enables AI features. Absent means they're simply off. |
| `SPARK_AI_MODEL` | `claude-opus-5` | Model used for AI features. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | — | Enables "Connect GitHub" for sync. |
| `SPARK_ORIGIN` | `http://localhost:3001` | Public origin, used to build the OAuth callback URL. |

To use your existing notes, point `SPARK_SPACE` at them:

```bash
SPARK_SPACE=~/Documents/notes npm run dev
```

---

## How it works

### Storage is a folder

A page named `projects/spark` is the file `projects/spark.md`. That's the whole
storage layer. Grep it, edit it in vim, sync it with Dropbox, commit it by hand
— Spark has no opinion, because it has no index to keep in step.

Files under `_plugins/` with a `.js` extension are stored verbatim; everything
else is markdown.

### Online mode, and opt-in sync mode

**Online mode** is the default and what every page load starts in. Reads and
writes go straight to the server, so what's on screen is the file on disk. There
is no local replica, so there is nothing to reconcile and nothing to go stale.

**Sync mode** additionally runs git on a timer — pull, commit, push. It's opt-in
because it needs a remote and a GitHub token, and because pushing to someone's
repository on their behalf should be a choice rather than a discovery. If a repo
is connected and sync is off, Spark says so once and then leaves you alone.

### Conflicts

Two devices editing the same page is normal, so it's handled in two places:

- **Between the browser and the server** — every write carries the revision the
  client last read. If the file changed underneath, the write is refused with a
  409 and you're asked what to do: keep yours, take theirs, or keep both. Spark
  never silently picks a winner.
- **Between git branches** — merges run through a line-level three-way merge
  (`apps/server/src/merge.ts`). Edits to different paragraphs merge silently;
  only genuinely overlapping edits produce conflict markers, and even then both
  sides are preserved. A page left with markers is reported in the sync panel
  and is never pushed, so one device's unresolved merge can't spread.

### Tasks

Any `- [ ]` line, on any page, appears on the Tasks view. Checking it there
rewrites the line in the page it came from. There is no task record and no task
database — a task is a line of markdown that happens to look like one, so tasks
stay attached to the thinking around them.

`📅 2026-07-27` or `due:2026-07-27` sets a due date. `#tags` filter.

### Capture

On a touch device Spark opens into a prompt instead of the editor, with a mode
switcher — Note, Task, Idea, Question, Log. The mode chooses the markdown, not
the destination: everything lands in the day's page (`journal/YYYY-MM-DD`) as
ordinary markdown, so nothing is siloed.

The microphone transcribes on-device via the browser's speech recognition, and
appends into the same box you can type in. With an AI key configured, spoken
captures can optionally be tidied into structured notes — opt-in, per capture.

### AI

Every AI entry point is a command or a slash command **you** trigger. Nothing
watches your keystrokes, nothing pre-fetches, and the API key never leaves the
server. Without `ANTHROPIC_API_KEY` the features are simply absent.

---

## Plugins

A plugin is one ES module in `_plugins/` inside your space, so it travels with
your notes:

```js
import { definePlugin } from '@spark/plugin-sdk';

export default definePlugin({
  id: 'word-count',
  name: 'Word count',
  activate(spark) {
    spark.commands.register({
      id: 'word-count.show',
      name: 'Count words',
      run: () => spark.ui.toast(`${spark.editor.text().split(/\s+/).length} words`),
    });
  },
});
```

Plugins get commands (with keybindings), slash commands, inline markdown
widgets, space read/write, editor control, events, scoped settings, and AI. The
built-in features use exactly the same API — there is no privileged internal
surface. See `packages/plugin-sdk/src/index.ts` for the full contract, and
`_plugins/word-count.js` in a fresh space for a working example.

---

## Keys

| Key | Action |
| --- | --- |
| `⌘K` | Search pages; type `>` for commands |
| `⌘⇧C` | Quick capture |
| `⌘⇧T` | Tasks |
| `⌘\` | Toggle page list |
| `/` | Slash commands, in the editor |
| `⌘B` `⌘I` `⌘E` | Bold, italic, code |
| `⌘⇧K` | Link |
| `⌘1`–`⌘6`, `⌘0` | Heading level / plain |
| `⌘↵` | Toggle task |

Command keys are dispatched in one place, so they work on every screen and can
never fire twice.

---

## Layout

```
packages/
  plugin-sdk/   Types plugin authors write against. No runtime dependencies.
  core/         Space client, markdown model, task index, plugin runtime,
                sync controller. No UI framework — this is what a mobile or
                desktop shell would reuse as-is.
  editor/       CodeMirror 6 + live syntax hiding. No UI framework either.
apps/
  server/       Hono API, filesystem space, git sync, GitHub auth, AI proxy.
  web/          React shell: capture, palette, tasks, sync, mobile toolbar.
```

The split is deliberate. `core` and `editor` know nothing about React, so the
web app is one shell among several rather than the place the logic lives.

---

## Notes on the current state

- Git **merge** behaviour is covered by tests against a real repository, and the
  sync **state machine** (setup, status, conflict reporting, error paths) is
  verified. Push and fetch against a live GitHub remote have not been exercised
  end to end — that needs real credentials.
- Voice capture uses the Web Speech API, which today means Chrome and Safari;
  the button is hidden where it isn't supported.
- Auth assumes a personal server: one space, one owner. The GitHub token is kept
  server-side (mode 0600), and anyone who can reach the server can read the
  notes. Put it behind a reverse proxy with auth before exposing it.

## Licence

Application code is yours to license as you see fit. iA Writer Quattro and Mono
are © iA Inc., under the SIL Open Font License 1.1, and are downloaded rather
than committed.
