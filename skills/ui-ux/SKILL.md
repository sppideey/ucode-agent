---
name: ui-ux
description: Design and build interfaces at the level of a senior product designer who also ships the code — direction, type, colour, layout, components, states, motion, accessibility and performance, verified on screen. Loads itself for any work with a user interface in it.
auto: app, apps, ui, ux, website, web app, webapp, web page, webpage, landing page, dashboard, frontend, front-end, interface, css, tailwind, html, react, vue, svelte, nextjs, next.js, shadcn, redesign, restyle, responsive, dark mode, ugly, styling, stylesheet, mockup, prototype, component, components, polished, beautiful, good looking, visually
---

# Interfaces, done properly

The house style of a language model is a centred column, a purple-to-blue
gradient, three identical cards, Inter at every size, and a lot of empty space.
Everyone has seen it a thousand times, and it reads as generated on sight.
This skill exists to stop you producing it.

Work in this order and do not skip ahead. Most bad interfaces are good CSS
applied to an undecided design.

1. Direction  2. Structure  3. Tokens  4. Components  5. States  6. Motion
7. Accessibility and performance  8. Look at it  9. Report

---

## 1. Decide the direction before any code

Write these down in one line each, then build to them:

- **Job** — what does this screen do, in one sentence a user would say?
- **Who and when** — who opens it, how often, on what device, in what light?
  A tool opened forty times a day and a page seen once need opposite things.
- **Mode** — pick one:
  - **Operate**: completing a task (apps, dashboards, tools, settings). Speed,
    scannability and consistency beat expression. Personality lives in details.
  - **Persuade**: deciding whether to act (landing, pricing, marketing). The
    design is the product; it has to earn attention in one screen.
  - **Read**: understanding something (docs, articles). Measure, rhythm and
    hierarchy first; decoration last.
  - **Experience**: looking at the work itself (portfolio, gallery). The
    content leads; the interface gets out of the way.
- **Tone** — one word you commit to: clinical, warm, editorial, technical,
  playful, industrial, calm, dense. "Modern and clean" is not a tone.
- **The one memorable thing** — a colour, a type move, a texture, a single
  interaction. Exactly one. It is the difference between a design and a theme.

A dashboard stays Operate however loud the brand is. A tool's landing page is
still Persuade. Never put a marketing hero on top of a working tool.

## 2. Structure: hierarchy before decoration

- Decide what the eye lands on first, second, third. Build that with **size,
  weight, colour and position** before reaching for a box, a border or a card.
  Three levels — primary, secondary, muted — is usually all a screen needs.
- **The primary thing gets disproportionate size.** If a score, a total or a
  status is the point of the screen, make it unmistakably larger than
  everything around it — not 10% bigger, three or four times bigger.
- Align to a grid and share edges. Ragged left edges are the single most common
  reason a page feels amateur. Pick a max content width (e.g. 1120px for apps,
  68ch for prose) and hold it.
- Group by proximity: space **inside** a group must be smaller than space
  **between** groups, or the grouping reads wrong however good the rest is.
- One job per element. A card that is a link, a form and a menu is three cards.
- Put actions where the eye already is: primary action at the end of the flow it
  completes, destructive actions separated from safe ones.

## 3. Tokens: set them once, never use a raw value again

Everything below is a starting point to adjust, not a look to ship unchanged.
The palette in particular must be re-picked for the product's tone.

```css
:root {
  /* Type — a real scale, fluid between mobile and desktop. */
  --font-sans: "Inter Tight", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-display: var(--font-sans);
  --font-mono: ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace;

  --text-xs:  .75rem;
  --text-sm:  .875rem;
  --text-md:  1rem;
  --text-lg:  clamp(1.125rem, 1rem + .4vw, 1.25rem);
  --text-xl:  clamp(1.375rem, 1.1rem + .9vw, 1.75rem);
  --text-2xl: clamp(1.75rem, 1.3rem + 1.6vw, 2.5rem);
  --text-3xl: clamp(2.25rem, 1.5rem + 3vw, 3.75rem);
  --text-hero: clamp(3rem, 2rem + 5vw, 6rem);

  /* Space — one scale, nothing in between. */
  --s-1: .25rem; --s-2: .5rem; --s-3: .75rem; --s-4: 1rem;  --s-5: 1.5rem;
  --s-6: 2rem;   --s-7: 3rem;  --s-8: 4rem;   --s-9: 6rem;  --s-10: 8rem;

  /* Colour — neutrals carry a hue; flat #808080 grey is what makes a UI look dead.
     OKLCH so lightness steps are perceptually even. */
  --bg:        oklch(98.5% .004 90);
  --surface:   oklch(100% 0 0);
  --surface-2: oklch(96.5% .006 90);
  --line:      oklch(90% .008 90);
  --ink:       oklch(22% .01 90);
  --ink-2:     oklch(45% .012 90);
  --ink-3:     oklch(60% .01 90);

  --accent:      oklch(58% .19 255);
  --accent-ink:  oklch(99% 0 0);
  --accent-soft: oklch(95% .03 255);

  --good: oklch(62% .16 150);  --good-soft: oklch(95% .04 150);
  --warn: oklch(72% .16 70);   --warn-soft: oklch(96% .05 80);
  --bad:  oklch(58% .21 25);   --bad-soft:  oklch(95% .04 25);

  --radius-sm: 6px; --radius: 10px; --radius-lg: 16px; --radius-full: 999px;
  --shadow-sm: 0 1px 2px oklch(20% .01 90 / .06);
  --shadow:    0 1px 2px oklch(20% .01 90 / .05), 0 8px 24px oklch(20% .01 90 / .08);
  --shadow-lg: 0 2px 4px oklch(20% .01 90 / .06), 0 24px 48px oklch(20% .01 90 / .14);
  --focus: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);

  --ease-out: cubic-bezier(.22, 1, .36, 1);
  --dur-1: 120ms; --dur-2: 200ms; --dur-3: 320ms;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: oklch(16% .008 260);   --surface: oklch(20% .01 260);
    --surface-2: oklch(24% .012 260); --line: oklch(30% .012 260);
    --ink: oklch(95% .005 260);  --ink-2: oklch(76% .01 260); --ink-3: oklch(60% .01 260);
    --accent: oklch(70% .16 255); --accent-ink: oklch(18% .02 260); --accent-soft: oklch(28% .06 255);
  }
}

*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: var(--text-md)/1.6 var(--font-sans);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
}
h1, h2, h3 { margin: 0; line-height: 1.1; letter-spacing: -.02em; text-wrap: balance; }
p { text-wrap: pretty; }
:focus-visible { outline: none; box-shadow: var(--focus); border-radius: var(--radius-sm); }
.num { font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 1ms !important; transition-duration: 1ms !important; }
}
```

