# Building something from nothing — the short form

The failure mode is not bad code. It is a folder of files that has never been
run, handed over as if it works.

## 1. Decide the shape before any file exists

One line each: **what it does**, **the core loop** (the one path that must work
perfectly), **the stack**, **the file list**.

| Need | Choose |
| --- | --- |
| One page, no secrets, no server | `create_app` with `plain-html` |
| Interactive client app, no secrets | `plain-html` still, unless it truly needs a build |
| Pages plus a server, secrets, API routes, SEO | `create_app` with `next-shadcn` |
| An API on its own | Node (Hono/Express) or Python (FastAPI) |

**Scope: complete, not sprawling.** Build what was asked, and build all of it
well: every feature someone using that kind of app expects on first use — a
tasks app adds, edits, ticks off, deletes, filters and remembers across a
reload; a quiz has questions, scoring, feedback and a restart; a game has
rules, a score, win and lose, and play again. Nothing from a different app: no
timer, calendar or analytics dashboard bolted onto a tasks app, no accounts on
a quiz. Features nobody named cost minutes and are where builds break — if one
is worth it, offer it in one line at the end instead of building it.

Pick the smallest stack that does the job and mean it: a tasks app, a
calculator, a timer, a game, a visualisation — all one page. Next.js costs an
install and a build, minutes the user waits through, and buys nothing an app
with no server needs.

## 2. Start from the starter — and finish in the same call

`create_app` takes `files`, so for a one-page app the scaffold and the whole
app are one call:

```
create_app({ folder: "tide", name: "Tide", files: [
  { path: "tide/index.html", content: "…" },
  { path: "tide/styles.css", content: "…" },
  { path: "tide/app.js",     content: "…" },
]})
```

Every round trip is ten to forty seconds of the user's time, so one call
instead of four is most of how long the build takes.

- `plain-html` is the default: three files, no install, no build. Its files
  come back in full inside the result — **never read them back**.
- `next-shadcn` installs in the background; commands in that folder wait for
  it on their own, so start writing components at once. Re-tint `globals.css`
  for the app's direction rather than shipping the slate default.
- Never run `create-next-app` or `shadcn init`. Nothing you run has a
  keyboard: every scaffolder needs its answers as flags up front.

## 2a. Paths in `files` are not the paths in the page

The two are relative to different things, and getting them confused is the
commonest way a finished build comes up as bare markup. `files` paths are
relative to the **project root**, so they carry the app folder. A link inside a
page is relative to **that page**, so it must not.

```
create_app({ folder: "tide", name: "Tide", files: [
  { path: "tide/index.html", content: "... <link rel=stylesheet href=\"styles.css\">
                                            <script type=module src=\"app.js\"></script> ..." },
  { path: "tide/styles.css", content: "..." },
  { path: "tide/app.js",     content: "..." },
]})
```

Wrong, and it 404s: `href="tide/styles.css"` inside `tide/index.html` — the
browser resolves that to `tide/tide/styles.css`, so no stylesheet and no script
load, and the page is unstyled markup with dead buttons.

## 2b. Look before you create

`create_app` refuses a folder that already has something in it unless you pass
the app in `files` — and a folder you half-made on an earlier attempt counts.
One `list_dir` in front of it costs a second and tells you whether you are
starting or resuming. The same goes for any command that makes a directory.

## 2c. Do not type what already exists

`add_block` has the pieces every app needs, written for whichever starter this
one uses: a list you can add to, tick off, rename and remove; a filter row; a
localStorage store; a dialog; toasts; a theme toggle; a table; an empty state.
Call it before writing any of those by hand. Each is a hundred lines you skip,
and typing is the slowest part of a build — a page assembled from blocks is
done minutes before the same page typed out. Call `add_block` with no name to
see what fits this app.

## 3. Structure

One component per file, named for what it is, not a 600-line `page.tsx`. In
Next.js: `src/app` (routes, `globals.css`, `api/<name>/route.ts`),
`src/components/<feature>/`, `src/lib/` for outside services and schemas.
Server components by default, `"use client"` only where it is interactive.
Types at every boundary; parse external data rather than trusting its shape.

## 4. Secrets and outside services

- **A key never reaches the browser.** It lives in a server route. Anything
  imported by a `"use client"` file ships to every visitor, including a
  "hardcoded for now" key — put it in a server-only module and say where.
- Every outbound call gets a timeout (`AbortSignal.timeout(60_000)`), a status
  check, and an error that says what failed — surfaced as a real message,
  never a silent `catch {}`.
- Calling a model: ask for JSON and parse it defensively (extract the first
  `{...}`, validate, clamp numbers), put the judgement rules in the prompt
  explicitly, and make the route timeout longer than the model takes.

## 5. Build order

Skeleton and design tokens first, so everything after is styled correctly the
first time; then the server route with the real integration; then the core
loop UI wired to it; then every state — empty, loading, success, error,
invalid input; then polish: motion, responsive, copy, title and metadata.

## 5a. It has to look finished

People judge the app in the first second it is on screen, before they click
anything. Before handing it over, check:

- A real title and one line saying what it is for — never "Welcome to…".
- The main action is visible without scrolling and is the most prominent button.
- Every button and input has hover and focus states; nothing is left browser-default.
- An empty list says what to do next ("No tasks yet — add one above"), never blank.
- It fits a 375px phone with no sideways scroll; tap targets are at least 44px.
- The number that matters (a score, a total, a timer) is big — several times body text.

## 5b. Tests, where there is a runner

`next-shadcn` ships vitest and one passing test, so `npm test` works from
the first minute — add cases for the core loop as you build it, not after, and
ucode will run the ones that touch whatever you change. Assert behaviour: that
adding an item puts it in the list, that the total is right, that an empty
input is refused.

`plain-html` has no runner and installs nothing, by design. Its test is the
browser check: ucode opens the app, types into the first field, presses Enter
and clicks the button that submits. Make sure that path is the one that works.

## 6. Prove it works, then report

`npm run build` type-checks and lints — a build that fails is not done. Start
it (`npm run dev` backgrounds itself and returns the URL; do not start it
twice), then `look_at_app` on every page. A clean build proves it compiles,
not that it works. Fix what you find and check again.

Done means: the core loop works end to end, no TODO, no placeholder copy, no
dead buttons, no console errors, every async action has its states, secrets
server-side, build passes. Then say what you built, how to run it, and — in
one sentence — anything you did not finish or could not test.
