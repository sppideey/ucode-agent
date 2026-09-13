/**
 * A short message that appears, is read out, and goes away.
 *
 * The version everyone writes is a div that fades in and is invisible to a
 * screen reader, so the one confirmation the app gives is the one thing a
 * blind user never hears. This one lives in a polite live region, stacks,
 * caps itself so a loop cannot bury the page, and holds still if the reader
 * has asked for less motion.
 *
 *   import { toast } from './blocks/toast.js';
 *
 *   toast('Saved');
 *   toast.error('Could not reach the server');
 *   toast('Deleted', { action: { label: 'Undo', onClick: undo } });
 */

const CSS = `
.tw {
  position: fixed; inset: auto 0 0 0; z-index: 60;
  display: flex; flex-direction: column-reverse; align-items: center; gap: var(--s1, 8px);
  padding: var(--s3, 16px); pointer-events: none;
}
.tt {
  display: flex; align-items: center; gap: var(--s2, 12px);
  max-width: min(420px, calc(100vw - 32px));
  padding: 12px var(--s3, 16px);
  color: var(--text, #e7eaf0); background: var(--surface, #14171c);
  border: 1px solid var(--line, #232830); border-radius: var(--r, 16px);
  box-shadow: 0 12px 32px rgb(0 0 0 / .45);
  pointer-events: auto;
  animation: tt-in 180ms cubic-bezier(.2,0,.2,1);
}
.tt[data-tone="error"] { border-color: var(--bad, #ff8b95); }
.tt[data-tone="error"] .tt-dot { background: var(--bad, #ff8b95); }
.tt-dot { width: 8px; height: 8px; flex: none; border-radius: 999px; background: var(--accent, #2dd4bf); }
.tt-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.tt-action {
  flex: none; padding: 4px 10px;
  font: 500 inherit; color: var(--accent, #2dd4bf);
  background: none; border: 1px solid var(--line, #232830); border-radius: 999px; cursor: pointer;
}
.tt-action:hover { background: var(--bg, #0b0d10); }
.tt-action:focus-visible { outline: 2px solid var(--accent, #2dd4bf); outline-offset: 2px; }
@keyframes tt-in { from { opacity: 0; transform: translateY(8px); } }
@media (prefers-reduced-motion: reduce) { .tt { animation: none; } }
`;

const MAX = 3;
const LIFE = 4000;

let wrap = null;

function region() {
  if (wrap) return wrap;
  document.head.append(Object.assign(document.createElement('style'), { textContent: CSS }));
  wrap = document.createElement('div');
  wrap.className = 'tw';
  // polite, not assertive: a confirmation should wait its turn rather than
  // interrupt whatever the reader is in the middle of.
  wrap.setAttribute('role', 'status');
  wrap.setAttribute('aria-live', 'polite');
  document.body.append(wrap);
  return wrap;
}

function show(text, { tone = 'default', action = null, duration = LIFE } = {}) {
  const host = region();

  const el = document.createElement('div');
  el.className = 'tt';
  el.dataset.tone = tone;

  const dot = document.createElement('span');
  dot.className = 'tt-dot';

  const label = document.createElement('span');
  label.className = 'tt-text';
  label.textContent = text;

  el.append(dot, label);

  let timer = null;
  const dismiss = () => { clearTimeout(timer); el.remove(); };

  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tt-action';
    button.textContent = action.label;
    button.addEventListener('click', () => { dismiss(); action.onClick?.(); });
    el.append(button);
  }

  host.append(el);
  while (host.children.length > MAX) host.firstElementChild.remove();

  // A toast the pointer is resting on is a toast being read.
  el.addEventListener('pointerenter', () => clearTimeout(timer));
  el.addEventListener('pointerleave', () => { timer = setTimeout(dismiss, 1200); });
  timer = setTimeout(dismiss, duration);

  return dismiss;
}

export const toast = Object.assign(show, {
  error: (text, options = {}) => show(text, { ...options, tone: 'error', duration: options.duration ?? 6000 }),
});
