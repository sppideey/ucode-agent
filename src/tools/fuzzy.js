/**
 * fuzzy.js — finding the text an edit meant when it is not in the file as written.
 *
 * Adapted from opencode's edit tool (MIT License, Copyright (c) 2025 opencode;
 * see THIRD_PARTY_NOTICES.md).
 *
 * An old_string that misses costs a whole round trip: the refusal goes back,
 * the model re-reads the file, and sends the edit again. Most misses are the
 * same handful of slips — a line of the middle remembered slightly wrong,
 * whitespace collapsed, the indent shifted, "\n" written out as an escape,
 * a stray blank line at either end. Each matcher below yields the spans of the
 * file that old_string plausibly means; the first span found exactly once is
 * the one replaced. Found in two places is never guessed at.
 *
 * files.js tries an exact match and its own whitespace-tolerant, re-indenting
 * match first; this is only reached when both have missed.
 */

/** How alike the middle lines of a block must be for block anchoring to accept it. */
const SIMILARITY = 0.65;

/**
 * Past this, the file is not searched loosely at all. The matchers are plain
 * scans and they run on the main thread, where a stale edit against a huge
 * lockfile would freeze the session — Esc included — for minutes.
 * ponytail: a flat cap, not a budget; move the chain to a worker if loose
 * edits on files this big ever matter.
 */
const MAX_LINES = 20_000;
const MAX_CHARS = 1_000_000;

function levenshtein(a, b) {
  if (a === '' || b === '') return Math.max(a.length, b.length);
  // Two long minified lines would be a hundred million steps. Lines that long
  // are not what a remembered-slightly-wrong edit is about: call them unlike.
  if (a.length * b.length > 1_000_000) return a === b ? 0 : Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** The lines of `find`, without the empty string a trailing newline leaves. */
function wantedLines(find) {
  const lines = find.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Lines joined into windows before a loose search gives up and calls it a miss. */
const WINDOW_BUDGET = 200_000;

/**
 * Every run of `count` consecutive lines whose first line `could` start a
 * match, joined back into text. The check is cheap and rules out nearly every
 * window before it is built; the budget bounds the rest.
 */
function* windows(lines, count, could = () => true) {
  let spent = 0;
  for (let i = 0; i + count <= lines.length; i++) {
    if (!could(lines[i])) continue;
    if ((spent += count) > WINDOW_BUDGET) return;
    yield lines.slice(i, i + count).join('\n');
  }
}

/**
 * First and last lines exact, the middle close enough. Catches an edit whose
 * middle was remembered with a changed word or two — the commonest miss on a
 * block the model read many steps ago.
 */
function* blockAnchor(content, find) {
  if (find.split('\n').length < 3) return;
  const want = wantedLines(find);
  const lines = content.split('\n');
  const first = want[0].trim();
  const last = want[want.length - 1].trim();
  const slack = Math.max(1, Math.floor(want.length * 0.25));

  // Only the first closing line after an opening one counts, and a block is
  // accepted within `slack` of the wanted length — so there is no point
  // looking further than that. Scanning on to the end of the file made a
  // blank first and last line quadratic in the file's length.
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== first) continue;
    const end = Math.min(lines.length, i + want.length + slack);
    for (let j = i + 2; j < end; j++) {
      if (lines[j].trim() !== last) continue;
      if (Math.abs(j - i + 1 - want.length) <= slack) blocks.push([i, j]);
      break;
    }
  }

  const similarity = ([i, j]) => {
    const inner = Math.min(want.length - 2, j - i - 1);
    if (inner <= 0) return 1;
    let total = 0;
    for (let k = 1; k < want.length - 1 && k < j - i; k++) {
      const a = lines[i + k].trim();
      const b = want[k].trim();
      const longest = Math.max(a.length, b.length);
      if (longest) total += 1 - levenshtein(a, b) / longest;
    }
    return total / inner;
  };

  // opencode takes the best-scoring block. Every block close enough is
  // offered instead, so two look-alike handlers read as ambiguous and are
  // refused rather than the first one quietly edited.
  for (const block of blocks) {
    if (similarity(block) >= SIMILARITY) yield lines.slice(block[0], block[1] + 1).join('\n');
  }
}
blockAnchor.how = 'by its first and last lines, the middle nearly the same';

/** Every run of whitespace treated as one space. */
function* whitespaceNormalized(content, find) {
  const flat = (s) => s.replace(/\s+/g, ' ').trim();
  const want = flat(find);
  if (!want) return;
  const lines = content.split('\n');

  for (const line of lines) {
    const flatLine = flat(line);
    if (flatLine === want) {
      yield line;
    } else if (flatLine.includes(want)) {
      const pattern = find.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      const hit = line.match(new RegExp(pattern));
      if (hit) yield hit[0];
    }
  }

  const count = find.split('\n').length;
  if (count > 1) {
    for (const block of windows(lines, count, (l) => want.startsWith(flat(l)))) if (flat(block) === want) yield block;
  }
}
whitespaceNormalized.how = 'with runs of whitespace collapsed';

/** The same block at a different indent depth. */
function* indentationFlexible(content, find) {
  const dedent = (s) => {
    const lines = s.split('\n');
    const filled = lines.filter((l) => l.trim());
    if (!filled.length) return s;
    const least = Math.min(...filled.map((l) => /^\s*/.exec(l)[0].length));
    return lines.map((l) => (l.trim() ? l.slice(least) : l)).join('\n');
  };
  const want = dedent(find);
  // Dedenting keeps every line's text, so the first lines must match trimmed.
  const head = find.split('\n')[0].trim();
  for (const block of windows(content.split('\n'), find.split('\n').length, (l) => l.trim() === head)) {
    if (dedent(block) === want) yield block;
  }
}
indentationFlexible.how = 'ignoring indentation';

