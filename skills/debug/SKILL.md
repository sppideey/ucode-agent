---
name: debug
description: Find the actual cause of a bug instead of the first plausible one — reproduce it, narrow it, prove the fix, and leave a test behind.
---

# Debugging

The temptation is to read the code, form a theory, change something, and
declare victory when the symptom disappears. That is how a bug gets moved
rather than fixed.

## Reproduce it first

Do not start from the description. Run the thing and see the failure with your
own eyes: the command, the input, the exact error and where it comes from. If
you cannot reproduce it, say so and ask for what you need — the input, the
version, the full stack. Guessing from a paraphrase wastes everyone's turn.

## Narrow before you theorise

- Read the whole stack trace, including the frames you assume are irrelevant.
  The top frame is where it surfaced, not necessarily where it went wrong.
- `grep` for the message text to find where it is produced.
- Cut the search space in half at a time: does the smaller input fail? Does it
  fail on the previous commit? Does the layer below get the right value?
- Print or log the values at the boundary rather than reasoning about what they
  should be. What you believe is in that variable is the thing under suspicion.

## Fix the cause

State the cause in one sentence before you change anything: *this value is
undefined here because the caller only sets it on the success path*. If you
cannot write that sentence, you have not found it yet.

Then fix that, not the symptom. A guard that hides the undefined value leaves
the real defect in place, with one more layer over it.

## Prove it

- Run the original reproduction. It must now pass.
- Run the rest of the tests. A fix that breaks two other things is a trade,
  and the user gets to make it, not you.
- Write a test that fails without your fix. A bug with no regression test comes
  back.

Then say what the cause actually was, in one or two sentences. If you fixed
something adjacent along the way, say that too.
