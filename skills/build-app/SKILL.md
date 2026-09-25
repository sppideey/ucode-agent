---
name: build-app
description: Take an app from nothing to running and finished — stack choice, non-interactive scaffolding, project structure, secrets, AI and API integration, error handling, and proving it works before saying it does.
auto: scaffold, new project, from scratch, build an app, make an app, create an app, build a website, make a website, build a site, build me a, next.js app, nextjs app, next app, react app, vite app, shadcn, create-next-app, full stack, fullstack, saas, mvp
---

# Building something from nothing

The failure mode is not bad code. It is a folder of files that has never been
run, handed over as if it works. Everything here is ordered to prevent that.

## 1. Decide the shape, out loud, before any file exists

One line each:

- **What it does** — the sentence a user would say.
- **The core loop** — the one path through it that must work perfectly
  (e.g. upload a photo → analysed → see a score and the problems).
- **The stack, and why** — the smallest thing that does the job:

  | Need | Choose |
  | --- | --- |
  | One page, no secrets, no server | `create_app` with the `plain-html` starter |
  | Interactive client app, no secrets | `plain-html` still, unless it truly needs a build |
  | Pages plus a server, secrets, API routes, SEO | `create_app` with `next-shadcn` |
  | An API on its own | Node (Hono/Express) or Python (FastAPI) |

  Choose the smallest one that does the job, and mean it: a tasks app, a
  calculator, a timer, a game, a visualisation, a converter — all one page.
  Next.js costs an install and a build, minutes the user waits through, and
  buys nothing an app with no server needs.

- **The file list** — the whole tree, before creating any of it.

If there is a user interface, the `ui-ux` skill is already loaded. Decide the
design direction now, not after the logic works. If the app calls a model,
load `ai-features`; if it has accounts, keys or uploads, load `security`.

## 2. Start from the starter — and finish in the same call

`create_app` copies a starter that is already known to build. It also takes
`files`, so for a one-page app the scaffold and the whole app are one call:

```
create_app({
  folder: "tide", name: "Tide", description: "…",
  files: [
    { path: "tide/index.html", content: "…" },
    { path: "tide/styles.css", content: "…" },
    { path: "tide/app.js",     content: "…" },
  ],
})
```

That is the whole build. Every round trip is ten to forty seconds of the
user's time, so the difference between one call and four is most of how long
this takes.

- **`plain-html` is the default**: three files, no install, no build, opens in
  a browser. Its files come back in full inside the result — **never read them
  back**, they are already in front of you.
- **`next-shadcn`** only when the app needs routes, a database or many
  screens. It copies Next.js 16, TypeScript, Tailwind 4 and shadcn with its
  components, light/dark and toasts, and starts `npm install` in the
  background — commands in that folder wait for the install on their own, so
  start writing components at once. Read the `TEMPLATE.md` in the result, and
  re-tint `globals.css` for the app's direction.

Never run `create-next-app` or `shadcn init` — that is four minutes and a
dozen steps the starter already did.

### Other stacks

Nothing you run has a keyboard. A scaffolder that asks "Would you like to use
TypeScript?" gets no answer and fails, so give it every answer up front:

```bash
# Next.js into ./my-app (use . to fill the current folder — it must be empty)
npx create-next-app@latest my-app --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes

# shadcn/ui, from inside the project — every component you need, in one add
npx shadcn@latest init -d -y
npx shadcn@latest add button card input label badge progress separator skeleton sonner tooltip -y
```

- `create-next-app` refuses a folder that already has files. If the current
  folder is not empty, scaffold into a named subfolder and pass it as `cwd` to
  every later command.
- For any other scaffolder, find the flag for every question (`--help`) first.
- Install dependencies once, all together: `npm i zod lucide-react` — not one
  `npm i` per package.

## 2b. Do not type what already exists

`add_block` has the pieces every app needs, written once and carefully, for
whichever starter this app uses. For a plain page: `item-list` (add, tick off,
rename, remove, empty state, counts, keyboard), `filter-bar`, `store`
(localStorage that survives private mode and stays in step across tabs),
`modal`, `toast`, `theme-toggle`. For React: `app-shell`, `page-header`,
`empty-state`, `data-table`, `stat-cards`.

Call it before writing any of those by hand. Two reasons, and the second is
the one that gets forgotten:

- They are finished. Every state, the keyboard, small screens, the cases a
  first draft skips.
- They are already typed. Typing is the slowest part of a build — a few
  thousand tokens at forty a second — so a page assembled from blocks is done
  minutes before the same page written out line by line.

They land as ordinary source files. Edit them to suit the app rather than
working around them.

