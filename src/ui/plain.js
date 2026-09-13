/**
 * plain.js — the interface for when there is no terminal to draw on.
 *
 * Piped input, CI, `echo "fix the test" | ucode`, a shell wrapper that hands
 * over a pipe instead of a keyboard. There is no frame to repaint here, so
 * output is simply printed in order and the prompt is one readline line.
 *
 * It carries the same method names as screen.js on purpose: the agent loop
 * talks to one interface and never asks which one it got.
 */

import readline from 'node:readline';
import chalk from 'chalk';
import {
  theme, blue, sky, dim, boxTop, boxBottom, boxRow,
  BANNER, BANNER_WIDTH, SPINNER, clip, shortenPath, asLabel, padVis, visLen, planLine, bannerPaint, modeChip, narrationMark, groupKind,
  tidyReply, trimAnswer,
} from './theme.js';
import { formatDuration, doneLine } from './activity.js';
import { renderer, render } from './markdown.js';

const COMMANDS = [
  '/help', '/model', '/models', '/session', '/sessions', '/resume',
  '/new', '/remember', '/skills', '/clear', '/search', '/copy', '/exit',
];

export class Plain {
  constructor({ cwd, input = process.stdin, output = process.stdout } = {}) {
    this.cwd = cwd;
    this.output = output;
    this.closed = false;
    this.mode = 'build';   // no way to toggle without a keyboard; stays here
    this.model = '';
    this.timer = null;
    this.frame = 0;
    this.md = renderer(output.columns || 80);

    this.rl = readline.createInterface({
      input,
      output,
      historySize: 200,
      completer(line) {
        if (!line.startsWith('/')) return [[], line];
        const hits = COMMANDS.filter((c) => c.startsWith(line));
        return [hits.length ? hits : COMMANDS, line];
      },
    });

    // Input is queued rather than read with rl.question(). When stdin is a
    // pipe, readline emits every buffered line at once, so a question-per-turn
    // loop would drop all but the first. Queueing behaves the same way
    // interactively and makes piping work.
    this.queue = [];
    this.waiters = [];

    this.rl.on('line', (line) => {
      const clean = line.replace(/^﻿/, ''); // strip a BOM on the first line
      const waiter = this.waiters.shift();
      if (waiter) waiter(clean);
      else this.queue.push(clean);
    });

    this.rl.on('close', () => {
      this.closed = true;
      while (this.waiters.length) this.waiters.shift()(null);
    });
  }

  width() {
    return Math.max(30, this.output.columns || 80);
  }

  // -- output --------------------------------------------------------------

  write(text = '') {
    this.stopSpinner();
    this.output.write(`${text}\n`);
  }

  blank() { this.write(''); }
  note(text) { this.write(dim(`  ${text}`)); }

  clearScreen() {
    this.stopSpinner();
    this.output.write('\x1B[2J\x1B[3J\x1B[H');
  }

  header({ cwd, model, used, limit, title }) {
    this.stopSpinner();
    this.model = model || this.model;
    this.percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

    const width = this.width();
    const room = Math.max(8, width - BANNER_WIDTH - 8);

    const facts = [
      ['dir', shortenPath(cwd, room - 9)],
      ['keys', '/help'],
      ['', ''],
      ['', ''],
      ['', 'made with ❤️ by om dixit'],
    ];

    // There is no input box to hang the status off here, so it goes on the
    // last row inside the header box — still framed, still the same three
    // facts, just attached to the only box this interface has.
    const rows = width >= BANNER_WIDTH + 30
      ? BANNER.map((art, i) => {
          const [label, value] = facts[i] ?? ['', ''];
          const right = label
            ? `${dim(label.padEnd(9))}${chalk.white(clip(value, room - 9))}`
            : (value ? dim(value) : '');
          return `  ${bannerPaint(i)(art)}   ${right}`;
        })
      : [
          `  ${blue.bold('U C O D E')}  ${dim('terminal coding agent')}`,
          ...facts
            .filter(([label]) => label)
            .map(([label, value]) => `  ${dim(label.padEnd(9))}${chalk.white(clip(value, width - 16))}`),
        ];

    this.write('');
    this.write(boxTop(width));
    for (const row of rows) this.write(boxRow(row, width));
    this.write(boxRow(this.statusRow(), width));
    this.write(boxBottom(width));
    this.write('');
  }

