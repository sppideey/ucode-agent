// SPDX-License-Identifier: AGPL-3.0-only - ucode, made and tested by om dixit. Additional terms: see NOTICE.
/**
 * scope.js — keeping a new app to what was asked for.
 *
 * In the system prompt and the build-app skill alone, Flash-Lite still built
 * "make me a tasks app" as a tasks app plus a pomodoro timer, a kanban board
 * and analytics — twice running — and the extra views were where the builds
 * broke. So the rule also rides on the request itself, the last thing the
 * model reads before it starts.
 */

export const SCOPE_NOTE =
  '(From ucode: if this asks for a new app, build it complete and well made, but as the one app asked ' +
  'for - no extra views or tools such as timers, calendars, kanban boards, analytics, stats or an ' +
  'editor for making your own, unless the request names them.)';

/**
 * A request for something to be built: a making word, then a thing to make.
 *
 * It used to fire on any message in an empty folder, and on a bare "app" or
 * "make". A user who typed "+" in their home folder got the note, and the
 * model took it as a request and built a calculator nobody asked for.
 */
const MAKE = String.raw`\b(?:make|build|create|design|generate|develop|code)\b`;
const THING = String.raw`\b(?:apps?|games?|website|site|page|tracker|calculator|quiz|tool|dashboard|list|timer|stopwatch|clock|form|portfolio|planner|converter|board|tic[- ]?tac[- ]?toe|snake|sudoku)\b`;
const BUILDS = [
  new RegExp(`${MAKE}\\s+(?:me\\s+|us\\s+)?(?:an?|some|my|our)\\s`, 'i'),   // make a stopwatch, build me a …
  new RegExp(`${MAKE}[^.?!\\n]{0,60}?${THING}`, 'i'),                           // make tic tac toe, create the quiz page
  /\bi\s+(?:want|need)\s+(?:a|an)\s+\S+/i,                                    // i want a homework tracker
];
/** Asking, not telling: "what can you make?", "how does it work". */
const QUESTION = /\?\s*$|^\s*(?:what|how|why|when|where|who|which|can|could|does|do|is|are|should|would)\b/i;

/** Does this message ask for something to be built? Never for a question. */
export const asksToBuild = (input) => !QUESTION.test(input) && BUILDS.some((re) => re.test(input));

/**
 * A design direction for one build, so two apps never come out the same.
 *
 * Left to itself the model reaches for the same tone, the same system font and
 * whatever accent the starter shipped with. Handing it a direction - a tone,
 * a pair of typefaces, an accent - is a choice already made, which is free; a
 * generic build caught afterwards costs a fix round. Every font is a free
 * Google Font with a system fallback, so an offline page still renders.
 */
export const DIRECTIONS = [
  { tone: 'calm', display: 'DM Serif Display', body: 'DM Sans', accent: '#c2410c', base: 'light' },
  { tone: 'technical', display: 'JetBrains Mono', body: 'IBM Plex Sans', accent: '#16a34a', base: 'dark' },
  { tone: 'playful', display: 'Baloo 2', body: 'Nunito', accent: '#e11d48', base: 'light' },
  { tone: 'editorial', display: 'Fraunces', body: 'Source Sans 3', accent: '#b45309', base: 'light' },
  { tone: 'clinical', display: 'IBM Plex Sans', body: 'IBM Plex Sans', accent: '#0369a1', base: 'light' },
  { tone: 'industrial', display: 'Space Grotesk', body: 'Space Grotesk', accent: '#eab308', base: 'dark' },
  { tone: 'warm', display: 'Bricolage Grotesque', body: 'Figtree', accent: '#ea580c', base: 'light' },
  { tone: 'dense', display: 'Manrope', body: 'Manrope', accent: '#2563eb', base: 'light' },
  { tone: 'retro', display: 'Righteous', body: 'Rubik', accent: '#db2777', base: 'dark' },
  { tone: 'natural', display: 'Lora', body: 'Karla', accent: '#4d7c0f', base: 'light' },
  { tone: 'bold', display: 'Archivo Black', body: 'Archivo', accent: '#dc2626', base: 'light' },
  { tone: 'soft', display: 'Quicksand', body: 'Mulish', accent: '#0e7490', base: 'light' },
];

/** The direction note for one build. `pick` is for tests. */
export function directionNote(pick = Math.random) {
  const d = DIRECTIONS[Math.floor(pick() * DIRECTIONS.length) % DIRECTIONS.length];
  const type = d.display === d.body ? `"${d.display}"` : `"${d.display}" for headings and "${d.body}" for text`;
  return '(From ucode: design direction for this build, unless the request sets its own - ' +
    `tone ${d.tone}; type ${type}, from Google Fonts with a system fallback; accent ${d.accent} ` +
    `on a ${d.base} base. In the same reply as your first tool call, say in one line the app's name, ` +
    'its tone, its accent and the one memorable detail it will have, then build to exactly that.)';
}

/**
 * A change to code that already exists - the other half of what ucode is for.
 *
 * Every rule in the system prompt about building is about a new app: design
 * it, write it whole, hand it over. Asked to fix a bug in a real project, a
 * model following those rules redesigns the page. So a change request in a
 * folder with code in it carries its own note instead.
 */
export const EDIT_NOTE =
  '(From ucode: this is a change to an existing project. Find the code first - find_symbol, grep ' +
  'or outline - then read only the files involved, together in one read_files. Make the smallest ' +
  'change that does it, in the style the code already uses. Do not redesign, rename or reformat ' +
  'what works, and do not start a new app. Then run the project\'s checks.)';

const CHANGE = /\b(?:fix|bug|error|broken|crash|fails?|change|update|refactor|rename|add|remove|delete|improve|optimi[sz]e|clean ?up|move|replace|support|implement|make it|make the)\b/i;

/** Does this message ask for a change to code that is already here? */
export const asksToChange = (input) => !asksToBuild(input) && CHANGE.test(input);

/**
 * The request as the model sees it. One that asks for an app carries the
 * scope note and a design direction; a change in a folder with code in it
 * carries the note for working in an existing project.
 */
export function withScope(input, { hasCode = false, pick = Math.random } = {}) {
  if (asksToBuild(input)) return `${input}\n\n${directionNote(pick)}\n${SCOPE_NOTE}`;
  if (hasCode && asksToChange(input)) return `${input}\n\n${EDIT_NOTE}`;
  return input;
}

/** A message with no letters or digits in it ("+", "?", "...") — nothing to answer or build. */
export const isNoise = (input) => !/[\p{L}\p{N}]/u.test(String(input ?? ''));
