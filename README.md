# Spark

Markdown notes app  with as little friction as possible.

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
npm run fonts     # ~11 MB of typefaces, all SIL OFL, fetched not committed
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
| `HOST` | `0.0.0.0` | Interface to bind. The default (every interface) makes the app reachable from other machines on the network, which is what a container needs to be reachable at all. Set `127.0.0.1` to restrict it to the local machine. |
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

## Docker

Pushes to the `main` branch build a container and publish it to GitHub Container
Registry as **`ghcr.io/<you>/<repo>`**, tagged `latest` and `main`; releases
(`v*` tags) are tagged with the tag name.

```bash
# Run once, mounting a folder of notes and a state directory.
# No ports are published to the host by default — `-p` does that.
docker run -d \
  --name spark-notes \
  -p 3001:3001 \
  -v /path/to/notes:/data/space \
  -v /path/to/state:/data/state \
  -e SPARK_ORIGIN=https://notes.example.com \
  ghcr.io/kailingma/spark-notes
```

A brand-new notes folder gets seeded on first boot; a folder that already
contains markdown is used as-is. State (the GitHub token, AI keys) lives in the
`/data/state` volume, space (your notes) in `/data/space` — keep them apart, so
sync can't push credentials. Without a volume, an empty container writes notes
to a fresh `/data/space`; once the container is deleted they go with it.

The image ships without the curated typefaces (~12 MB of OFL fonts are fetched,
not committed — see `scripts/fetch-fonts.mjs`). The named modes (Sans, Serif,
Mono) fall back to system faces. To include them:

```bash
docker build --build-arg FETCH_FONTS=1 -t spark-notes .
```

Every other variable in the table above (and the rest of `.env.example`) works
unchanged as a `-e` or `--env-file`. Inside the container the server listens on
port `3001` and binds all interfaces (`HOST=0.0.0.0`) so the published port
reaches it.

---

## How it works

### Storage is a folder

A page named `projects/spark` is the file `projects/spark.md`. That's the whole
storage layer. Grep it, edit it in vim, sync it with Dropbox, commit it by hand
— Spark has no opinion, because it has no index to keep in step.

Files under `_plugins/` with a `.js` extension are stored verbatim; everything
else is markdown. Four folders in a space hold something other than your prose,
and all four are still plain files you can read, edit and delete:

| Folder | What is in it |
| --- | --- |
| `_plugins/` | Plugins, as ES modules. Yours to write |
| `_skills/` | Procedures Spark should follow, as `SKILL.md` |
| `memory/` | What Spark has learned about you |
| `files/` | Attachments, referenced from notes as ordinary markdown links |

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
| `Memory` | What Spark has learned about you, and where each part of it lives |

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

### AI (Spark)

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

### Spark, and what it learns

Spark is the assistant in the right-hand panel. It reads and writes the pages in
your space, and over time it stops needing to be told the same things twice.

**It remembers, in files you can read.** Correct it once — "meeting notes go in
`meetings/`" — and it writes that down. What it knows lives in four markdown
files in your own space: `memory/essentials` (facts about you),
`memory/conventions` (how you want your space worked in, and how you want to be
written to), `memory/threads` (what is outstanding) and `memory/buffer` (things
it noticed but has not judged). Open **Memory** to see all of it on one screen,
delete any line you disagree with, or edit the files in vim — they are just
notes. `git log memory/` is the history of everything it has ever concluded
about you.

Threads are written as ordinary `- [ ]` tasks, so they show up in **Tasks** with
everything else, and ticking one there is how you tell Spark it is finished.

Every so often, at the end of a conversation you started, Spark reviews the
buffer and decides what to keep, what to merge into something it already knew,
and what to throw away. It never does this on a timer: nothing here runs while
you are away.

**It learns procedures too.** A folder in `_skills/` with a `SKILL.md` in it is a
job you want done a particular way, written once — the seeded
`_skills/weekly-review/` is a working example. Spark is told what each skill is
for and reads the instructions when the job comes up, so a folder of twenty costs
nothing until one is needed. Tell it how you want something done and ask it to
remember, and it will write the skill itself.

**You can hand it files.** Drag one onto the composer, paste a screenshot, or use
the paperclip. Uploads land in `files/` in your space as ordinary files, and what
Spark writes into a note is an ordinary markdown link — so an attachment survives
the app exactly as a note does. Images and PDFs it can look at; text, CSV, JSON
and code it can read. Anything else it will tell you it cannot read rather than
guessing.

**It can search by meaning**, not just by words. Word search always works and
needs nothing set up. Name an embedding model in **Settings → Spark** and "what
did I decide about pricing" will also find the paragraph that never says pricing.

