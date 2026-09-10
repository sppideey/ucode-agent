---
name: ui-ux
description: How to design and build an interface that looks deliberate rather than generated — direction, tokens, layout, states, motion, accessibility. Loads itself for any work with a user interface in it.
auto: app, apps, ui, ux, website, web app, webapp, web page, webpage, landing page, dashboard, frontend, front-end, interface, css, tailwind, html, react, vue, svelte, nextjs, next.js, redesign, restyle, responsive, dark mode, ugly, styling, stylesheet, mockup, prototype
---

# Interfaces

The house style of a language model is a centred column, a purple-to-blue
gradient, three equal cards and a lot of empty space. It is recognisable on
sight, and everyone has now seen it a thousand times. Your job is to not
produce it.

This is not decoration applied at the end. It is the order the work happens in:
direction, then structure, then tokens, then states, then verification.

## 1. Decide the direction before writing any CSS

Answer these to yourself in one line each, then build to the answers:

1. **Job** — what does this screen actually do?
2. **Who** — who opens it, how often, and what do they need first?
3. **Tone** — pick one and commit: utilitarian, editorial, technical, playful,
   industrial, calm, dense. "Modern and clean" is not a tone, it is a way of
   avoiding the question.
4. **One memorable detail** — a colour, a texture, a typographic move, a single
   interaction. Exactly one. It is the difference between a design and a
   template.

## 2. Pick the mode from the surface, not the product

The mode names what success looks like for the person in front of it. It
decides how much the interface is allowed to perform.

- **Operate** — they are completing a task. App UI, dashboards, editors,
  admin, settings, tools. Scannability, consistency and speed beat expression
  every time. The personality lives in precise details, not in the hero.
- **Persuade** — they are deciding whether to act. Landing pages, pricing,
  marketing. Here the design *is* the product; earn the attention.
- **Read** — they are trying to understand something. Docs, articles, guides.
  Structure for comprehension first, then make reading pleasant enough to stay.
- **Experience** — they are looking at the work itself. Portfolios, galleries.
  The artifact leads from the first screen and the interface gets out of the way.

A tool's landing page is still Persuade. A dashboard is still Operate however
beautiful the brand is. Never put a marketing hero on top of a working tool.

## 3. Tokens first, then never a raw value again

Set these at the top and use them everywhere. One-off hard-coded values are
exactly how a design drifts out of alignment with itself.

```css
:root {
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, monospace;

  /* One scale. Nothing between the steps. */
  --text--1: .8125rem; --text-0: 1rem;   --text-1: 1.25rem;
  --text-2:  1.5rem;   --text-3: 2rem;   --text-4: 2.75rem;

  --s1: .25rem; --s2: .5rem; --s3: .75rem; --s4: 1rem;
  --s5: 1.5rem; --s6: 2rem;  --s7: 3rem;   --s8: 4rem;

  /* Neutrals carry a hue. Flat #808080 grey is what makes a UI look dead. */
  --bg: #fbfaf9;  --surface: #ffffff; --line: #e6e2dd;
  --ink: #17161a; --ink-2: #55525c;   --ink-3: #8a8792;

  --accent: #2f6fe0; --accent-ink: #ffffff; --accent-soft: #eaf1fe;
  --danger: #b42318; --ok: #217a4b; --warn: #b25e09;

  --radius: 10px; --radius-sm: 6px;
  --shadow: 0 1px 2px rgb(20 18 24 / .05), 0 8px 24px rgb(20 18 24 / .07);
  --focus: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #101014;  --surface: #17171c; --line: #2a2a33;
    --ink: #f2f1f5; --ink-2: #b3b0bd;   --ink-3: #807d8a;
    --accent: #6fa4ff; --accent-ink: #0f1016; --accent-soft: #16203a;
  }
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: var(--text-0)/1.6 var(--font);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3 { margin: 0; line-height: 1.15; letter-spacing: -.02em; }
:focus-visible { outline: none; box-shadow: var(--focus); }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
```

**Swap the four palette lines to change direction, and keep everything else:**

- **Paper** — `--bg:#faf9f7; --surface:#fff; --ink:#1a1815; --accent:#b45309`.
  Warm, calm, for reading and for tools used daily.
- **Console** — `--bg:#0d1117; --surface:#161b22; --ink:#e6edf3; --accent:#2f81f7`
  with `--line:#30363d`. Technical and dense, for dashboards and dev tools.
- **Editorial** — `--bg:#fffdf8; --surface:#fff; --ink:#141414; --accent:#c2410c`
  plus a serif on headings only. For content and landing pages.

One direction, all the way through. Half Console and half Editorial reads as a
mistake, because it is one.

**The rules behind the tokens**, for when you need a value that is not in them:

- **Spacing** — every value from the scale. Space *inside* a group must be
  smaller than the space *around* it, or the grouping reads wrong however good
  the rest is.
- **Type** — one family for UI, at most one more for display. Body 15–17px,
  line-height 1.5–1.65, measure capped at 65–75ch. Headings tighter: 1.1–1.25,
  and `letter-spacing: -.02em` above 28px.