**The rules behind the tokens**, for when you need a value that is not there:

- **Type.** One family for UI, at most one more for display. Body 15–17px at
  1.5–1.65 line height, measure 60–75ch. Headings 1.05–1.2 line height with
  negative tracking above 28px. Weight does more than size for mid-level
  hierarchy: 600 for labels that matter, 400 for body, 500 for UI controls.
  Use `tabular-nums` anywhere numbers line up or change in place.
- **Pick a typeface with intent.** Inter everywhere is the generated look. Good
  free choices through `next/font/google` or Google Fonts: *Inter Tight,
  Geist, Manrope, DM Sans, Plus Jakarta Sans, Instrument Sans, Space Grotesk,
  IBM Plex Sans* for UI; *Fraunces, Instrument Serif, Bricolage Grotesque,
  Newsreader* for display. Load only the weights you use, `display: swap`.
- **Colour.** One accent hue, one neutral ramp tinted slightly toward it, and
  semantic good/warn/bad that mean one thing each. Colour is for meaning and
  emphasis, not decoration. Never pure `#000` on pure `#fff`. Count the hue
  families at the end: more than one accent plus the semantics means the
  palette got away from you.
- **Radius.** Pick one base and derive: controls 6–8, cards 10–16, pills full.
  Four unrelated radii look like an accident.
- **Depth.** Borders and background steps first; shadows only for things that
  genuinely float (menus, popovers, modals, toasts). A shadow on every card
  flattens the hierarchy it was meant to create.
- **Dark mode.** Swap variables, never invert. Surfaces get *lighter* as they
  rise. Text around 92–95% lightness, not pure white. Re-check every accent for
  contrast in dark — most need to get lighter.

### With Tailwind and shadcn/ui

- shadcn ships with a neutral slate look. **Re-theme it** in `globals.css` by
  setting its CSS variables (`--background`, `--foreground`, `--primary`,
  `--muted`, `--accent`, `--destructive`, `--border`, `--ring`, `--radius`) to
  your palette. Shipping the default theme is shipping someone else's design.
- Use components for behaviour and accessibility (Dialog, Popover, Tabs,
  Select, Tooltip, Toast/Sonner), then style them to the direction. Do not wrap
  every region of the page in a `Card` — that is the three-card look again.
- Extend the Tailwind theme with your tokens rather than scattering arbitrary
  values (`text-[17px]`, `mt-[13px]`). Arbitrary values are the raw values this
  section forbids, in a different syntax.
- Icons: `lucide-react`, one stroke width throughout, sized to the text beside
  them (16px with 14–15px text, 20px with 16–18px). Never emoji as UI icons.

## 4. Components, with every state built in

Every interactive element needs **default, hover, focus-visible, active,
disabled**, and where it applies **selected, loading, error**. A control with
only a default state is unfinished, not minimal.

```css
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--s-2);
  min-height: 44px; padding: 0 var(--s-5);
  font: 500 var(--text-md)/1 var(--font-sans);
  border: 1px solid transparent; border-radius: var(--radius-sm);
  background: var(--accent); color: var(--accent-ink);
  cursor: pointer; transition: filter var(--dur-1), transform var(--dur-1) var(--ease-out);
}
.btn:hover { filter: brightness(1.07); }
.btn:active { transform: translateY(1px) scale(.99); }
.btn:disabled, .btn[aria-busy="true"] { opacity: .5; cursor: not-allowed; filter: none; }
.btn--quiet { background: transparent; color: var(--ink); border-color: var(--line); }
.btn--quiet:hover { background: var(--surface-2); }
```

