export function createCelebrationQueue({
  present,
  handoffMs = 250,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
  onIdle = () => {},
} = {}) {
  if (typeof present !== 'function') throw new TypeError('A celebration presenter is required.');

  const queuedIds = new Set();
  const completedIds = new Set();
  const pending = [];
  let active = null;
  let controller = null;
  let autoTimer = null;
  let handoffTimer = null;
  let dismissing = false;

  const clearAutoTimer = () => {
    if (autoTimer === null) return;
    clearTimer(autoTimer);
    autoTimer = null;
  };

  const pump = () => {
    if (active || handoffTimer !== null || !pending.length) return;
    active = pending.shift();
    dismissing = false;
    controller = present(active) || {};
    if (Number.isFinite(active.durationMs) && active.durationMs >= 0) {
      autoTimer = setTimer(() => {
        autoTimer = null;
        dismissCurrent('auto');
      }, active.durationMs);
    }
  };

  const finishCurrent = (item, reason) => {
    if (active !== item) return;
    clearAutoTimer();
    controller?.cleanup?.(reason);
    controller = null;
    active = null;
    dismissing = false;
    queuedIds.delete(item.id);
    completedIds.add(item.id);

    if (pending.length) {
      handoffTimer = setTimer(() => {
        handoffTimer = null;
        pump();
      }, handoffMs);
    } else {
      onIdle();
    }
  };

  function dismissCurrent(reason = 'dismissed') {
    if (!active || dismissing) return false;
    dismissing = true;
    clearAutoTimer();
    const item = active;
    let dismissal;
    try {
      dismissal = controller?.dismiss?.(reason);
    } catch (error) {
      dismissal = Promise.reject(error);
    }
    Promise.resolve(dismissal)
      .catch(() => {})
      .then(() => finishCurrent(item, reason));
    return true;
  }

  const enqueue = (items = []) => {
    const candidates = Array.isArray(items) ? items : [items];
    candidates.filter(Boolean).forEach((item) => {
      if (!item.id) throw new TypeError('Every celebration requires a stable id.');
      if (queuedIds.has(item.id) || completedIds.has(item.id)) return;
      queuedIds.add(item.id);
      pending.push(item);
    });
    pump();
  };

  const clear = ({ forgetCompleted = false } = {}) => {
    clearAutoTimer();
    if (handoffTimer !== null) {
      clearTimer(handoffTimer);
      handoffTimer = null;
    }
    controller?.cleanup?.('cleared');
    controller = null;
    active = null;
    dismissing = false;
    pending.length = 0;
    queuedIds.clear();
    if (forgetCompleted) completedIds.clear();
    onIdle();
  };

  const state = () => ({
    active: active ? { ...active } : null,
    pending: pending.map((item) => ({ ...item })),
    dismissing,
  });

  return { clear, dismissCurrent, enqueue, state };
}