- **Colour** — one accent hue, one neutral ramp, semantic red/amber/green. Never
  pure `#000` on pure `#fff`.
- **Radius** — pick one and derive: inputs and buttons 6–8, cards 10–12,
  pills 999. Four unrelated radii look like an accident.
- **Depth** — borders and background steps first, shadows last, and only for
  things that genuinely float: menus, modals, toasts. A shadow on every card
  flattens the hierarchy instead of building it.
- **Dark mode** — swap the variables. Never invert. Surfaces get *lighter* as
  they rise, and pure white on near-black is too harsh: use around 90%.

## 4. Layout

- Build hierarchy with size, weight and colour before reaching for a box.
  Three levels — primary, secondary, muted — is usually all you need.
- Align to a grid and share edges. Ragged left edges are the single most
  common reason a page feels amateur.
- Full width is not a layout. Constrain content to what the content needs: a
  table wants width, prose does not.
- One job per element. A card that is a link, a form and a menu is three cards.

## 5. States are most of the work

An interface that only handles the happy path is a mockup. For every screen:

- **Empty** — first run, nothing there yet. Say what this is and how to make
  the first one. Never a blank box.
- **Loading** — skeletons shaped like the real content, or a spinner on the
  control that was pressed. Do not blank the page.
- **Error** — what failed and what they can do about it. Keep their input.
- **Partial** — one row failed and the rest loaded.

And for every interactive element: `:hover`, `:focus-visible`, `:active`,
`:disabled`, and the selected state. A control with only a default state is
unfinished, not minimal. `outline: none` with no replacement focus ring is a
bug, not a style choice.

```css
.btn {
  font: 500 var(--text-0)/1 var(--font);
  padding: var(--s3) var(--s5);
  border: 1px solid transparent; border-radius: var(--radius-sm);
  background: var(--accent); color: var(--accent-ink);
  cursor: pointer; transition: filter .15s, transform .05s;
}
.btn:hover    { filter: brightness(1.08); }
.btn:active   { transform: translateY(1px); }
.btn:disabled { opacity: .45; cursor: not-allowed; filter: none; }
.btn--quiet   { background: transparent; color: var(--ink); border-color: var(--line); }
.btn--quiet:hover { background: var(--accent-soft); }

.input {
  width: 100%; padding: var(--s3) var(--s4);
  font: var(--text-0) var(--font); color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--radius-sm);
}
.input::placeholder { color: var(--ink-3); }
```

## 6. Motion

One authored moment, not effects scattered everywhere, and not the same
entrance animation on every section. 120–200ms, on `transform`, `opacity`,
`filter` and colour only — never on `height` or `width`. Ease out from a state
that is already visible. Honour `prefers-reduced-motion` every time.

## 7. Non-negotiable

- Contrast 4.5:1 for body text and placeholders, 3:1 for large text and for
  the borders of controls.
- Every control reachable and operable by keyboard, in the order it appears.
- Labels on inputs. A placeholder is not a label.
- Touch targets 44px.
- `<button>` for actions, `<a href>` for navigation. Never a `<div>` with an
  onClick.
- `aria-label` on any icon-only button; real `alt` text on meaningful images.
- Nothing shifts as content loads: reserve the space, set image dimensions.
- 16px minimum body text on mobile, and `<meta name="viewport" content="width=device-width, initial-scale=1">`.

## 8. Do not

These are the defaults of the category rather than laws — a brief can earn any
of them — but reaching for one *because it was the first thing to hand* means
you were not deciding.

- Purple-to-blue gradient headers. Gradient text. Glassmorphism as decoration.
- Three identical feature cards with a lorem sentence each. Same-size icon +
  heading + text cards used as the whole page structure. Nested cards.
- The hero-metric template: big number, small label, three supporting stats.
- A tracked uppercase eyebrow over every section, or 01 / 02 / 03 section
  numbers where the order carries no information.
- Emoji as interface icons. Use an icon set or well-drawn inline SVG.
- Monospace as a costume for "technical" when there is no code or data in it.
- A modal for something that needs neither interruption nor protected focus.
- Centring everything. Long centred paragraphs are genuinely harder to read.
- Inventing a component library when the project already has one. Look for
  existing components, tokens and utilities first, and use them.
- Placeholder copy. Write the real words — they are part of the design.

## 9. Before you say it is done

Open it and look at it. Then walk this list and fix what fails. The last three
are the ones that get skipped, so do not skip them:

1. **375px wide.** No horizontal scrollbar, nothing overlapping, nothing cut
   off. If you wrote no media query at all, you have not done this.
2. **The longest realistic string** in every label and every cell. Does the row
   hold, or does one long title break the layout?
3. **Empty data.** Is there a real empty state, or a blank rectangle?
4. **Keyboard only.** Tab through everything. Can you see where you are at
   every step?
5. **Count the accent hues.** More than one family means the palette got away
   from you. Put it back.
6. **Contrast.** `--ink-3` on `--bg` is for hints, never for anything that has
   to be read.

Then say which of these you actually checked and what you found. Do not claim
it works on mobile if you never made it narrow. If it runs in a browser, start
it with `run_command` and `background: true` and open it before you call it
finished.