  setFacts() { /* nothing to repaint without a frame */ }

  /** The same three facts the full screen shows, on the row under the header. */
  statusRow() {
    const inner = this.width() - 2;
    const chip = modeChip(this.mode);
    const left = ` ${chip}  ${chalk.white(this.model || '—')}`;
    const percent = Math.round(this.percent ?? 0);
    const right = `${percent >= 75 ? theme.warn(`${percent}%`) : dim(`${percent}%`)} `;
    const pad = Math.max(1, inner - visLen(left) - visLen(right));
    return padVis(left + ' '.repeat(pad) + right, inner);
  }

  toolCall(label) {
    this.stopSpinner();
    this.output.write(`${narrationMark(groupKind(label))} ${asLabel(label)}\n`);
  }

  plan(items) {
    const line = planLine(items);
    if (line) this.write(line);
  }

  toolResult(summary) {
    this.stopSpinner();
    this.output.write(dim(`  └ ${summary}\n`));
  }

  toolFailed(summary) {
    this.stopSpinner();
    this.output.write(`${dim('  └ ')}${theme.error(summary)}\n`);
  }

  /** The change, with the same line-number gutter the full screen uses. */
  diff(lines) {
    this.stopSpinner();
    for (const line of lines) {
      if (line.startsWith('~')) {
        this.output.write(`         ${sky(line.slice(1))}\n`);
        continue;
      }
      const added = line.startsWith('+');
      const rest = line.slice(1);
      const parsed = /^(\d+)\|\s?([\s\S]*)$/.exec(rest);
      if (!parsed) {
        this.output.write(`         ${dim(rest)}\n`);
        continue;
      }
      const [, number, body] = parsed;
      const paint = added ? theme.ok : theme.error;
      this.output.write(`  ${dim(number.padStart(6))} ${paint(`${added ? '+' : '-'} ${body}`)}\n`);
    }
  }

  commandOutput(lines) {
    this.stopSpinner();
    for (const line of lines) this.output.write(`    ${dim(line)}\n`);
  }

  assistant(text, { closing = false } = {}) {
    const body = closing ? trimAnswer(tidyReply(text)) : tidyReply(text);
    const out = render(this.md, body);
    if (!out) return;
    this.stopSpinner();
    this.output.write(`\n${out}\n\n`);
  }

  narrate(text) {
    const line = asLabel(text);
    if (!line) return;
    this.stopSpinner();
    this.write(dim(`  ⋮ ${line}`));
  }

  progress(lines) {
    const last = lines[lines.length - 1]?.trim();
    if (last) this.updateSpinner(last);
  }

  // Streaming has nowhere to repaint here, so the reply is printed whole when
  // it is finished. The loop only streams into a real terminal anyway.
  streamBegin() {}
  streamDelta() {}
  streamEnd() { return ''; }
  thinkingDelta() {}
  thinkingEnd() {}

  // -- spinner -------------------------------------------------------------

