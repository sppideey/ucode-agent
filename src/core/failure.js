/**
 * failure.js — the single error shape used everywhere in ucode.
 *
 * A stack trace tells the user what line broke. It does not tell them what
 * ucode was trying to do, or what they should do about it. Every failure in
 * this program carries those three things as fields, so no screen ever has to
 * fall back on a raw trace to explain itself.
 */

export class Failure extends Error {
  /**
   * @param {object} o
   * @param {string}  o.kind       machine-readable category, e.g. 'rate_limit'
   * @param {string}  o.attempted  what was happening: 'reading src/app.js'
   * @param {string}  o.failed     what went wrong, in plain words
   * @param {string} [o.fix]       the concrete next step
   * @param {Error}  [o.cause]     the underlying error, kept for --debug
   * @param {object} [o.detail]    structured extras (status, retryAfter, ...)
   */
  constructor({ kind, attempted, failed, fix, cause, detail }) {
    super(`${attempted}: ${failed}`);
    this.name = 'Failure';
    this.kind = kind;
    this.attempted = attempted;
    this.failed = failed;
    this.fix = fix;
    this.cause = cause;
    this.detail = detail ?? {};
  }
}

/**
 * A failure inside a tool.
 *
 * These never reach the user as a crash. They are handed back to the model as
 * text, which is why they read like instructions to whoever caused them — the
 * model can usually fix its own mistake on the next step if it is told what
 * the mistake was.
 */
export class ToolFailure extends Failure {
  constructor(fields) {
    super(fields);
    this.name = 'ToolFailure';
  }

  /** What the model is shown in place of a tool result. */
  forModel() {
    const out = [`ERROR (${this.kind}) while ${this.attempted}.`, this.failed];
    if (this.fix) out.push(`Suggestion: ${this.fix}`);
    return out.join('\n');
  }
}

/** The user said no at a confirmation prompt. Their call, not a fault. */
export class Declined extends ToolFailure {
  constructor(what) {
    super({
      kind: 'declined',
      attempted: what,
      failed: 'The user declined this action.',
      fix: 'Do not try it again. Say what you were going to do and ask how they want to proceed.',
    });
    this.name = 'Declined';
  }
}

/** True for anything carrying the three-field shape, however it was made. */
export function isFailure(err) {
  return Boolean(err && typeof err === 'object' && err.attempted && err.failed);
}
