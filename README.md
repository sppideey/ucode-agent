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
  │ ◆ Build · Nemotron 3 Ultra                                                0% │
  ╰──────────────────────────────────────────────────────────────────────────────╯


                                                                            v1.2.0
```

and once you are talking, each message you send is boxed in the same blue as
the input, so your own words are easy to find in a long session:

```
╭──────────────────────────────────────────────────────────────────────────────────╮
│ › build a notes dashboard                                                        │
╰──────────────────────────────────────────────────────────────────────────────────╯
● Writing index.html
  └ created · 148 lines
       1 + <!doctype html>
       2 + <html lang="en">
         … 146 more lines
● Running npm run dev
  └ ready · http://localhost:3000 · PID 4812

╭──────────────────────────────────────────────────────────────────────────────────╮
│ › now add a dark mode toggle                                                     │
│                                                                                  │
│ ◆ Build · Nemotron 3 Ultra                                                    4% │
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
| **Nemotron 3 Ultra** ★ | 1M | the default — deepest reasoning, slowest to first token |
| Nemotron 3.5 Lightning | 1M | the same enormous window, answers much sooner |
| Nemotron 3 Super | 262k | strong all-rounder, quick to start |
| Nemotron 3 Nano Omni | 256k | small, fast, reasoning tuned |
| **North Mini Code** ★ | 256k | code and UI specialist — reach for it on frontend work |

`/model` shows them and switches. `ucode -m cohere/north-mini-code:free`
starts on one.

Ultra is the default because the work this is for — read a codebase, hold it in
mind, change several files consistently — is what a million-token window and a
long think are for. When the wait stops being worth it, switch.

## What it does

**Thirteen tools.** `read_file`, `read_files`, `write_file`, `batch_write`,
`edit_file`, `multi_edit`, `edit_files`, `list_dir`, `glob`, `grep`,
`run_command`, `run_commands`, `web_search`. Read-only calls run in parallel,
and start the moment the model finishes writing them — while the rest of its
reply is still arriving. Anything that writes runs on its own, in order.

**Parallel workers.** When a build splits into parts that touch different files
— the API route, the upload component, the results view — the model hands them
to up to three workers that build at the same time, each line in the transcript
tagged with the worker's name. File writes take turns so two never collide.

**Installs that start early.** The moment a `package.json` with dependencies is
written, its install starts in the background while the rest of the app is
still being written. An install the model asks for later waits for that one
instead of running twice, and anything run in that folder waits for it too.

**Errors fixed before you see them.** When the model says it is done, ucode
type-checks every file it changed — `tsc --noEmit` for TypeScript projects,
a syntax check for JavaScript and Python — and hands any errors back to fix,
up to three rounds.

**A plan you can see.** For longer jobs the model keeps a short checklist, shown
as one line: `plan 2/5  ✓ Scaffold · ✓ Upload · ▸ Score dial · ○ Findings · ○ Polish`.

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
this folder first.

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
| `/new` | save this one and start fresh |
| `/remember <note>` | add a standing note to this project's `UCODE.md` |
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
`UCODE_BASE_URL`.

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
src/tools/            the eleven tools, plus their shared plumbing
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
