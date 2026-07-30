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
npm run fonts     # downloads the reading and interface faces (all SIL OFL)
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

Everything is environment variables; every one has a working default, so a
fresh clone runs with nothing set up.

To change something, copy the annotated example and edit it:

```bash
cp .env.example .env
```

`.env` lives at the repository root, is read by the server wherever npm happens
to run it from, and is gitignored. A variable already set in your shell wins
over the file, so `PORT=4000 npm run dev` still overrides it. No `.env` at all
is fine and says nothing.

| Variable | Default | What it does |
| --- | --- | --- |
| `SPARK_SPACE` | `./space` | The notes directory. **This is the database.** Point it at any folder of markdown. |
| `SPARK_STATE` | `./.spark` | Server-side state (GitHub token, AI key). Never inside the space, never in git. |
| `PORT` | `3001` | Server port. |
| `SPARK_SPACE_NAME` | `Spark` | Display name. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | — | Starting AI credentials. Usually easier to set in Settings → AI. |
| `SPARK_AI_PROVIDER` | inferred | `openai` or `anthropic`. Inferred from whichever key is present. |
| `SPARK_AI_MODEL` | per provider | Model used for AI features. |
| `SPARK_AI_ENDPOINT` | provider default | Base URL, for any OpenAI-compatible server. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | — | Enables "Connect GitHub" for sync. |
| `SPARK_ORIGIN` | `http://localhost:3001` | Public origin, used to build the OAuth callback URL. |

The AI settings are the one thing you can also change from inside the app, in
**Settings → AI**; what you save there wins over the environment.

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

`📅 2026-07-27` or `due:2026-07-27` sets a due date. `#tags` filter. Clicking a
task's source opens that page with the cursor on that line.

### Links, tags and backlinks

`[[Page]]` renders as a soft rounded chip and clicking it goes there. An
external link keeps the familiar underline, so you can tell where a click will
take you before you make it. `#tags` are links too.

To *edit* rather than follow, `⌥`-click. That's the one gesture for "leave it
alone and show me the markdown" — it works on links, tags, checkboxes and
images alike.

Pages that link to the one you're reading appear as a block at the end of the
page, with the line they were mentioned on. Click one to jump straight to that
line.

Backlinks and tags are scanned on demand rather than kept in an index. A folder
of markdown can be edited by anything, so a cached graph would be wrong the
moment you touched a file outside the app.

### Virtual pages

Some pages are views over the space rather than files in it:

| Page | What it is |
| --- | --- |
| `Tasks` | Every `- [ ]` in the space |
| `Tags` | Every tag, with counts |
| `tags/<name>` | Everywhere one tag is used |

They have real page names, so `[[Tasks]]` and `[[tags/idea]]` are ordinary
links, they can be bookmarked, and they show up in backlinks — but nothing is
ever written to disk for them, because there is nothing to write. The editor
simply isn't mounted. A tag nobody has used yet still has a page; it just says
so, which is what makes it safe to link to a tag before it means anything.

### Capture

A box that is nothing but a cursor, with a mode switcher — Note, Task, Idea,
Question, Log. The mode chooses the markdown, not the destination: everything
lands in the day's page (`journal/YYYY-MM-DD`) as ordinary markdown, so nothing
is siloed.

On a touch device Spark opens straight into it instead of the editor, and it
fills the screen. Everywhere else it is `⌘⇧C`, the bolt in the header, or
**Quick capture** in the palette, and it opens as a card over the note you were
reading — Escape puts you back on the line you were on.

The microphone transcribes on-device via the browser's speech recognition, and
appends into the same box you can type in. With an AI key configured, spoken
captures can optionally be tidied into structured notes — opt-in, per capture.

### AI

Every AI entry point is a command or a slash command **you** trigger. Nothing
watches your keystrokes, nothing pre-fetches, and the model never speaks first.

Point it at anything: Anthropic's Messages API, or any OpenAI-compatible
server — OpenAI, OpenRouter, Groq, Together, or a local Ollama, LM Studio or
vLLM, in which case nothing leaves your machine at all. Set the provider, model,
endpoint and key in **Settings → AI**.

The key is written to `.spark/ai.json` at mode 0600 — on the server, outside the
space, so it is never committed and never pushed by sync. The browser is only
ever told *that* a key is configured and its last four characters; the key
itself never travels back, so nothing running on the page can read it. Spark is
a personal server, though: anyone who can reach it can already read your notes,
and the key is protected to that same standard and no further. If you expose it
beyond localhost, put it behind TLS.

### Appearance

**Settings → Appearance** holds the theme, the window mode, and type — chosen
twice, once for your notes and once for everything around them.

*Document type* is the reading font — sans (Inter), serif (Source Serif 4, with
Fraunces for titles) or mono (iA Writer Mono) — the text size in px, and the
reading width.

*Interface type* is the face and size of everything that is not a document:
tabs, panels, the navigator, Spark, the status bar, settings itself. Sans and
serif are IBM Plex here rather than the reading faces, because chrome and prose
want different things from a typeface; mono is the same iA Writer Mono. The size
is the root size the whole interface is measured against, adjustable in fifths
of a pixel — at 0.75rem a label moves in smaller steps than the number suggests.

Code and tables stay monospaced under every combination, because column
alignment is part of what they mean. Everything here is per-device and never
synced.

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
| `⌘⇧N` | New page |
| `⌘B` `⌘I` `⌘E` | Bold, italic, code |
| `⌘⇧K` | Link |
| `⌘F` | Find in page |
| Click | Follow a `[[link]]`, URL or `#tag` |
| `⌥`-click | Don't follow — put the cursor there and show the markdown underneath |
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
