// Document-local ownership of optional work, never an authentication decision.
// Old form completions cannot release a newer attempt or revive old work.
export function createAuthEntryTransition() {
  const reservations = new Set();
  const listeners = new Set();
  let controller = new AbortController();
  const rotate = () => { controller.abort(); controller = new AbortController(); };
  const notify = () => { for (const listener of listeners) listener(reservations.size > 0); };
  return {
    capture: () => reservations.size ? null : controller.signal,
    isCurrent: signal => Boolean(signal && signal === controller.signal && !signal.aborted && !reservations.size),
    begin() {
      const owner = {}; reservations.add(owner); rotate(); notify();
      return () => {
        if (!reservations.delete(owner)) return;
        rotate(); notify();
      };
    },
    suspend() { reservations.add('departing-document'); rotate(); notify(); },
    restore() { reservations.clear(); rotate(); notify(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export const authEntryTransition = createAuthEntryTransition();
