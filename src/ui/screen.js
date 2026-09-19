/**
 * screen.js — the full-screen interface.
 *
 * Used whenever stdout is a real terminal. Everything else — piped input, CI,
 * `echo ... | ucode` — falls back to plain.js, which is why both exist.
 *
 * The layout, top to bottom:
 *
 *   ╭──────────────────────────────────────────────────╮
 *   │  UCODE wordmark                    dir / keys    │
 *   ╰──────────────────────────────────────────────────╯
 *
 *    the conversation, scrolling with the wheel or PgUp
 *
 *   ╭──────────────────────────────────────────────────╮
 *   │ › what you are typing, growing downward as it     │
 *   │                                                  │
 *   │ ◆ Build · Nemotron 3 Ultra                    4% │
 *   ╰──────────────────────────────────────────────────╯
 *
 * Both boxes are drawn rather than ruled off, because a box says "this is a
 * thing you use" where a horizontal rule only says "something changes here".
 *
 * The status sits inside the input box rather than under it: it describes the
 * thing you are typing into, so it belongs within the same border. It carries
 * three facts and no more — which mode is live, which model is answering, and
 * how full the window is. Anything else down there competes with what the user
 * is actually looking at, which is what they just typed.
 *
 * The transcript is a buffer of pre-rendered lines and the whole frame is
 * repainted whenever anything changes. At terminal sizes that is cheap, and
 * it rules out every partial-update bug at once.
 */

import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import {
  theme, blue, sky, deep, dim, edge, ADDED, REMOVED, BANNER, BANNER_WIDTH, SPINNER,
  boxTop, boxBottom, boxRow, visLen, padVis, clip, wrapAnsi,
  shortenPath, asLabel, ensureColour, planLine, bare, narration, narrationMark, groupKind, groupLabel, groupTarget, runLine, planRows, tidyReply, trimAnswer,
  bannerPaint, RAIL, modeChip, asNarrationLine } from './theme.js';
import { FRAME_MS, spinnerGlyph, formatDuration, doneLine, workingLine, bannerSweep, SWEEP_MS } from './activity.js';
import { gitBranch } from '../core/git.js';
import { renderer, render, polish } from './markdown.js';
import { VERSION } from '../core/version.js';

/**
 * One line of narration, in the model's own words: "Reading screen.js".
 * Anything longer than this is prose, and prose belongs in the answer.
 */
export const MAX_LABEL = 120;

export function isLabel(text) {
  const t = String(text ?? '').trim();
  return t.length > 0 && t.length <= MAX_LABEL && !t.includes('\n');
}

export const COMMANDS = [
  '/help', '/model', '/models', '/session', '/sessions', '/resume',
  '/new', '/remember', '/skills', '/clear', '/search', '/copy', '/exit',
  '/stats', '/doctor', '/deploy', '/look', '/undo',
];

// ANSI ----------------------------------------------------------------------
const ESC = '\x1b';
const ALT_ON = `${ESC}[?1049h`;
const ALT_OFF = `${ESC}[?1049l`;

/**
 * Mouse setup, decided by measurement rather than by documentation.
 *
 * 1007 is alternate scroll: inside the alternate screen the terminal turns
 * wheel events into arrow keys. On Windows that is the only way a wheel ever
 * reaches the program, because ConPTY forwards no mouse input at all — a probe
 * that enabled every tracking mode received nothing from a scroll.
 *
 * And mouse tracking suppresses alternate scroll. So on Windows tracking is
 * deliberately not requested: it delivers nothing there, and asking for it
 * would cost the wheel. Elsewhere tracking works, so the mode chip is
 * clickable on those platforms.
 */
const TRACK = process.platform === 'win32'
  ? '' : `${ESC}[?1000h${ESC}[?1002h${ESC}[?1015h${ESC}[?1006h`;
const UNTRACK = process.platform === 'win32'
  ? '' : `${ESC}[?1006l${ESC}[?1015l${ESC}[?1002l${ESC}[?1000l`;

const PASTE_ON = `${ESC}[?2004h`;
const PASTE_OFF = `${ESC}[?2004l`;
const MOUSE_ON = `${ESC}[?1007h${TRACK}`;
const MOUSE_OFF = `${UNTRACK}${ESC}[?1007l`;
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const HOME = `${ESC}[H`;
const CLEAR_LINE = `${ESC}[K`;
/** Written out rather than inline, so no edit can turn it into a real break. */
const NEWLINE = String.fromCharCode(10);
const at = (row, col) => `${ESC}[${row};${col}H`;
const title = (t) => `${ESC}]0;${t}\x07`;

/**
 * Every paint is wrapped in these. Autowrap off means a row that is one cell
 * wider than we counted loses its last cell instead of wrapping onto the next
 * row and scrolling the whole frame up — that scroll was the glitch. The
 * synchronized-update pair makes terminals that support it show the frame in
 * one go; the rest ignore it.
 */
const PAINT_BEGIN = `${ESC}[?2026h${ESC}[?7l`;
const PAINT_END = `${ESC}[?7h${ESC}[?2026l`;

/**
 * Text as it may be drawn: colour codes kept, everything that moves the cursor
 * gone. A carriage return from a CRLF file sent the padding back over the
 * line, a tab took eight cells while it was counted as one, and a clear-screen
 * from a tool's output wiped the frame mid-paint.
 *
 * The SGR colour codes (\x1b[..m) are matched first and kept. An earlier
 * version only excluded them from the CSI branch, so the bare-\x1b fallback
 * stripped the ESC off every colour code and left "[36m" littered across
 * coloured lines — visible only in a real terminal, never in tests, which is
 * why the glitch survived the suite.
 */
