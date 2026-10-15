import assert from 'node:assert/strict';
import test from 'node:test';
import { StoreWatchers } from './storeWatchers';

test('watchers are reused for active stores and stopped when a store leaves the workspace', () => {
  const started: string[] = [];
  const stopped: string[] = [];
  const watchers = new StoreWatchers(path => {
    started.push(path);
    return () => { stopped.push(path); };
  });

  watchers.ensure('/a/review.json');
  watchers.ensure('/a/review.json');
  watchers.ensure('/b/review.json');
  assert.deepEqual(started, ['/a/review.json', '/b/review.json']);

  watchers.retain(['/b/review.json']);
  assert.deepEqual(stopped, ['/a/review.json']);
  watchers.ensure('/a/review.json');
  assert.deepEqual(started, ['/a/review.json', '/b/review.json', '/a/review.json']);

  watchers.dispose();
  assert.deepEqual(stopped, ['/a/review.json', '/b/review.json', '/a/review.json']);
});
