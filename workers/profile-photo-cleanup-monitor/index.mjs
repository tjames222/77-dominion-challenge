import { DurableObject } from 'cloudflare:workers';
import { CRON, OBJECT_NAME } from './constants.mjs';
import { runTick } from './runner.mjs';

export class CleanupMonitor extends DurableObject {
  async tick(scheduledTime) {
    // At most 16 seconds of bounded network waiting, below the 30-second input
    // gate deadline. Concurrent schedules cannot overtake an in-flight send.
    return this.ctx.blockConcurrencyWhile(() => runTick(this.ctx.storage, this.env, scheduledTime));
  }
}

export default {
  fetch() { return new Response('Not found', { status: 404 }); },
  async scheduled(controller, env) {
    if (controller.cron !== CRON) throw new Error('Unexpected monitor schedule.');
    try {
      const id = env.MONITOR.idFromName(OBJECT_NAME);
      const result = await env.MONITOR.get(id).tick(controller.scheduledTime);
      console.log(JSON.stringify({ monitor: 'profile_photo_cleanup', ...result }));
    } catch {
      console.error(JSON.stringify({ monitor: 'profile_photo_cleanup', status: 'needs_review', code: 'monitor_tick_failed' }));
      throw new Error('Monitor tick failed.');
    }
  },
};