const ESCAPES = { n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '`': '`', '\\': '\\', '\n': '\n', $: '$' };
const unescape = (s) => s.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_, c) => ESCAPES[c]);

/** "\n" and "\"" written out as escapes, where the file has the real characters. */
function* escapeNormalized(content, find) {
  const want = unescape(find);
  if (content.includes(want)) yield want;
  // A trailing backslash may be escaping the line break, so it is left off.
  const could = (l) => want.startsWith(unescape(l).replace(/\\$/, ''));
  for (const block of windows(content.split('\n'), want.split('\n').length, could)) {
    if (unescape(block) === want) yield block;
  }
}
escapeNormalized.how = 'after undoing escaped characters';
// A model that wrote old_string with "\n" for its line breaks wrote
// new_string the same way; spliced in as is, the file would get a literal
// backslash-n where each line break should be. A new_string with real line
// breaks is already in the file's terms and is left alone.
escapeNormalized.adapt = (replacement, find) =>
  unescape(find) !== find && !replacement.includes('\n') ? unescape(replacement) : replacement;

/** Blank lines or spaces at either end that the file does not have there. */
function* trimmedBoundary(content, find) {
  const want = find.trim();
  if (want === find || !want) return;
  if (content.includes(want)) yield want;
  for (const block of windows(content.split('\n'), find.split('\n').length, (l) => want.startsWith(l.trimStart()))) {
    if (block.trim() === want) yield block;
  }
}
trimmedBoundary.how = 'ignoring leading and trailing whitespace';

/** First and last lines exact, the same length, and at least half the middle identical. */
function* contextAware(content, find) {
  if (find.split('\n').length < 3) return;
  const want = wantedLines(find);
  const lines = content.split('\n');
  const first = want[0].trim();
  const last = want[want.length - 1].trim();

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== first) continue;
    // Only a block exactly as long as the one wanted is accepted.
    const end = Math.min(lines.length, i + want.length);
    for (let j = i + 2; j < end; j++) {
      if (lines[j].trim() !== last) continue;
      const block = lines.slice(i, j + 1);
      if (block.length === want.length) {
        let same = 0;
        let counted = 0;
        for (let k = 1; k < block.length - 1; k++) {
          const a = block[k].trim();
          const b = want[k].trim();
          if (a || b) {
            counted++;
            if (a === b) same++;
          }
        }
        if (counted === 0 || same / counted >= 0.5) yield block.join('\n');
      }
      break;
    }
  }
}
contextAware.how = 'by its first and last lines';

const MATCHERS = [blockAnchor, whitespaceNormalized, indentationFlexible, escapeNormalized, trimmedBoundary, contextAware];

/**
 * A match far bigger than what was asked for is a matcher reaching, not a
 * find. Replacing it would delete code the model never meant to touch.
 */
function tooWide(match, find) {
  const lines = find.split('\n').length;
  if (match.split('\n').length >= Math.max(lines + 3, lines * 2)) return true;
  if (lines === 1) return false;
  return match.trim().length > Math.max(find.trim().length + 500, find.trim().length * 4);
}

/** How many separate places a set of [start, end) spans covers, overlaps counted once. */
function places(spans) {
  let count = 0;
  let reach = -1;
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    if (start >= reach) count++;
    reach = Math.max(reach, end);
  }
  return count;
}

/**
 * Replace what `find` loosely means in `content`.
 *
 * `find` and `replacement` should already use the file's line endings; the
 * file itself is never re-ended, so a mixed file keeps every line it had.
 * Returns { text, index, count, how } on success, { ambiguous: true } when the
 * first matcher to find anything finds it in more than one place,
 * { wide: true } when the match is far bigger than `find`, and null when
 * nothing matched at all. With `all`, every copy of the matched span changes.
 *
 * Unlike opencode, a matcher that finds two places is the end of it: a looser
 * matcher further down picking one of them would be a guess.
 */
export function fuzzyReplace(content, find, replacement, { all = false } = {}) {
  if (!find || content.length > MAX_CHARS || find.length > MAX_CHARS) return null;
  if (content.split('\n', MAX_LINES + 1).length > MAX_LINES) return null;
  for (const matcher of MATCHERS) {
    // Spans built from whole lines of a \r\n file end on the last line's \r.
    // That \r belongs to the line break after the match, which stays.
    const own = (m) => (m.endsWith('\r') && !find.endsWith('\r') ? m.slice(0, -1) : m);
    const hits = [...new Set([...matcher(content, find)].map(own))].filter((m) => m && content.includes(m));
    if (!hits.length) continue;

    const pick = hits[0];
    if (tooWide(pick, find)) return { wide: true };
    const text = matcher.adapt ? matcher.adapt(replacement, find) : replacement;
    const index = content.indexOf(pick);
    if (all) {
      const copies = content.split(pick);
      return { text: copies.join(text), index, count: copies.length - 1, how: matcher.how };
    }

    const spans = [];
    for (const m of hits) {
      for (let i = content.indexOf(m); i !== -1; i = content.indexOf(m, i + 1)) spans.push([i, i + m.length]);
    }
    if (places(spans) > 1) return { ambiguous: true };
    return { text: content.slice(0, index) + text + content.slice(index + pick.length), index, count: 1, how: matcher.how };
  }
  return null;
}
