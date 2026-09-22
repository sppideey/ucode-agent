/**
 * browser.js — looking at the app the way a person would.
 *
 * A build that passes and a page that works are different claims. This opens
 * the running app in a real browser at a phone width and a desktop width, and
 * reports what a person would run into: errors in the console, requests that
 * failed, a layout that spills off the side of a phone, broken images,
 * controls with no name. It saves a screenshot of each, and has the one model
 * in the set that can see — Nemotron Nano Omni — review them as a designer
 * would. The model building the app then has something concrete to fix.
 *
 * It drives the browser already on the machine (Edge or Chrome) through
 * playwright-core, so there is no separate 150 MB browser download.
 */

import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import { ToolFailure } from '../core/failure.js';
import { ask } from '../core/provider.js';
import { getRoot, result } from './shared.js';

const VISION_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
const WIDTHS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'desktop', width: 1440, height: 900 },
];
const LOCAL = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i;
const MAX_SHOT_HEIGHT = 3000;

let browserPromise = null;

/**
 * One browser for the whole session, started on first use. The installed
 * Edge or Chrome is tried first; Playwright's own Chromium only if it happens
 * to be installed.
 */
async function browser() {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    let chromium;
    try {
      ({ chromium } = await import('playwright-core'));
    } catch (err) {
      throw new ToolFailure({
        kind: 'no_playwright',
        attempted: 'starting a browser',
        failed: `playwright-core could not be loaded: ${err.message}`,
        fix: 'Reinstall ucode (npm install -g ucode-agent). Carry on without looking at the app, and say so.',
      });
    }
    const tried = [];
    for (const channel of ['msedge', 'chrome', undefined]) {
      try {
        return await chromium.launch({ channel, headless: true });
      } catch (err) {
        tried.push(`${channel ?? 'bundled chromium'}: ${String(err.message).split('\n')[0]}`);
      }
    }
    throw new ToolFailure({
      kind: 'no_browser',
      attempted: 'starting a browser',
      failed: `No browser could be started. Tried ${tried.join('; ')}.`,
      fix: 'Install Google Chrome or Microsoft Edge. Carry on without looking at the app, and say so.',
    });
  })();
  browserPromise.catch(() => { browserPromise = null; });
  return browserPromise;
}

/** Close the shared browser, if one was started. Called when ucode exits. */
export async function closeBrowser() {
  if (!browserPromise) return;
  try { await (await browserPromise).close(); } catch { /* already gone */ }
  browserPromise = null;
}

/** Layout and accessibility checks run inside the page. */
function inspect() {
  const vw = window.innerWidth;
  const describeEl = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const text = (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `<${el.tagName.toLowerCase()}${id}${cls}>${text ? ` "${text}"` : ''}`;
  };

  const overflow = document.documentElement.scrollWidth - vw;
  const wide = [];
  if (overflow > 1) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1 && getComputedStyle(el).position !== 'fixed') {
        wide.push(`${describeEl(el)} reaches ${Math.round(r.right)}px`);
        if (wide.length >= 5) break;
      }
    }
  }

  const broken = [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src.slice(0, 80));
  const noAlt = [...document.images].filter((i) => !i.hasAttribute('alt')).length;
  const unnamed = [...document.querySelectorAll('button, a[href], [role="button"]')]
    .filter((el) => !(el.innerText || '').trim() && !el.getAttribute('aria-label') && !el.getAttribute('title')
      && !el.querySelector('[aria-label], title, img[alt]:not([alt=""])'))
    .slice(0, 5).map(describeEl);
  const inputsNoLabel = [...document.querySelectorAll('input:not([type="hidden"]), textarea, select')]
    .filter((el) => !(el.id && document.querySelector(`label[for="${el.id}"]`)) && !el.closest('label')
      && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
    .length;
  const tiny = vw < 600
    ? [...document.querySelectorAll('button, a[href], [role="button"], input, select')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.height < 32 || r.width < 32); })
        .length
    : 0;
  const smallText = [...document.querySelectorAll('p, li, span, a, button, label, td')]
    .filter((el) => el.childElementCount === 0 && (el.innerText || '').trim() && parseFloat(getComputedStyle(el).fontSize) < 12)
    .length;

  return {
    title: document.title,
    overflow: overflow > 1 ? Math.round(overflow) : 0,
    wide, broken, noAlt, unnamed, inputsNoLabel, tiny, smallText,
    empty: !(document.body.innerText || '').trim(),
  };
}