function printable(text) {
  return String(text)
    .replace(/\t/g, '    ')
    .replace(/\x1b\[[0-9;]*m|(\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()#][0-9A-Za-z]|[\x30-\x7e])?|[\x00-\x09\x0b-\x1a\x1c-\x1f\x7f])/g, (m, bad) => (bad ? '' : m));
}

/**
 * Fixed rows below the header: the gap under it, the gap above the input box,
 * the input box's two borders, the blank row inside it, and the status row.
 */
const CHROME_BELOW = 6;

/** How long one sentence of reasoning holds the line before the next takes it. */
const THOUGHT_HOLD_MS = 1100;

/** Reasoning that is about the request rather than about the work. */
const RESTATEMENT = /^(?:the user|they|so the user|user)|^(?:i (?:need|should|will need) to (?:understand|figure|work out|check what))|^(?:let me (?:understand|re-?read|look at the (?:request|prompt)))|^(?:the (?:request|prompt|task) (?:is|asks|says))/i;

/** The wordmark only earns its place with room for the facts column beside it. */
const WORDMARK_NEEDS = BANNER_WIDTH + 30;

/** What the empty input box says before anything is typed. */
const PLACEHOLDER = 'Ask anything…';

/**
 * What it says instead while the agent has the turn.
 *
 * The status row beside it already says "esc to stop", so this carries the
 * half nothing else on screen does: that the box is still live, and a line
 * typed into it now is kept and sent when the turn ends rather than lost. The
 * short form is for a terminal too narrow to hold the sentence, where a cut
 * one would read as a glitch.
 */
const WORKING_HINT = 'Working… type to queue your next message';
const WORKING_HINT_SHORT = 'Working…';
const WORKING_HINT_NEEDS = WORKING_HINT.length + 8;

/**
 * Three things to try, under the box, on a screen with nothing on it yet.
 *
 * A wordmark over an empty field is handsome and tells you nothing you can act
 * on — the first thing a new user has to do is guess what this accepts. Three
 * greyed lines answer that in one glance, and they say something about the
 * range of it too: build something new, understand something that exists,
 * change something small. They are dim, and they are gone the moment anything
 * is on the screen.
 */
const SUGGESTIONS = [
  'build me a landing page for a coffee shop',
  'explain what this project does and how it fits together',
  'add a dark mode toggle that remembers the choice',
];

/** The width of the `try` label, so the three lines share one left edge. */
const SUGGEST_LABEL = 6;

/** Rows the suggestions occupy under the box: one of air, then the three. */
const SUGGEST_ROWS = SUGGESTIONS.length + 1;

export class Screen {
  constructor({ cwd, input = process.stdin, output = process.stdout } = {}) {
    this.cwd = cwd;
    this.input = input;
    this.output = output;

    this.lines = [];        // the rendered transcript
    this.scroll = 0;        // rows scrolled up from the bottom
    this.buffer = '';       // what is being typed
    this.cursor = 0;
    this.history = [];
    this.historyIndex = -1;

    this.status = { busy: false, text: '', frame: 0, since: 0 };
    this.facts = {};
    this.model = '';

    this.waiters = [];
    this.queue = [];
    this.closed = false;

    // 'build' may edit and run; 'plan' is read-only. Ctrl+B swaps them, and
    // the chip is clickable wherever the terminal forwards clicks.
    this.mode = 'build';
    this.chipTo = 0;
    this.onInterrupt = null;
    this.onModeChange = null;
    this.spinTimer = null;
    this.paintedBusy = false;  // whose turn the frame on screen was drawn for
    this.paintedLines = null; // transcript length at the last paint; growth since then belongs underneath a scrolled-back view
    this.activity = null; // the turn in flight: when it began, how many steps
    this.tick = 0;        // animation frames painted, for the spinner
    this.intro = 0;       // when the launch sweep began, 0 once it is over
    this.introTimer = null;
    this.pendingPrompt = null;
    this.lastPrompt = '';  // the last thing the user said, for the echo check
    this.facts.branch = gitBranch(cwd);

    this.cols = output.columns || 80;
    this.rows = output.rows || 24;
    this.md = renderer(this.width());
  }

  // -- lifecycle -----------------------------------------------------------

  async start() {
    ensureColour(this.output);
    this.output.write(ALT_ON + MOUSE_ON + PASTE_ON + HIDE + title(`ucode — ${path.basename(this.cwd)}`));
    this.input.setRawMode?.(true);
    this.input.resume();
    this.input.setEncoding('utf8');
    this.input.on('data', (chunk) => this.onData(chunk));

    this.onResize = () => {
      this.cols = this.output.columns || 80;
      this.rows = this.output.rows || 24;
      this.md = renderer(this.width());
      this.render();
    };
    this.output.on('resize', this.onResize);

    this.render();
    this.startIntro();
  }

  /**
   * The light that crosses the wordmark once, at launch.
   *
   * Half a second, on the start screen only, and abandoned the instant there is
   * anything else to look at. Below 256 colours there are no shades to fade
   * through, so it is skipped rather than flickered.
   */
  startIntro() {
    if (!this.output.isTTY || chalk.level < 2 || !this.welcoming()) return;
    this.intro = Date.now();
    this.introTimer = setInterval(() => {
      if (this.closed || !this.welcoming() || Date.now() - this.intro >= SWEEP_MS) this.stopIntro();
      else this.render();
    }, FRAME_MS);
    this.introTimer.unref?.();
  }

  stopIntro() {
    if (this.introTimer) clearInterval(this.introTimer);
    this.introTimer = null;
    if (!this.intro) return;
    this.intro = 0;
    if (!this.closed) this.render();
  }

  stop() {
    this.activity = null;
    if (this.introTimer) clearInterval(this.introTimer);
    this.introTimer = null;
    this.intro = 0;
    this.stopSpinner();
    this.stopTimer();
    this.output.off?.('resize', this.onResize);
    this.input.setRawMode?.(false);
    this.input.pause();
    this.output.write(PASTE_OFF + MOUSE_OFF + ALT_OFF + SHOW);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    while (this.waiters.length) this.waiters.shift()(null);
  }

  /**
   * Every column the terminal has.
   *
   * Capped at 100 for a release, and it was wrong: on a wide monitor the frame
   * sat in the left half of the screen with the rest of it empty, which reads
   * as the window having failed to open rather than as a measured column. The
   * interface fills what it is given. Prose inside it is still held to 100 by
   * the markdown renderer, which is where that limit belongs — the boxes are
   * the shape of the window, not of a paragraph.
   */
  width() {
    return Math.max(30, this.cols);
  }

  /** Usable width inside a box: two borders and a space of padding each side. */
  inner() {
    return Math.max(8, this.width() - 4);
  }

  // -- transcript ----------------------------------------------------------

  /**
   * Append without painting.
   *
   * Anything replacing a region of the transcript has to build the whole
   * region and then render once. Painting between the delete and the re-add
   * puts a frame on screen with the text missing, and at streaming speed that
   * reads as flicker.
   */
  add(text = '') {
    const width = this.width();
    for (const raw of printable(text).split('\n')) {
      if (visLen(raw) <= width) this.lines.push(raw);
      else for (const wrapped of wrapAnsi(raw, width)) this.lines.push(wrapped);
    }
  }

  push(text = '') {
    this.add(text);
    this.soon();
  }

  /**
   * Collapse a burst of pushes into one frame.
   *
   * Printing a list one line at a time repaints the screen per line — a model
   * list of fifty entries drew a hundred frames back to back, which is visible
   * as a cascade. A microtask runs before any I/O, so everything pushed in one
   * synchronous stretch becomes a single render, while a push after an await
   * still paints immediately.
   */
  soon() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.render();
    });
  }

  write(text = '') { this.push(text); }
  blank() { this.push(''); }
  note(text) { this.push(dim(`  ${text}`)); }

  clearScreen() {
    this.lines = [];
    this.scroll = 0;
    this.paintedLines = null;
    this.render();
  }

  /**
   * The reply, at full strength, with room either side.
   *
   * `closing` says this is the last thing the turn will say. It is then also
   * the last thing left on screen, and what the whole session reads like
   * afterwards, so it is cut to eight lines — see trimAnswer.
   */
  assistant(text, { closing = false, replay = false, silent = false } = {}) {
    if (!text?.trim()) return;
    // A replayed answer goes back exactly as it was first shown: no tidying,
    // no trimming, no re-read of the request. Tidy-up exists to keep a live
    // answer short; on a resumed one it rewrites history, which is why a
    // resumed session read like only fragments had survived.
    const tidy = tidyReply(text, 4, this.lastPrompt);
    const body = replay ? String(text) : (closing ? trimAnswer(tidy) : tidy);
    if (!body.trim()) return;
    this.endRun();
    this.add('');

    // No bullet, and no indent. A mark on every reply made the answer read as
    // one more step in the list above it, and on "Hey! How can I help you
    // today?" it was a bullet on a greeting. The answer already wins the page
    // by being the only thing on it at full strength; it does not also need to
    // be labelled.
    this.add(render(this.md, body));

    this.add('');
    if (!silent) this.render();
  }

  /**
   * Something the user said, marked down its left edge in the same blue as the
   * box it was typed into.
   *
   * A long session is mostly the agent's output — tool calls, diffs, answers.
   * Your own messages are the landmarks you scroll back looking for, so they
   * get a mark of their own. It was a full box, and forty turns of that is a
   * ladder of rules across the page: two horizontal lines per message, each as
   * loud as the input box, none of them saying anything the rail does not.
   */
  userMessage(text, { silent = false } = {}) {
    // Kept so the reply can be checked against it: an answer that opens by
    // saying the request back is repeating the line directly above it.
    this.lastPrompt = String(text ?? '');
    this.scroll = 0; // sending something is the one thing that jumps to the bottom
    const room = Math.max(8, this.width() - 2);   // the rail and the space after it

    const rows = [];
    for (const paragraph of String(text).replace(/\r/g, '').split('\n')) {
      for (const line of wrapAnsi(paragraph, room)) rows.push(line);
    }

    // Room between what you asked for and what came back: without it the reply
    // starts against your own message and the two read as one block of text.
    this.add('');
    for (const row of rows) this.add(`${blue(RAIL)} ${chalk.white(row)}`);
    this.add('');
    this.add('');
    if (!silent) this.render();
  }

  /**
   * A tool call, as it happens: "● Listing src".
   *
   * This lives in the transcript rather than only on the status line. The
   * status line overwrites itself and is empty by the end of the turn, so work
   * announced only there scrolls past unseen — and the diff underneath ends up
   * with nothing above it explaining where it came from.
   */
  toolCall(label) {
    // U+25CF, not U+23FA: the latter carries emoji presentation, which Windows
    // Terminal draws as a white circle on a blue tile.
    // Trimmed here rather than at paint time: runLine hands back a coloured
    // string, and asLabel's regexes run off the end of one of those into the
    // escape sequence instead of the last word.
    const clean = asLabel(label);
    const kind = groupKind(clean);
    // One line per kind of work for as long as the model is working on one
    // thing. Reading, writing and reading again used to draw six lines that
    // said three things; now the "Reading files" line it already has is the
    // one that counts up, wherever it sits.
    const run = (this.segment ??= new Map()).get(kind);

    if (run && this.lines[run.at] !== undefined) {
      run.count++;
      run.label = clean;
      run.targets.push(groupTarget(clean));
      this.run = run;
      this.paintRun();
    } else {
      const fresh = {
        kind, count: 1, at: 0, label: clean,
        targets: [groupTarget(clean)], added: 0, removed: 0,
      };
      this.push(`${narrationMark(kind)} ${runLine(fresh)}`);
      fresh.at = this.lines.length - 1;
      this.run = fresh;
      this.segment.set(kind, fresh);
    }
    this.updateSpinner(label);
  }

  /**
   * The model speaking — or a plan, or a failure — ends the segment.
   *
   * Up to that point a kind of work keeps one line and counts up on it. After
   * it, the next read is a new piece of work and deserves its own line, which
   * is what makes the transcript read as a sequence of things done rather
   * than a set of running totals.
   */
  /**
   * Stop adding to the current run, but keep the lines already on screen.
   *
   * A kind of work gets one line for the whole turn. Starting a fresh set
   * whenever the model spoke meant "Creating Tide from the HTML starter" five
   * times down the page and "Reading files" four, each saying the same thing
   * about a different moment. One line that counts up says all of it and
   * costs one row.
   */
  endRun() { this.run = null; }

  /** A new turn starts with a clean page's worth of lines. */
  newSegment() { this.run = null; this.segment = new Map(); }

  /** Redraw the run's single line from what it has accumulated. */
  /**
   * Redraw the run's single line from what it has accumulated.
   *
   * While its step is still running the text shimmers, which is the only
   * thing on screen saying "this is happening now" once the per-step result
   * lines are gone. It settles to plain dim the moment the step finishes, so
   * the finished ones above stay quiet.
   */
  paintRun() {
    if (!this.run) return;
    this.lines[this.run.at] = `${narrationMark(this.run.kind)} ${runLine(this.run)}`;
    this.render();
  }

  /**
   * A change, as its two numbers.
   *
   * The diff itself used to go into the transcript. A 539-line file printed
   * there buries the answer under a copy of something already on disk, so
   * what is kept is the shape of the change: how much arrived, how much left.
   */
  /**
   * A one-word verdict on the step that just ran — "clean", "3 to fix".
   *
   * Same rule as diffStat: it goes on the line that named the step. Nothing
   * goes underneath a bullet, and a result line per tool doubles the height of
   * the transcript to say "ok".
   */
  runStat(text) {
    if (!this.run || !text) return;
    this.run.stat = text;
    this.paintRun();
  }

  diffStat({ added = 0, removed = 0 } = {}) {
    if (!this.run) return;
    this.run.added += added;
    this.run.removed += removed;
    this.paintRun();
  }

  /** The checklist, when the model updates it. One line, wrapped if it must. */
  plan(items) {
    const rows = planRows(items);
    if (!rows.length) return;
    this.endRun();          // a plan is not another step of whatever came before
    for (const row of rows) this.push(row);
  }

  /**
   * What came of a step.
   *
   * Nothing goes underneath the bullet any more: a line of its own for every
   * result doubles the height of the transcript to say "ok". The bullet
   * already names the step, and a change adds its numbers to that same line.
   * Only a failure earns a line of its own.
   */
  toolResult() {}

  /**
   * Something went wrong, and the model is the one who can do anything about it.
   *
   * A red line of machinery — a failed edit, a command that exited non-zero —
   * reads as the tool being broken, when almost always it is a step the model
   * corrects on its own a second later. It goes to the model; the screen stays
   * for what is being built. Whatever is genuinely unrecoverable surfaces as
   * the model saying so in words, which is the form worth reading.
   */
  toolFailed() {
    this.endRun();
  }

  /**
   * The change itself, under the result.
   *
   * A line-number gutter, then the sign and the code tinted right across the
   * row. The numbers are the point: a diff you cannot navigate from is a
   * picture of a change rather than a record of one.
   */
  diff(lines) {
    const gutter = 6;
    // Two spaces of indent, the gutter, one space, then the tint fills the
    // rest. One column over and every row wraps, splitting the whole diff.
    const room = Math.max(12, this.width() - gutter - 3);

    for (const line of lines) {
      // A file heading in a multi-file write.
      if (line.startsWith('~')) {
        this.add(`  ${dim(' '.repeat(gutter))} ${sky(line.slice(1))}`);
        continue;
      }

      const added = line.startsWith('+');
      const rest = line.slice(1);
      // Tools emit "<line>| <text>". A row with no number is the "12 more
      // lines" note, which is not part of the change, so it stays dim.
      const parsed = /^(\d+)\|\s?([\s\S]*)$/.exec(rest);
      if (!parsed) {
        this.add(`  ${dim(' '.repeat(gutter))} ${dim(rest)}`);
        continue;
      }

      const [, number, body] = parsed;
      const tint = added ? ADDED : REMOVED;
      this.add(
        `  ${dim(number.padStart(gutter))} ` +
        // Tabs would leave the tint ending short of the row, so they widen.
        tint(padVis(clip(`${added ? '+' : '-'} ${body.replace(/\t/g, '  ')}`, room), room))
      );
    }
    this.render(); // a sixteen-line diff is one frame, not sixteen
  }

  /** Captured output under a command, dimmed so it reads as evidence. */
  commandOutput(lines) {
    for (const line of lines) this.add(`    ${dim(line)}`);
    this.render();
  }

  /**
   * A running command's output, live — on the status line and nowhere else.
   *
   * Only the newest line, gone as soon as the next arrives. Appending each one
   * instead would mean a test run leaving sixty lines of "ok" in the
   * conversation permanently, which is noise the moment it scrolls. What
   * survives a command is decided when it ends: nothing if it worked, the tail
   * if it did not.
   */
  progress(lines) {
    const last = lines[lines.length - 1]?.trim();
    if (last) this.updateSpinner(last);
  }

  /**
   * The model's own account of the step it is taking, before it takes it.
   *
   * Not called status(): `this.status` holds the spinner state, and a method
   * of the same name would be shadowed by it on every instance.
   */
  narrate(text) {
    const line = asLabel(text);
    if (!line) return;
    this.push(`${dim('⋮')} ${dim(clip(line, this.width() - 4))}`);
    this.updateSpinner(line);
  }

  // -- streaming -----------------------------------------------------------
  // Deltas appear as plain text as they arrive, then get replaced in place by
  // properly rendered markdown once the reply is complete.

  streamBegin() {
    this.stopSpinner();
    this.streamAt = this.lines.length;
    this.streamBuf = '';
    this.streamPainted = 0;
  }

  streamDelta(delta) {
    if (this.streamAt === undefined) this.streamBegin();
    this.streamBuf += delta;
    const now = Date.now();
    if (now - this.streamPainted < 60) return; // about 16fps is plenty
    this.streamPainted = now;
    this.repaintStream();
  }

  /**
   * Repaint the partial reply.
   *
   * polish() runs on the partial text so bold, inline code and bullets are
   * already styled while it streams. Without it the text arrives raw and then
   * visibly re-renders at the end, which reads as a glitch.
   */
  repaintStream() {
    this.lines.length = this.streamAt;
    this.add('');
    this.add(polish(this.streamBuf));
    this.render(); // one frame, and never one without the reply in it
  }

  /**
   * Finish a streamed reply.
   *
   * `asLabel` says the text turned out to be narration ahead of a tool call
   * rather than an answer, in which case one short line folds down into the
   * status line it was always meant to be.
   */
  streamEnd({ asNarration = false, closing = false } = {}) {
    if (this.streamAt === undefined) return '';
    const text = this.streamBuf;
    this.lines.length = this.streamAt;
    this.streamAt = undefined;
    this.streamBuf = '';

    // Mid-build the model's prose is commentary on work that has not happened
    // yet, so it is condensed to one line rather than printed whole — long or
    // short, it never becomes a block of text above the file being written.
    if (asNarration) {
      const line = asNarrationLine(text);
      if (line) this.narrate(line);
      else this.render();
    }
    else if (text.trim()) this.assistant(text, { closing });
    else this.render();
    return text;
  }

  // -- thinking ------------------------------------------------------------
  // A reasoning model does all its working before it says anything. None of it
  // is printed: it is long, repetitive, and guesses drawn from it read worse
  // than silence. The spinner counts the seconds so the wait is visibly alive,
  // and the transcript gets one line afterwards saying how long it took.

  /**
   * The model's reasoning does not go on screen.
   *
   * It was surfaced here to fill the wait before the first tool call, and what
   * it actually filled it with was the model talking to itself: "I need to
   * build this", "The user wants a tasks app". Nobody needs their own request
   * read back to them, and half-formed working-out is not something to publish.
   * What the model *says* is its reply, and that is the only thing shown.
   */
  thinkingDelta() {}

  thinkingEnd() {}

  error(err, { debug = false } = {}) {
    const known = err && typeof err === 'object' && err.attempted;
    this.push('');
    if (known) {
      this.push(`${theme.error('✗')} ${chalk.white(`Failed while ${err.attempted}.`)}`);
      this.push(`  ${err.failed}`);
      if (err.fix) this.push(`  ${blue('→')} ${err.fix}`);
      if (err.kind) this.push(dim(`  (${err.kind})`));
    } else {
      this.push(`${theme.error('✗')} ${chalk.white('Something broke inside ucode.')}`);
      this.push(`  ${err?.message ?? String(err)}`);
      this.push(`  ${blue('→')} That is a bug in ucode rather than in your project. Re-run with --debug.`);
    }
    if (debug) {
      const stack = (known && err.cause?.stack) || err?.stack;
      if (stack) this.push(dim(stack));
    }
    this.push('');
  }

  // -- header --------------------------------------------------------------

  setFacts(facts) {
    this.facts = { ...this.facts, ...facts };
    if (facts.model) this.model = facts.model;
    this.render();
  }

  /** Same shape as the plain UI's header(), so the loop needs no branch. */
  header({ cwd, model, used, limit, title: sessionTitle }) {
    if (cwd && cwd !== this.facts.cwd) this.facts.branch = gitBranch(cwd);
    this.setFacts({
      cwd,
      model,
      title: sessionTitle,
      percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    });
  }

  /**
   * How many rows the header box occupies.
   *
   * The frame has to be exactly as tall as the terminal or every row below the
   * shortfall is off by that much — including the one the caret is parked on.
   * So this is derived, never assumed.
   */
  headerHeight() {
    return this.width() >= WORDMARK_NEEDS ? BANNER.length + 2 : 5;
  }

  headerLines() {
    const width = this.width();
    const inner = width - 2;              // between the borders

    if (width < WORDMARK_NEEDS) {
      // Too narrow for the wordmark: stack it rather than wrap it into noise.
      const rows = [
        `  ${blue.bold('U C O D E')}  ${dim('terminal coding agent')}`,
        `  ${dim('dir'.padEnd(8))}${chalk.white(clip(shortenPath(this.facts.cwd ?? this.cwd, inner - 12), inner - 12))}`,
      ];
      return [boxTop(width), ...rows.map((r) => boxRow(r, width)), boxBottom(width)];
    }

    // Two spaces of padding, the wordmark, a gap, then the facts column.
    //
    // Only what you cannot work out by looking, and never what the status row
    // already carries: the model and how full the window is live down there,
    // next to each other, and a second copy up here would be a second place to
    // keep in sync for no reader who needed it. What is left is where you are,
    // which branch that is on, which build you are running, and the two keys
    // worth knowing before you have typed anything.
    //
    // Every row has something on it. Three blank rows and a credit floating
    // under them read as a column that was meant to be filled and was not.
    const room = Math.max(8, inner - BANNER_WIDTH - 6);
    const value = (v) => clip(String(v), Math.max(4, room - 10));
    const branch = this.facts.branch;

    // The facts run together from the top with nothing between them, the credit
    // sits on the last row, and whatever is left over is the gap between the
    // two. Holding a row empty in the middle of the list — which is what a
    // fixed six-row layout did when a fact was missing — reads as a line that
    // failed to draw rather than as spacing.
    const facts = [
      ['dir', value(shortenPath(this.facts.cwd ?? this.cwd, room - 10))],
      branch && ['branch', value(branch)],
      VERSION && ['version', value(this.facts.update ? `${VERSION} → ${this.facts.update} next start` : VERSION)],
      ['keys', value('/help · esc interrupts · ctrl+b plan')],
    ].filter(Boolean).slice(0, BANNER.length - 1);

    while (facts.length < BANNER.length - 1) facts.push(['', '']);
    facts.push(['', 'made with ❤️ by om dixit']);

    const rows = BANNER.map((art, i) => {
      const [label, text] = facts[i] ?? ['', ''];
      const right = label
        ? `${dim(label.padEnd(10))}${chalk.white(text)}`
        : (text ? dim(text) : '');
      return `  ${bannerPaint(i)(art)}   ${right}`;
    });

    // The frame is lit the way the wordmark inside it is: brightest along the
    // top rule, settling to deep at the bottom. Eight rows of box for six of
    // banner, so the borders take the two ends of the same ramp and the box
    // reads as one object with a light above it rather than as a rule someone
    // drew around a picture.
    const depth = BANNER.length + 2;
    return [
      boxTop(width, bannerPaint(0, depth)),
      ...rows.map((r, i) => boxRow(r, width, bannerPaint(i + 1, depth))),
      boxBottom(width, bannerPaint(depth - 1, depth)),
    ];
  }

  // -- input box -----------------------------------------------------------

  /** The typed line, wrapped to the inside of a box `width` characters across. */
  /**
   * The typed text, laid out as rows inside the box.
   *
   * A line break in the buffer is a row of its own before any wrapping is
   * considered. Slicing the text into fixed widths without looking for one
   * put the newline into the frame instead, and the terminal obeyed it — the
   * pasted text walked out of the box and over the transcript beside it.
   *
   * `starts` records where each row begins in the text, so the caret can be
   * placed by looking up rather than by counting characters a second way and
   * hoping the two agree.
   */
  inputLines(width = this.inner()) {
    const prefix = this.pendingPrompt ? `${this.pendingPrompt} ` : '› ';
    const full = prefix + this.buffer;

    const rows = [];
    const starts = [];
    let at = 0;

    for (const para of full.split(NEWLINE)) {
      let i = 0;
      do {
        rows.push(para.slice(i, i + width));
        starts.push(at + i);
        i += width;
      } while (i < para.length);
      at += para.length + 1; // the newline itself
    }

    if (rows.length === 0) { rows.push(prefix); starts.push(0); }
    return { rows, prefix, width, starts };
  }

  /** Which row the caret sits on, and how far along it. */
  caretAt(width) {
    const { rows, prefix, starts } = this.inputLines(width);
    const index = prefix.length + this.cursor;
    let row = 0;
    while (row + 1 < starts.length && starts[row + 1] <= index) row++;
    return { row, col: Math.min(index - starts[row], rows[row].length), rows };
  }

  viewportHeight() {
    return Math.max(
      3,
      this.rows - this.headerHeight() - CHROME_BELOW - this.inputLines().rows.length
    );
  }

  /**
   * The input box: what you are typing, and directly under it, inside the same
   * border, the three things worth knowing while you type.
   *
   * The status used to sit outside the box on the last row of the screen,
   * which made it a separate object floating under the input. Inside the
   * border it reads as part of the thing you are using — the box says "this is
   * where you work", and the row underneath says what you are working with.
   */
  inputBox(width = this.width()) {
    const { rows } = this.inputLines(width - 4);
    const border = this.borderPaint();
    const busy = this.busy();
    // Nothing typed yet: a quiet prompt where the text will go. The caret sits
    // on its first letter and typing replaces it.
    const empty = !this.buffer && !this.pendingPrompt;
    const hint = !busy ? PLACEHOLDER
      : (width >= WORKING_HINT_NEEDS ? WORKING_HINT : WORKING_HINT_SHORT);
    const painted = rows.map((row, i) =>
      i === 0
        ? boxRow(` ${border('›')}${empty ? ` ${dim(hint)}` : row.slice(1)}`, width, border)
        : boxRow(` ${row}`, width, border)
    );
    return [
      boxTop(width, border),
      ...painted,
      // A blank row between the two. Sitting directly under the caret, the
      // status read as a second line of the thing being typed; one row of air
      // separates what you are writing from what you are writing it with.
      boxRow('', width, border),
      boxRow(this.statusRow(width), width, border),
      boxBottom(width, border),
    ];
  }

  /** Is the agent holding the turn? */
  busy() {
    return this.status.busy || !!this.activity;
  }

  /**
   * The input box's edge, which says whose turn it is.
   *
   * Bold blue while the box is yours, quiet while the agent has it. The status
   * row inside the same box already carries the words; this is the half you
   * catch without reading, from the corner of your eye, in the one place on
   * screen you were already looking.
   */
  borderPaint() {
    return this.busy() ? deep : edge;
  }

  /**
   * Repaint after something that may have changed whose turn it is.
   *
   * The cheap path redraws one row, which is right twelve times a second for a
   * spinner and wrong at a turn boundary: the border above and below would
   * still be the old weight while the status row had the new one, and the box
   * would be drawn in two colours. A whole frame costs nothing twice a turn.
   */
  paintBusy() {
    if (this.busy() === this.paintedBusy) this.paintStatus();
    else this.render();
  }

  // -- status row ----------------------------------------------------------

  modeChip() {
    return modeChip(this.mode);
  }

  /**
   * How full the context window is, as a bare number.
   *
   * It turns amber at 75% because that is where turns start being folded away
   * into a summary — the one moment the number predicts something you would
   * want to know before it happens.
   */
  percentChip() {
    const percent = Math.round(this.facts.percent ?? 0);
    return percent >= 75 ? theme.warn(`${percent}%`) : dim(`${percent}%`);
  }

  /**
   * Which mode is live, which model is answering, and how full the window is.
   *
   * Nothing else earns a place. The provider name was there and was cut: it is
   * the same on every line of every session, so it was decoration that had to
   * be read past to reach the two things that do change.
   *
   * The spinner used to borrow the middle of this row while something ran. It
   * has a row of its own outside the box now, so the only thing that ever
   * appears between the model and the percentage is a flash — a reply to
   * something you just pressed, gone a moment later.
   */
  statusRow(width = this.width()) {
    const inner = width - 2;             // the space between the two borders
    const chip = this.modeChip();
    const left = ` ${chip}  ${chalk.white(this.model || '—')}`;

    // How long the turn has taken, back in the box beside the other two facts
    // about the session. It is not on the live line: that line says what is
    // being done, and a clock ticking in the middle of it competes with the
    // words for no reason. Under a second there is no number worth reading.
    const now = Date.now();
    const since = this.activity?.start ?? this.status.since ?? 0;
    const running = this.busy() && since && now - since >= 1000;
    const right = `${running ? `${dim(formatDuration(now - since))}   ` : ''}${this.percentChip()} `;

    // Where a click on the bottom row still counts as hitting the mode chip.
    this.chipTo = 2 + visLen(chip);

    const between = Math.max(1, inner - visLen(left) - visLen(right));
    const middle = this.flashText ? dim(clip(this.flashText, between - 2)) : '';

    const tail = middle ? `${middle}   ` : '';
    const pad = Math.max(1, inner - visLen(left) - visLen(tail) - visLen(right));
    return padVis(left + ' '.repeat(pad) + tail + right, inner);
  }

  /**
   * What is happening right now: the spinner, what it is doing, how long it has
   * been doing it, and the way out.
   *
   * It used to live in whatever space the status row had spare between the
   * model name and the percentage — inside the box you type into, which is the
   * one place on screen that is about you rather than about the agent. Out
   * here it sits directly under the steps it belongs to, in the same column,
   * and has room for a bar instead of a shimmer.
   */
  activityLine(width = this.width()) {
    if (!this.busy()) return '';
    const now = Date.now();
    return workingLine({
      glyph: spinnerGlyph(this.tick, now),
      label: this.status.busy ? this.status.text : 'working',
      hint: 'esc to stop',
      room: Math.max(4, width),
      t: now,
    });
  }

  /**
   * Which row the live line is painted on, 1-based, or 0 when it is not shown.
   *
   * It is the last line of the conversation, so its row moves as the
   * conversation grows and stops moving once the viewport is full. Scrolled
   * back, or with the picker open, it is not on screen at all and the cheap
   * repaint has nothing to do.
   */
  activityRowAt() {
    if (this.scroll > 0 || this.picker) return 0;
    const index = Math.min(this.lines.length + 1, this.viewportHeight()) - 1;
    return index < 0 ? 0 : this.headerHeight() + 2 + index;
  }

  /**
   * Repaint only the moving rows, leaving the caret where the user left it.
   *
   * It is the second row from the bottom now — the box's own border is below
   * it — so the row is written with its borders rather than as a bare line.
   */
  paintStatus() {
    if (this.closed) return;
    // On the start screen the status row is mid-screen, not second from the
    // bottom, so the cheap single-row repaint would draw it in the wrong place.
    if (this.welcoming()) {
      this.render();
      return;
    }
    const [row, col] = this.caret();
    const width = this.width();
    const liveAt = this.activityRowAt();
    this.output.write(
      PAINT_BEGIN + HIDE +
      (liveAt ? at(liveAt, 1) + CLEAR_LINE + padVis(this.activityLine(width), width) : '') +
      at(this.rows - 1, 1) + CLEAR_LINE + boxRow(this.statusRow(width), width, this.borderPaint()) +
      at(row, col) + SHOW + PAINT_END
    );
  }

  toggleMode() {
    this.mode = this.mode === 'plan' ? 'build' : 'plan';
    this.flash(this.mode === 'plan'
      ? 'plan mode — reads and researches, changes nothing'
      : 'build mode — free to edit files and run commands');
    this.onModeChange?.(this.mode);
    this.render();
  }

  /** A message on the status line that fades on its own. */
  flash(text) {
    this.flashText = text;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashText = null;
      this.paintStatus();
    }, 2500);
    this.flashTimer.unref?.();
    this.paintStatus();
  }

  // -- spinner -------------------------------------------------------------

  startSpinner(text = 'thinking') {
    // `since` is what makes a long think legible: the label may not change for
    // a minute, so the seconds beside it are the proof it is still alive.
    this.status = { busy: true, text: asLabel(text), frame: 0, since: Date.now() };
    this.startTimer();
    this.paintBusy();
  }

  updateSpinner(text) {
    if (!this.status.busy) return;
    this.status.text = asLabel(text);
    this.paintStatus();
  }

  stopSpinner() {
    if (!this.activity) this.stopTimer();
    if (this.status.busy) {
      this.status = { busy: false, text: '', frame: 0, since: 0 };
      this.paintBusy();
    }
  }

  // -- the turn in flight ----------------------------------------------------

  /** A turn begins: the timer and step count run until turnEnd(). */
  turnStart() {
    this.newSegment();
    this.activity = { start: Date.now(), steps: 0, movedAt: 0 };
    this.startTimer();
    this.paintBusy();
  }

  /** One more model step in this turn. */
  step() {
    if (!this.activity) return;
    this.activity.steps++;
    this.activity.movedAt = Date.now();
  }

  /** The turn is over: leave "✓ Done in 6m 12s · 25 steps" under the answer. */
  turnEnd({ ok = true } = {}) {
    const a = this.activity;
    this.activity = null;
    if (!this.status.busy) this.stopTimer();
    // Nothing is written when a turn finishes. The reply is the end of the
    // turn, and a timing line under it is bookkeeping the reader did not ask
    // for. A turn that stopped *without* finishing still says so, because
    // silence there is indistinguishable from a crash.
    if (a && !ok && Date.now() - a.start >= 2000) {
      this.push(`  ${doneLine(Date.now() - a.start, a.steps, { ok })}`);
    }
    this.paintBusy();
  }

  /** The animation clock: only the status row repaints, about twelve times a second. */
  startTimer() {
    if (this.spinTimer) return;
    this.spinTimer = setInterval(() => {
      // Only the status row repaints on a tick. Animating a transcript line
      // meant redrawing the whole frame twelve times a second, and the input
      // box was being rebuilt under the user's cursor as they typed.
      this.tick++;
      this.paintStatus();
    }, FRAME_MS);
    this.spinTimer.unref?.();
  }

  stopTimer() {
    if (!this.spinTimer) return;
    clearInterval(this.spinTimer);
    this.spinTimer = null;
  }

  // -- input ---------------------------------------------------------------

  nextLine() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  ask() {
    return this.nextLine();
  }

  submit(text) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(text);
    else this.queue.push(text);
  }

  /** y/n, answered on the input line. */
  confirm({ action, detail, risk }) {
    this.push('');
    this.push(`${chalk.inverse(theme.warn(risk === 'command' ? ' shell ' : ' outside project '))} ${chalk.white(action)}`);
    for (const line of String(detail ?? '').split('\n')) {
      if (line) this.push(dim(`  ${line}`));
    }

    this.pendingPrompt = 'go ahead? [y/N]';
    this.scroll = 0; // the question has to be on screen to be answered
    this.render();

    return this.nextLine().then((answer) => {
      this.pendingPrompt = null;
      // End of input counts as no. Never run something nobody approved.
      const yes = /^(y|yes)$/i.test(String(answer ?? '').trim());
      this.push(dim(yes ? '  approved' : '  declined'));
      this.push('');
      return yes;
    });
  }

  /**
   * A modal list: arrows move, Enter picks, Esc cancels.
   *
   * Only while this is open do the arrows stop scrolling the transcript. They
   * cannot be given up permanently, because under alternate scroll the mouse
   * wheel arrives as arrow keys.
   */
  pick(items, { active = 0, hint = 'enter to choose · esc to cancel', deletable = false } = {}) {
    this.picker = {
      items,
      index: Math.min(Math.max(0, active), Math.max(0, items.length - 1)),
      hint,
      // With deletable, `d` twice on a row resolves { delete: index }. Twice,
      // because a single stray keypress should never cost a conversation.
      deletable,
      armed: null,
    };
    this.render();
    return new Promise((resolve) => { this.pickerResolve = resolve; });
  }

  closePicker(value) {
    const resolve = this.pickerResolve;
    this.picker = null;
    this.pickerResolve = null;
    this.render();
    resolve?.(value);
  }

  /**
   * Rows for an open picker, windowed so a long list still fits.
   *
   * An item may carry a `sub` line — a second, dimmer row underneath it. That
   * is what lets a list of saved conversations show what each one was actually
   * about instead of a column of near-identical titles.
   */
  pickerLines(height) {
    const { items, index, hint, armed } = this.picker;
    const room = Math.max(1, height - 2);

    // Rows per item, so the window can be sized in rows rather than in items.
    const rowsFor = (item) => (typeof item !== 'string' && item.sub ? 2 : 1);
    const perItem = items.map(rowsFor);

    // Walk outward from the selection until the window is full. Starting from
    // the selection guarantees it is on screen however long the list is.
    let first = index;
    let last = index;
    let used = perItem[index] ?? 1;
    while (used < room && (first > 0 || last < items.length - 1)) {
      if (first > 0 && used + perItem[first - 1] <= room) { first--; used += perItem[first]; }
      else if (last < items.length - 1 && used + perItem[last + 1] <= room) { last++; used += perItem[last]; }
      else break;
    }

    const out = [];
    for (let i = first; i <= last; i++) {
      const item = items[i];
      const body = typeof item === 'string' ? item : item.label;
      if (i === armed) out.push(`${theme.warn('✗')} ${theme.warn(bare(body))}`);
      else out.push(i === index ? `${blue('❯')} ${chalk.bold.white(body)}` : `  ${dim(body)}`);
      if (typeof item !== 'string' && item.sub) out.push(`  ${item.sub}`);
    }

    out.push('');
    out.push(armed !== null && armed !== undefined
      ? theme.warn('  press d again to delete this conversation · any other key keeps it')
      : dim(`  ${hint}`));
    return out;
  }

  /** A numbered list, answered on the input line. */
  async choose(prompt, items, { allowNone = true } = {}) {
    items.forEach((item, i) => this.push(`  ${blue(String(i + 1).padStart(2))}. ${item}`));
    if (allowNone) this.push(dim('   0. none — start fresh'));
    this.push('');

    this.pendingPrompt = prompt;
    this.render();

    const answer = await this.nextLine();
    this.pendingPrompt = null;

    const trimmed = String(answer ?? '').trim();
    if (trimmed === '' || trimmed === '0') return null;

    const index = Number(trimmed);
    if (!Number.isInteger(index) || index < 1 || index > items.length) {
      this.push(theme.warn(`  "${trimmed}" is not one of 1-${items.length}.`));
      return null;
    }
    return index - 1;
  }

  // -- keyboard and mouse --------------------------------------------------

  /**
   * Scroll the transcript, clamped at both ends.
   *
   * When there is nothing above the fold, say so. Silence is indistinguishable
   * from broken input, and the difference matters: one means the conversation
   * simply fits, the other means the terminal is not forwarding keys at all.
   */
  scrollBy(delta) {
    const max = Math.max(0, this.lines.length - this.viewportHeight());
    if (max === 0) {
      this.flash('nothing above — it all fits on screen');
      return;
    }
    const before = this.scroll;
    this.scroll = Math.min(Math.max(0, this.scroll + delta), max);
    if (this.scroll === before && delta > 0) this.flash('already at the top');
    // One wheel notch arrives as three arrow keys in one chunk; one frame, not three.
    this.soon();
  }

  /**
   * Text arriving as a paste rather than as typing.
   *
   * A terminal in bracketed-paste mode wraps pasted text in markers, which is
   * the only way to tell forty lines pasted at once from forty lines typed
   * very fast. Without it every newline in the paste reads as Enter, so a
   * pasted block submits itself a line at a time and arrives as forty
   * messages. Inside the markers a newline is just a character.
   */
  onPaste(text) {
    const clean = String(text).replace(/\r\n?/g, '\n');
    this.buffer = this.buffer.slice(0, this.cursor) + clean + this.buffer.slice(this.cursor);
    this.cursor += clean.length;
    this.render();
  }

  onData(chunk) {
    // Pasted text first: it is wrapped in markers and must not be read as
    // keys, or its newlines submit it in pieces.
    const paste = /\[200~([\s\S]*?)\[201~/g;
    if (paste.test(chunk)) {
      paste.lastIndex = 0;
      let at = 0;
      let m;
      while ((m = paste.exec(chunk))) {
        if (m.index > at) this.onData(chunk.slice(at, m.index));
        this.onPaste(m[1]);
        at = m.index + m[0].length;
      }
      if (at < chunk.length) this.onData(chunk.slice(at));
      return;
    }
    // An unterminated paste: hold what has arrived and wait for the rest.
    const open = chunk.indexOf('[200~');
    if (open !== -1) {
      if (open > 0) this.onData(chunk.slice(0, open));
      this.pasting = chunk.slice(open + 6);
      return;
    }
    if (this.pasting !== undefined && this.pasting !== null) {
      const close = chunk.indexOf('[201~');
      if (close === -1) { this.pasting += chunk; return; }
      this.onPaste(this.pasting + chunk.slice(0, close));
      this.pasting = null;
      const after = chunk.slice(close + 6);
      if (after) this.onData(after);
      return;
    }

    // UCODE_DEBUG_KEYS=1 logs every byte the terminal sends to
    // ~/.ucode/keys.log. Whether mouse reporting works at all depends on the
    // terminal forwarding it; this is how to find out.
    if (process.env.UCODE_DEBUG_KEYS) {
      appendFile(path.join(homedir(), '.ucode', 'keys.log'), `${JSON.stringify(chunk)}\n`).catch(() => {});
    }

    // Pull mouse reports out of the chunk wherever they sit. Anchoring the
    // match to the whole chunk meant a wheel event arriving alongside any
    // other byte was silently treated as typing.
    let rest = '';
    let index = 0;
    // Two encodings: SGR (ESC [ < b ; x ; y M|m), and the legacy form
    // (ESC [ M then three bytes offset by 32) for terminals that ignore 1006.
    const mouse = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[M([\s\S])([\s\S])([\s\S])/g;
    let match;

    while ((match = mouse.exec(chunk)) !== null) {
      rest += chunk.slice(index, match.index);
      index = match.index + match[0].length;
      if (match[1] !== undefined) {
        this.onMouse(Number(match[1]), Number(match[2]), Number(match[3]), match[4]);
      } else {
        this.onMouse(
          match[5].charCodeAt(0) - 32,
          match[6].charCodeAt(0) - 32,
          match[7].charCodeAt(0) - 32,
          'M'
        );
      }
    }
    rest += chunk.slice(index);

    // A chunk carrying a line break *and* other text did not come from a
    // keyboard: nobody types a newline in the middle of a burst. Many
    // terminals, Windows ones especially, send a paste with no markers at
    // all, so without this every newline in it reads as Enter and the paste
    // submits itself a line at a time.
    if (looksPasted(rest)) { this.onPaste(rest); return; }

    for (const key of splitKeys(rest)) this.onKey(key);
  }

  onMouse(button, col, row, press) {
    // Wheel reports set bit 6; bit 0 says which way.
    if (button >= 64) {
      this.scrollBy(button % 2 === 0 ? 3 : -3);
      return;
    }
    if (press !== 'M' || button !== 0) return;
    if (this.welcoming()) {
      const g = this.welcomeGeometry();
      const statusRow = g.boxTop + g.inputRows + 3;          // 1-based
      if (row === statusRow && col > g.left + 1 && col <= g.left + this.chipTo) this.toggleMode();
      return;
    }
    // The mode chip, at the left of the bottom row.
    if (row === this.rows - 1 && col >= 2 && col <= this.chipTo) this.toggleMode();
  }

  onKey(key) {
    // An open picker owns the keyboard until it closes.
    if (this.picker) {
      const last = this.picker.items.length - 1;
      if (this.picker.deletable && (key === 'd' || key === 'D' || key === `${ESC}[3~`)) {
        if (this.picker.armed === this.picker.index) { this.closePicker({ delete: this.picker.index }); return; }
        this.picker.armed = this.picker.index;
        this.render();
        return;
      }
      this.picker.armed = null;   // any other key takes the delete back
      if (key === `${ESC}[A`) { this.picker.index = Math.max(0, this.picker.index - 1); this.render(); return; }
      if (key === `${ESC}[B`) { this.picker.index = Math.min(last, this.picker.index + 1); this.render(); return; }
      if (key === '\r' || key === '\n') { this.closePicker(this.picker.index); return; }
      if (key === ESC || key === '\x03') { this.closePicker(null); return; }
      return;
    }

    switch (key) {
      case '\r':
      case '\n': {
        const text = this.buffer;
        this.buffer = '';
        this.cursor = 0;
        this.historyIndex = -1;
        if (text.trim()) {
          this.history.unshift(text);
          // Answers to a y/N or a numbered pick are not messages, so they are
          // not echoed: the prompt reports its own outcome.
          if (!this.pendingPrompt) this.userMessage(text);
        }
        this.render();
        this.submit(text);
        return;
      }

      case '\x7f':  // backspace
      case '\b':
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
          this.cursor--;
        }
        break;

      case '\x03':  // ctrl+c
        if (this.status.busy && this.onInterrupt) this.onInterrupt();
        else { this.buffer = ''; this.cursor = 0; }
        break;

      case '\x04':  // ctrl+d
        this.close();
        return;

      case '\x02':  // ctrl+b — swap plan and build
        this.toggleMode();
        return;

      case '\x15':  // ctrl+u — clear the line
        this.buffer = this.buffer.slice(this.cursor);
        this.cursor = 0;
        break;

      case ESC:     // esc — stop the turn in flight
        if (this.onInterrupt) this.onInterrupt();
        return;

      case '\t': {
        const hit = COMMANDS.find((c) => c.startsWith(this.buffer));
        if (hit) { this.buffer = hit; this.cursor = hit.length; }
        break;
      }

      // With an empty line the arrows scroll the conversation; once there is
      // something typed they walk history. Terminals often swallow PgUp and
      // PgDn for their own scrollback, so this is the path that always works.
      case `${ESC}[A`:
        if (!this.buffer) { this.scrollBy(2); return; }
        if (this.history.length) {
          this.historyIndex = Math.min(this.historyIndex + 1, this.history.length - 1);
          this.buffer = this.history[this.historyIndex] ?? '';
          this.cursor = this.buffer.length;
        }
        break;

      case `${ESC}[B`:
        if (!this.buffer) { this.scrollBy(-2); return; }
        this.historyIndex = Math.max(this.historyIndex - 1, -1);
        this.buffer = this.historyIndex === -1 ? '' : (this.history[this.historyIndex] ?? '');
        this.cursor = this.buffer.length;
        break;

      case `${ESC}[1;5A`: this.scrollBy(2); return;   // ctrl+up
      case `${ESC}[1;5B`: this.scrollBy(-2); return;  // ctrl+down
      case `${ESC}[5~`: this.scrollBy(this.viewportHeight()); return;
      case `${ESC}[6~`: this.scrollBy(-this.viewportHeight()); return;

      case `${ESC}[H`: this.scrollBy(this.lines.length); return;
      case `${ESC}[F`: this.scroll = 0; this.render(); return;

      case `${ESC}[C`: this.cursor = Math.min(this.cursor + 1, this.buffer.length); break;
      case `${ESC}[D`: this.cursor = Math.max(this.cursor - 1, 0); break;

      default:
        if (key >= ' ' && !key.startsWith(ESC)) {
          this.buffer = this.buffer.slice(0, this.cursor) + key + this.buffer.slice(this.cursor);
          this.cursor += key.length;
        } else {
          return;
        }
    }

    this.render();
  }

  // -- painting ------------------------------------------------------------

  render() {
    if (this.closed) return;
    if (this.welcoming()) {
      this.renderWelcome();
      return;
    }

    const width = this.width();
    const height = this.viewportHeight();

    // Scrolled back, the view stays on what is being read while output grows
    // underneath: every line added since the last paint extends the scroll by
    // the same amount, so the same rows stay on screen. Snapping to the
    // bottom on every streamed line fought the wheel sixteen times a second.
    // A streamed reply truncates its tail and rebuilds it on every delta, so
    // the growth since the last paint is net — but the tail sits below a
    // scrolled-back viewport, and net growth still moves the scroll by exactly
    // the amount that keeps the visible rows put.
    if (this.scroll > 0 && this.paintedLines != null) {
      const grown = this.lines.length - this.paintedLines;
      this.scroll = Math.min(Math.max(0, this.scroll + grown), Math.max(0, this.lines.length - height));
    }
    this.paintedLines = this.lines.length;

    // The live line is the last line of the conversation, not a fixture above
    // the input box. Pinned down there it sat at the bottom of the screen while
    // the message that started it was at the top, with the empty middle of the
    // viewport between them — so the thing being done looked unrelated to the
    // thing that had been asked. On the end of the transcript it arrives
    // directly under the prompt, which is where the eye already is.
    const live = this.activityLine(width);
    const said = live ? [...this.lines, live] : this.lines;

    const end = Math.max(0, said.length - this.scroll);
    const start = Math.max(0, end - height);
    const window = this.picker ? this.pickerLines(height) : said.slice(start, end);
    while (window.length < height) window.push('');

    const frame = [
      ...this.headerLines(),
      '',
      ...window,
      // Always one clear row between the last thing said and the box you type
      // in. Without it the newest line of output sits against the border and
      // reads as part of the input rather than as the answer above it.
      '',
      ...this.inputBox(),
    ];

    // The cursor is hidden for the duration of the paint. Without this it is
    // dragged through every line as the frame is written, which shows up as a
    // dot flickering above the input box on every keystroke.
    const out = [PAINT_BEGIN, HIDE];
    for (let i = 0; i < this.rows; i++) {
      out.push(at(i + 1, 1) + CLEAR_LINE + padVis(frame[i] ?? '', width));
    }

    const [row, col] = this.caret();
    out.push(at(row, col) + SHOW + PAINT_END);
    this.paintedBusy = this.busy();
    this.output.write(out.join(''));
  }

  /**
   * Where the typing caret belongs, 1-based.
   *
   * Column three is the first character inside the box: border, a space of
   * padding, then the text.
   */
  caret() {
    if (this.welcoming()) {
      const g = this.welcomeGeometry();
      const { row, col } = this.caretAt(g.boxWidth - 4);
      // g.boxTop is 0-based and the typed lines start one below the border.
      return [g.boxTop + 2 + row, g.left + 3 + col];
    }

    const { row, col: at, rows } = this.caretAt();
    const col = 3 + at;
    // Counting up from the bottom: the box border is the last row, the status
    // row is above it, then the blank row, then the typed lines.
    const firstRow = this.rows - 2 - rows.length;
    return [firstRow + row, col];
  }

  // -- start screen ----------------------------------------------------------

  /**
   * Nothing has been said yet, so there is nothing to scroll: the screen is the
   * wordmark and the place to type, centred, and nothing else.
   *
   * It comes back after /clear and /new too, since those empty the transcript —
   * a fresh conversation starts from the same quiet screen as a fresh launch.
   */
  welcoming() {
    return this.lines.length === 0 && !this.picker;
  }

  /** Where everything on the start screen goes, 0-based rows. */
  welcomeGeometry() {
    const cols = this.width();
    const boxWidth = Math.max(30, Math.min(cols - 4, 84));
    const left = Math.max(0, Math.floor((cols - boxWidth) / 2));
    const big = cols >= BANNER_WIDTH + 4 && this.rows >= 18;
    const art = big ? BANNER : ['u c o d e'];
    const inputRows = this.inputLines(boxWidth - 4).rows.length;
    const boxRows = inputRows + 4;                         // borders, typed rows, gap, status
    const suggest = this.rows >= boxRows + art.length + SUGGEST_ROWS + 6;
    const block = art.length + 2 + boxRows + (suggest ? SUGGEST_ROWS : 0);
    // A touch above true centre reads as centred; exact centre looks low.
    const top = Math.max(0, Math.floor((this.rows - block) / 2) - 1);
    return { cols, boxWidth, left, big, art, inputRows, boxRows, suggest, top, boxTop: top + art.length + 2 };
  }

  renderWelcome() {
    const g = this.welcomeGeometry();
    const frame = new Array(this.rows).fill('');

    // The wordmark lit from the top: sky at the crown, deep in the shadow
    // rows. Across the rows rather than along them — a name split down its
    // middle reads as two words, where a name that fades downward reads as
    // one object with a light on it.
    const elapsed = this.intro ? Date.now() - this.intro : Infinity;
    g.art.forEach((line, i) => {
      const pad = ' '.repeat(Math.max(0, Math.floor((g.cols - line.length) / 2)));
      frame[g.top + i] = pad + (g.big
        ? bannerSweep(line, i, g.art.length, elapsed)
        : blue.bold(line));
    });

    const indent = ' '.repeat(g.left);
    this.inputBox(g.boxWidth).forEach((row, i) => {
      frame[g.boxTop + i] = indent + row;
    });

    // Three things to try, aligned with the text inside the box above them.
    if (g.suggest) {
      const at = g.boxTop + g.boxRows + 1;
      SUGGESTIONS.forEach((text, i) => {
        const label = i === 0 ? 'try'.padEnd(SUGGEST_LABEL) : ' '.repeat(SUGGEST_LABEL);
        frame[at + i] = `${indent} ${dim(sky(label))}${dim(clip(text, Math.max(8, g.boxWidth - SUGGEST_LABEL - 2)))}`;
      });
    }

    // The version, in the corner, and nothing else on the screen.
    if (VERSION) {
      const tag = dim(this.facts.update ? `v${VERSION} · v${this.facts.update} installed, starts next time` : `v${VERSION}`);
      frame[this.rows - 1] = ' '.repeat(Math.max(0, g.cols - visLen(tag) - 2)) + tag;
    }

    const out = [PAINT_BEGIN, HIDE];
    for (let i = 0; i < this.rows; i++) {
      out.push(at(i + 1, 1) + CLEAR_LINE + padVis(frame[i], g.cols));
    }
    const [row, col] = this.caret();
    out.push(at(row, col) + SHOW + PAINT_END);
    this.paintedBusy = this.busy();
    this.output.write(out.join(''));
  }
}

/**
 * Split a raw stdin chunk into keys, keeping escape sequences whole.
 *
 * Application cursor key mode (DECCKM) makes a terminal send ESC O A for the
 * up arrow rather than ESC [ A. Both are normalised to the bracket form here
 * so the key handler only ever sees one of them.
 */
/**
 * Did this arrive as a paste, judged by shape rather than by markers?
 *
 * Someone pressing Enter sends one carriage return on its own. A paste sends
 * a line break with text around it, in a single read. That difference is all
 * there is to go on when a terminal does not implement bracketed paste, and
 * it is enough.
 *
 * Anything carrying an escape sequence is left alone: that is a key or a
 * mouse report, and reading one as text would put gibberish in the input.
 */
export function looksPasted(chunk) {
  const text = String(chunk ?? '');
  if (text.length < 2 || text.includes(ESC)) return false;
  const breaks = (text.match(/[\r\n]/g) ?? []).length;
  if (breaks === 0) return false;
  // One trailing break is someone finishing a line, not pasting one.
  if (breaks === 1 && /[\r\n]$/.test(text)) return false;
  return true;
}

export function splitKeys(chunk) {
  const keys = [];
  let i = 0;

  while (i < chunk.length) {
    const c = chunk[i];
    if (c !== ESC) { keys.push(c); i++; continue; }

    const rest = chunk.slice(i);
    const csi = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(rest);
    if (csi) { keys.push(csi[0]); i += csi[0].length; continue; }

    const ss3 = /^\x1bO([A-Za-z])/.exec(rest);
    if (ss3) { keys.push(`${ESC}[${ss3[1]}`); i += ss3[0].length; continue; }

    keys.push(ESC);
    i++;
  }

  return keys;
}
