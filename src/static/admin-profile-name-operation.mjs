// One total mutation budget from the public API entry, including client and
// writer imports. This never uses the read-retry boundary. A lost submitted
// response is uncertain, not evidence that its transaction rolled back.
const error = code => Object.assign(new Error('The display-name operation could not be confirmed.'), { code });
export async function runProfileNameOperation(intent, { signal } = {}, getClient) {
  const reviewed = Object.freeze({ ...intent }); const controller = new AbortController(); let submitted = false; let settled = false; let timer; let rejectStop;
  const stopped = new Promise((_, reject) => { rejectStop = reject; });
  const stop = () => { controller.abort(); rejectStop(error(submitted ? 'ADMIN_PROFILE_NAME_RESULT_UNCERTAIN' : 'ADMIN_UNAVAILABLE')); };
  const operation = Object.freeze({
    assertActive() { if (settled || signal?.aborted || controller.signal.aborted) throw error(submitted ? 'ADMIN_PROFILE_NAME_RESULT_UNCERTAIN' : 'ADMIN_UNAVAILABLE'); },
    markSubmitted() { this.assertActive(); submitted = true; },
  });
  timer = setTimeout(stop, 20_000); signal?.addEventListener('abort', stop, { once: true });
  try {
    return await Promise.race([(async () => {
      operation.assertActive(); const client = await getClient(); operation.assertActive();
      const result = await client.correctProfileName(reviewed, { signal: controller.signal, operation }); operation.assertActive(); return result;
    })(), stopped]);
  } finally { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); controller.abort(); }
}
