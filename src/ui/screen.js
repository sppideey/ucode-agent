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
  shortenPath, asLabel, ensureColour, planLine, bare, BG_ON, BG_OFF, onBackground } from './theme.js';
import { FRAME_MS, fitActivity, shimmer, spinnerGlyph, formatDuration, doneLine, stepPaint } from './activity.js';
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
  '/stats', '/doctor', '/deploy',
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

const MOUSE_ON = `${ESC}[?1007h${TRACK}`;
const MOUSE_OFF = `${UNTRACK}${ESC}[?1007l`;
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const HOME = `${ESC}[H`;
const CLEAR_LINE = `${ESC}[K`;
const at = (row, col) => `${ESC}[${row};${col}H`;
const title = (t) => `${ESC}]0;${t}\x07`;

/**
 * Fixed rows below the header: the gap under it, the gap above the input box,
 * the input box's two borders, the blank row inside it, and the status row.
 */
const CHROME_BELOW = 6;

/** The wordmark only earns its place with room for the facts column beside it. */
const WORDMARK_NEEDS = BANNER_WIDTH + 30;

/** Where the U ends and CODE begins in each row of the wordmark. */
const WORDMARK_SPLIT = 9;

/** What the empty input box says before anything is typed. */
const PLACEHOLDER = 'Ask anything…';

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
    this.activity = null; // the turn in flight: when it began, how many steps
    this.tick = 0;        // animation frames painted, for the spinner
    this.pendingPrompt = null;

    this.cols = output.columns || 80;
    this.rows = output.rows || 24;
    this.md = renderer(this.width());
  }

  // -- lifecycle -----------------------------------------------------------

  async start() {
    ensureColour(this.output);
    this.output.write(ALT_ON + MOUSE_ON + HIDE + BG_ON + `${ESC}[2J` + title(`ucode — ${path.basename(this.cwd)}`));
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
  }

  stop() {
    this.activity = null;
    this.stopSpinner();
    this.stopTimer();
    this.output.off?.('resize', this.onResize);
    this.input.setRawMode?.(false);
    this.input.pause();
    this.output.write(BG_OFF + MOUSE_OFF + ALT_OFF + SHOW);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    while (this.waiters.length) this.waiters.shift()(null);
  }

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
    for (const raw of String(text).split('\n')) {
      if (visLen(raw) <= width) this.lines.push(raw);
      else for (const wrapped of wrapAnsi(raw, width)) this.lines.push(wrapped);
    }
    this.scroll = 0; // new output snaps back to the bottom
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
    this.render();
  }

  assistant(text) {
    if (!text?.trim()) return;
    this.add('');
    this.add(render(this.md, text));
    this.add('');
    this.render();
  }

  /**
   * Something the user said, in the conversation, in the same blue box as the
   * input it was typed into.
   *
   * A long session is mostly the agent's output — tool calls, diffs, answers.
   * Your own messages are the landmarks you scroll back looking for, so they
   * get the frame: every one of them is findable at a glance, and the box
   * matches the one below so it is plain where each came from.
   */
  userMessage(text) {
    const width = this.width();
    const room = Math.max(8, width - 6);   // borders, padding, and the caret column

    const rows = [];
    for (const paragraph of String(text).replace(/\r/g, '').split('\n')) {
      for (const line of wrapAnsi(paragraph, room)) rows.push(line);
    }

    this.add('');
    this.add(boxTop(width, edge));
    rows.forEach((row, i) => {
      const lead = i === 0 ? blue('›') : ' ';
      this.add(boxRow(` ${lead} ${chalk.white(row)}`, width, edge));
    });
    this.add(boxBottom(width, edge));
    this.render();
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
    this.push(`${blue('●')} ${asLabel(label)}`);
    this.updateSpinner(label);
  }

  /** The checklist, when the model updates it. One line, wrapped if it must. */
  plan(items) {
    const line = planLine(items);
    if (line) this.push(line);
  }

  toolResult(summary) {
    this.push(dim(`  └ ${summary}`));
  }

  toolFailed(summary) {
    this.push(`${dim('  └ ')}${theme.error(summary)}`);
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
    this.push(dim(`  ⋮ ${clip(line, this.width() - 6)}`));
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
  streamEnd({ asNarration = false } = {}) {
    if (this.streamAt === undefined) return '';
    const text = this.streamBuf;
    this.lines.length = this.streamAt;
    this.streamAt = undefined;
    this.streamBuf = '';

    if (asNarration && isLabel(text)) this.narrate(text);
    else if (text.trim()) this.assistant(text);
    else this.render();
    return text;
  }

  // -- thinking ------------------------------------------------------------
  // A reasoning model does all its working before it says anything. None of it
  // is printed: it is long, repetitive, and guesses drawn from it read worse
  // than silence. The spinner counts the seconds so the wait is visibly alive,
  // and the transcript gets one line afterwards saying how long it took.

  thinkingDelta() {
    if (this.thoughtSince === undefined) this.thoughtSince = Date.now();
  }

  thinkingEnd() {
    if (this.thoughtSince === undefined) return;
    const seconds = Math.round((Date.now() - this.thoughtSince) / 1000);
    if (seconds >= 2) this.push(dim(`  ⋮ thought for ${seconds}s`));
    this.thoughtSince = undefined;
  }

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
    // Only what you cannot work out by looking: where you are, and how to get
    // help. How full the window is belongs on the status row next to the model
    // it describes, and the session title is already the terminal's own window
    // title — repeating either here is a second place to keep in sync for no
    // reader who needed it.
    const room = Math.max(8, inner - BANNER_WIDTH - 6);
    const facts = [
      ['dir', shortenPath(this.facts.cwd ?? this.cwd, room - 9)],
      ['keys', '/help · esc interrupts'],
      ['', ''],
      ['', ''],
      ['', ''],
      ['', 'made with ❤️ by om dixit'],
    ];

    const rows = BANNER.map((art, i) => {
      const [label, value] = facts[i] ?? ['', ''];
      const right = label
        ? `${dim(label.padEnd(9))}${chalk.white(clip(value, room - 9))}`
        : (value ? dim(value) : '');
      return `  ${blue(art)}   ${right}`;
    });

    return [boxTop(width), ...rows.map((r) => boxRow(r, width)), boxBottom(width)];
  }

  // -- input box -----------------------------------------------------------

  /** The typed line, wrapped to the inside of a box `width` characters across. */
  inputLines(width = this.inner()) {
    const prefix = this.pendingPrompt ? `${this.pendingPrompt} ` : '› ';
    const full = prefix + this.buffer;

    const rows = [];
    for (let i = 0; i < full.length; i += width) rows.push(full.slice(i, i + width));
    if (rows.length === 0) rows.push(prefix);

    return { rows, prefix, width };
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
    // Nothing typed yet: a quiet prompt where the text will go. The caret sits
    // on its first letter and typing replaces it.
    const empty = !this.buffer && !this.pendingPrompt;
    const painted = rows.map((row, i) =>
      i === 0
        ? boxRow(` ${blue('›')}${empty ? ` ${dim(PLACEHOLDER)}` : row.slice(1)}`, width, edge)
        : boxRow(` ${row}`, width, edge)
    );
    return [
      boxTop(width, edge),
      ...painted,
      // A blank row between the two. Sitting directly under the caret, the
      // status read as a second line of the thing being typed; one row of air
      // separates what you are writing from what you are writing it with.
      boxRow('', width, edge),
      boxRow(this.statusRow(width), width, edge),
      boxBottom(width, edge),
    ];
  }

  // -- status row ----------------------------------------------------------

  modeChip() {
    return this.mode === 'plan' ? `${sky('◇')} ${sky('Plan')}` : `${blue('◆')} ${blue('Build')}`;
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
   * The middle is borrowed while something is running, for the spinner and the
   * way out of it, and handed straight back when it finishes.
   */
  statusRow(width = this.width()) {
    const inner = width - 2;             // the space between the two borders
    const chip = this.modeChip();
    const left = ` ${chip} ${dim('·')} ${chalk.white(this.model || '—')}`;
    const right = `${this.percentChip()} `;

    // Where a click on the bottom row still counts as hitting the mode chip.
    this.chipTo = 2 + visLen(chip);

    const between = Math.max(1, inner - visLen(left) - visLen(right));

    let middle = '';
    if (this.flashText) {
      middle = dim(clip(this.flashText, between - 2));
    } else if (this.status.busy || this.activity) {
      // The whole turn, not just the current tool: the timer and step count
      // keep going through the gaps between calls, so a long build never
      // looks like it has stopped.
      const now = Date.now();
      const a = this.activity;
      const since = a?.start ?? this.status.since ?? now;
      const meta = [];
      if (a?.steps) meta.push({ text: `step ${a.steps}`, paint: stepPaint(now - a.movedAt < 900) });
      if (now - since >= 1000) meta.push({ text: formatDuration(now - since), keep: true });
      middle = fitActivity({
        glyph: spinnerGlyph(this.tick, now),
        label: this.status.busy ? this.status.text : 'working',
        meta,
        hint: 'esc to stop',
        paint: (s) => shimmer(s, now),
      }, between - 3);
    }

    // The percentage is pinned to the right border whatever is in the middle,
    // with a gap kept in front of it so a long spinner label cannot run into
    // the number and read as part of it.
    const tail = middle ? `${middle}   ` : '';
    const pad = Math.max(1, inner - visLen(left) - visLen(tail) - visLen(right));
    return padVis(left + ' '.repeat(pad) + tail + right, inner);
  }

  /**
   * Repaint only the status row, leaving the caret where the user left it.
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
    this.output.write(
      HIDE +
      at(this.rows - 1, 1) + CLEAR_LINE + boxRow(this.statusRow(), this.width(), edge) +
      at(row, col) + SHOW
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
    this.paintStatus();
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
      this.paintStatus();
    }
  }

  // -- the turn in flight ----------------------------------------------------

  /** A turn begins: the timer and step count run until turnEnd(). */
  turnStart() {
    this.activity = { start: Date.now(), steps: 0, movedAt: 0 };
    this.startTimer();
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
    if (a && ok && Date.now() - a.start >= 2000) this.push(`  ${doneLine(Date.now() - a.start, a.steps)}`);
    this.paintStatus();
  }

  /** The animation clock: only the status row repaints, about twelve times a second. */
  startTimer() {
    if (this.spinTimer) return;
    this.spinTimer = setInterval(() => {
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
    this.render();
  }

  onData(chunk) {
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

    const end = Math.max(0, this.lines.length - this.scroll);
    const start = Math.max(0, end - height);
    const window = this.picker ? this.pickerLines(height) : this.lines.slice(start, end);
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
    const out = [HIDE, HOME];
    for (let i = 0; i < this.rows; i++) {
      out.push(BG_ON + CLEAR_LINE + onBackground(padVis(frame[i] ?? '', width)) + (i === this.rows - 1 ? '' : '\n'));
    }

    const [row, col] = this.caret();
    out.push(at(row, col) + SHOW);
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
      const { rows, prefix, width } = this.inputLines(g.boxWidth - 4);
      const index = prefix.length + this.cursor;
      const row = Math.min(Math.floor(index / width), rows.length - 1);
      // g.boxTop is 0-based and the typed lines start one below the border.
      return [g.boxTop + 2 + row, g.left + 3 + (index % width)];
    }

    const { rows, prefix, width } = this.inputLines();
    const index = prefix.length + this.cursor;
    const row = Math.min(Math.floor(index / width), rows.length - 1);
    const col = 3 + (index % width);
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
    const block = art.length + 2 + inputRows + 4;          // wordmark, gap, box
    // A touch above true centre reads as centred; exact centre looks low.
    const top = Math.max(0, Math.floor((this.rows - block) / 2) - 1);
    return { cols, boxWidth, left, big, art, inputRows, top, boxTop: top + art.length + 2 };
  }

  renderWelcome() {
    const g = this.welcomeGeometry();
    const frame = new Array(this.rows).fill('');

    // The wordmark in two tones of the one blue, the way a name reads in two
    // halves: the U quieter, CODE brighter.
    g.art.forEach((line, i) => {
      const pad = ' '.repeat(Math.max(0, Math.floor((g.cols - line.length) / 2)));
      frame[g.top + i] = pad + (g.big
        ? deep(line.slice(0, WORDMARK_SPLIT)) + sky(line.slice(WORDMARK_SPLIT))
        : blue.bold(line));
    });

    const indent = ' '.repeat(g.left);
    this.inputBox(g.boxWidth).forEach((row, i) => {
      frame[g.boxTop + i] = indent + row;
    });

    // The version, in the corner, and nothing else on the screen.
    if (VERSION) {
      const tag = dim(this.facts.update ? `v${VERSION} · v${this.facts.update} installed, starts next time` : `v${VERSION}`);
      frame[this.rows - 1] = ' '.repeat(Math.max(0, g.cols - visLen(tag) - 2)) + tag;
    }

    const out = [HIDE, HOME];
    for (let i = 0; i < this.rows; i++) {
      out.push(BG_ON + CLEAR_LINE + onBackground(padVis(frame[i], g.cols)) + (i === this.rows - 1 ? '' : '\n'));
    }
    const [row, col] = this.caret();
    out.push(at(row, col) + SHOW);
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
