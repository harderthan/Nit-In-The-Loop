import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { addThread, type ReviewDocument } from './review';
import { readReview, updateReview, writeReview } from './store';

test('missing review file reads as an empty versioned document', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  try {
    assert.deepEqual(await readReview(path.join(directory, 'missing.json')), { version: 1, threads: [] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('writeReview round trips a versioned thread and creates parent directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  const file = path.join(directory, 'nested', 'reviews.json');
  try {
    const review = { version: 1 as const, threads: [] };
    addThread(review, {
      path: 'src/a.ts', side: 'new', startLine: 5, endLine: 5,
      baseCommit: 'abcd', anchorText: 'change', author: 'agent', body: 'Inspect this.',
    });
    await writeReview(file, review);
    assert.deepEqual(await readReview(file), review);
    assert.deepEqual(await readdir(path.dirname(file)), ['reviews.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('readReview rejects corrupt data and preserves original file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  const file = path.join(directory, 'reviews.json');
  try {
    const corrupt = '{"version":1,"threads": [broken';
    await writeFile(file, corrupt);
    await assert.rejects(readReview(file), /review|json|parse/i);
    assert.equal(await readFile(file, 'utf8'), corrupt);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('readReview rejects unsupported versions without rewriting them', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  const file = path.join(directory, 'reviews.json');
  try {
    const unsupported = '{"version":2,"threads":[]}';
    await writeFile(file, unsupported);
    await assert.rejects(readReview(file), /version/i);
    assert.equal(await readFile(file, 'utf8'), unsupported);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('updateReview preserves concurrent thread additions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  const file = path.join(directory, 'reviews.json');
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => updateReview(file, async review => {
      await new Promise(resolve => setTimeout(resolve, 5));
      addThread(review, {
        path: `src/${index}.ts`, side: 'new', startLine: 1, endLine: 1,
        baseCommit: 'abcd', anchorText: 'change', author: 'agent', body: `Inspect ${index}.`,
      });
    })));
    const review = await readReview(file);
    assert.equal(review.threads.length, 12);
    assert.deepEqual(review.threads.map(thread => thread.path).sort(),
      Array.from({ length: 12 }, (_, index) => `src/${index}.ts`).sort());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('updateReview preserves concurrent writes from separate processes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  const file = path.join(directory, 'reviews.json');
  const run = promisify(execFile);
  const script = `
    const { updateReview } = await import('./src/core/store.ts');
    const { addThread } = await import('./src/core/review.ts');
    for (let i = 0; i < 4; i++) {
      await updateReview(process.env.REVIEW_TEST_FILE, async review => {
        await new Promise(resolve => setTimeout(resolve, 5));
        addThread(review, {
          path: 'src/' + process.env.REVIEW_TEST_WORKER + '-' + i + '.ts',
          side: 'new', startLine: 1, endLine: 1, baseCommit: 'abcd',
          anchorText: 'change', author: 'agent', body: 'Inspect.',
        });
      });
    }
  `;
  try {
    await Promise.all(Array.from({ length: 3 }, (_, index) => run(process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script], {
        cwd: process.cwd(),
        env: { ...process.env, REVIEW_TEST_FILE: file, REVIEW_TEST_WORKER: String(index) },
      })));
    assert.equal((await readReview(file)).threads.length, 12);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('updateReview leaves data unchanged and releases its lock when mutation fails', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  const file = path.join(directory, 'reviews.json');
  try {
    await assert.rejects(updateReview(file, () => { throw new Error('rejected'); }), /rejected/);
    await updateReview(file, review => {
      addThread(review, {
        path: 'src/a.ts', side: 'new', startLine: 1, endLine: 1,
        baseCommit: 'abcd', anchorText: 'change', author: 'agent', body: 'Inspect.',
      });
    });
    assert.equal((await readReview(file)).threads.length, 1);
    assert.deepEqual(await readdir(directory), ['reviews.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('updateReview recovers a lock left by a crashed process', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  const file = path.join(directory, 'reviews.json');
  const ready = path.join(directory, 'locked');
  const script = `
    const { updateReview } = await import('./src/core/store.ts');
    const { writeFile } = await import('node:fs/promises');
    await updateReview(process.env.REVIEW_TEST_FILE, async () => {
      await writeFile(process.env.REVIEW_TEST_READY, 'ready');
      await new Promise(() => setInterval(() => {}, 1000));
    });
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, REVIEW_TEST_FILE: file, REVIEW_TEST_READY: ready },
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 5_000;
    while (true) {
      try { await readFile(ready); break; } catch { /* Wait for the child to hold the lock. */ }
      assert.ok(child.exitCode === null && Date.now() < deadline, 'child did not acquire lock');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    child.kill('SIGKILL');
    await once(child, 'exit');
    await Promise.all(Array.from({ length: 8 }, (_, index) => updateReview(file, async review => {
      await new Promise(resolve => setTimeout(resolve, 5));
      addThread(review, {
        path: `src/recovered-${index}.ts`, side: 'new', startLine: 1, endLine: 1,
        baseCommit: 'abcd', anchorText: 'change', author: 'agent', body: 'Recovered.',
      });
    })));
    assert.equal((await readReview(file)).threads.length, 8);
  } finally {
    child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

test('commit threads round trip and reject an invalid commit hash', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  const file = path.join(directory, 'reviews.json');
  try {
    const review: ReviewDocument = { version: 1, threads: [] };
    const commit = 'b'.repeat(40);
    addThread(review, { path: '', side: 'new', startLine: 1, endLine: 1, baseCommit: commit, anchorText: '', commit, author: 'human', body: 'Body comment.' });
    assert.throws(() => addThread(review, { path: '', side: 'new', startLine: 1, endLine: 1, baseCommit: '', anchorText: '', author: 'human', body: 'No path.' }), /path/);
    await writeReview(file, review);
    assert.deepEqual(await readReview(file), review);
    await writeFile(file, JSON.stringify({ version: 1, threads: [{ ...review.threads[0], commit: 'HEAD' }] }));
    await assert.rejects(readReview(file), /Invalid review file/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
