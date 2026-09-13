/**
 * State in one place, saved to localStorage, and the same in every tab.
 *
 * The three things a hand-written version gets wrong: it throws in private
 * mode, it dies on a corrupt value written by an older version of the app,
 * and it silently disagrees with itself when the app is open twice.
 *
 *   import { createStore } from './blocks/store.js';
 *
 *   const store = createStore('tide', { items: [], filter: 'all' });
 *   store.subscribe(render);            // called now and after every change
 *   store.update((s) => ({ items: [...s.items, task] }));
 *   store.state.items
 */

export function createStore(key, initial = {}) {
  let state = { ...initial, ...read(key, initial) };
  const listeners = new Set();

  function announce() {
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (err) {
        // One broken listener must not stop the others, or half the page
        // stops redrawing for a reason nobody can see.
        console.error('store listener failed', err);
      }
    }
  }

  // The app open in two tabs is one app. Without this the second tab keeps
  // showing what the first one deleted, then overwrites it on the next save.
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== key) return;
      state = { ...initial, ...read(key, initial) };
      announce();
    });
  }

  return {
    get state() { return state; },

    /** Replace some of the state. Saves, then tells everyone. */
    set(patch) {
      state = { ...state, ...patch };
      write(key, state);
      announce();
    },

    /** The same, from a function of the current state. */
    update(fn) {
      this.set(fn(state) ?? {});
    },

    /** Called straight away with the current state, and after every change. */
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },

    /** Back to how it started, on disk as well as in memory. */
    reset() {
      state = { ...initial };
      write(key, state);
      announce();
    },
  };
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // An array or a string where an object belongs is a store written by an
    // older version of this app. Start again rather than crash on load.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { ...fallback };
  } catch {
    return {};
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode, or the quota is full. Losing the save is survivable;
    // throwing here would take the whole page down with it.
  }
}
