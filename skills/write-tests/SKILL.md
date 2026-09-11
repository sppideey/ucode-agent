---
name: write-tests
description: Write tests that catch real regressions — the right level for each behaviour, real edge cases, deterministic setups, mocks only at the boundaries, and proof that each test can actually fail.
auto: write tests, add tests, add a test, unit test, unit tests, test coverage, integration test, e2e test, end to end test, testing, vitest, jest, pytest, playwright
---

# Writing tests

The test that matters is the one that fails the day someone breaks what it
covers. Every other test is overhead with a green tick on it.

## 1. Find how this project tests

- Look for the runner and its config before writing anything: `vitest.config.*`,
  `jest.config.*`, `playwright.config.*`, `pytest.ini`/`pyproject.toml`,
  `go test`, the `test` script in `package.json`.
- Match the existing style: file location (`__tests__/`, `*.test.ts` beside the
  source, `tests/`), naming, helpers, fixtures. Use what is there.
- If nothing exists, pick the standard for the stack — Vitest for Vite and
  Next.js, pytest for Python, the built-in `go test` — and add the script.

## 2. Pick the right level for each behaviour

- **Unit** — pure logic: parsing, scoring, validation, formatting, reducers.
  Fast, many, no I/O.
- **Integration** — a route handler with its validation and error paths, a
  component with its real children, a module against a real temporary
  database or filesystem.
- **End to end** — the one or two core user journeys, in a real browser
  (Playwright). Few, because they are slow and brittle.

Most value per minute is in unit tests of the logic that makes decisions and
integration tests of the boundaries where data comes in.

## 3. Test behaviour, not implementation

Assert what a caller can observe — the return value, the rendered output, the
response, the state afterwards. A test that checks a private helper was called
breaks on every refactor while proving nothing about the feature.

For UI, query the way a user finds things: by role, label and text
(`getByRole('button', { name: /analyze/i })`), not by class names or test IDs
unless there is no accessible alternative.

## 4. Cover the cases that find bugs

For every unit, go through:

- empty, one, many
- boundaries: 0, -1, the exact threshold, just over and just under it, the max
- missing: `null`, `undefined`, missing field, empty string, wrong type
- malformed input: invalid JSON, a string where a number was expected,
  a reply wrapped in prose
- failure paths: the dependency throws, times out, returns an error status
- repetition: the second call, the same input twice, concurrent calls

A threshold rule ("sodium over 600mg is flagged") needs a test at 599, 600 and
601. That is where the off-by-one lives.

## 5. Keep tests deterministic and independent

- Control time (`vi.useFakeTimers()`, a fixed clock) and randomness (a seed).
- No real network. Mock at the boundary — the HTTP call, the SDK client — and
  never mock the thing under test.
- Each test sets up what it needs and cleans up after. No reliance on order.
- Build test data with small factories so each test states only what matters
  to it.
- One behaviour per test, named for it:
  `flags sodium when it is over the daily threshold`.
- Arrange, act, assert — visibly separated.
- Snapshots only for stable, small output; a 400-line snapshot gets approved
  without being read.

## 6. Prove each test can fail

Break the code on purpose — flip a comparison, delete a branch — and watch the
test fail, then restore it. A test that has never failed is a test you have no
reason to trust. Delete tests that cannot fail (asserting a constant, a mock
asserting itself).

## 7. Run and report

Run the whole suite, not only the new file. Report the real numbers — passed,
failed, skipped — including anything that was already failing before you
started, and anything you could not cover and why.
