/**
 * __APP_NAME__
 *
 * Plain modules, no build step: this file is what the browser runs. Keep the
 * state in one place and render from it, so there is one answer to "what is
 * on screen" rather than a DOM that has been patched in six directions.
 */

const app = document.querySelector('#app');

/** Everything the page knows. Change this, then call render(). */
const state = {
  items: load(),
};

function load() {
  try {
    return JSON.parse(localStorage.getItem('__APP_SLUG__') ?? '[]');
  } catch {
    return []; // a corrupt store is an empty one, not a broken page
  }
}

function save() {
  try {
    localStorage.setItem('__APP_SLUG__', JSON.stringify(state.items));
  } catch {
    // Private mode, or the quota is full. Losing the save is survivable;
    // throwing here would take the whole page down with it.
  }
}

function render() {
  app.innerHTML = '';
  app.append(
    Object.assign(document.createElement('div'), {
      className: 'card',
      textContent: 'Edit app.js to build __APP_NAME__.',
    })
  );
}

render();