- **Buttons:** verb labels ("Analyze label", not "Submit"). One primary per
  view. Loading state replaces the label's icon with a spinner and keeps the
  width fixed so nothing jumps.
- **Inputs:** a visible `<label>` always — a placeholder is not a label. Help
  text below, errors below in `--bad` with an icon, `aria-invalid` and
  `aria-describedby` wired up. Validate on blur, re-validate on input once
  an error is showing, never shout on the first keystroke.
- **File upload:** a real drop zone *and* a click target, keyboard operable,
  showing accepted types and max size before the user tries. Show the chosen
  file (thumbnail for images), let them replace or remove it, validate type and
  size on the client before sending anything.
- **Scores and metrics:** the number large, with its scale ("7.4 / 10"), a
  label that says what it measures, and a colour band (good/warn/bad) that is
  never the *only* signal — pair it with a word ("Good", "Moderate", "Poor").
- **Lists of issues or findings:** most severe first; each with the thing, the
  value, why it matters, in one or two lines. If there are none, say so plainly
  once — do not render an empty section header.
- **Tables:** right-align numbers, left-align text, tabular numerals, sticky
  header on long tables, row hover, and a real empty state.

## 5. States are most of the work

An interface that only handles the happy path is a mockup. For every screen
and every async action:

- **Empty / first run** — what this is, and the one action that starts it.
  Illustrated or typographic, never a blank rectangle.
- **Loading** — skeletons shaped like the real content, or a progress
  indicator on the control that was pressed. Say what is happening if it takes
  more than a second ("Reading the label…"). Never blank the page.
- **Success** — the result, with a clear next action (try another, share, copy).
- **Error** — what failed in plain words, what to do next, and the user's input
  preserved. Distinguish "you can fix this" (wrong file type) from "we failed"
  (network, model error) — they need different words and different actions.
- **Partial** — some parts loaded, one failed; show what worked.
- **Edge content** — the longest realistic name, a value of zero, a missing
  field, a thousand rows. Design for them, do not discover them.

Announce async results to screen readers with an `aria-live="polite"` region.

## 6. Motion

One authored moment, not effects scattered everywhere. For a result screen that
might be the score counting up and the findings staggering in 40–60ms apart.
Everything else: 120–200ms, ease-out, on `transform`, `opacity`, `filter` and
colour only — never animate `width`, `height`, `top` or `left`. Content must
be readable with motion off; honour `prefers-reduced-motion` every time.

## 7. Accessibility and performance — non-negotiable

- Contrast: 4.5:1 body text and placeholders, 3:1 large text, icons and control
  borders. `--ink-3` on `--bg` is for hints only.
- Keyboard: every control reachable in visual order, visible focus ring,
  Escape closes overlays, focus returns to the trigger.
- Semantics: `<button>` for actions, `<a href>` for navigation, landmarks
  (`header`, `main`, `nav`), one `<h1>`, headings in order.
- Targets 44×44px on touch. `aria-label` on icon-only buttons. Real `alt` text.
- Viewport meta, 16px minimum input text on mobile (iOS zooms below that).
- No layout shift: reserve space for images and async content, set image
  dimensions, use `next/image` in Next.js, `font-display: swap`.
- Ship less JS: server components by default in Next.js, `"use client"` only on
  the parts that are interactive.

## 8. Do not

Defaults of the category. A brief can earn any of them; reaching for one
because it was first to hand means you were not deciding.

- Purple-to-blue gradients, gradient text, glassmorphism as decoration,
  glowing blobs in the background.
- Three identical feature cards; icon + heading + sentence cards as the whole
  page; cards inside cards.
- The hero-metric template: big number, small label, three stats in a row.
- A tracked uppercase eyebrow over every section; 01/02/03 section numbers.
- Emoji as icons. Monospace as a costume. Centred long paragraphs.
- The default shadcn slate theme, unchanged.
- Lorem ipsum, "Feature 1", "John Doe", placeholder images. Write the real copy
  — it is part of the design.
- A modal for anything that does not need to interrupt.

## 9. Look at it, then report

Run it (`npm run dev` starts in the background and returns the URL), then call
`look_at_app` with that URL. It opens the app in a real browser at 375px and
1440px, reports console errors, failed requests, overflow, broken images and
unlabeled controls, and returns a designer's review of the screenshots. Fix what
it finds and look again. Then check:

1. **375px wide** — no horizontal scroll, nothing overlapping or clipped. If you
   wrote no responsive rules at all, you have not done this.
2. **1440px wide** — the content has a max width and does not stretch into
   unreadable lines.
3. **Longest realistic content** in every label, cell and card.
4. **Every state** — empty, loading, success, error — reachable and designed.
5. **Keyboard only** — tab through everything; focus always visible.
6. **Contrast** of body text, muted text and the accent on its background.
7. **Hue count** — one accent family plus semantics.
8. **The first thing the eye lands on** is the thing that matters most.

Then say which of these you actually checked and what you found. Never claim it
works on mobile if you never made it narrow.
