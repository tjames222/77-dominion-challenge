export const HEADER_RELOAD_MESSAGE = 'Member controls could not load. Save any unfinished work, then reload this page to try again.';

export function createAuthenticatedHeaderLoader({
  load = () => import('./shared-header-actions.js'),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let promise;
  return () => {
    // Cache public code only. A timeout or failed module map stays failed for
    // this document; never retry automatically or retain an actor/controller.
    promise ||= new Promise((resolve, reject) => {
      const fail = () => reject(new Error(HEADER_RELOAD_MESSAGE));
      const timer = setTimer(fail, 30_000);
      Promise.resolve().then(load).then(resolve, fail).finally(() => clearTimer(timer));
    });
    return promise;
  };
}

export const loadAuthenticatedHeader = createAuthenticatedHeaderLoader();
