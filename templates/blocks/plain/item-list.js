/**
 * A list of things you can add, tick off, rename and remove.
 *
 * The part of a one-page app that is written from scratch most often and
 * finished least often: no empty state, no keyboard, no way to fix a typo,
 * and a delete button that is a bare × with nothing to announce it. This one
 * has all of that, and it is an ordinary file now — edit it to suit the app.
 *
 *   import { ItemList } from './blocks/item-list.js';
 *
 *   const list = ItemList({
 *     items: store.state.items,
 *     onChange: (items) => store.set({ items }),
 *     placeholder: 'Add a task',
 *     empty: { title: 'Nothing here yet', description: 'Add the first one above.' },
 *   });
 *   document.querySelector('#app').append(list.el);
 *
 * Items are `{ id, text, done }`. `onChange` gets the whole array back after
 * every change, so the state lives in one place and this only draws it.
 */

const CSS = `
.il { display: flex; flex-direction: column; gap: var(--s3, 16px); }
.il-add { display: flex; gap: var(--s1, 8px); }
.il-add input {
  flex: 1; min-width: 0;
  padding: 12px var(--s2, 12px);
  font: inherit; color: var(--text, #e7eaf0);
  background: var(--surface, #14171c);
  border: 1px solid var(--line, #232830); border-radius: var(--r, 16px);
}
.il-add input::placeholder { color: var(--muted, #8b93a3); }
.il-add input:focus-visible, .il button:focus-visible, .il input:focus-visible {
  outline: 2px solid var(--accent, #2dd4bf); outline-offset: 2px;
}
.il-add button {
  padding: 0 var(--s4, 24px); min-height: 44px;
  font: 500 inherit; color: var(--accent-ink, #04110f); background: var(--accent, #2dd4bf);
  border: 0; border-radius: var(--r, 16px); cursor: pointer;
  transition: filter var(--fast, 160ms);
}
.il-add button:hover { filter: brightness(1.08); }
.il-add button:disabled { opacity: .45; cursor: not-allowed; filter: none; }

.il-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--s1, 8px); }
.il-row {
  display: flex; align-items: center; gap: var(--s2, 12px);
  padding: var(--s2, 12px);
  background: var(--surface, #14171c);
  border: 1px solid var(--line, #232830); border-radius: var(--r, 16px);
}
.il-row:hover { border-color: color-mix(in oklab, var(--line, #232830) 60%, var(--accent, #2dd4bf)); }
.il-check { width: 20px; height: 20px; flex: none; accent-color: var(--accent, #2dd4bf); cursor: pointer; }
.il-text {
  flex: 1; min-width: 0; padding: 4px 6px; margin: -4px -6px;
  font: inherit; color: inherit; background: none; border: 1px solid transparent; border-radius: 8px;
  text-align: left; cursor: text; overflow-wrap: anywhere;
}
.il-text:hover { border-color: var(--line, #232830); }
.il-row[data-done="true"] .il-text { color: var(--muted, #8b93a3); text-decoration: line-through; }
.il-edit {
  flex: 1; min-width: 0; padding: 4px 6px; margin: -4px -6px;
  font: inherit; color: var(--text, #e7eaf0); background: var(--bg, #0b0d10);
  border: 1px solid var(--accent, #2dd4bf); border-radius: 8px;
}
.il-remove {
  flex: none; width: 32px; height: 32px; display: grid; place-items: center;
  font-size: 18px; line-height: 1; color: var(--muted, #8b93a3);
  background: none; border: 0; border-radius: 8px; cursor: pointer;
  transition: color var(--fast, 160ms), background var(--fast, 160ms);
}
.il-remove:hover { color: var(--bad, #ff8b95); background: color-mix(in oklab, var(--surface, #14171c) 70%, var(--bad, #ff8b95)); }

.il-empty { padding: var(--s5, 40px) var(--s3, 16px); text-align: center; }
.il-empty h2 { margin: 0 0 var(--s1, 8px); font-size: 1.05rem; }
.il-empty p { margin: 0; color: var(--muted, #8b93a3); }
.il-count { color: var(--muted, #8b93a3); font-size: .875rem; }
@media (prefers-reduced-motion: reduce) { .il * { transition: none !important; } }
`;