const safeName = (p) => (p === '/' ? 'home' : p.replace(/^\/+|\/+$/g, '').replace(/[^\w-]+/g, '_')) || 'page';

async function review(shots) {
  const request = [
    {
      role: 'system',
      content:
        'You are a senior product designer reviewing screenshots of a web app, one at a phone width ' +
        'and one at desktop width. Each screenshot is the whole page, top to bottom, so anything not ' +
        'in it is genuinely not there. List the concrete visual problems a user would notice, most ' +
        'important first: broken or cramped layout, overflow, misalignment, weak hierarchy (is the ' +
        'most important thing the most prominent?), inconsistent spacing, low contrast, default-looking ' +
        'components, awkward empty states, text that is too small. For each: where it is, what is wrong, ' +
        'and the specific fix. At most 8 points, one or two lines each. If it genuinely looks polished, ' +
        'say so in one line and name the one thing that would improve it most. No preamble.',
    },
    {
      role: 'user',
      content: shots.map((s) => `${s.label}`).join(' and ') + '.',
      images: shots.map((s) => s.dataUrl),
    },
  ];
  const reply = await ask(request, [], {
    model: VISION_MODEL,
    temperature: 0.2,
    // A reasoning model spends its budget thinking before it writes; 900
    // tokens came back as an empty review. Keep the thinking short, and leave
    // room for the answer.
    maxOutputTokens: 4000,
    reasoning: { effort: 'low' },
    // The free vision model is often busy. One try, and a hard cap: a review
    // that cannot run is skipped, never waited on.
    attempts: 1,
    signal: AbortSignal.timeout(REVIEW_BUDGET_MS),
  });
  const text = reply.text.trim();
  if (!text) throw new Error('the vision model returned an empty review');
  return text;
}

const REVIEW_BUDGET_MS = 60_000;

/**
 * The designer's review is the slow part — a reasoning model looking at
 * screenshots, most of a minute — so each app gets one per turn: a look after
 * the fixes only re-runs the fast checks. A review that failed (busy model,
 * empty reply) gets one more try on the next look, then is let go.
 */
const reviews = new Map(); // base URL -> { done, tries }

/** A new request from the user: the apps may be reviewed afresh. */
export function forgetReviews() {
  reviews.clear();
}


/**
 * Text typed into the app while checking it. Distinctive enough to recognise
 * in a screenshot, and obviously not something a user wrote.
 */
const PROBE_TEXT = 'ucode check';

/** Did anything at all happen on the page? */
// The markup itself, not its length: a timer going 25:00 -> 24:59, a counter
// going 0 -> 1 or a task ticked off by a class change keeps every length the
// same, and was reported as "NOTHING HAPPENS" — a false accusation the model
// then "fixed" by rewriting script that worked.
const moved = (a, b) => a.nodes !== b.nodes || a.html !== b.html || a.stored !== b.stored;

/**
 * Use the app, rather than only looking at it.
 *
 * Everything else here is an inspection: overflow, labels, broken images,
 * console errors on load. All of it passes on an app whose Add button does
 * nothing, because a page with dead JavaScript still renders, still has good
 * contrast and still has no console errors — it simply does not work. Nothing
 * in the harness ever pressed anything, so the model was never told, and never
 * fixed it.
 *
 * So: type into the first text field, press Enter, and if that changed nothing,
 * click the first button. Then look at whether the page has more nodes, more
 * text, or more in localStorage than it did. Any of those moving means the core
 * loop is wired up. None of them moving, on a page that has controls to press,
 * means it is not.
 *
 * Real keyboard and mouse input through the driver, never synthetic DOM events:
 * an implicit form submit does not fire for a dispatched event, which would
 * report a working form as dead.
 *
 * A page with nothing to press — a landing page, a chart, a page of prose — is
 * not exercised and not judged. Returning null there is the difference between
 * a check and a false accusation.
 */
