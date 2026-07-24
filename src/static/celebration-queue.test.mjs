import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCelebrationQueue } from './celebration-queue.mjs';

const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

function fakeClock() {
  let timerId = 0;
  const timers = new Map();
  return {
    clearTimer(id) { timers.delete(id); },
    setTimer(callback, delay) {
      timerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    runDelay(delay) {
      const match = [...timers].find(([, timer]) => timer.delay === delay);
      if (!match) return false;
      const [id, timer] = match;
      timers.delete(id);
      timer.callback();
      return true;
    },
    delays() { return [...timers.values()].map(({ delay }) => delay); },
  };
}

describe('celebration queue', () => {
  it('waits for dismissal completion and advances after the short handoff', async () => {
    const clock = fakeClock();
    const presented = [];
    const queue = createCelebrationQueue({
      present(item) {
        presented.push(item.id);
        return { dismiss: () => Promise.resolve() };
      },
      handoffMs: 240,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    queue.enqueue([
      { id: 'day-complete', durationMs: 10_000 },
      { id: 'badge', durationMs: 5_000 },
    ]);
    assert.deepEqual(presented, ['day-complete']);
    assert.equal(queue.dismissCurrent('backdrop'), true);
    assert.equal(queue.dismissCurrent('escape'), false);
    await flushPromises();
    assert.deepEqual(clock.delays(), [240]);
    assert.equal(clock.runDelay(240), true);
    assert.deepEqual(presented, ['day-complete', 'badge']);
  });

  it('uses the same completion path for automatic dismissal', async () => {
    const clock = fakeClock();
    const dismissals = [];
    const queue = createCelebrationQueue({
      present(item) {
        return { dismiss: (reason) => { dismissals.push([item.id, reason]); } };
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    queue.enqueue({ id: 'badge', durationMs: 5_600 });
    assert.equal(clock.runDelay(5_600), true);
    await flushPromises();
    assert.deepEqual(dismissals, [['badge', 'auto']]);
    assert.equal(queue.state().active, null);
  });

  it('deduplicates active, queued, and already completed items', async () => {
    const clock = fakeClock();
    const presented = [];
    const queue = createCelebrationQueue({
      present(item) {
        presented.push(item.id);
        return { dismiss: () => {} };
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    queue.enqueue([{ id: 'badge' }, { id: 'badge' }]);
    queue.enqueue({ id: 'badge' });
    assert.deepEqual(presented, ['badge']);
    queue.dismissCurrent();
    await flushPromises();
    queue.enqueue({ id: 'badge' });
    assert.deepEqual(presented, ['badge']);
  });

  it('clears stale automatic and handoff timers', async () => {
    const clock = fakeClock();
    const presented = [];
    const queue = createCelebrationQueue({
      present(item) {
        presented.push(item.id);
        return { dismiss: () => Promise.resolve() };
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    queue.enqueue([{ id: 'first', durationMs: 5_000 }, { id: 'second', durationMs: 5_000 }]);
    queue.dismissCurrent();
    await flushPromises();
    queue.clear();
    assert.deepEqual(clock.delays(), []);
    assert.deepEqual(presented, ['first']);
  });
});
