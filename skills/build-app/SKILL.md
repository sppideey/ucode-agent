---
name: build-app
description: Take something from nothing to running — choosing the stack, laying out the files, installing, wiring it up, and proving it works before saying it does.
auto: scaffold, new project, from scratch, build an app, make an app, create an app, build a website, make a website, build a site, build me a
---

# Building something from nothing

The failure mode here is not writing bad code. It is delivering a folder of
files that has never been run, described as if it works.

## Decide the shape before writing anything

State these in one line each, out loud, then build to them:

- **What it does** — the single sentence a user would say.
- **The stack** — and why. Default to the smallest thing that does the job: a
  single HTML file with no build step is a legitimate answer and often the
  right one. Reach for a framework when routing, state or a component tree
  genuinely earns it, not because the project sounds serious.
- **The files** — the whole list, before you create any of them.

If the request has a user interface in it, the `ui-ux` skill is already loaded.
Follow it. Do not design as you go and tidy up afterwards.

## Lay it out in one pass

Use `batch_write` for the whole skeleton rather than `write_file` twenty times.
One call, every file, in dependency order. Then `run_command` the install, and
`run_commands` for anything independent that can happen at the same time.

Real content from the first pass. Placeholder copy, `TODO`, and a commented-out
function are all the same thing: a promise you did not keep, in a file the user
now has to find.

## Wire everything

Every button does its thing. Every form submits, validates and says what went
wrong. Every list has an empty state. Every request has a loading state and a
failure state. A control that does nothing is worse than no control, because
the user has to try it to find out.

If it stores anything, decide where, and make it survive a reload.

## Run it, then look at it

- Start it with `run_command`. A dev server needs `background: true`, which
  returns immediately with a PID — a foreground server just burns the turn and
  gets killed.
- Then actually exercise it: `curl` the routes, run the tests, open the page.
  A clean build is not evidence that it works, only that it compiles.
- Fix what you find and run it again.

## Report what happened

Say what you built, how to start it, and what you checked. If something is
untested or unfinished, say which part and why — that sentence costs you
nothing and saves the user an hour of finding out on their own.
