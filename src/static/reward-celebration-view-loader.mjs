export const REWARD_PRESENTATION_RELOAD_MESSAGE = 'Your rewards are saved, but their celebration could not load. Save any unfinished work, then reload this page to see them.';

// Retain public code only, never an actor, reward, claim token or controller.
export function createPermanentRewardCelebrationLoader({
  loadModule = () => import('./reward-celebration-view.js'),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let pending;
  return () => {
    pending ||= new Promise((resolve, reject) => {
      const fail = () => reject(new Error(REWARD_PRESENTATION_RELOAD_MESSAGE));
      const timer = setTimer(fail, 30_000);
      Promise.resolve().then(loadModule).then((module) => {
        if (typeof module?.presentPermanentRewardCelebration !== 'function') throw new Error('Invalid reward renderer.');
        resolve(module);
      }).catch(fail).finally(() => clearTimer(timer));
    });
    // Browsers retain failed module imports. Recovery requires a new document;
    // never retry an import or a reward mutation automatically.
    return pending;
  };
}

export const loadPermanentRewardCelebration = createPermanentRewardCelebrationLoader();
