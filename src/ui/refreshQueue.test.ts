import assert from 'node:assert/strict';
import test from 'node:test';
import { CoalescedRefresh } from './refreshQueue';

test('requests made during a refresh produce one follow-up run without overlap', async () => {
  let release!: () => void;
  let started = 0;
  let active = 0;
  let maximumActive = 0;
  const queue = new CoalescedRefresh(async () => {
    started++;
    active++;
    maximumActive = Math.max(maximumActive, active);
    if (started === 1) await new Promise<void>(resolve => { release = resolve; });
    active--;
  });

  const first = queue.request();
  const second = queue.request();
  const third = queue.request();
  assert.equal(started, 1);
  release();
  await Promise.all([first, second, third]);
  assert.equal(started, 2);
  assert.equal(maximumActive, 1);
});

test('a failed refresh can be requested again', async () => {
  let attempts = 0;
  const queue = new CoalescedRefresh(async () => {
    if (++attempts === 1) throw new Error('temporary');
  });
  await assert.rejects(queue.request(), /temporary/);
  await queue.request();
  assert.equal(attempts, 2);
});

test('a request queued during a failed refresh still runs', async () => {
  let rejectFirst!: (error: Error) => void;
  let attempts = 0;
  const queue = new CoalescedRefresh(async () => {
    attempts++;
    if (attempts === 1) await new Promise<void>((_, reject) => { rejectFirst = reject; });
  });
  const first = queue.request();
  const second = queue.request();
  rejectFirst(new Error('temporary'));
  await assert.rejects(first, /temporary/);
  await assert.rejects(second, /temporary/);
  assert.equal(attempts, 2);
});

test('a request arriving as the drain settles is not lost', async () => {
  let attempts = 0;
  let queue!: CoalescedRefresh;
  queue = new CoalescedRefresh(async () => {
    attempts++;
    if (attempts === 1) queueMicrotask(() => queueMicrotask(() => { void queue.request(); }));
  });

  await queue.request();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
});