## 3. Structure it like a real project

For Next.js App Router:

```
src/
  app/
    layout.tsx          fonts, metadata, <body> shell, Toaster
    page.tsx            the screen — composes components, holds little logic
    globals.css         design tokens and the shadcn theme variables
    api/<name>/route.ts server-only endpoints; the only place secrets live
  components/
    <feature>/          one folder per feature: its pieces, split by job
    ui/                 shadcn components (generated — edit via the theme)
  lib/
    <service>.ts        calls to outside services, typed in and out
    schemas.ts          zod schemas shared by client and server
    utils.ts
  types/                shared TypeScript types, if lib/ does not own them
```

- **One component per file**, named for what it is (`ScoreDial.tsx`,
  `NutrientFindings.tsx`, `LabelUpload.tsx`), not a 600-line `page.tsx`.
- Server components by default; `"use client"` only on the interactive parts.
- Types at every boundary. Parse external data with zod rather than trusting
  its shape.

## 4. Secrets and outside services

- **A key never reaches the browser.** It lives in a server route or server
  action. Anything imported by a `"use client"` file ships to every visitor —
  including a "hardcoded for now" key. If the user asks to hardcode one, put it
  in a server-only module (`lib/server/*.ts`, or `import 'server-only'`) and
  say where it is so they can move it to `.env.local` later.
- Every outbound call gets: a timeout (`AbortSignal.timeout(60_000)`), a check
  of the response status, and an error that says what failed — surfaced to the
  UI as a real message, never a silent `catch {}`.

### Calling an AI model (any OpenAI-compatible API)

```ts
// src/app/api/analyze/route.ts — runs on the server only
export const runtime = 'nodejs';
export const maxDuration = 60;

const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'provider/model-id',
    messages: [
      { role: 'system', content: 'Reply with JSON only, matching this shape: {...}' },
      { role: 'user', content: [
        { type: 'text', text: 'Analyse this nutrition label.' },
        { type: 'image_url', image_url: { url: dataUrl } },   // data:image/jpeg;base64,...
      ] },
    ],
  }),
  signal: AbortSignal.timeout(60_000),
});
```

- **Ask for JSON and parse it defensively.** Models wrap JSON in prose or code
  fences: extract the first `{...}` block, `JSON.parse` it, validate with zod,
  and on failure return a clear "could not read the result" error rather than
  crashing. Clamp numbers to their range.
- **Put the judgement rules in the prompt, explicitly** — thresholds, what
  counts as "too much", what to omit. A vague prompt gives a different answer
  every time; a specific one gives the product its consistency.
- **Images:** check type and size on the client (e.g. ≤ 5 MB, jpeg/png/webp),
  downscale large photos in a canvas before upload, send as a base64 data URL.
- Reasoning models may take 10–60s. Show progress, and make the route's
  timeout longer than the model's.

## 5. Build order

1. Skeleton and design tokens, so every later piece is styled correctly first time.
2. The server route with the real integration, tested with `curl` before any UI.
3. The core loop UI, wired to the real route.
4. Every state: empty, loading, success, error, and invalid input.
5. Polish: motion, responsive, copy, favicon, page title and metadata.

Use `batch_write` for the skeleton — one call, every file.

## 5a. It has to look finished

People judge the app in the first second it is on screen, before they click
anything. Before handing it over, check:

- A real title and one line saying what it is for — never "Welcome to…".
- The main action is visible without scrolling and is the most prominent button.
- Every button and input has hover and focus states; nothing is left browser-default.
- An empty list says what to do next ("No tasks yet — add one above"), never blank.
- It fits a 375px phone with no sideways scroll; tap targets are at least 44px.
- The number that matters (a score, a total, a timer) is big — several times body text.

## 6. Prove it works

- `npm run build` — it type-checks and lints; a build that fails is not done.
- Start it: `npm run dev` goes to the background on its own and comes back with
  the URL once ready. Do not start it twice.
- Exercise it: `curl` the API route with real input, then `look_at_app` on every
  page — it loads them in a real browser at phone and desktop width and reports
  errors, overflow and a visual review. A clean build proves it compiles, not
  that it works.
- Fix what you find and check again.

## 7. Definition of done

- The core loop works end to end against the real service.
- No `TODO`, no placeholder copy, no dead buttons, no console errors.
- Every async action has loading, success and error states.
- Invalid input is caught with a useful message before it reaches the server.
- Secrets only on the server.
- `npm run build` passes.

## 8. Report

What you built, the URL, how to start it again, and what you checked. If
anything is untested or unfinished, name it — one sentence of honesty saves the
user an hour of finding out on their own.
