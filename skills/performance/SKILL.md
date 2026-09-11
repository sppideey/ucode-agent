---
name: performance
description: Make software measurably faster — measure first, find the real bottleneck, fix it, and prove the improvement with numbers. Covers web vitals, bundles, React rendering, APIs, databases and Node.
auto: slow, slower, performance, perf, optimize, optimise, optimization, speed up, faster, lag, laggy, sluggish, bundle size, lighthouse, core web vitals, web vitals, lcp, cls, inp, memory leak, re-render, rerender, n+1, latency, takes too long
---

# Performance

Guessing at performance is how people spend a day optimizing something that
was never slow. Measure, change one thing, measure again.

## 1. Measure before touching anything

- **Define the slow thing precisely**: which page, action or endpoint, how slow
  now, how fast it needs to be.
- **Get a baseline number** you can re-run:
  - Web page: Lighthouse / PageSpeed (LCP, INP, CLS, total JS), the browser
    Performance panel, `next build` output (per-route JS size).
  - API: time the request (`curl -w "%{time_total}\n"`), log durations per step.
  - Node/Python: a profiler (`node --cpu-prof`, `clinic`, `py-spy`), or timers
    around the suspect code.
  - Database: `EXPLAIN ANALYZE` on the slow query.
- Measure the production build, not dev mode — dev is deliberately slow.

## 2. Find the actual bottleneck

It is almost always one of these, in roughly this order of likelihood:

1. **Network waterfalls** — requests that wait on each other when they could run
   in parallel; data fetched on the client that could be fetched on the server.
2. **Too much JavaScript** — heavy dependencies, everything marked
   `"use client"`, no code splitting.
3. **Unoptimized images and fonts** — huge images, no dimensions (layout shift),
   blocking font loads.
4. **Database** — N+1 queries, missing indexes, fetching whole tables, no
   pagination.
5. **Rendering** — React re-rendering large trees on every keystroke, expensive
   work inside render, long lists without virtualization.
6. **Algorithmic** — nested loops over large data, repeated work that could be
   cached or computed once.

## 3. Fixes by area

**Web (Next.js / React)**
- Server components by default; `"use client"` at the leaves only.
- `next/image` with explicit sizes; `priority` on the LCP image; modern formats.
- `next/font` with `display: swap`, only the weights used.
- Dynamic `import()` for heavy, below-the-fold or rarely used components.
- Replace heavy libraries (moment → date-fns/Intl, lodash → native, big chart
  libs → lighter ones) and check the per-route JS in the build output.
- Parallelize independent fetches with `Promise.all`; stream with `Suspense`.
- Cache: static where possible, `revalidate` for data that changes slowly.

**React rendering**
- Keep state as low in the tree as possible; lift only what must be shared.
- Stable props: memoize expensive values and callbacks passed to memoized
  children — but only where the profiler shows a real cost.
- Virtualize lists over a few hundred rows.
- Debounce input-driven work (search, validation) at ~200–300ms.

**APIs and databases**
- Index columns used in `WHERE`, `JOIN` and `ORDER BY`; confirm with `EXPLAIN`.
- Batch or join instead of querying in a loop (N+1).
- Select only the columns needed; paginate everything user-sized.
- Cache expensive, repeatable results (in memory, Redis, HTTP caching) with a
  clear invalidation rule.
- Move slow non-essential work (emails, analytics, thumbnails) to a background
  job.

**Node**
- Never block the event loop with sync I/O or heavy CPU in a request handler.
- Stream large files instead of reading them whole.
- Reuse clients and connections (DB pools, HTTP keep-alive).

## 4. Change one thing at a time, and prove it

After each change, re-run the same measurement. Keep changes that move the
number; revert ones that do not — complexity without a measured win is a cost.

## 5. Report with numbers

Before and after for each metric that changed ("LCP 4.1s → 1.6s, route JS
312 kB → 148 kB"), what caused it, and anything left that would need a bigger
change to fix.
