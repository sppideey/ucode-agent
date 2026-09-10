# ucode

A coding agent that lives in your terminal. It reads your code, edits it, runs
your commands, and keeps every conversation on disk. It runs on NVIDIA and
Cohere models through OpenRouter, all of them free.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│  ██╗   ██╗ ██████╗ ██████╗ ██████╗ ███████╗   dir      ~/projects/notes-app  │
│  ██║   ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝   date     10 Sept 2026          │
│  ██║   ██║██║     ██║   ██║██║  ██║█████╗     session  4%  Notes dashboard   │
│  ██║   ██║██║     ██║   ██║██║  ██║██╔══╝     keys     /help · esc interrupts│
│  ╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗                                  │
│   ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝   made with ❤️ by om dixit       │
╰──────────────────────────────────────────────────────────────────────────────╯

● Writing index.html
  └ created · 148 lines
       1 + <!doctype html>
       2 + <html lang="en">
       3 +   <head>
         … 145 more lines
● Running npm test
  └ exit 0 · 12 lines

╭──────────────────────────────────────────────────────────────────────────────╮
│ › now add a dark mode toggle                                                 │
╰──────────────────────────────────────────────────────────────────────────────╯
  ◆ Build · Nemotron 3 Ultra (free) OpenRouter
```

## Install

```bash
npm i -g ucode-agent
```

Then put a key where it will survive upgrades:

```bash
mkdir -p ~/.ucode
echo "OPENROUTER_API_KEY=sk-or-..." > ~/.ucode/.env
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
serve capable models free through OpenRouter, and both handle tool calling
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

**Eleven tools.** `read_file`, `write_file`, `batch_write`, `edit_file`,
`multi_edit`, `list_dir`, `glob`, `grep`, `run_command`, `run_commands`,
`web_search`. Read-only calls run in parallel; anything that writes runs on its
own, in order.

**Edits that never guess.** `edit_file` matches exactly once or it fails, and
when it fails it says *why* — the text is there but the indentation differs, or
its first line appears at line 40 and the rest does not. A wrong edit reported
as a success is the most expensive thing an agent can do.

**Diffs with real line numbers.** Removed lines are numbered where they were,
added lines where they now are. Numbers you can jump to, not decoration.

**Live commentary.** `● Listing src`, `● Running npm test` — what it is doing,
as it does it, named after the file or command rather than the tool.

**Two modes.** Build edits and runs. Plan reads and researches with the writing
tools withheld, which is stronger than asking a model nicely. `ctrl+b` swaps
them; the chip at the bottom left says which is live.

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

**`ui-ux` loads itself.** Ask for an app, a dashboard, a landing page, or say
the UI is ugly, and the whole skill is in context before the model takes its
first step. Waiting for the model to decide it needs design guidance means
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
| `~/.ucode/.env` | `OPENROUTER_API_KEY`, and `TAVILY_API_KEY` for web search |
| `~/.ucode/sessions/` | one JSON per conversation |
| `.ucode/skills/` | skills belonging to a project |

Environment overrides: `UCODE_MODEL`, `UCODE_MAX_CONTEXT_TOKENS`,
`UCODE_MAX_STEPS`, `UCODE_MAX_TOOL_OUTPUT`, `UCODE_REQUEST_TIMEOUT_MS`,
`UCODE_BASE_URL`.

Web search needs a Tavily key — free, 1000 searches a month, no card. Without
one, ucode answers from what it knows and says that it could not check.

## How it is put together

```
ucode.js              the command: arguments in, Agent out
src/core/loop.js      the agent loop, the system prompt, the slash commands
src/core/provider.js  the only file that knows OpenRouter exists
src/core/history.js   sessions on disk
src/core/window.js    folding a long conversation to fit
src/core/skills.js    loading skills, and deciding which load themselves
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
