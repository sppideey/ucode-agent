/**
 * jslogic.js — the logic mistakes, in the system prompt, every turn.
 *
 * Skills are disclosed progressively and that is right for almost everything:
 * a body loads when the work matches it. This does not, because the failures
 * below do not announce themselves. They arrive in the middle of a build
 * nobody called "a JavaScript task" — an empty state that stops coming back,
 * a listener attached to a row that has since been replaced — and by the time
 * the work looks like it needs a guide, the guide is being read too late.
 *
 * So it is always on, and the price of that is length: every word here is
 * re-read by the provider on every step of every build. It is kept to the
 * mistakes that have actually shipped from here, in the shortest form that
 * still says what to do instead. Anything a parser could catch belongs in a
 * check — see htmlcheck.js — not in this list. Nothing general about
 * JavaScript belongs here at all: the model already knows it, and a paragraph
 * confirming what it knows costs the same as one it does not.
 *
 * The vanilla section is drawn from builds that came out of ucode looking
 * finished and were not. The framework section is the same failures one level
 * up.
 */

export const JS_LOGIC = `## The logic mistakes that ship looking finished

Every one of these renders. None of them throws where you can see it. Check
each against what you are writing, before you write it.

In a page:

- **Empty is a state, not a starting position.** A render function that clears
  its container decides what zero items looks like, in that same function.
  Markup sitting in index.html, or one render call at start-up, survives the
  first paint and then never comes back: add an item, delete it, and the list
  is blank for good.
- **User text goes in with textContent.** Into innerHTML, a task named
  \`<img src=x onerror=alert(1)>\` runs, and one reading \`5 < 6\` silently eats
  the rest of the row. Build rows with createElement and set .textContent.
- **Every var(--x) needs a --x in :root.** An undefined custom property does
  not fall back and does not warn — the browser discards the whole declaration,
  so the padding is simply missing. Use only names you defined.
- **One listener on the container, not one per row.** Re-rendering throws the
  rows away and their listeners with them. Listen on the list and read
  event.target.closest('[data-id]').
- **An id that goes through the DOM comes back a string.** dataset.id is
  "1738", never 1738, so === against a numeric id is always false. Make ids
  strings when you create them.
- **Saved is not loaded.** Writing localStorage is half of it: read it as the
  page boots, before the first render, and confirm a refresh keeps the state.
- **A missing element kills every line after it.** getElementById returns null
  for a typo, .addEventListener on it throws, and the rest of the module never
  runs — so every later handler in that file is silently never attached. One
  typo, and nothing on the page works.

In React or Next, the same failures one level up:

- **Setting state does not change the variable you are holding.** Two
  setCount(count + 1) in one handler add one. Pass a function when the next
  value depends on the last.
- **State is replaced, never edited.** items.push(x) then setItems(items) is
  the same reference, so nothing re-renders.
- **Hooks run every render, in order** — never inside an if, a loop, or after
  an early return.
- **An effect that sets what it depends on is a loop**, and one with no
  dependency array runs after every render.
- **key={index} is not identity.** On a list that reorders or filters, it moves
  state onto the wrong row.
- **"use client" is per file, at the top.** State, an event handler or a
  browser API in a server file fails at build, not at run.`;
