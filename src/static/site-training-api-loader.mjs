import { newSiteTrainingRequestId } from './site-training-request-id.mjs';
import { TRAINING_RELOAD_MESSAGE, TRAINING_RELOAD_REQUIRED } from './site-training-ui-loader.mjs';

const changed = () => Object.assign(new Error('The signed-in account changed. Try again.'), {
  code: 'SITE_TRAINING_ACTOR_CHANGED',
});
const reloadRequired = () => Object.assign(new Error(TRAINING_RELOAD_MESSAGE), {
  code: TRAINING_RELOAD_REQUIRED,
});

// Cache public code only. Every call captures its own lifecycle before any
// await; neither an actor, bearer, response nor mutation is cached or retried.
export function createSiteTrainingApiLoader({
  load = () => import('./menu-training-controllers.mjs'),
  readOwner,
  readEpoch,
  dependencies,
  timeoutMs = 30_000,
}) {
  let modulePromise;
  const loadModule = () => {
    if (!modulePromise) modulePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(reloadRequired()), timeoutMs);
      Promise.resolve().then(load).then(resolve, () => reject(reloadRequired()))
        .finally(() => clearTimeout(timer));
    });
    return modulePromise;
  };

  return async function invoke(operation, input = {}) {
    const epoch = readEpoch();
    const args = structuredClone(input);
    const actorId = String(args.expectedUserId || '').trim();
    if (!actorId) throw new TypeError('A captured signed-in account is required for page training operations.');
    if (!['getSiteTrainingState', 'claimSiteTraining', 'transitionSiteTraining'].includes(operation)) {
      throw new TypeError('Choose a published training operation.');
    }
    if (operation !== 'getSiteTrainingState' && args.requestId === undefined) {
      args.requestId = newSiteTrainingRequestId();
    }
    const assertEpoch = () => { if (epoch !== readEpoch()) throw changed(); };
    const owner = await readOwner();
    assertEpoch();
    if (!owner || owner.actorId !== actorId || !owner.sessionIdentity
      || (!owner.preview && !owner.bearer)) throw changed();
    // Copy primitives before another await; caller/runtime objects stay mutable.
    const identity = owner.sessionIdentity;
    const bearer = owner.bearer;
    const preview = owner.preview;
    const verifyOwner = async () => {
      assertEpoch();
      const current = await readOwner();
      assertEpoch();
      if (!current || current.actorId !== actorId || current.sessionIdentity !== identity
        || current.bearer !== bearer || current.preview !== preview) throw changed();
    };
    const module = await loadModule();
    await verifyOwner();
    const guard = async (work) => {
      await verifyOwner();
      assertEpoch();
      const result = await work();
      await verifyOwner();
      return result;
    };
    const service = module.createSiteTrainingApi({
      ...dependencies,
      requireUser: (expected) => guard(() => dependencies.requireUser(expected)),
      requireHybridPreviewUser: (expected) => guard(() => dependencies.requireHybridPreviewUser(expected)),
      requireSupabase: () => ({
        rpc: (name, values) => guard(() => {
          assertEpoch();
          // The installed SDK still awaits getAccessToken internally. Its
          // explicit-header rule keeps that lookup from switching this call to
          // a replacement bearer. Expected-actor server checks remain intact.
          return dependencies.requireSupabase().rpc(name, values)
            .setHeader('Authorization', `Bearer ${bearer}`);
        }),
      }),
    });
    assertEpoch();
    const result = await service[operation](args);
    await verifyOwner();
    return result;
  };
}
