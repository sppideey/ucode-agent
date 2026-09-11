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
import path from 'node:path';
import { ToolFailure } from '../core/failure.js';
import { ask } from '../core/provider.js';
import { getRoot, result } from './shared.js';

const VISION_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free';
const WIDTHS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'desktop', width: 1440, height: 900 },
];
const LOCAL = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i;

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
        'and one at desktop width. List the concrete visual problems a user would notice, most ' +
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
  const reply = await ask(request, [], { model: VISION_MODEL, temperature: 0.2, maxOutputTokens: 900 });
  return reply.text.trim();
}

export async function lookAtApp({ url, paths = ['/'], review: wantReview = true }) {
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
  const sections = [];
  const toReview = [];
  let problems = 0;

  for (const pagePath of pages) {
    for (const size of WIDTHS) {
      const context = await b.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const errors = [];
      const failed = [];
      page.on('console', (m) => {
        if (m.type() === 'error' && !/devtools|download the react/i.test(m.text())) errors.push(m.text().slice(0, 200));
      });
      page.on('pageerror', (e) => errors.push(`uncaught: ${String(e.message).slice(0, 200)}`));
      page.on('requestfailed', (r) => failed.push(`${r.method()} ${r.url().slice(0, 100)} — ${r.failure()?.errorText ?? 'failed'}`));
      page.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 100)}`); });

      const target = `${base}${pagePath}`;
      let loadError = null;
      try {
        // A dev server compiles a page on its first request, which can take a
        // while; networkidle then waits for the page's own data to arrive.
        await page.goto(target, { waitUntil: 'networkidle', timeout: 60_000 });
      } catch (err) {
        try { await page.goto(target, { waitUntil: 'load', timeout: 30_000 }); }
        catch (err2) { loadError = String(err2.message).split('\n')[0]; }
      }
      await page.waitForTimeout(600); // let entrance animations settle

      const file = path.join(shotsDir, `${safeName(pagePath)}-${size.name}.jpg`);
      let facts = null;
      if (!loadError) {
        facts = await page.evaluate(inspect).catch((err) => ({ error: err.message }));
        const buffer = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false });
        await fs.writeFile(file, buffer);
        toReview.push({ label: `${pagePath} at ${size.width}px (${size.name})`, dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}` });
      }
      await context.close();

      const lines = [`### ${pagePath} at ${size.width}px (${size.name})`];
      if (loadError) {
        lines.push(`Could not load: ${loadError}`);
        problems++;
      } else {
        lines.push(`Screenshot: ${path.relative(getRoot(), file).split(path.sep).join('/')}`);
        if (facts?.empty) { lines.push('- The page rendered no visible text at all.'); problems++; }
        if (facts?.overflow) {
          lines.push(`- Content is ${facts.overflow}px wider than the screen, so it scrolls sideways:`, ...facts.wide.map((w) => `  - ${w}`));
          problems++;
        }
        if (facts?.broken?.length) { lines.push(`- Broken images: ${facts.broken.join(', ')}`); problems++; }
        if (facts?.unnamed?.length) { lines.push(`- Buttons or links with no accessible name: ${facts.unnamed.join(', ')}`); problems++; }
        if (facts?.inputsNoLabel) { lines.push(`- ${facts.inputsNoLabel} form field(s) without a label.`); problems++; }
        if (facts?.noAlt) lines.push(`- ${facts.noAlt} image(s) without alt text.`);
        if (facts?.tiny) lines.push(`- ${facts.tiny} tap target(s) smaller than 32px on a phone.`);
        if (facts?.smallText) lines.push(`- ${facts.smallText} text element(s) under 12px.`);
      }
      if (errors.length) { lines.push('- Console errors:', ...[...new Set(errors)].slice(0, 6).map((e) => `  - ${e}`)); problems++; }
      if (failed.length) { lines.push('- Failed requests:', ...[...new Set(failed)].slice(0, 6).map((f) => `  - ${f}`)); problems++; }
      if (lines.length === 2 && !loadError) lines.push('- No errors, no overflow, nothing unlabeled.');
      sections.push(lines.join('\n'));
    }
  }

  let critique = '';
  if (wantReview !== false && toReview.length) {
    try {
      critique = await review(toReview.slice(0, 4));
    } catch (err) {
      critique = `(The visual review could not run: ${err.failed ?? err.message}. The checks above still apply.)`;
    }
  }

  const body = [
    ...sections,
    critique ? `## Visual review\n${critique}` : '',
    '',
    problems
      ? 'Fix the problems above, then look again to confirm.'
      : 'The automatic checks found nothing. Weigh the visual review, fix what is worth fixing.',
  ].filter(Boolean).join('\n\n');

  return result(
    body,
    problems
      ? `${problems} problem${problems === 1 ? '' : 's'} found · screenshots in .ucode/screenshots`
      : 'no errors · screenshots in .ucode/screenshots'
  );
}
