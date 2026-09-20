// Keep this controller independent of the composer, API and dialog graphs.
// In particular, resetting an account must not load an otherwise unused UI.
export function createShareComposerLoader(loadComposer) {
  let composer = null;
  let loading = null;
  let generation = 0;
  const documents = new Map();

  const load = () => {
    if (composer) return Promise.resolve(composer);
    if (!loading) {
      loading = Promise.resolve().then(loadComposer).then((module) => {
        composer = module;
        return module;
      }).catch((error) => {
        loading = null;
        throw error;
      });
    }
    return loading;
  };

  const closeShareComposer = (reason = 'auth-change') => {
    generation += 1;
    for (const state of documents.values()) {
      state.request += 1;
      state.finish?.();
    }
    composer?.closeShareComposer(reason);
  };

  const initShareComposer = (ownerDocument = globalThis.document) => {
    if (!ownerDocument?.querySelectorAll) return null;
    for (const trigger of ownerDocument.querySelectorAll('[data-share-composer]')) {
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-controls', 'shareComposerDialog');
    }
    if (composer) composer.initShareComposer(ownerDocument);
    if (documents.has(ownerDocument)) return documents.get(ownerDocument);

    const state = { request: 0, finish: null, status: null };
    documents.set(ownerDocument, state);
    const announce = (text) => {
      if (!state.status) {
        state.status = ownerDocument.createElement('span');
        state.status.className = 'sr-only';
        state.status.setAttribute('role', 'status');
        state.status.setAttribute('aria-live', 'polite');
        ownerDocument.body.append(state.status);
      }
      state.status.textContent = text;
    };

    ownerDocument.addEventListener('click', async (event) => {
      const trigger = event.target?.closest?.('[data-share-composer]');
      if (!trigger || trigger.disabled || trigger.getAttribute('aria-disabled') === 'true') return;
      if (composer) {
        // Header rehydration can replace a trigger after the initial import.
        composer.initShareComposer(ownerDocument);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      state.finish?.();
      const request = ++state.request;
      const actorGeneration = generation;
      const priorBusy = trigger.getAttribute('aria-busy');
      trigger.setAttribute('aria-busy', 'true');
      announce('Loading sharing options…');
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (priorBusy === null) trigger.removeAttribute('aria-busy');
        else trigger.setAttribute('aria-busy', priorBusy);
        if (state.finish === finish) {
          state.finish = null;
          announce('');
        }
      };
      state.finish = finish;
      try {
        const module = await load();
        if (request !== state.request || actorGeneration !== generation
          || !trigger.isConnected || trigger.disabled || trigger.getAttribute('aria-disabled') === 'true') return;
        module.initShareComposer(ownerDocument);
        finish();
        // Re-enter the component's normal trigger handler, only after Vite has
        // loaded its component-owned CSS and only for the still-current actor.
        trigger.click();
      } catch {
        if (request === state.request && actorGeneration === generation) {
          finish();
          announce('Sharing options could not load. Please try the Share button again.');
        }
      } finally {
        finish();
      }
    }, true);
    return state;
  };

  return { initShareComposer, closeShareComposer };
}