let styled = false;
function styles() {
  if (styled) return;
  styled = true;
  document.head.append(Object.assign(document.createElement('style'), { textContent: CSS }));
}

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export function ItemList({
  items = [],
  onChange = () => {},
  placeholder = 'Add an item',
  addLabel = 'Add',
  empty = { title: 'Nothing here yet', description: 'Add the first one above.' },
} = {}) {
  styles();

  let rows = items.map((i) => ({ ...i }));
  let editing = null;                       // id of the row being renamed

  const el = document.createElement('div');
  el.className = 'il';

  // -- the add row ---------------------------------------------------------
  const form = document.createElement('form');
  form.className = 'il-add';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', placeholder);
  input.autocomplete = 'off';
  const add = document.createElement('button');
  add.type = 'submit';
  add.textContent = addLabel;
  add.disabled = true;
  form.append(input, add);

  input.addEventListener('input', () => { add.disabled = !input.value.trim(); });

  function submit() {
    const text = input.value.trim();
    if (!text) return;
    rows = [...rows, { id: uid(), text, done: false }];
    input.value = '';
    add.disabled = true;
    commit();
    input.focus();
  }

  form.addEventListener('submit', (event) => { event.preventDefault(); submit(); });

  // Enter is how this control is actually used, and a form's implicit submit
  // is conditional on things outside this file — a disabled default button, a
  // browser quirk, an ancestor that swallows the key. Handled outright.
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    submit();
  });

  const list = document.createElement('ul');
  list.className = 'il-rows';

  const count = document.createElement('p');
  count.className = 'il-count';
  count.setAttribute('aria-live', 'polite');

  el.append(form, list, count);

  function commit() {
    draw();
    onChange(rows.map((r) => ({ ...r })));
  }

  function row(item) {
    const li = document.createElement('li');
    li.className = 'il-row';
    li.dataset.done = String(Boolean(item.done));

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'il-check';
    check.checked = Boolean(item.done);
    check.setAttribute('aria-label', `Mark "${item.text}" as ${item.done ? 'not done' : 'done'}`);
    check.addEventListener('change', () => {
      rows = rows.map((r) => (r.id === item.id ? { ...r, done: check.checked } : r));
      commit();
    });

    let body;
    if (editing === item.id) {
      // Renaming in place: Enter keeps it, Escape puts it back, and clicking
      // away keeps it too — losing an edit to a stray click is infuriating.
      body = document.createElement('input');
      body.className = 'il-edit';
      body.value = item.text;
      body.setAttribute('aria-label', `Rename "${item.text}"`);
      const keep = () => {
        const text = body.value.trim();
        editing = null;
        if (!text || text === item.text) return draw();
        rows = rows.map((r) => (r.id === item.id ? { ...r, text } : r));
        commit();
      };
      body.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); keep(); }
        if (event.key === 'Escape') { event.preventDefault(); editing = null; draw(); }
      });
      body.addEventListener('blur', keep);
      queueMicrotask(() => { body.focus(); body.select(); });
    } else {
      body = document.createElement('button');
      body.type = 'button';
      body.className = 'il-text';
      body.textContent = item.text;
      body.setAttribute('aria-label', `Rename "${item.text}"`);
      body.addEventListener('click', () => { editing = item.id; draw(); });
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'il-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove "${item.text}"`);
    remove.addEventListener('click', () => {
      rows = rows.filter((r) => r.id !== item.id);
      commit();
      input.focus();
    });

    li.append(check, body, remove);
    return li;
  }

  function draw() {
    list.replaceChildren();
    if (!rows.length) {
      const blank = document.createElement('li');
      blank.className = 'il-empty';
      const title = document.createElement('h2');
      title.textContent = empty.title;
      const description = document.createElement('p');
      description.textContent = empty.description ?? '';
      blank.append(title, description);
      list.append(blank);
      count.textContent = '';
      return;
    }
    for (const item of rows) list.append(row(item));
    const left = rows.filter((r) => !r.done).length;
    count.textContent = `${left} of ${rows.length} left`;
  }

  draw();

  return {
    el,
    /** Redraw from a new array — call this when the state changes elsewhere. */
    setItems(next = []) {
      rows = next.map((i) => ({ ...i }));
      editing = null;
      draw();
    },
    get items() { return rows.map((r) => ({ ...r })); },
    focus() { input.focus(); },
  };
}
