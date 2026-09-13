/**
 * A dialog that behaves like one: Escape closes it, focus is trapped inside
 * while it is open and goes back to whatever opened it afterwards, and the
 * page behind it cannot be scrolled or tabbed into.
 *
 * Built on the browser's own <dialog>, which does the trapping and the
 * backdrop already. A hand-rolled div gets the look and none of the rest.
 *
 *   import { Modal } from './blocks/modal.js';
 *
 *   const confirm = Modal({
 *     title: 'Delete this list?',
 *     description: 'Everything in it goes too. This cannot be undone.',
 *     confirmLabel: 'Delete',
 *     danger: true,
 *     onConfirm: () => store.reset(),
 *   });
 *   document.body.append(confirm.el);
 *   button.addEventListener('click', () => confirm.open());
 */

const CSS = `
.md {
  width: min(440px, calc(100vw - 32px)); padding: 0;
  color: var(--text, #e7eaf0); background: var(--surface, #14171c);
  border: 1px solid var(--line, #232830); border-radius: var(--r, 16px);
  box-shadow: 0 24px 60px rgb(0 0 0 / .5);
}
.md::backdrop { background: rgb(0 0 0 / .6); }
.md-body { padding: var(--s4, 24px); }
.md h2 { margin: 0 0 var(--s1, 8px); font-size: 1.1rem; }
.md p { margin: 0; color: var(--muted, #8b93a3); }
.md-actions {
  display: flex; justify-content: flex-end; gap: var(--s1, 8px);
  padding: var(--s2, 12px) var(--s4, 24px) var(--s4, 24px);
}
.md button {
  min-height: 44px; padding: 0 var(--s4, 24px);
  font: 500 inherit; border-radius: var(--r, 16px); cursor: pointer;
  transition: filter var(--fast, 160ms), background var(--fast, 160ms);
}
.md-cancel {
  color: var(--text, #e7eaf0); background: none;
  border: 1px solid var(--line, #232830);
}
.md-cancel:hover { background: var(--bg, #0b0d10); }
.md-confirm { color: var(--accent-ink, #04110f); background: var(--accent, #2dd4bf); border: 0; }
.md-confirm:hover { filter: brightness(1.08); }
.md-confirm[data-danger="true"] { color: var(--bad-ink, #2a0b0e); background: var(--bad, #ff8b95); }
.md button:focus-visible { outline: 2px solid var(--accent, #2dd4bf); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .md button { transition: none; } }
`;

let styled = false;
function styles() {
  if (styled) return;
  styled = true;
  document.head.append(Object.assign(document.createElement('style'), { textContent: CSS }));
}

let seq = 0;

export function Modal({
  title = '',
  description = '',
  content = null,              // an element, if the dialog is more than a question
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm = () => {},
  onCancel = () => {},
} = {}) {
  styles();

  const id = `md-${++seq}`;
  const el = document.createElement('dialog');
  el.className = 'md';
  el.setAttribute('aria-labelledby', id);

  const body = document.createElement('div');
  body.className = 'md-body';

  const heading = document.createElement('h2');
  heading.id = id;
  heading.textContent = title;
  body.append(heading);

  if (description) {
    const p = document.createElement('p');
    p.textContent = description;
    body.append(p);
  }
  if (content) body.append(content);

  const actions = document.createElement('div');
  actions.className = 'md-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'md-cancel';
  cancel.textContent = cancelLabel;
  cancel.addEventListener('click', () => close('cancel'));

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'md-confirm';
  confirm.dataset.danger = String(Boolean(danger));
  confirm.textContent = confirmLabel;
  confirm.addEventListener('click', () => close('confirm'));

  actions.append(cancel, confirm);
  el.append(body, actions);

  // Escape fires the dialog's own cancel event; route it through the same
  // path as the button so onCancel runs however it was dismissed.
  el.addEventListener('cancel', (event) => { event.preventDefault(); close('cancel'); });

  // A click on the backdrop lands on the dialog itself, never on its contents.
  el.addEventListener('click', (event) => { if (event.target === el) close('cancel'); });

  let opener = null;

  function close(how) {
    el.close();
    opener?.focus?.();
    opener = null;
    if (how === 'confirm') onConfirm();
    else onCancel();
  }

  return {
    el,
    open() {
      opener = document.activeElement;
      el.showModal();
      confirm.focus();
    },
    close: () => close('cancel'),
    get isOpen() { return el.open; },
  };
}
