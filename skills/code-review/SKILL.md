---
name: code-review
description: Review a change the way a careful colleague would — correctness first, then the things that will hurt later, with the reasoning attached.
---

# Reviewing code

A review that lists everything is not a review, it is a linter with opinions.
Rank what you find, and be honest about which parts you actually verified.

## Read it in this order

1. **Correctness.** Does it do what it claims? Walk the edge cases: empty,
   one, many, null, the boundary value, the concurrent call, the second run.
2. **Failure.** What happens when the thing it depends on fails? A swallowed
   error and a bare `catch {}` are bugs waiting for the worst possible moment.
3. **Security.** Untrusted input reaching a query, a shell, a path, or the DOM.
   Secrets in the source. Credentials in a log line.
4. **Contracts.** Did a signature, a return shape or a stored format change
   without every caller and every existing row being accounted for?
5. **Clarity.** Names that say what the thing is. Comments that explain why,
   never what. A function that fits in your head.
6. **Tests.** Does the test actually fail when the code is wrong? A test that
   asserts a mock was called proves nothing about behaviour.

## Say it usefully

For each finding: the file and line, what breaks, and the input that breaks it.
"This could be cleaner" is not actionable. "`parse()` throws on an empty body,
which the retry path hits on a 204" is.

Separate what you know from what you suspect, and say which is which. If you
did not run it, do not describe the behaviour as if you watched it happen.

Say what is good, briefly, and only where it is genuinely worth copying.
Reviews that never approve of anything stop being read.
