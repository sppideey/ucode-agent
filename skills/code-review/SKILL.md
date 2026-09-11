---
name: code-review
description: Review code the way a senior engineer would — correctness first, then security, failure handling, contracts, performance and tests, with every finding ranked, located and backed by a concrete failing scenario.
auto: review, code review, review my, review this, audit this, look over, check my code, pr review, pull request
---

# Reviewing code

A review that lists everything is a linter with opinions. The value is in
finding what will actually break, ranking it, and being honest about what you
verified versus what you suspect.

## 1. Understand before judging

- What is the change trying to do? Read the description, the diff, and enough of
  the surrounding code to know the callers and the data it touches.
- Get the diff: `git diff`, `git diff main...HEAD`, or the files named. Read
  every changed file in full, not only the hunks — context is where bugs hide.
- If there are tests, run them. If it runs, run it.

## 2. Passes, in order of what hurts most

1. **Correctness** — does it do what it claims for every input? Walk: empty,
   one, many, null/undefined, the boundary value, duplicates, the second call,
   concurrent calls, a slow or failing dependency.
2. **Security** — untrusted input reaching SQL, a shell, a file path, a URL
   fetch (SSRF), `innerHTML`/`dangerouslySetInnerHTML`, `eval`, a redirect.
   Secrets in source, in client bundles, or in logs. Missing auth or
   authorization checks on a route. IDs a user can change to see someone
   else's data.
3. **Failure handling** — errors swallowed (`catch {}`), a fallback that hides
   a real failure, no timeout on an outbound call, a partial write left behind,
   an error message that leaks internals.
4. **Contracts** — a changed signature, return shape, API response, or stored
   format without every caller and every existing record accounted for.
   Migrations that are not reversible or not safe on live data.
5. **Performance** — N+1 queries, unbounded loops over user data, missing
   pagination, work in a render loop, a huge dependency for a small job,
   blocking I/O on a hot path.
6. **Concurrency and state** — shared mutable state, race conditions,
   stale caches, React effects with missing or wrong dependencies.
7. **Tests** — do they fail when the code is wrong? A test asserting a mock was
   called proves nothing about behaviour. Are the risky paths covered?
8. **Clarity** — names that say what things are, functions that fit in your
   head, comments that explain *why*. Only flag this when it will cause a real
   misunderstanding.

## 3. Verify before you report

For each suspected issue, check it: read the caller, trace the value, run the
case if you can. Drop anything you cannot substantiate, or label it clearly as
a question rather than a finding.

## 4. Write findings that can be acted on

Rank by severity:

- **Blocker** — wrong results, data loss, a security hole, a crash on a normal path.
- **Major** — breaks on a realistic edge case, or a failure that will be hard to diagnose.
- **Minor** — a real but small risk, or a clear maintainability cost.
- **Nit** — style and preference. Keep these few, or leave them out.

Each finding: **where** (`path:line`), **what breaks**, **the input or sequence
that breaks it**, and **the fix**. For example:

> **Major** — `src/app/api/analyze/route.ts:42` — `JSON.parse(text)` throws when
> the model wraps its reply in a code fence, which it does intermittently. The
> route then returns a 500 with no message. Extract the first `{…}` block and
> validate it with the zod schema; return a 422 with "could not read the label"
> on failure.

"This could be cleaner" is not a finding.

## 5. Close out

Start with a one-line verdict (ship / ship after fixes / needs rework), then
the findings, most severe first. Mention what is genuinely good only where it
is worth copying. State what you did not review or could not run.

If asked to fix the findings, fix blockers and majors first, re-run the tests,
and report what changed.
