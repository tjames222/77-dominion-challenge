export function createJournalApplicationLoader(importApplication) {
  let applicationLoad;
  return async function loadJournalApplication() {
    if (!applicationLoad) {
      applicationLoad = importApplication()
        .then(({ createJournalApiClientFromApplication }) => createJournalApiClientFromApplication());
    }
    return applicationLoad;
  };
}

const loadJournalApplication = createJournalApplicationLoader(
  () => import('./journal-api-application.mjs'),
);

export function createJournalSessionOpener(loadApplication) {
  return async function openSession(options = {}) {
    let application;
    try { application = await loadApplication(); }
    catch {
      throw Object.assign(new Error('We couldn’t load your private journal. Reload this page to try again.'), {
        code: 'JOURNAL_CODE_UNAVAILABLE',
      });
    }
    return application.open(options);
  };
}

export const openJournalSession = createJournalSessionOpener(loadJournalApplication);
