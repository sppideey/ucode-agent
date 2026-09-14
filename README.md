# ucode

A coding agent that lives in your terminal. It reads your code, edits it, runs
your commands, and keeps every conversation on disk. It runs on NVIDIA and
Cohere models, all of them free.

It opens on a quiet screen — the name, the place to type, and the version in the
corner:

```
                     ██╗   ██╗ ██████╗ ██████╗ ██████╗ ███████╗
                     ██║   ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝
                     ██║   ██║██║     ██║   ██║██║  ██║█████╗
                     ██║   ██║██║     ██║   ██║██║  ██║██╔══╝
                     ╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗
                      ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝


  ╭──────────────────────────────────────────────────────────────────────────────╮
  │ › Ask anything…                                                              │
  │                                                                              │
  │  BUILD   North Mini Code                                                  0% │
  ╰──────────────────────────────────────────────────────────────────────────────╯

   try   build me a landing page for a coffee shop
         explain what this project does and how it fits together
         add a dark mode toggle that remembers the choice


                                                                           v1.44.0
```

A light crosses the wordmark once as it opens, and the three lines under the box
are there so an empty screen has something to say. Once you are talking, each
message you send is marked down its left edge in the same blue as the input, so
your own words are easy to find in a long session — and each step the agent
takes carries the shape of the work: a hollow diamond to look, a filled one to
change, an arrow to run.

```
▌ build a notes dashboard

◇ Read 3 files
◆ Writing index.html +148 -0
▸ Running npm run dev

The dashboard is at http://localhost:3000, and `npm run dev` brings it back up.

╭──────────────────────────────────────────────────────────────────────────────────╮
│ › now add a dark mode toggle                                                     │
│                                                                                  │
│  BUILD   North Mini Code                                                      4% │
╰──────────────────────────────────────────────────────────────────────────────────╯
```

The status sits inside the input box because it describes the thing you are
typing into. Three facts, no more: the live mode, the answering model, and how
full the context window is. The percentage turns amber at 75%, which is where
older turns start being folded into a summary. While a turn is running the
middle of that row carries the spinner and the way out of it, and hands the
space straight back when it finishes.

## Install

```bash
npm i -g ucode-agent
```

Then put a key where it will survive upgrades:

```bash
mkdir -p ~/.ucode
echo "UCODE_API_KEY=sk-or-..." > ~/.ucode/.env
```

