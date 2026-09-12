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
import { dim, sky, theme, clip, SPINNER } from './theme.js';

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
 * The spinner glyph for a frame, breathing slowly between two blues.
 *
 * The pulse is slow — a little over a second a breath — so it reads as the
 * glyph being alive rather than as a blink.
 */
export function spinnerGlyph(frame, t, { level = chalk.level } = {}) {
  const glyph = SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length];
  if (level < 2) return theme.blue(glyph);
  const k = (Math.sin((Math.max(0, t) / 1300) * Math.PI * 2) + 1) / 2;
  const [r, g, b] = mix([0x4d, 0x8d, 0xff], [0x9f, 0xc6, 0xff], k);
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
export function doneLine(ms, steps) {
  const count = steps > 0 ? ` · ${steps} step${steps === 1 ? '' : 's'}` : '';
  return `${theme.ok('✓')} ${dim(`Done in ${formatDuration(ms)}${count}`)}`;
}

/** The step count, brighter for a moment right after it goes up. */
export function stepPaint(justMoved) {
  return justMoved ? sky : dim;
}
