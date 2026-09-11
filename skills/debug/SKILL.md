---
name: debug
description: Find and fix the real cause of a bug — reproduce it, narrow it down with evidence, prove the fix, guard it with a test, and check for the same bug elsewhere.
auto: bug, crash, crashes, crashing, broken, not working, doesn't work, does not work, stack trace, exception, traceback, throws, failing, fails, regression, undefined is not, cannot read properties, 500 error, blank page, hangs, freezes
---

# Debugging

The temptation is to read the code, form a theory, change something, and call
it fixed when the symptom goes away. That moves bugs rather than fixing them.
Work from evidence, in this order.

## 1. Reproduce it yourself

Do not debug from the description. Run it and see it fail: the exact command,
the input, the full error, the line it comes from. Write down the reproduction
as a single command or a few steps — you will run it again at the end.

If you cannot reproduce it, say so and ask for exactly what is missing: the
input, the environment, the version, the full output. Guessing from a
paraphrase wastes everyone's turn.

## 2. Read the whole error

- The whole stack trace, including frames you assume are irrelevant. The top
  frame is where it surfaced, not necessarily where it went wrong.
- The first error, not the last. Later errors are often consequences.
- `grep` for the exact message text to find where it is produced.
- Check the obvious before the clever: is the file saved, the server restarted,
  the right branch checked out, the env var set, the dependency installed, the
  cache cleared (`.next`, `node_modules/.vite`, `__pycache__`)?

## 3. Narrow it down

Cut the search space in half each step:

- **Input:** does a smaller or simpler input still fail? Find the smallest one
  that does.
- **Code:** comment out or bypass half the path. Does it still fail?
- **Time:** did it work before? `git log` / `git diff` since then, or
  `git bisect` between a good and a bad commit.
- **Layer:** is the value right when it enters the function? When it leaves?
  At the API boundary? In the database? Log it at each boundary and look,
  rather than reasoning about what it "should" be.

The value you are sure about is the one under suspicion. Print it.

## 4. Know where bugs usually live

- **Async:** a missing `await`, a race between two requests, state read before
  it is set, a promise rejection nobody catches.
- **State:** stale closures in React effects, mutation of shared objects, a
  cache that was never invalidated.
- **Boundaries:** off-by-one, empty arrays, `null` vs `undefined` vs `''`,
  timezones, number parsing (`'10' + 1`), float rounding.
- **Data shape:** the API returned something different from the type — an
  error object, a wrapped payload, a string instead of JSON.
- **Environment:** missing env var, wrong Node version, path case sensitivity,
  Windows vs POSIX paths and line endings, a port already in use.
- **Build tooling:** a stale build cache, a server/client boundary violation in
  Next.js, a default vs named export mismatch, ESM vs CommonJS.

## 5. State the cause before fixing it

Write it in one sentence: *"`score` is `undefined` here because the parser
returns `{ data: {...} }` and the component reads `result.score`."* If you
cannot write that sentence, you have not found the cause yet — keep narrowing.

## 6. Fix the cause, not the symptom

A `?.` or a `try/catch` that hides the failure leaves the defect in place under
one more layer. Fix it where it originates. Keep the change as small as the
cause allows, and do not refactor unrelated code in the same change.

## 7. Prove it

- Run the original reproduction. It must pass now.
- Run the whole test suite. A fix that breaks two other things is a trade the
  user gets to decide on, not you.
- Add a regression test that fails without the fix and passes with it — then
  briefly revert the fix to confirm the test really catches it.
- Look for the same mistake elsewhere: `grep` for the same pattern, call, or
  assumption. Bugs come in families.

## 8. Report

The cause in one or two sentences, the fix, how you verified it, and anything
adjacent you noticed but did not change. If you could not fully confirm it,
say what is still uncertain.
