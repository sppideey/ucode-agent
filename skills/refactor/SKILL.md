---
name: refactor
description: Restructure code without changing what it does — a safety net first, small verified steps, clear boundaries and names, and no behaviour change slipped in along the way.
auto: refactor, refactoring, clean up, cleanup, clean this, restructure, reorganize, reorganise, simplify, tech debt, technical debt, extract, split this file, split up, dead code, duplicate code, duplication, messy code, spaghetti
---

# Refactoring

A refactor changes the shape of code and nothing else. The moment behaviour
changes, it is a rewrite, and a rewrite hidden inside a refactor is how
regressions ship with nobody noticing.

## 1. Know why, and where it stops

- State the goal in one line: *split the 700-line page into components*,
  *remove the duplicated fetch logic*, *make the scoring rules testable*.
- State the boundary: which files are in scope. Resist improving everything you
  pass on the way — note it and leave it.

## 2. Build the safety net first

- Run the existing tests and record the result. If there are none around the
  code you are changing, **write characterization tests first**: tests that pin
  down what the code does now, including its odd behaviour. You are preserving
  behaviour, so you must be able to detect when it changes.
- For UI with no tests, capture the current behaviour: what renders in each
  state, what each control does.

## 3. Read it all before moving anything

Read every file in scope in full, and find every caller of what you will change
(`grep` for the names, the imports, the routes). A rename that misses one
dynamic reference is a runtime error waiting for the one path nobody tested.

## 4. Small steps, each one green

Do one kind of change at a time, and run the tests after each:

- **Rename** to say what things are: `data` → `analysis`, `handle()` →
  `submitLabel()`. Names are most of readability.
- **Extract** a function or component for each distinct job; a function should
  do one thing at one level of abstraction.
- **Move** code next to what uses it: feature folders over type folders.
- **Remove duplication** only when the copies really are the same concept —
  two similar-looking pieces that change for different reasons should stay two.
- **Delete dead code** — unused exports, unreachable branches, commented-out
  blocks. Confirm it is unused with a search first.
- **Simplify conditionals**: early returns over nesting, lookup tables over long
  `if/else` chains, named booleans over complex expressions.
- **Push side effects to the edges**: pure logic in the middle (easy to test),
  I/O at the boundary.

Use `multi_edit` for several changes in one file, and keep each step small
enough that a failing test points straight at the cause.

## 5. Keep behaviour identical

- Same inputs, same outputs, same errors, same side effects, same order of
  side effects.
- Public APIs and stored formats unchanged, or every caller and every stored
  record updated in the same change.
- If you find a bug while refactoring, **do not fix it silently inside the
  refactor**. Finish the refactor, then fix the bug as its own change — or
  report it — so each can be reviewed and reverted on its own.

## 6. Finish

- All tests pass, the build passes, the linter and type checker are clean.
- The code is measurably simpler: fewer lines, fewer branches, smaller files,
  clearer names — say which.
- Report what moved where, anything you noticed but deliberately left alone,
  and any behaviour you had to pin down with new tests.
