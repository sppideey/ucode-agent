---
name: write-tests
description: Write tests that fail for the right reason — behaviour over implementation, real edges, and no assertions that can never break.
---

# Writing tests

The test that matters is the one that fails the day someone breaks the thing it
covers. Every other test is overhead with a green tick on it.

## Test behaviour, not implementation

Assert on what a caller can observe: the return value, the state afterwards,
the thing that was written. A test that checks a private helper was called
locks the implementation in place and will need rewriting the first time
anyone refactors — while still not proving the feature works.

## Cover the edges, not five versions of the middle

For each unit, the ones that actually find bugs:

- empty, one, many
- the boundary: 0, -1, the last index, the maximum
- null, undefined, the missing field, the wrong type
- the failure path: the dependency throws, the network times out, the file is
  gone
- the second call: is it idempotent, is state left behind?

## Make each test readable on its own

- The name says the behaviour: `returns null when the session file is missing`.
- Arrange, act, assert, in that order and visibly separated.
- One reason to fail per test. Six assertions in a row means the first failure
  hides the other five.
- No shared mutable state between tests, and no dependence on the order they
  run in.
- Real values over mocks wherever it is affordable. Mock the network and the
  clock; do not mock the thing you are testing.

## Prove the test works

Break the code on purpose and watch the test fail, then put it back. A test
that has never failed is a test you have no reason to trust. If a test cannot
fail — an assertion on a constant, a mock asserting itself — delete it.

Then run the whole suite and report the real numbers, including anything that
was already failing before you started.
