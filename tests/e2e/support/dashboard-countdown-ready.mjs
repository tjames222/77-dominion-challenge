// Only for idle, fixed-clock, single-page preview fixtures. Install after
// reveal, before changing storage or dispatching any interaction/refresh.
// Hydration and visit renders precede reveal; the countdown starts only after
// boot celebration recovery. This works with source-served and compiled code.
export async function observePostRevealCountdown(page) {
  await page.evaluate(() => {
    const label = document.getElementById('countdownActionsLabel');
    if (!label) throw new Error('Expected the Dashboard countdown fixture.');
    globalThis.__DOMINION_E2E_POST_REVEAL_COUNTDOWN__ = false;
    const observer = new MutationObserver(() => {
      globalThis.__DOMINION_E2E_POST_REVEAL_COUNTDOWN__ = true;
      observer.disconnect();
    });
    observer.observe(label, { childList: true });
  });
  return () => page.evaluate(() => globalThis.__DOMINION_E2E_POST_REVEAL_COUNTDOWN__ === true);
}
