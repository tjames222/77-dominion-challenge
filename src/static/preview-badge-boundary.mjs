const staleOwner = () => new Error('The signed-in account changed. Try again.');
const unavailable = () => new Error('Badge history is temporarily unavailable. Reload and try again.');

// Only the module is cached by the platform. No actor, private result, lock
// reservation, or failed loader promise survives an operation.
export function createPreviewBadgeBoundary({ captureOwner, requestLock,
  loadRuntime = () => import('./badge-preview-state.mjs') }) {
  const verify = async (owner) => {
    const current = await captureOwner(owner.actorId);
    if (current.actorId !== owner.actorId || current.sessionIdentity !== owner.sessionIdentity
      || current.token !== owner.token || current.epoch !== owner.epoch) throw staleOwner();
  };
  return {
    async run(expectedUserId, operation, { lock = true } = {}) {
      if (!expectedUserId) throw staleOwner();
      const owner = Object.freeze({ ...await captureOwner(expectedUserId) });
      if (owner.actorId !== expectedUserId || !owner.sessionIdentity) throw staleOwner();
      if (lock && !requestLock) throw new Error('This preview browser cannot safely synchronize badge history.');
      let runtime;
      try { runtime = await loadRuntime(); } catch { throw unavailable(); }
      await verify(owner);
      // An async reader must recheck this original owner after its own awaits;
      // it must never start a fresh boundary around an older private snapshot.
      if (!lock) return operation(runtime, () => verify(owner));
      return requestLock(`dominion:badges:${expectedUserId}`, async () => {
        await verify(owner);
        // Private reads, the existing synchronous reducer and its writes stay
        // together in this unchanged per-actor critical section.
        return operation(runtime);
      });
    },
  };
}