**It can run code, if you let it.** Off by default and switched on in the
server's environment rather than in the app, because whether a machine will
execute generated code is a decision about the machine. With it on, Spark answers
the arithmetic questions — total this column, count these across months, reshape
this CSV — by writing a few lines of Python and running them, rather than by
estimating. `SPARK_SANDBOX=docker` gives it a container with no network; see
`.env.example` for what the other options do and do not protect.

Each of these is a separate switch in **Settings → Spark**, and the server
enforces all of them again on its own — a capability Spark was not given is a
tool it is never told about, so it cannot be talked into one.

### Appearance

**Settings → Appearance** holds the theme, the window mode, and type — chosen
twice, once for your notes and once for everything around them.

*Themes.* Twelve palettes, each in light and dark, shown as a gallery of
miniatures rather than a list of names: every card is a small page in the theme it
stands for, with that theme's paper, ink, accent and title face. Paper is cream
stock and brick red; Ink is almost monochrome; Fjord, Ember, Solar and Rosé for
anyone who has had a favourite terminal colour scheme since 2011; Terminal is
phosphor green; Bloom is high chroma and no apology; Noir is black, white, one
red and no rounded corners. A theme's colours apply whatever else you have set.

*Document type* is the reading font — sans (Inter), serif (Source Serif 4, with
Fraunces for titles), mono (iA Writer Mono), or **curated** — the text size in px,
and the reading width.

*Curated* is the interesting one. It means "whatever this was designed to be read
in": the pairing the theme was built around, or one of thirteen font packs from
the dropdown beside it. A pack is a title face, a reading face, an interface face
and a monospace chosen together, plus the numbers that make a title behave like
one — so Editorial gives you Playfair italics over a news serif, Stretch pulls
Archivo out to 125% and slants it, Condensed squeezes Bricolage to 75% in caps,
Wonk turns Fraunces' wonk axis all the way up, Poster sets every heading in
Anton, and Legible is Atkinson Hyperlegible with more air than usual. The two
sides of the app can draw from different packs.

Picking Sans, Serif or Mono keeps a theme's palette and drops its voice. That is
deliberate: choosing a sans should mean a sans.

*Interface type* is the face and size of everything that is not a document:
tabs, panels, the navigator, Spark, the status bar, settings itself. Sans and
serif are IBM Plex here rather than the reading faces, because chrome and prose
want different things from a typeface; mono is the same iA Writer Mono. The size
is the root size the whole interface is measured against, adjustable in fifths
of a pixel — at 0.75rem a label moves in smaller steps than the number suggests.

Code and tables stay monospaced under every combination, because column
alignment is part of what they mean. Everything here is per-device and never
synced.

Both the themes and the font packs are ordinary extensions using the ordinary
plugin API, so a file in `_plugins/` can add its own — see below.

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
widgets, space read/write, editor control, events, scoped settings, AI, and
themes. The built-in features use exactly the same API — there is no privileged
internal surface. See `packages/plugin-sdk/src/index.ts` for the full contract,
and `_plugins/word-count.js` in a fresh space for a working example.

A theme is data, so a plugin that adds one is short:

```js
spark.themes.register({
  id: 'my-theme',
  name: 'My theme',
  // Ten colours; the text ramp, rules and code chips are derived from them.
  light: { bg: '#f7f3ea', text: '#23201a', accent: '#a8341f' },
  dark: { bg: '#171512', text: '#ece4d4', accent: '#e2755c' },
  // The pairing Curated will wear — a pack you registered, or one of the
  // thirteen that ship with the app.
  fontPack: 'editorial',
});
```

`spark.themes.registerFonts()` does the same for a font pack, including the
`@font-face` declarations for faces it brings with it. Everything the app's own
Appearance panel offers is reachable this way, which is the only way to know the
surface is good enough.

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
  server/       Hono API, filesystem space, git sync, GitHub auth, AI proxy,
                Spark's memory, skills, retrieval, attachments and sandbox.
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

Application code is yours to license as you see fit.

Every typeface is under the **SIL Open Font License 1.1** and is downloaded by
`npm run fonts` rather than committed, so nothing here redistributes a binary.
iA Writer Quattro and Mono are © iA Inc. The rest — Inter, Source Serif 4,
Fraunces, IBM Plex Sans/Serif/Mono, Playfair Display, Newsreader, Instrument
Sans/Serif, Space Grotesk, Space Mono, Archivo, Bricolage Grotesque, Work Sans,
Libre Franklin, Manrope, Bodoni Moda, EB Garamond, DM Serif Display, Anton,
Unbounded, Atkinson Hyperlegible, Lexend and JetBrains Mono — belong to their
respective authors; `scripts/fetch-fonts.mjs` names the source of each file.
