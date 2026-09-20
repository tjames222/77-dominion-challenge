import { createConfirmationDialog } from './dialog.mjs';
import { TRAINING_RELOAD_MESSAGE, TRAINING_RELOAD_REQUIRED } from './site-training-ui-loader.mjs';

export { TRAINING_RELOAD_MESSAGE };
export const TRAINING_RELOAD_LABEL = 'Reload to load training';

// This never reloads on failure, focus, connectivity changes, or handoff. Only
// the explicit confirmation can navigate, leaving drafts and progress alone.
export function createSiteTrainingLoadRecovery({
  id,
  document: ownerDocument = globalThis.document,
  window: windowLike = globalThis.window,
  confirmationFactory = createConfirmationDialog,
} = {}) {
  let required = false;
  let dialog = null;
  let destroyed = false;
  const dismiss = () => {
    dialog?.destroy();
    dialog = null;
  };
  return {
    get required() { return required; },
    record(error) {
      if (!destroyed && error?.code === TRAINING_RELOAD_REQUIRED) required = true;
      return required;
    },
    open(trigger) {
      if (destroyed || !required) return false;
      dialog ||= confirmationFactory({
        id,
        document: ownerDocument,
        title: 'Reload to load training?',
        description: 'Save any unfinished journal entry, check-in, or other edits first. Reloading may discard unsaved changes. Your saved training progress will not be reset.',
        cancelLabel: 'Keep editing',
        confirmLabel: 'Reload page',
        pendingLabel: 'Reloading…',
        onConfirm: () => {
          if (!destroyed) windowLike.location.reload();
        },
      });
      dialog.open(trigger);
      return true;
    },
    dismiss,
    destroy() { destroyed = true; dismiss(); },
  };
}
