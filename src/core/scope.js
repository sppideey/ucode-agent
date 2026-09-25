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

/** The request as the model sees it: one that asks for an app carries the note. */
export function withScope(input) {
  return asksToBuild(input) ? `${input}\n\n${SCOPE_NOTE}` : input;
}

/** A message with no letters or digits in it ("+", "?", "...") — nothing to answer or build. */
export const isNoise = (input) => !/[\p{L}\p{N}]/u.test(String(input ?? ''));