  startSpinner(text = 'thinking') {
    this.stopSpinner();
    if (!this.output.isTTY) return; // a pipe does not want animation frames
    this.spinnerText = asLabel(text);
    this.since = Date.now();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.paintSpinner();
    }, 100);
    this.timer.unref?.();
    this.paintSpinner();
  }

  paintSpinner() {
    const since = this.turn?.start ?? this.since;
    const secs = Math.round((Date.now() - since) / 1000);
    const meta = [this.turn?.steps ? `step ${this.turn.steps}` : '', secs >= 2 ? formatDuration(secs * 1000) : '']
      .filter(Boolean).join(' · ');
    const line = `  ${blue(SPINNER[this.frame])} ${dim(this.spinnerText)}` + (meta ? dim(` · ${meta}`) : '');
    this.output.write(`\r\x1b[K${padVis(line, this.width() - 1)}`);
  }

  updateSpinner(text) {
    if (!this.timer) return;
    this.spinnerText = asLabel(text);
    this.paintSpinner();
  }

  stopSpinner() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.output.write('\r\x1b[K');
  }

  // -- the turn in flight ----------------------------------------------------

  turnStart() {
    this.turn = { start: Date.now(), steps: 0 };
  }

  step() {
    if (this.turn) this.turn.steps++;
  }

  turnEnd({ ok = true } = {}) {
    const t = this.turn;
    this.turn = null;
    if (t && !ok && Date.now() - t.start >= 2000) {
      this.write(`  ${doneLine(Date.now() - t.start, t.steps, { ok })}`);
    }
  }

  // -- input ---------------------------------------------------------------

  nextLine() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  promptWith(text) {
    this.rl.setPrompt(text);
    this.rl.prompt();
    return this.nextLine();
  }

  ask() {
    this.stopSpinner();
    return this.promptWith(`${blue('› ')}`);
  }

  async confirm({ action, detail, risk }) {
    this.stopSpinner();
    const badge = risk === 'command' ? ' shell ' : ' outside project ';
    this.output.write(`\n${chalk.inverse(theme.warn(badge))} ${chalk.white(action)}\n`);
    for (const line of String(detail ?? '').split('\n')) {
      if (line) this.output.write(dim(`  ${line}\n`));
    }

    const answer = await this.promptWith(`${blue('  go ahead? ')}${dim('[y/N] ')}`);
    // End of input is a no: never run something nobody approved.
    const yes = /^(y|yes)$/i.test(String(answer ?? '').trim());
    this.output.write(dim(yes ? '  approved\n\n' : '  declined\n\n'));
    return yes;
  }

  async choose(prompt, items, { allowNone = true } = {}) {
    this.stopSpinner();
    items.forEach((item, i) => this.output.write(`  ${blue(String(i + 1).padStart(2))}. ${item}\n`));
    if (allowNone) this.output.write(dim('   0. none — start fresh\n'));
    this.output.write('\n');

    const answer = await this.promptWith(`${blue('› ')}${dim(`${prompt} `)}`);
    if (answer === null) return null;

    const trimmed = String(answer).trim();
    if (trimmed === '' || trimmed === '0') return null;

    const index = Number(trimmed);
    if (!Number.isInteger(index) || index < 1 || index > items.length) {
      this.write(theme.warn(`  "${trimmed}" is not one of 1-${items.length}. Starting fresh.`));
      return null;
    }
    return index - 1;
  }

  error(err, { debug = false } = {}) {
    this.stopSpinner();
    const known = err && typeof err === 'object' && err.attempted;

    this.output.write('\n');
    if (known) {
      this.output.write(`${theme.error('✗')} ${chalk.white(`Failed while ${err.attempted}.`)}\n`);
      this.output.write(`  ${err.failed}\n`);
      if (err.fix) this.output.write(`  ${blue('→')} ${err.fix}\n`);
      if (err.kind) this.output.write(dim(`  (${err.kind})\n`));
    } else {
      this.output.write(`${theme.error('✗')} ${chalk.white('Something broke inside ucode.')}\n`);
      this.output.write(`  ${err?.message ?? String(err)}\n`);
      this.output.write(`  ${blue('→')} That is a bug in ucode rather than in your project. Re-run with --debug.\n`);
    }

    if (debug) {
      const stack = (known && err.cause?.stack) || err?.stack;
      if (stack) this.output.write(dim(`\n${stack}\n`));
    }
    this.output.write('\n');
  }

  close() {
    this.stopSpinner();
    this.rl.close();
  }
}
