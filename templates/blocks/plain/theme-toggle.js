/**
 * Light and dark, remembered, and right on the first paint.
 *
 * Two things a hand-written toggle misses: it ignores the setting the
 * operating system already has, so a daylight user gets a dark page and has
 * to fix it every visit; and it applies the saved choice after the stylesheet
 * has painted, so the page flashes the wrong colours on every load.
 *
 *   import { ThemeToggle, applyTheme } from './blocks/theme-toggle.js';
 *
 *   applyTheme();                                  // first line of app.js
 *   header.append(ThemeToggle().el);
 *
 * The starter's stylesheet is the dark one. This adds the light values as an
 * override on [data-theme="light"], so nothing already written has to change.
 */

const CSS = `
:root[data-theme="light"] {
  --bg: #f7f8fa;
  --surface: #ffffff;
  --line: #e3e6ec;
  --text: #171a1f;
  --muted: #626a78;
  --accent: #0d9488;
  --accent-ink: #ffffff;
  --bad: #c2405a;
  --bad-ink: #ffffff;
}
.tg {
  display: inline-grid; place-items: center;
  width: 40px; height: 40px;
  font-size: 16px; line-height: 1;
  color: var(--muted, #8b93a3); background: var(--surface, #14171c);
  border: 1px solid var(--line, #232830); border-radius: 999px; cursor: pointer;
  transition: color var(--fast, 160ms), border-color var(--fast, 160ms);
}
.tg:hover { color: var(--text, #e7eaf0); border-color: var(--accent, #2dd4bf); }
.tg:focus-visible { outline: 2px solid var(--accent, #2dd4bf); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .tg { transition: none; } }
`;

const KEY = 'theme';

let styled = false;
function styles() {
  if (styled) return;
  styled = true;
  document.head.append(Object.assign(document.createElement('style'), { textContent: CSS }));
}

const saved = () => {
  try { return localStorage.getItem(KEY); } catch { return null; }
};

const systemPrefersLight = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;

/** What the page should be showing right now. */
export function currentTheme() {
  return saved() ?? (systemPrefersLight() ? 'light' : 'dark');
}

/**
 * Put the theme on <html>. Call this once, as early as possible — before the
 * first render, not after it.
 */
export function applyTheme(theme = currentTheme()) {
  styles();
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  return theme;
}

export function ThemeToggle({ onChange = () => {} } = {}) {
  styles();
  let theme = applyTheme();

  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'tg';

  // Drawn rather than typed: a moon from the dingbat block is a different
  // shape in every font, and missing altogether in some.
  const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>';
  const MOON = '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>';

  function paint() {
    el.innerHTML =
      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
      `stroke-width="1.7" stroke-linecap="round" aria-hidden="true">${theme === 'light' ? SUN : MOON}</svg>`;
    el.setAttribute('aria-label', theme === 'light' ? 'Switch to dark' : 'Switch to light');
    el.setAttribute('aria-pressed', String(theme === 'dark'));
  }

  el.addEventListener('click', () => {
    theme = theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, theme); } catch { /* private mode: this visit only */ }
    applyTheme(theme);
    paint();
    onChange(theme);
  });

  // Someone who has never chosen follows the system, including when it
  // changes at sunset while the page is open.
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
      if (saved()) return;
      theme = applyTheme(currentTheme());
      paint();
    });
  }

  paint();
  return { el, get theme() { return theme; } };
}
