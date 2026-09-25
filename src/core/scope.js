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

/** A request that may be for a new app. Loose on purpose: the note it adds says "if". */
export const BUILD_ASK =
  /\b(?:make|build|create|design|code|write|generate|develop)\b|\bi\s+(?:want|need)\b|\b(?:app|game|website|site|page|tracker|calculator|quiz)\b/i;

/** The request as the model sees it: one in an empty folder, or shaped like a build, carries the note. */
export function withScope(input, { fresh = false } = {}) {
  return fresh || BUILD_ASK.test(input) ? `${input}\n\n${SCOPE_NOTE}` : input;
}
