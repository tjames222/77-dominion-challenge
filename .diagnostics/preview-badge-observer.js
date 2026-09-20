(() => {
  const CAPACITY = 5000;
  const ring = new Array(CAPACITY);
  let size = 0;
  let next = 0;
  let sequence = 0;
  let recorderErrors = 0;
  let nextLockId = 0;
  const held = new Map();
  const observedKeys = new Set([
    'dominion:badgeState:v1', 'dominion:badges', 'dominion:previewUserStateByOwner',
    'dominion:previewUserStateLegacyOwner', 'dominion:mockUserId', 'dominion:mockUserIdsByIdentity',
  ]);
  const rawGet = Storage.prototype.getItem;
  const rawSet = Storage.prototype.setItem;
  const rawRemove = Storage.prototype.removeItem;
  const rawClear = Storage.prototype.clear;
  const capturedDateNow = Date.now.bind(Date);
  let storage;
  try { storage = localStorage; } catch { return; }
  const safely = (operation) => { try { return operation(); } catch { recorderErrors += 1; return undefined; } };
  const rawRead = (key) => Reflect.apply(rawGet, storage, [key]);
  const award = (row) => ({
    id: row?.awardId, key: row?.key, token: row?.celebrationClaimToken,
    until: row?.celebrationClaimUntil, seen: row?.celebrationSeenAt, legacy: row?.legacy,
  });
  function digest(key, value) {
    if (value === null) return null;
    if (key === 'dominion:mockUserId' || key === 'dominion:previewUserStateLegacyOwner') return value;
    try {
      const parsed = JSON.parse(value);
      if (key === 'dominion:mockUserIdsByIdentity') return Object.values(parsed || {});
      if (key === 'dominion:badges') return Array.isArray(parsed) ? parsed.map(award) : parsed;
      if (key === 'dominion:badgeState:v1') return { schemaVersion: parsed?.schemaVersion, awards: parsed?.awards?.map(award) };
      return Object.fromEntries(Object.entries(parsed || {}).map(([owner, state]) => [owner, {
        state: state?.['dominion:badgeState:v1']?.awards?.map(award),
        badges: state?.['dominion:badges']?.map(award),
      }]));
    } catch { return { malformed: true, bytes: typeof value === 'string' ? value.length : null }; }
  }
  const snapshot = () => ({
    actor: rawRead('dominion:mockUserId'),
    legacyOwner: rawRead('dominion:previewUserStateLegacyOwner'),
    legacyState: digest('dominion:badgeState:v1', rawRead('dominion:badgeState:v1')),
    ownerMap: digest('dominion:previewUserStateByOwner', rawRead('dominion:previewUserStateByOwner')),
  });
  function record(type, data = {}) {
    safely(() => {
      ring[next] = {
        sequence: ++sequence, type, monotonicMs: performance.now(), timeOrigin: performance.timeOrigin,
        observedDateNow: Date.now(), capturedDateNow: capturedDateNow(),
        held: [...held.entries()].map(([id, name]) => ({ id, name })), ...data,
      };
      next = (next + 1) % CAPACITY;
      size = Math.min(size + 1, CAPACITY);
    });
  }
  window.__previewBadgeObservation = {
    report: () => ({
      capacity: CAPACITY, totalRecorded: sequence, overwritten: Math.max(sequence - size, 0), recorderErrors,
      // Init-script ordering may mean the captured clock is already fixture-fixed.
      capturedClockIsNotGuaranteedNative: true,
      events: Array.from({ length: size }, (_, index) => ring[(next - size + index + CAPACITY) % CAPACITY]),
      final: safely(snapshot),
    }),
  };
  Storage.prototype.getItem = function (key) {
    const result = Reflect.apply(rawGet, this, arguments);
    safely(() => { if (this === storage && observedKeys.has(key)) record('storage-read', { key, value: digest(key, result) }); });
    return result;
  };
  Storage.prototype.setItem = function (key, value) {
    safely(() => { if (this === storage && observedKeys.has(key)) record('storage-write-before', {
      key, value: digest(key, value), previous: digest(key, rawRead(key)), stack: new Error().stack,
    }); });
    const result = Reflect.apply(rawSet, this, arguments);
    safely(() => { if (this === storage && observedKeys.has(key)) record('storage-write-after', { key, value: digest(key, rawRead(key)) }); });
    return result;
  };
  Storage.prototype.removeItem = function (key) {
    safely(() => { if (this === storage && observedKeys.has(key)) record('storage-remove-before', { key, previous: digest(key, rawRead(key)), stack: new Error().stack }); });
    const result = Reflect.apply(rawRemove, this, arguments);
    safely(() => { if (this === storage && observedKeys.has(key)) record('storage-remove-after', { key }); });
    return result;
  };
  Storage.prototype.clear = function () {
    safely(() => { if (this === storage) record('storage-clear-before', { snapshot: snapshot(), stack: new Error().stack }); });
    const result = Reflect.apply(rawClear, this, arguments);
    safely(() => { if (this === storage) record('storage-clear-after', { snapshot: snapshot() }); });
    return result;
  };
  window.addEventListener('storage', (event) => safely(() => {
    if (event.storageArea !== storage || (event.key !== null && !observedKeys.has(event.key))) return;
    record('storage-event', { key: event.key, oldValue: digest(event.key, event.oldValue), newValue: digest(event.key, event.newValue), snapshot: snapshot() });
  }));
  if (!navigator.locks?.request) { record('locks-unavailable'); return; }
  const rawRequest = navigator.locks.request;
  navigator.locks.request = function (name, optionsOrCallback, maybeCallback) {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (typeof callback !== 'function') return Reflect.apply(rawRequest, this, arguments);
    const id = ++nextLockId;
    safely(() => record('lock-request', { id, name, snapshot: snapshot() }));
    const observed = function (...args) {
      safely(() => { held.set(id, name); record('lock-enter', { id, name, snapshot: snapshot() }); });
      let result;
      try { result = Reflect.apply(callback, this, args); }
      catch (error) {
        safely(() => { record('lock-callback-throw', { id, name, message: String(error.message), snapshot: snapshot() }); held.delete(id); });
        throw error;
      }
      const settled = (outcome) => safely(() => {
        record('lock-callback-settled', { id, name, outcome, snapshot: snapshot() });
        held.delete(id);
      });
      // Observe native async callback settlement without returning a replacement
      // promise, adding an await, or postponing the original callback result.
      safely(() => {
        if (result instanceof Promise) Promise.prototype.then.call(result, () => settled('fulfilled'), () => settled('rejected'));
        else settled('returned-non-promise');
      });
      return result;
    };
    const args = [...arguments];
    args[typeof optionsOrCallback === 'function' ? 1 : 2] = observed;
    return Reflect.apply(rawRequest, this, args);
  };
  record('observer-installed', { snapshot: safely(snapshot) });
})();
