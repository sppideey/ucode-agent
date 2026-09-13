/**
 * activity.js — what the status row shows while ucode is working.
 *
 * A long turn is minutes of the agent doing things the user did not type and
 * cannot see coming. The status row is the one place that says it is still
 * going, so it has to look alive at a glance without asking to be read: a
 * spinner that turns, a soft band of light passing across the label, the
 * step count ticking up, and the time the turn has taken so far.
 *
 * Everything here is a pure function of the text and the clock, so it can be
 * tested without a terminal and painted at any frame rate.
 */

import chalk, { Chalk } from 'chalk';
import { dim, sky, theme, clip, SPINNER, bannerRGB, bannerPaint } from './theme.js';

/** One painter per colour level, so a test can ask for truecolour on a pipe. */
const painters = new Map();
const painter = (level) => {
  if (!painters.has(level)) painters.set(level, new Chalk({ level }));
  return painters.get(level);
};

/** One frame every 85ms — just under twelve a second, smooth without being busy. */
export const FRAME_MS = 85;

/**
 * A duration as a person says it: 0.4s, 14s, 2m 04s, 1h 07m.
 *
 * Seconds are zero-padded once there are minutes, so the text after the timer
 * does not shift sideways every time the seconds roll from 9 to 10.
 */
export function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${(value / 1000).toFixed(1)}s`;
  const total = Math.floor(value / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// ---------------------------------------------------------------------------
// The shimmer
// ---------------------------------------------------------------------------

/**
 * The two ends of the shimmer, both blue. The resting colour is muted enough
 * to read as secondary text beside the model name; the peak is almost white,
 * so the band reads as light passing over the words rather than a second
 * colour arriving.
 */
const REST_RGB = [0x7a, 0x96, 0xc8];
const PEAK_RGB = [0xe6, 0xf0, 0xff];

/** Half the width of the band of light, in characters. */
const BAND = 3;

/** How fast the band travels, in characters a second. */
const SPEED = 46;

/** Characters' worth of dark between one pass and the next. */
const PAUSE = 10;

/** Brightness steps. Neighbouring letters that land on the same step share one escape code. */
const STEPS = 8;

const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));

/**
 * The text with a soft band of light passing across it, left to right, then a
 * short rest, then again.
 *
 * `t` is milliseconds on any clock; the band's position is a function of it,
 * so a slow frame skips ahead rather than slowing the sweep down.
 *
 * Needs 256 colours or more. With 16 there are no in-between blues to fade
 * through, and a band that jumps between two colours reads as flicker rather
 * than light — so below that the label is simply dim, and never moves.
 */
export function shimmer(text, t, { level = chalk.level } = {}) {
  const s = String(text ?? '');
  if (!s || level < 2) return dim(s);

  const cycle = s.length + BAND * 2 + PAUSE;
  const centre = ((Math.max(0, t) / 1000) * SPEED) % cycle - BAND;

  let out = '';
  let run = '';
  let runStep = -1;
  const flush = () => {
    if (!run) return;
    const [r, g, b] = mix(REST_RGB, PEAK_RGB, runStep / STEPS);
    out += painter(level).rgb(r, g, b)(run);
    run = '';
  };

  for (let i = 0; i < s.length; i++) {
    const distance = Math.abs(i - centre);
    // A cosine falloff: brightest at the centre, fading smoothly to nothing
    // at the edge of the band, so the light has no hard edge to it.
    const k = distance < BAND ? (Math.cos((Math.PI * distance) / BAND) + 1) / 2 : 0;
    const step = Math.round(k * STEPS);
    if (step !== runStep) { flush(); runStep = step; }
    run += s[i];
  }
  flush();
  return out;
}

/**
 * The wordmark with a light passing across it, once, at launch.
 *
 * The first thing anyone sees of a program is the half second before they can
 * type, and ucode was spending it showing a finished picture. A band of light
 * crossing the mark left to right in that same half second costs nothing, is
 * over before it can annoy anyone, and is the difference between a logo that
 * was printed and one that arrived.
 *
 * Every row is swept from the same clock, so the light is a vertical bar
 * travelling across the whole wordmark rather than six separate glints. It
 * blends out of the row's own gradient colour, not out of a flat blue, so the
 * moment it passes the mark is exactly what it will look like at rest.
 *
 * Below 256 colours there are no in-between shades to fade through, so the
 * mark is simply drawn finished — a two-colour "sweep" is a flicker.
 */
export const SWEEP_MS = 620;

/** Half the width of the travelling band, in characters. */
const SWEEP_BAND = 7;

export function bannerSweep(line, row, rows, elapsed, { level = chalk.level } = {}) {
  const text = String(line ?? '');
  const rest = bannerRGB(row, rows);
  const progress = SWEEP_MS > 0 ? elapsed / SWEEP_MS : 1;
  if (level < 2 || !text || progress >= 1 || progress < 0) return bannerPaint(row, rows)(text);

  // The centre starts off the left edge and ends off the right, so the band
  // enters and leaves rather than appearing in the middle of the letters.
  const centre = progress * (text.length + SWEEP_BAND * 2) - SWEEP_BAND;

  let out = '';
  let run = '';
  let runStep = -1;
  const flush = () => {
    if (!run) return;
    const [r, g, b] = mix(rest, PEAK_RGB, runStep / STEPS);
    out += painter(level).rgb(r, g, b)(run);
    run = '';
  };

  for (let i = 0; i < text.length; i++) {
    const distance = Math.abs(i - centre);
    const k = distance < SWEEP_BAND ? (Math.cos((Math.PI * distance) / SWEEP_BAND) + 1) / 2 : 0;
    const step = Math.round(k * STEPS);
    if (step !== runStep) { flush(); runStep = step; }
    run += text[i];
  }
  flush();
  return out;
}


/**
 * The bar that says work is happening, with no claim about how much is left.
 *
 * A spinner turning in one cell says "alive". A band of light running along a
 * track says "alive, and going somewhere", which is the honest amount of
 * progress an agent can report — it does not know how many steps are left, so
 * a filling bar would be a lie and an indeterminate one is not.
 *
 * The band runs off both ends rather than bouncing inside the track: a bounce
 * draws the eye to the turn, where a pass reads as something continuous going
 * by. Below 256 colours there is nothing to fade through, so the track is
 * simply dim and still, and the spinner beside it carries the motion.
 */
export const BAR_CELLS = 12;

/** The unlit track, and the crest of the band running along it. */
const TRACK_RGB = [0x24, 0x34, 0x4f];
const CREST_RGB = [0x8f, 0xbc, 0xff];

/** One pass of the band, in milliseconds. */
const BAR_PERIOD = 1400;

/** Half the width of the band, in cells. */
const BAR_BAND = 3.5;

export function indeterminate(cells, t, { level = chalk.level } = {}) {
  const width = Math.max(0, Math.floor(cells));
  if (!width) return '';
  const track = '━'.repeat(width);
  if (level < 2) return dim(track);

  const centre = ((Math.max(0, t) % BAR_PERIOD) / BAR_PERIOD) * (width + BAR_BAND * 2) - BAR_BAND;

  let out = '';
  let run = '';
  let runStep = -1;
  const flush = () => {
    if (!run) return;
    const [r, g, b] = mix(TRACK_RGB, CREST_RGB, runStep / STEPS);
    out += painter(level).rgb(r, g, b)(run);
    run = '';
  };

  for (let i = 0; i < width; i++) {
    const distance = Math.abs(i - centre);
    const k = distance < BAR_BAND ? (Math.cos((Math.PI * distance) / BAR_BAND) + 1) / 2 : 0;
    const step = Math.round(k * STEPS);
    if (step !== runStep) { flush(); runStep = step; }
    run += track[i];
  }
  flush();
  return out;
}

/**
 * The whole live line: what is happening, that it is still happening, how long
 * it has been happening, and how to stop it.
 *
 * This used to be squeezed into whatever the status row had spare between the
 * model name and the percentage, which is why the label shimmered — it was the
 * only way to look alive in twenty columns. With a row of its own the motion
 * moves to the bar and the label can simply be read.
 *
 * Things are given up from the least useful end as the terminal narrows: the
 * hint first, then the bar shortens, then it goes, then the label is clipped.
 * The spinner is the last thing standing, because a line with nothing moving
 * on it says the program has hung.
 */
export function workingLine({
  glyph, label = '', elapsed = '', hint = 'esc to stop', room, t = 0, level = chalk.level,
} = {}) {
  const text = String(label ?? '');
  if (room < 3) return glyph;

  const tail = [elapsed, hint].filter(Boolean).join('   ');
  const shortTail = elapsed || '';

  const draw = (cells, tailText, labelRoom) => {
    let out = `${glyph} ${sky(clip(text, labelRoom))}`;
    if (cells) out += `   ${indeterminate(cells, t, { level })}`;
    if (tailText) out += `   ${dim(tailText)}`;
    return out;
  };

  for (const [cells, tailText] of [
    [BAR_CELLS, tail], [BAR_CELLS, shortTail], [8, shortTail], [0, shortTail], [0, ''],
  ]) {
    const fixed = 2 + (cells ? cells + 3 : 0) + (tailText ? tailText.length + 3 : 0);
    const labelRoom = room - fixed;
    if (labelRoom >= Math.min(MIN_LABEL, text.length)) return draw(cells, tailText, labelRoom);
  }

  return `${glyph} ${sky(clip(text, Math.max(1, room - 2)))}`;
}

/**
 * The spinner glyph for a frame, breathing slowly between two blues.
 *
 * The pulse is slow — a little over a second a breath — so it reads as the
 * glyph being alive rather than as a blink.
 */
export function spinnerGlyph(frame, t, { level = chalk.level } = {}) {
  const glyph = SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length];
  if (level < 2) return theme.blue(glyph);
  const k = (Math.sin((Math.max(0, t) / 1000) * Math.PI * 2) + 1) / 2;
  const [r, g, b] = mix([0x2f, 0x6f, 0xe0], [0x9f, 0xc6, 0xff], k);
  return painter(level).rgb(r, g, b)(glyph);
}

// ---------------------------------------------------------------------------
// Fitting it into the room there is
// ---------------------------------------------------------------------------

/** Shorter than this, a label is a stub that says nothing, so it goes entirely. */
const MIN_LABEL = 10;

/**
 * The middle of the status row, fitted to `room` columns.
 *
 * Parts, in the order they are given up when the terminal is too narrow for
 * all of them:
 *
 *   1. the "esc to stop" hint     — useful once, known after that
 *   2. the end of the label        — clipped with an ellipsis, down to a stub
 *   3. the step count
 *   4. the label itself
 *   5. the elapsed time
 *
 * The spinner is the last thing standing: even with a single column left the
 * row still shows that something is happening.
 *
 * `meta` is a list of { text, paint, keep } — keep marks the one that survives
 * the longest (the timer). `paint` colours the label, which is where the
 * shimmer comes in.
 */
export function fitActivity({ glyph, label = '', meta = [], hint = '', paint = dim }, room) {
  if (room < 1) return '';
  const items = meta.filter((m) => m && m.text);
  const kept = items.filter((m) => m.keep);
  const text = String(label ?? '');

  const width = (labelLen, list, withHint) =>
    1 +
    (labelLen ? 1 + labelLen : 0) +
    (list.length ? (labelLen ? 3 : 1) + list.map((m) => m.text).join(' · ').length : 0) +
    (withHint && hint ? 2 + hint.length : 0);

  const build = (labelText, list, withHint) => {
    let out = glyph;
    if (labelText) out += ` ${paint(labelText)}`;
    if (list.length) {
      out += labelText ? dim(' · ') : ' ';
      out += list.map((m) => (m.paint ?? dim)(m.text)).join(dim(' · '));
    }
    if (withHint && hint) out += `  ${dim(hint)}`;
    return out;
  };

  if (text) {
    if (width(text.length, items, true) <= room) return build(text, items, true);
    if (width(text.length, items, false) <= room) return build(text, items, false);
    for (const list of [items, kept]) {
      const labelRoom = room - width(0, list, false) - 1 - (list.length ? 2 : 0);
      if (labelRoom >= MIN_LABEL) return build(clip(text, labelRoom), list, false);
    }
  }
  for (const list of [items, kept, []]) {
    if (width(0, list, false) <= room) return build('', list, false);
  }
  return glyph;
}

/**
 * The line a finished turn leaves in the transcript: "✓ Done in 6m 12s · 25 steps".
 *
 * Green for the tick, because green means done and nothing else in this
 * theme; the rest dim, because it is a footnote to the answer above it rather
 * than something to read first.
 */
export function doneLine(ms, steps, { ok = true } = {}) {
  // The step count is bookkeeping: it tells the reader nothing about whether
  // the thing they asked for exists. /stats has it for anyone who wants it.
  void steps;
  if (!ok) return `${theme.warn('!')} ${dim(`Stopped after ${formatDuration(ms)} without finishing`)}`;
  return `${theme.ok('✓')} ${dim(`Done in ${formatDuration(ms)}`)}`;
}

/** The step count, brighter for a moment right after it goes up. */
export function stepPaint(justMoved) {
  return justMoved ? sky : dim;
}
