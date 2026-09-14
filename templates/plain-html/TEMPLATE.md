# __APP_NAME__

A plain HTML, CSS and JavaScript app. No framework, no build step, no install:
`index.html` is the whole program's front door.

## The files

- `index.html` — the markup, and the only place scripts and styles are linked
- `styles.css` — the design tokens at the top, then the components
- `app.js` — an ES module; `state` holds everything, `render()` draws it

## Working in it

Open `index.html` in a browser, or serve the folder if the app fetches
anything: `python -m http.server 8000`. There is nothing to install and
nothing to compile, so a change is visible on refresh.

## What this starter cannot run

There is no build step, so there is no compiler to turn anything into browser
JavaScript. That rules out, in `app.js` or any module it loads:

- **JSX** — `render(<App />, root)` is a syntax error in a plain module. The
  page renders nothing and the console says an unexpected token was found.
- **TypeScript** — no types, no `interface`, no `as`.
- **Bare imports** — `import React from "react"` has nowhere to resolve from.
  Only relative paths (`./store.js`) and full URLs work.

Write plain ES modules and DOM calls. If the app genuinely needs a framework,
it needed `next-shadcn` instead, and that decision belongs before the first
file, not after the page comes up blank.

## Conventions worth keeping

- **One state object, one render.** Patching the DOM from several places is
  where these apps become impossible to reason about.
- **Tokens in `:root`.** Colour, spacing and timing are defined once, so the
  look can be changed without touching components.
- **Reduced motion is honoured** at the bottom of the stylesheet. Leave it in.
- Keep it to these three files until there is a real reason not to.
