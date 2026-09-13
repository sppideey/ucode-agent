/**
 * A row of filters — All / Active / Done — that works from the keyboard.
 *
 * Written by hand it usually becomes three divs with a click handler and no
 * way to reach it by tab. These are real buttons in a labelled group, with
 * arrow keys moving between them and one tab stop for the whole row.
 *
 *   import { FilterBar } from './blocks/filter-bar.js';
 *
 *   const filters = FilterBar({
 *     options: [
 *       { value: 'all', label: 'All' },
 *       { value: 'active', label: 'Active' },
 *       { value: 'done', label: 'Done' },
 *     ],
 *     value: 'all',
 *     onChange: (value) => { state.filter = value; render(); },
 *   });
 *   document.querySelector('#app').append(filters.el);
 */

const CSS = `
.fb {
  display: inline-flex; gap: 2px; padding: 4px;
  background: var(--surface, #14171c);
  border: 1px solid var(--line, #232830); border-radius: 999px;
}
.fb button {
  padding: 8px var(--s3, 16px); min-height: 36px;
  font: inherit; color: var(--muted, #8b93a3);
  background: none; border: 0; border-radius: 999px; cursor: pointer;
  transition: color var(--fast, 160ms), background var(--fast, 160ms);
}
.fb button:hover { color: var(--text, #e7eaf0); }
.fb button[aria-pressed="true"] {
  color: var(--accent-ink, #04110f); background: var(--accent, #2dd4bf);
}
.fb button:focus-visible { outline: 2px solid var(--accent, #2dd4bf); outline-offset: 2px; }
.fb-count { margin-left: 6px; opacity: .7; font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) { .fb button { transition: none; } }
`;

let styled = false;
function styles() {
  if (styled) return;
  styled = true;
  document.head.append(Object.assign(document.createElement('style'), { textContent: CSS }));
}

export function FilterBar({
  options = [],
  value = options[0]?.value,
  onChange = () => {},
  label = 'Filter',
} = {}) {
  styles();

  let current = value;

  const el = document.createElement('div');
  el.className = 'fb';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', label);

  const buttons = options.map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.value = option.value;
    button.textContent = option.label;

    if (option.count !== undefined) {
      const count = document.createElement('span');
      count.className = 'fb-count';
      count.textContent = String(option.count);
      button.append(count);
    }

    button.addEventListener('click', () => pick(option.value));
    el.append(button);
    return button;
  });

  // One tab stop for the row, arrows to move inside it: the pattern a
  // keyboard user expects from a group of related choices.
  el.addEventListener('keydown', (event) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const step = keys[event.key];
    if (!step) return;
    event.preventDefault();
    const at = buttons.findIndex((b) => b.dataset.value === current);
    const next = buttons[(at + step + buttons.length) % buttons.length];
    pick(next.dataset.value);
    next.focus();
  });

  function paint() {
    for (const button of buttons) {
      const on = button.dataset.value === current;
      button.setAttribute('aria-pressed', String(on));
      button.tabIndex = on ? 0 : -1;
    }
  }

  function pick(next) {
    if (next === current) return;
    current = next;
    paint();
    onChange(current);
  }

  paint();

  return {
    el,
    get value() { return current; },
    /** Move the selection without calling onChange — for state set elsewhere. */
    setValue(next) { current = next; paint(); },
    /** Update the numbers beside the labels. */
    setCounts(counts = {}) {
      for (const button of buttons) {
        const count = counts[button.dataset.value];
        let span = button.querySelector('.fb-count');
        if (count === undefined) { span?.remove(); continue; }
        if (!span) {
          span = document.createElement('span');
          span.className = 'fb-count';
          button.append(span);
        }
        span.textContent = String(count);
      }
    },
  };
}