async function useTheApp(page) {
  const snapshot = () => page.evaluate(() => ({
    nodes: document.body.querySelectorAll('*').length,
    text: document.body.innerText.replace(/\s+/g, ' ').trim().length,
    html: document.body.innerHTML,
    stored: (() => { try { return JSON.stringify(localStorage).length; } catch { return 0; } })(),
  }));

  const before = await snapshot().catch(() => null);
  if (!before) return null;
  const tried = [];

  // A field and the Enter key: the core loop of most one-page apps.
  const field = page.locator('input[type="text"], input[type="search"], input:not([type]), textarea').first();
  if (await field.count().catch(() => 0)) {
    const ok = await field.fill(PROBE_TEXT, { timeout: 2_000 }).then(() => true).catch(() => false);
    if (ok) {
      await field.press('Enter', { timeout: 2_000 }).catch(() => {});
      await page.waitForTimeout(300);
      tried.push('typed into the first field and pressed Enter');
    }
  }

  let after = await snapshot().catch(() => before);
  if (tried.length && moved(before, after)) return { tried, worked: true };

  // Nothing moved, so try the other half of the same pattern — the button that
  // submits, before any other. Taking simply the first button in the document
  // finds the theme toggle in the header, clicks it, and reports a working app
  // as dead because switching to dark mode adds no elements.
  const candidates = [
    page.locator('form button[type="submit"], form input[type="submit"], button[type="submit"], input[type="submit"]'),
    page.locator('form button:not([disabled])'),
    page.locator('button:not([disabled]), [role="button"]'),
  ];

  const pressed = new Set();
  for (const group of candidates) {
    const count = Math.min(await group.count().catch(() => 0), 3);
    for (let i = 0; i < count; i++) {
      const button = group.nth(i);
      const label = (await button.innerText().catch(() => '') || '').trim().replace(/\s+/g, ' ').slice(0, 24);
      if (pressed.has(label || `#${i}`)) continue;
      pressed.add(label || `#${i}`);

      const ok = await button.click({ timeout: 2_000 }).then(() => true).catch(() => false);
      if (!ok) continue;
      await page.waitForTimeout(300);
      tried.push(`clicked ${label ? `"${label}"` : 'a button'}`);

      after = await snapshot().catch(() => after);
      if (moved(before, after)) return { tried, worked: true };
    }
  }

  if (!tried.length) return null;
  if (!moved(before, after)) return { tried, worked: false };

  // It worked. Did any of it last?
  //
  // An app that writes to localStorage and never reads it back looks perfect
  // for as long as you stay on the page, and loses everything the moment
  // anyone refreshes. Only asked when the app actually stored something —
  // otherwise no persistence was intended, and reporting its absence would be
  // inventing a requirement nobody asked for.
  if (after.stored > before.stored) {
    try {
      await page.reload({ waitUntil: 'load', timeout: 20_000 });
      await page.waitForTimeout(400);
      const reloaded = await snapshot();
      if (reloaded.text <= before.text) return { tried, worked: true, lost: true };
    } catch { /* a reload that will not happen is not evidence of anything */ }
  }

  return { tried, worked: true };
}

/**
 * Serve a folder over http just long enough to look at it.
 *
 * The default starter has no dev server — three files that open straight from
 * disk — so there was nothing for the checker to point at, and the most
 * thorough thing ucode runs could not run on the apps it makes most often. A
 * static server on an ephemeral port costs nothing and closes again the
 * moment the look is done.
 */
export async function withStaticServer(dir, fn) {
  const http = await import('node:http');
  const root = path.resolve(dir);
  const types = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  };

  const server = http.createServer((req, res) => {
    const rel = (req.url === '/' ? '/index.html' : req.url).split('?')[0];
    const file = path.join(root, decodeURIComponent(rel));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fsSync.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] ?? 'text/plain' });
      res.end(buf);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

