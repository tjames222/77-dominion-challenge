import { pathToFileURL } from 'node:url';

// These reviewed IDs are intentionally not runtime-selectable. The test checks
// them against the production worker/renderer constants to catch drift.
export const FEEDBACK_PROVIDER_TARGET = Object.freeze({
  teamId: 'f61599d3-1342-430f-855e-2d3bc574a94b',
  teamName: 'Foundation Technology', teamKey: 'FOU',
  projectId: 'd9c1d9b7-b35b-4da5-9a9e-be384e06bd2b', projectName: '77-dominion-challenge',
  labelId: 'ffbc76e4-a42e-475d-b31d-963fe3100de5', labelName: 'Early Access Feedback',
});
const endpoint = 'https://api.linear.app/graphql';
const query = `query VerifyDominionFeedbackProvider($teamId: String!, $teamFilterId: ID!, $projectId: String!, $labelId: String!) {
  team(id: $teamId) { id name key archivedAt }
  project(id: $projectId) {
    id name archivedAt trashed
    teams(first: 2, filter: { id: { eq: $teamFilterId } }) { nodes { id } pageInfo { hasNextPage } }
  }
  issueLabel(id: $labelId) { id name archivedAt isGroup team { id } }
}`;
const failure = () => new Error('Production feedback provider could not be verified.');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read-only metadata probe; it never fetches people, issues or issue contents. */
export async function verifyProductionFeedbackProvider({
  apiKey = process.env.LINEAR_FEEDBACK_API_KEY,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 10000,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 32 || apiKey.length > 512
    || /[^\x21-\x7e]/.test(apiKey) || typeof fetchImpl !== 'function'
    || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 10000) throw failure();
  const controller = new AbortController();let timer;let reader;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();void reader?.cancel().catch(() => {});reject(failure());
    }, requestTimeoutMs);
  });
  const work = async () => {
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables: {
          teamId: FEEDBACK_PROVIDER_TARGET.teamId, teamFilterId: FEEDBACK_PROVIDER_TARGET.teamId,
          projectId: FEEDBACK_PROVIDER_TARGET.projectId, labelId: FEEDBACK_PROVIDER_TARGET.labelId,
        } }),
      });
      if (controller.signal.aborted || response.status !== 200 || response.redirected || !response.body) throw failure();
      reader = response.body.getReader();const chunks = [];let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();if (controller.signal.aborted) throw failure();if (done) break;
          bytes += value.byteLength;if (bytes > 32768) throw failure();chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {});reader.releaseLock(); }
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      if (!record(result) || (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length !== 0))
        || !record(result.data)) throw failure();
      const { team, project, issueLabel: label } = result.data;
      if (!record(team) || team.id !== FEEDBACK_PROVIDER_TARGET.teamId || team.name !== FEEDBACK_PROVIDER_TARGET.teamName
        || team.key !== FEEDBACK_PROVIDER_TARGET.teamKey || team.archivedAt !== null
        || !record(project) || project.id !== FEEDBACK_PROVIDER_TARGET.projectId || project.name !== FEEDBACK_PROVIDER_TARGET.projectName
        || project.archivedAt !== null || (project.trashed !== null && project.trashed !== false)
        || !record(project.teams) || !Array.isArray(project.teams.nodes) || project.teams.nodes.length !== 1
        || !record(project.teams.nodes[0]) || project.teams.nodes[0].id !== FEEDBACK_PROVIDER_TARGET.teamId
        || !record(project.teams.pageInfo) || project.teams.pageInfo.hasNextPage !== false
        || !record(label) || label.id !== FEEDBACK_PROVIDER_TARGET.labelId || label.name !== FEEDBACK_PROVIDER_TARGET.labelName
        || label.archivedAt !== null || label.isGroup !== false
        || (label.team !== null && (!record(label.team) || label.team.id !== FEEDBACK_PROVIDER_TARGET.teamId))) throw failure();
      // Read access does not prove Create Issues permission. Never imply a write
      // test occurred, and never return provider identity or response contents.
      return Object.freeze({ verified: true, readOnly: true, writePermissionVerified: false });
    } catch { throw failure(); }
  };
  try { return await Promise.race([work(), timeout]); }
  finally { clearTimeout(timer);controller.abort(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await verifyProductionFeedbackProvider();
    console.log('Production feedback provider metadata verified read-only; no issue was created.');
  } catch {
    console.error('Production feedback provider could not be verified.');process.exitCode = 1;
  }
}
