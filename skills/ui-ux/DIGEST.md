# Interfaces, done properly — the short form

The house style of a language model is a centred column, a purple-to-blue
gradient, three identical cards, Inter at every size, and a lot of empty space.
Everyone has seen it a thousand times, and it reads as generated on sight.
This exists to stop you producing it.

Order: direction, structure, tokens, components, states, motion, accessibility,
look at it, report. Most bad interfaces are good CSS applied to an undecided
design.

## 1. Direction — one line each, before any code

- **Job** — what the screen does, in a sentence a user would say.
- **Mode** — **Operate** (tasks, tools, dashboards: speed and scannability),
  **Persuade** (landing, pricing: earn attention in one screen), **Read** (docs:
  measure and rhythm), **Experience** (portfolio: content leads). A dashboard
  stays Operate however loud the brand is.
- **Tone** — one word you commit to: clinical, warm, editorial, technical,
  playful, industrial, calm, dense. "Modern and clean" is not a tone.
- **The one memorable thing** — a colour, a type move, a texture, one
  interaction. Exactly one. It is the difference between a design and a theme.

## 2. Structure — hierarchy before decoration

- Decide what the eye lands on first, second, third, and build it with size,
  weight, colour and position before reaching for a box, a border or a card.
  Three levels — primary, secondary, muted — is usually all a screen needs.
- **The primary thing gets disproportionate size.** If a score or a total is
  the point of the screen, make it three or four times bigger, not 10%.
- Align to a grid and share edges. Ragged left edges are the single most common
  reason a page feels amateur. Hold a max width (~1120px apps, 68ch prose).
- Space **inside** a group must be smaller than space **between** groups.
- One job per element. Put the primary action at the end of the flow it
  completes; keep destructive actions away from safe ones.

## 3. Tokens — set once, never use a raw value again

Define in `:root` and use nothing else afterwards: a type scale (xs → hero,
`clamp()` for the big sizes), one space scale (.25/.5/.75/1/1.5/2/3/4/6/8rem),
colour, radius, and duration/easing.

- **Neutrals carry a hue.** Flat `#808080` grey is what makes a UI look dead.
  OKLCH keeps lightness steps perceptually even.
- Roles, not names: `--bg`, `--surface`, `--surface-2`, `--line`, `--ink`,
  `--ink-2`, `--ink-3`, `--accent`, `--accent-ink`, `--accent-soft`, plus
  good/warn/bad. One accent family plus semantics — count the hues.
- **Depth:** borders and background steps first; shadows only for things that
  genuinely float (menus, popovers, modals, toasts).
- **Dark mode:** swap variables, never invert. Surfaces get *lighter* as they
  rise, text 92–95% lightness rather than pure white, and every accent
  re-checked for contrast — most need to get lighter.
- **Tailwind/shadcn:** re-theme the slate default in `globals.css`
  (`--background`, `--foreground`, `--primary`, `--muted`, `--accent`,
  `--destructive`, `--border`, `--ring`, `--radius`). Use the components for
  behaviour, style them to the direction, and do not wrap every region in a
  `Card`. No arbitrary values (`text-[17px]`) — that is a raw value in another
  syntax. Icons: lucide, one stroke width, sized to the text beside them.

## 4. Components — every state built in

Every interactive element needs default, hover, focus-visible, active and
disabled, plus selected, loading and error where they apply. A control with
only a default state is unfinished, not minimal.

- **Buttons:** verb labels ("Analyze label", not "Submit"), one primary per
  view, 44px minimum height, loading keeps the width fixed so nothing jumps.
- **Inputs:** a visible `<label>` always — a placeholder is not a label. Help
  text below, errors below with an icon, `aria-invalid` and `aria-describedby`
  wired. Validate on blur, re-validate on input once an error shows, never
  shout on the first keystroke.
- **Numbers and metrics:** large, with the scale ("7.4 / 10") and a label
  saying what it measures. A colour band is never the only signal — pair it
  with a word.
- **Lists of findings:** most severe first, each one thing/value/why in a line
  or two. None? Say so once; do not render an empty section header.
- **Tables:** numbers right, text left, tabular numerals, sticky header, row
  hover, a real empty state.

## 5. States are most of the work

An interface that only handles the happy path is a mockup. Every screen and
every async action needs:

- **Empty / first run** — what this is and the one action that starts it.
  Never a blank rectangle.
- **Loading** — skeletons shaped like the real content, or a spinner on the
  control that was pressed; say what is happening past a second. Never blank
  the page.
- **Success** — the result and the next action.
- **Error** — what failed in plain words, what to do, and the input preserved.
  "You can fix this" and "we failed" need different words.
- **Partial** — show what worked.
- **Edge content** — longest realistic name, zero, missing field, a thousand
  rows. Design for them rather than discovering them.

Announce async results with `aria-live="polite"`.

## 6. Motion

One authored moment, not effects everywhere. Everything else 120–200ms,
ease-out, on `transform`, `opacity`, `filter` and colour only — never `width`,
`height`, `top` or `left`. Readable with motion off; honour
`prefers-reduced-motion` every time.

## 7. Accessibility and performance — non-negotiable

- Contrast 4.5:1 body text and placeholders, 3:1 large text, icons and borders.
- Every control keyboard-reachable in visual order, visible focus ring, Escape
  closes overlays, focus returns to the trigger.
- `<button>` for actions, `<a href>` for navigation, landmarks, one `<h1>`,
  headings in order. `aria-label` on icon-only buttons, real `alt` text.
- 44×44px touch targets, viewport meta, 16px minimum input text on mobile.
- No layout shift: reserve space for images and async content,
  `font-display: swap`. In Next.js, `next/image`, server components by default,
  `"use client"` only where it is interactive.

## 8. Do not

Purple-to-blue gradients, gradient text, glassmorphism as decoration, glowing
blobs. Three identical feature cards; cards inside cards. The big-number-plus-
three-stats template. Tracked uppercase eyebrows over every section; 01/02/03
numbering. Emoji as icons. Monospace as a costume. Centred long paragraphs.
The default shadcn slate theme. Lorem ipsum, "Feature 1", "John Doe",
placeholder images — write the real copy, it is part of the design. A modal
for anything that does not need to interrupt.

## 9. Look at it, then report

Run it, then call `look_at_app` with the URL: it opens the app at 375px and
1440px and reports console errors, failed requests, overflow, broken images and
unlabeled controls. Fix what it finds in one pass, then check 375px (no
horizontal scroll, nothing clipped), 1440px (a max width, no unreadable line
lengths), the longest realistic content, every state, keyboard only, contrast,
and the hue count.