export async function lookAtApp({ url, paths = ['/'], review: withReview = true }) {
  const base = String(url ?? '').trim().replace(/\/+$/, '');
  if (!LOCAL.test(`${base}/`)) {
    throw new ToolFailure({
      kind: 'bad_args',
      attempted: 'looking at the app',
      failed: `"${url}" is not a local address. This only opens apps running on this machine.`,
      fix: 'Pass the URL the dev server reported, e.g. http://localhost:3000',
    });
  }

  const pages = (Array.isArray(paths) && paths.length ? paths : ['/'])
    .map((p) => `/${String(p).trim().replace(/^\/+/, '')}`)
    .slice(0, 4);

  const shotsDir = path.join(getRoot(), '.ucode', 'screenshots');
  await fs.mkdir(shotsDir, { recursive: true });

  const b = await browser();

  // Every page at every width opens at once, each in its own context: the
  // wait is for the slowest one, not the sum of them all.
  const checks = await Promise.all(pages.flatMap((pagePath) => WIDTHS.map(async (size) => {
    let shot = null;
    const context = await b.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    const failed = [];
    page.on('console', (m) => {
      // The browser asks for /favicon.ico on its own. A page without one is
      // not broken, and counting that 404 sent every plain-html build round
      // a fix loop it did not need.
      if (/\/favicon\.ico$/i.test(m.location()?.url ?? '')) return;
      if (m.type() === 'error' && !/devtools|download the react/i.test(m.text())) errors.push(m.text().slice(0, 200));
    });
    page.on('pageerror', (e) => errors.push(`uncaught: ${String(e.message).slice(0, 200)}`));
    page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url().slice(0, 100)} — ${r.failure()?.errorText ?? 'failed'}`));
    page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 100)}`); });

    const target = `${base}${pagePath}`;
    let loadError = null;
    let used = null;
    try {
      // 'load', not 'networkidle': a dev server holds a hot-reload
      // connection open and polls, so the network may never go quiet and
      // 'networkidle' would wait out its whole timeout on every page, at
      // every width. 'load' covers the first-request compile; the page's own
      // data then gets a short, bounded chance to settle.
      await page.goto(target, { waitUntil: 'load', timeout: 90_000 });
      await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => {});
    } catch (err) {
      loadError = String(err.message).split('\n')[0];
    }
    await page.waitForTimeout(400); // let entrance animations settle

    const file = path.join(shotsDir, `${safeName(pagePath)}-${size.name}.jpg`);
    let facts = null;
    try {
      if (!loadError) {
        facts = await page.evaluate(inspect).catch((err) => ({ error: err.message }));
        // The whole page, so the reviewer never reports as missing what is
        // only below the fold — capped, so an endless feed stays one image.
        const tall = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
        const buffer = await page.screenshot({
          type: 'jpeg',
          quality: 70,
          fullPage: true,
          ...(tall > MAX_SHOT_HEIGHT ? { clip: { x: 0, y: 0, width: size.width, height: MAX_SHOT_HEIGHT } } : {}),
        });
        await fs.writeFile(file, buffer);
        shot = { label: `${pagePath} at ${size.width}px (${size.name})`, dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}` };

        // Once per look, not once per width: pressing the same button four
        // times says nothing the first press did not, and costs four seconds.
        if (size.name === 'desktop' && pagePath === pages[0]) {
          used = await useTheApp(page).catch(() => null);
        }
      }
    } catch (err) {
      loadError = `the page broke while being checked: ${String(err.message).split('\n')[0]}`;
    } finally {
      await context.close().catch(() => {});
    }

    const rel = loadError ? null : path.relative(getRoot(), file).split(path.sep).join('/');
    return { pagePath, size, facts, errors, failed, loadError, shot, used, rel };
  })));

  // One section per page, not one per page and width.
  //
  // Almost everything these checks find is a fact about the page and comes
  // back identical at every width: an image that is broken at 375px is broken
  // at 1440px, a console error fires in both, an unlabelled field is
  // unlabelled twice. Printed per width, every one of those lines appeared
  // twice over — and counted twice, so one broken image read as two problems
  // and a clean page still produced two near-identical paragraphs to read.
  //
  // What genuinely changes with the viewport is the layout: overflow, tap
  // targets, type size. Only those are still named by width.
  const uniq = (xs) => [...new Set(xs)];
  const sections = [];
  const toReview = [];
  let problems = 0;
  let broken = false;

  for (const pagePath of pages) {
    const shots = checks.filter((c) => c.pagePath === pagePath);
    const lines = [`### ${pagePath}`];
    const loaded = shots.filter((s) => !s.loadError);

    if (!loaded.length) {
      lines.push(`Could not load: ${shots[0]?.loadError ?? 'no response'}`);
      problems++;
      broken = true;
      sections.push(lines.join('\n'));
      continue;
    }

    // The desktop render is where the page-wide facts are read from, and the
    // only one the core loop was exercised on.
    const main = loaded.find((s) => s.size.name === 'desktop') ?? loaded[0];
    const facts = main.facts ?? {};
    const errors = uniq(loaded.flatMap((s) => s.errors));
    const failed = uniq(loaded.flatMap((s) => s.failed));
    const used = loaded.find((s) => s.used)?.used ?? null;

    lines.push(`Screenshots: ${loaded.map((s) => `${s.rel} (${s.size.name})`).join(', ')}`);
    for (const s of loaded) if (s.shot) toReview.push(s.shot);

    if (facts.empty) { lines.push('- The page rendered no visible text at all.'); problems++; }
    if (facts.broken?.length) { lines.push(`- Broken images: ${facts.broken.join(', ')}`); problems++; }
    if (facts.unnamed?.length) { lines.push(`- Buttons or links with no accessible name: ${facts.unnamed.join(', ')}`); problems++; }
    if (facts.inputsNoLabel) { lines.push(`- ${facts.inputsNoLabel} form field(s) without a label.`); problems++; }
    if (facts.noAlt) lines.push(`- ${facts.noAlt} image(s) without alt text.`);

    // A width that failed on its own — the phone render timed out, the desktop
    // one came back — is still a failure, and grouping by page must not let it
    // disappear behind the width that worked.
    for (const s of shots.filter((c) => c.loadError)) {
      lines.push(`- At ${s.size.width}px (${s.size.name}) it could not load: ${s.loadError}`);
      problems++;
      broken = true;
    }

    for (const s of loaded) {
      const f = s.facts ?? {};
      const at = `At ${s.size.width}px (${s.size.name})`;
      if (f.overflow) {
        lines.push(`- ${at}: content is ${f.overflow}px wider than the screen, so it scrolls sideways:`,
          ...f.wide.map((w) => `  - ${w}`));
        problems++;
      }
      if (f.tiny) lines.push(`- ${at}: ${f.tiny} tap target(s) smaller than 32px.`);
      if (f.smallText) lines.push(`- ${at}: ${f.smallText} text element(s) under 12px.`);
    }

    if (used && !used.worked) {
      lines.push(
        `- NOTHING HAPPENS WHEN YOU USE IT. I ${used.tried.join(', then ')} — and the page`,
        '  gained no elements, changed no text and stored nothing. The markup and the styling',
        '  are there; the behaviour is not wired to them. Find the listener that was never',
        '  attached, or the handler that throws before it does anything, and fix that first:',
        '  everything else on this page is decoration until it works.',
      );
      problems++;
    } else if (used?.lost) {
      lines.push(
        `- It works until you refresh. I ${used.tried.join(', then ')}, the page`,
        '  responded, and it wrote to localStorage — but after a reload it was back to',
        '  empty. Something is being saved and never read back at start-up. Load the',
        '  stored state when the page boots, and check it survives a refresh.',
      );
      problems++;
    } else if (used) {
      lines.push(`- Core loop works: I ${used.tried.join(', then ')}, the page responded, and it survived a reload.`);
    }

    if (errors.length) { lines.push('- Console errors:', ...errors.slice(0, 6).map((e) => `  - ${e}`)); problems++; }
    if (failed.length) { lines.push('- Failed requests:', ...failed.slice(0, 6).map((f) => `  - ${f}`)); problems++; }
    if (lines.length === 2) lines.push('- No errors, no overflow, nothing unlabeled.');

    // A dead core loop counts as broken: a screenshot of an app that does not
    // work is not worth a paragraph on its typography.
    if (errors.length || facts.empty || (used && !used.worked)) broken = true;
    sections.push(lines.join('\n'));
  }

  // A page that crashed or threw is fixed first; reviewing a screenshot of an
  // error overlay is a minute spent on nothing.
  let critique = '';
  const state = reviews.get(base) ?? { done: false, tries: 0 };
  if (withReview && !broken && !state.done && state.tries < 2 && toReview.length) {
    state.tries++;
    reviews.set(base, state);
    try {
      critique = await review(toReview.slice(0, 4));
      state.done = true;
    } catch (err) {
      const why = String(err.failed ?? err.message).replace(/[.\s]+$/, '');
      critique = `(The visual review could not run: ${why}. The checks above still apply.)`;
    }
  }

  const body = [
    ...sections,
    critique ? `## Visual review\n${critique}` : '',
    '',
    problems
      ? 'Fix the problems above - only those; leave everything that works as it is.'
      : state.done && critique
        ? 'The automatic checks found nothing. Weigh the visual review, fix what is worth fixing - ' +
          'the next look re-runs only the fast checks.'
        : 'The automatic checks found nothing.',
  ].filter(Boolean).join('\n\n');

  return result(
    body,
    problems
      ? `${problems} problem${problems === 1 ? '' : 's'} found · screenshots in .ucode/screenshots`
      : 'no errors · screenshots in .ucode/screenshots'
  );
}