Keys are free at [openrouter.ai/keys](https://openrouter.ai/keys). A `.env` in
the project you are working on wins over that one, and a real environment
variable wins over both.

Then, in any project:

```bash
ucode
```

Needs Node 22 or newer.

## The models

Five, and no picker full of names nobody recognises. NVIDIA and Cohere both
serve capable models free, and both handle tool calling
properly, which is the thing an agent actually depends on.

| Model | Context | For |
| --- | --- | --- |
| Nemotron 3 Ultra | 1M | deepest reasoning, slowest to first token |
| Nemotron 3.5 Lightning | 1M | the same enormous window, answers much sooner |
| Nemotron 3 Super | 262k | strong all-rounder, quick to start |
| Nemotron 3 Nano Omni | 256k | small, fast, reasoning tuned |
| **North Mini Code** ★ | 256k | the default — built for code and interface work, quick to answer |

`/model` shows them and switches. `ucode -m cohere/north-mini-code:free`
starts on one.

North Mini Code is the default: it is built for code and interfaces, which is most
of what ucode is asked to do, and it answers far sooner than the big reasoning
models. Switch to Ultra when a problem needs the million-token window more than
the speed.

**The model you chose is the model you keep.** Free endpoints are shared and
"too many requests" is routine, so ucode waits it out with growing pauses and
comes back to the same model. It does not quietly hand your build to a
different one: a build that starts on one model and finishes on another
finishes to a different standard, and the swap lands exactly when you are least
placed to work out why the output changed. Set `UCODE_FALLBACK=1` if you would
rather it moved down the list — North Mini Code, Nemotron 3.5 Lightning, Super,
Ultra — when a model stays busy.

## What it does

**Twenty-one tools.** `create_app`, `read_file`, `read_files`, `write_file`,
`batch_write`, `edit_file`, `multi_edit`, `edit_files`, `rename_symbol`,
`find_symbol`, `outline`, `type_of`, `add_block`, `list_dir`, `glob`, `grep`,
`run_command`, `run_commands`, `look_at_app`, `web_search`, `deploy`. Read-only
calls run in parallel, and start the moment the model finishes writing them —
while the rest of its reply is still arriving. Anything that writes runs on its
own, in order.

**It asks rather than guesses.** `type_of` opens a language service on the
TypeScript the project itself has installed and gives back the exact signature,
the JSDoc, and where a thing is defined — inferred types included. `find_symbol`
answers "where is this declared", which is the question `grep` is usually being
asked badly. `rename_symbol` renames by code shape, knowing where strings and
comments begin, because a find-and-replace that matched too much is the most
common broken edit.

**It checks itself as it goes.** After a change: an incremental type check that
answers in about a second rather than a cold minute, then the tests that reach
the files just changed, then anything the running dev server has complained
about since the last look. All three come back the way an error does, so the
model fixes them without being told.

**New apps are ready in seconds.** A starter installed once is kept and
hard-linked into the next app — the same files under another name, so it costs
no extra disk and skips the wait entirely.

**Apps start from a ready-made starter — and finish in the same call.**
`create_app` copies a starter that is already known to build, and takes the
app's files with it, so a one-page app is a single round trip: the starter
lands, the model's files are written over it, and the starter's own files come
back inside the result so there is nothing to read afterwards.

The default starter is `plain-html`: one page, one stylesheet, one module,
nothing to install and nothing to build. A tasks app, a game, a calculator or a
visualisation is finished before a framework would have finished installing.
`next-shadcn` is there for routes, a database or many screens — Next.js 16,
TypeScript, Tailwind 4, shadcn/ui with 25 components, light/dark, toasts and a
considered theme. Setting that up by hand is about four minutes
(`create-next-app` and the shadcn CLI measured at 116s and 130s) plus a dozen
round trips; the copy takes under a second, and its install runs in the
background while the model writes the first components.

**Built to be fast, and measured.** A traced build of a small Next.js app went
from 17 minutes and 116 model steps to about 6 minutes and 25 steps, by fixing
where the time actually went:

- Edits return the file as it now stands, so the model does not re-read it.
- Files written more than a few steps ago stop being re-sent in full; the
  conversation stays small, so every step answers faster.
- A file-write whose JSON is malformed — a missing comma, an unescaped quote in
  the code, raw line breaks — is repaired instead of thrown away with all its
  output.
- Every write is parsed on the spot, so a syntax error comes back in the same
  step rather than a minute later from a failed build.
- A failed build that is missing a component or package says exactly which
  command fixes it.
- The starter is the shadcn models already know (Radix), so the code they write
  compiles the first time.
- A new app goes out without the tools it has nothing to point at — no symbol
  lookup, no rename, no type query in an empty folder — and an instruction pack
  that loads itself sends its short form, with the full one a `load_skill`
  away. Both are re-read by the provider on every step, so what is not in the
  request is time off every one of them.
- Ready-made blocks for a page with no build step as well as for React: a list you
  can add to, tick off, rename and remove, a filter row, a localStorage store, a
  dialog, toasts, a theme toggle. Typing is the slowest part of a build, and each
  block is a hundred lines nobody has to type.
- A nested argument written the wrong way — a JSON string, a { path: contents } map
  — is read rather than refused. Each refusal was a round trip spent being told
  something that could simply be parsed.
- A tool that was not offered is refused rather than quietly run, so withholding one
  from a new project, or from plan mode, means what it says.
- The closing message is cut to eight lines. A build that ends with the request
  read back and every feature ticked off is a status report nobody asked for,
  and it is the last thing left on screen.

`UCODE_TRACE=1` writes every model call and tool, with its duration, to
`~/.ucode/trace.jsonl`.

Measured on "build me a simple todo app" — same prompt, same model, two traced
runs: **27 model calls, 8 failed tool calls, no finished app** before this round of
work; **14 model calls, no failures, a working app in under two minutes** after it.

**Deploy in one line.** Say "deploy it", or type `/deploy [folder]`, and the app
goes live on Vercel. ucode picks a short project name that fits the app and is
free (`food-iq`, else `food-iq-app`…), copies the app's `.env` keys to Vercel as
encrypted variables, refuses code with a secret written into it (and says how to
move it to a server route), and gives you the link. Deploying again updates the
same link. Needs a token from vercel.com/account/tokens in `~/.ucode/.env` as
`VERCEL_TOKEN=...`.

**A look for every app.** `create_app` takes a design preset — ocean, grove,
sunset, graphite, violet or citrus — each a full light and dark palette with its
own font, so apps stop looking like the same default blue.

**Every turn can be taken back.** `/undo` puts back every file the last turn
changed — a rewritten file returns byte for byte, a file that did not exist
before is removed again. Each write keeps the original the first time that turn
touches it, so what comes back is the state before the turn rather than before
the last of six edits to the same file. An agent that writes to your disk on
its own should be able to take it back, whether or not the project has git.

**It notices when it is going round in circles.** The same failing edit, an edit
that changes nothing, or a build failing on the same errors three times gets a
firm, specific note; if that does not work, the turn moves to another model.

**It never dies at the daily limit.** When the free daily limit runs out mid-build,
ucode counts down to the reset and carries on by itself.

**You can see it working.** The status row shows the current step with a light
sweeping across it, the step count and the time, and each answer ends with
`✓ Done in 6m 12s · 25 steps`. When a dev server comes up, the app opens in your
browser (`UCODE_OPEN=0` turns that off).

**`/stats` and `ucode doctor`.** `/stats` shows the session's time, steps, tokens,
files and builds. `ucode doctor` (or `/doctor`) checks Node, npm, git, the API
key and today's free requests left, the browser, the Vercel token and the
version, with the fix for anything wrong.

**Parallel workers.** When a build splits into parts that touch different files
— the API route, the upload component, the results view — the model hands them
to up to three workers that build at the same time, each line in the transcript
tagged with the worker's name. File writes take turns so two never collide.

**Installs that start early.** The moment a `package.json` with dependencies is
written, its install starts in the background while the rest of the app is
still being written. An install the model asks for later waits for that one
instead of running twice, and anything run in that folder waits for it too.

**It opens what it built and uses it.** Every app build ends with a look — not
when the model remembers to ask for one, but as part of the same pass that
type-checks. It opens the app in a real browser (the Edge or Chrome already on
your machine, so there is nothing extra to download) at 375px and 1440px, and
serves the folder itself when there is no dev server to point at, which is how
a three-file app gets checked at all.

Then it uses the app. It types into the first field, presses Enter, and clicks
the button that submits — and if the page gains no elements, changes no text
and stores nothing, that is reported as the thing to fix before anything else.
A page that renders and has no working behaviour passes a type check, a syntax
check and a screenshot; the only way to find out is to press something.

It also reports console errors, failed requests, content that spills off a
phone screen, broken images and unlabeled controls, saves screenshots to
`.ucode/screenshots`, and has Nemotron Nano Omni review them the way a designer
would. The model fixes what it finds before calling the app done. Both widths load at once, and the designer review — the slow part — runs
on the first look at an app in each request and is skipped, not waited on, when
the vision model is busy. The look after the fixes re-runs only the fast checks:
a few seconds.

**Errors fixed before you see them.** When the model says it is done, ucode
type-checks every file it changed — `tsc --noEmit` for TypeScript projects,
a syntax check for JavaScript and Python — and hands any errors back to fix,
up to three rounds.

**A plan you can see.** For longer jobs the model keeps a short checklist, with
a bar across the top for how far along it is and one row per step, so the one in
progress is findable without reading the rest:

```
  ━━━━──────  2/5
    ✓ Scaffold
    ✓ Upload
    ▸ Score dial
    ○ Findings
    ○ Polish
```

**It knows the project before it asks.** Each turn starts with a map of every
file and the names each code file exports, so the model goes straight to the
right file instead of searching for it.

**Project memory.** `UCODE.md` in a project — and `~/.ucode/UCODE.md` for how you
like to work everywhere — is read at the start of every turn. `/remember <note>`
adds a line to it.

**Edits that never guess.** `edit_file` matches exactly once or it fails, and
when it fails it says *why*. It tolerates what does not matter — tabs against
spaces, a different indent depth, Windows line endings — and re-indents the
replacement to fit the file, but a match found twice is still refused.
`edit_files` changes several files in one call, and writes none of them if any
edit fails.

**Diffs with real line numbers.** Removed lines are numbered where they were,
added lines where they now are. Numbers you can jump to, not decoration.

**Live commentary.** `● Listing src`, `● Running npm test` — what it is doing,
as it does it, named after the file or command rather than the tool.

**Two modes.** Build edits and runs. Plan reads and researches with the writing
tools withheld, which is stronger than asking a model nicely. `ctrl+b` swaps
them; the chip inside the input box says which is live.

**Sessions.** Everything is on disk under `~/.ucode/sessions`, saved after every
step. `/resume` lists them with what each one was actually about, the ones from
this folder first. Press `d` twice on one to delete it — the list stays open, so
clearing out several is quick — or `/session delete 2,5`.

**It updates itself.** Each launch checks npm in the background and, if there is
a newer version, installs it while you work. The next launch is the new one.
Set `UCODE_NO_UPDATE=1` to turn that off.

**A context window that folds rather than forgets.** Past 75% the oldest turns
are summarised instead of dropped, never cutting between a tool call and its
result. The full history stays on disk regardless.

**Screenshots.** Mention a `.png` in your message and it gets attached.

## Skills

A skill is a folder with a `SKILL.md`: frontmatter, then instructions. Only the
names and one-line descriptions go into the system prompt — a body is pulled in
when it is wanted, so the prompt stays the same size however many you add.

| Skill | For |
| --- | --- |
| `ui-ux` | interfaces: direction, tokens, layout, states, motion, accessibility |
| `build-app` | going from nothing to something running, and proving it runs |
| `debug` | finding the real cause instead of the first plausible one |
| `code-review` | reviewing a change the way a careful colleague would |
| `write-tests` | tests that fail for the right reason |
| `ai-features` | model-backed features: prompts with rules, validated JSON, images, failure handling |
| `security` | secrets, auth, ownership checks, injection, XSS, CSRF, SSRF, uploads |
| `performance` | measure first, find the real bottleneck, prove the win with numbers |
| `refactor` | change the shape of code without changing what it does |

**Every skill loads itself** when the request calls for it — an app pulls in
`ui-ux` and `build-app`, "it crashes" pulls in `debug`, an AI feature pulls in
`ai-features`, an API key pulls in `security` — so the whole skill is in
context before the model takes its first step. Waiting for the model to decide it needs design guidance means
finding out it did not after the app is built.

Add your own in `.ucode/skills/<name>/SKILL.md` inside a project. A project
skill shadows a built-in of the same name. Give it an `auto:` line and it loads
itself too:

```markdown
---
name: house-style
description: How we write services here.
auto: endpoint, handler, migration
---

Everything after the frontmatter is the instruction.
```

## Commands

| | |
| --- | --- |
| `/help` | the list |
| `/model` | show the models and switch — `/models` does the same |
| `/resume` | pick up an earlier conversation — `/session`, `/sessions` too |
| `/session delete 2,5` | delete saved conversations by number (or `d d` in the list) |
| `/new` | save this one and start fresh |
| `/remember <note>` | add a standing note to this project's `UCODE.md` |
| `/undo` | put back every file the last turn changed |
| `/look [url]` | open the running app and report what is on the page |
| `/deploy [folder]` | put the app online and get its link |
| `/stats` | time, steps and tokens this session |
| `/doctor` | check that everything ucode needs is working |
| `/skills` | what it knows how to do, and what is loaded |
| `/search <query>` | look something up on the web |
| `/copy` | last reply to the clipboard |
| `/clear` | clear the screen, keep the conversation |
| `/exit` | save and quit |

`ctrl+b` plan/build · `esc` stops a running turn · `ctrl+d` quits ·
`↑ ↓` scroll the conversation, or walk history once you are typing ·
`tab` completes a command

## Options

```
ucode [options]

  -m, --model <id>   which model to use
  -C, --cwd <dir>    work in another directory
      --plan         start in plan mode
      --debug        print stack traces when something breaks
  -v, --version      print the version
  -h, --help         the above
```

## Configuration

| | |
| --- | --- |
| `~/.ucode/.env` | `UCODE_API_KEY`, and `TAVILY_API_KEY` for web search |
| `~/.ucode/sessions/` | one JSON per conversation |
| `.ucode/skills/` | skills belonging to a project |
| `UCODE.md` | project memory, read every turn |
| `~/.ucode/UCODE.md` | your own standing instructions, for every project |

Environment overrides: `UCODE_MODEL`, `UCODE_WORKER_MODEL` (a faster model for
parallel workers), `UCODE_WORKER_STEPS`, `UCODE_MAX_CONTEXT_TOKENS`,
`UCODE_MAX_STEPS`, `UCODE_MAX_TOOL_OUTPUT`, `UCODE_REQUEST_TIMEOUT_MS`,
`UCODE_BASE_URL`, `UCODE_NO_UPDATE`.

Web search needs a Tavily key — free, 1000 searches a month, no card. Without
one, ucode answers from what it knows and says that it could not check.

## How it is put together

```
ucode.js              the command: arguments in, Agent out
src/core/loop.js      the agent loop, the system prompt, the slash commands
src/core/provider.js  the only file that knows which provider answers
src/core/history.js   sessions on disk
src/core/window.js    folding a long conversation to fit
src/core/skills.js    loading skills, and deciding which load themselves
src/core/context.js   the project map and project memory
src/core/failure.js   one error shape: what, why, what next
src/tools/            the twenty-one tools, plus their shared plumbing
src/ui/screen.js      the full-screen interface
src/ui/plain.js       the same interface for when there is no terminal
src/ui/theme.js       colour, boxes, and the string maths behind both
```

Everything above `provider.js` speaks one small provider-neutral message
format. Moving to another host means rewriting that one file.

Every failure carries three things — what was attempted, what failed, and what
to do next — so no screen ever has to fall back on a stack trace. Tool failures
are handed to the model as text instead, which is why they read like
instructions.

## Development

```bash
git clone https://github.com/sppideey/ucode-agent
cd ucode-agent
npm install
npm link      # puts `ucode` on PATH, pointing at this checkout
npm test
```

`npm link` matters while developing: it symlinks the global command to your
working copy, so an edit is live on the next launch. Running
`npm i -g ucode-agent` replaces that with a frozen copy from the registry and
your edits stop taking effect.

The tests need no network and no framework — `node test/run.js` runs them all.

## Licence

ISC. Made with ❤️ by om dixit.
