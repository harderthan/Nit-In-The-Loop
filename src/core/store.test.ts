import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { addAgentReply, addReply, addThread, type NewThread, type ReviewDocument } from './review';
import { readReview, updateReview, writeReview } from './store';

const line = (filePath: string, body: string, lineNumber = 1): NewThread => ({
  location: { on: 'worktree', sha: '', file: { path: filePath, side: 'new', lines: [lineNumber, lineNumber], text: 'change' } },
  author: 'agent', body,
});

test('missing review file reads as an empty versioned document', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  try {
    assert.deepEqual(await readReview(path.join(directory, 'missing.json')), { version: 2, threads: [] });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('writeReview round trips a versioned thread and creates parent directory', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  const file = path.join(directory, 'nested', 'reviews.json');
  try {
    const review: ReviewDocument = { version: 2, threads: [] };
    addThread(review, line('src/a.ts', 'Inspect this.', 5));
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
    const unsupported = '{"version":3,"threads":[]}';
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
      addThread(review, line(`src/${index}.ts`, `Inspect ${index}.`, 1));
    })));
    const review = await readReview(file);
    assert.equal(review.threads.length, 12);
    assert.deepEqual(review.threads.map(thread => thread.location.file?.path).sort(),
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
          location: { on: 'worktree', sha: '', file: { path: 'src/' + process.env.REVIEW_TEST_WORKER + '-' + i + '.ts', side: 'new', lines: [1, 1], text: 'change' } },
          author: 'agent', body: 'Inspect.',
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
      addThread(review, line('src/a.ts', 'Inspect.', 1));
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
      addThread(review, line(`src/recovered-${index}.ts`, 'Recovered.', 1));
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
    const review: ReviewDocument = { version: 2, threads: [] };
    addThread(review, { location: { on: 'commit', sha: 'b'.repeat(40) }, author: 'human', body: 'Body comment.' });
    await writeReview(file, review);
    assert.deepEqual(await readReview(file), review);
    await writeFile(file, JSON.stringify({ version: 2, threads: [{ ...review.threads[0], location: { on: 'commit', sha: 'HEAD' } }] }));
    await assert.rejects(readReview(file), /Invalid review file/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a version 1 file reads as version 2 and is saved as version 2 on the next write', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  const file = path.join(directory, 'reviews.json');
  const commit = 'c'.repeat(40);
  const comment = { id: 'c1', author: 'human', body: 'Why?', createdAt: '2026-01-01T00:00:00.000Z' };
  const v1 = {
    version: 1,
    threads: [
      { id: 't1', path: 'a.ts', side: 'old', startLine: 2, endLine: 3, baseCommit: commit, anchorText: 'x', stale: false, resolved: true,
        agentSession: 's1', comments: [{ ...comment, queued: true }] },
      { id: 't2', path: 'b.ts', side: 'new', startLine: 1, endLine: 1, baseCommit: commit, anchorText: 'y', commit, stale: false, resolved: false, comments: [comment] },
      { id: 't3', path: '', side: 'new', startLine: 1, endLine: 1, baseCommit: commit, anchorText: '', commit, stale: false, resolved: false, comments: [comment] },
    ],
  };
  try {
    await writeFile(file, JSON.stringify(v1));
    const upgraded = await readReview(file);
    const at = comment.createdAt;
    assert.deepEqual(upgraded, {
      version: 2,
      threads: [
        { id: 't1', status: 'resolved', location: { on: 'worktree', sha: commit, file: { path: 'a.ts', side: 'old', lines: [2, 3], text: 'x' } },
          agent: { session: 's1' }, comments: [{ id: 'c1', author: 'human', body: 'Why?', at, queued: true }] },
        { id: 't2', status: 'open', location: { on: 'commit', sha: commit, file: { path: 'b.ts', side: 'new', lines: [1, 1], text: 'y' } },
          comments: [{ id: 'c1', author: 'human', body: 'Why?', at }] },
        { id: 't3', status: 'open', location: { on: 'commit', sha: commit }, comments: [{ id: 'c1', author: 'human', body: 'Why?', at }] },
      ],
    });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1);
    await updateReview(file, () => {});
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), upgraded);
    await writeFile(file, JSON.stringify({ version: 1, threads: [{ ...v1.threads[0], side: 'both' }] }));
    await assert.rejects(readReview(file), /Invalid review file/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function schemaValidator() {
  const Ajv2020 = (await import('ajv/dist/2020')).default;
  const addFormats = (await import('ajv-formats')).default;
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(await readFile(path.join(process.cwd(), 'schema', 'review.schema.json'), 'utf8')));
  return { validate, errors: () => ajv.errorsText(validate.errors) };
}

test('the JSON Schema and the store validator accept and reject the same documents', async () => {
  const schema = await schemaValidator();
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  const file = path.join(directory, 'reviews.json');
  const matchesStore = async (document: unknown) => {
    await writeFile(file, JSON.stringify(document));
    return readReview(file).then(() => true, () => false);
  };
  const sha = 'e'.repeat(40);
  const comment = { id: 'c1', author: 'human', body: 'Check.', at: '2026-01-01T00:00:00.000Z' };
  const fileRange = { path: 'a.ts', side: 'new', lines: [1, 2], text: 'x' };
  const thread = { id: 't1', status: 'open', location: { on: 'worktree', sha, file: fileRange }, comments: [comment] };
  const withFile = (extra: object) => ({ version: 2, threads: [{ ...thread, location: { on: 'worktree', sha, file: { ...fileRange, ...extra } } }] });
  const withThread = (extra: object) => ({ version: 2, threads: [{ ...thread, ...extra }] });
  const withComment = (extra: object) => withThread({ comments: [{ ...comment, ...extra }] });
  const valid = [
    { version: 2, threads: [] },
    withThread({}),
    withThread({ location: { on: 'worktree', sha: '', file: fileRange } }),
    withThread({ status: 'resolved', agent: { session: 's' }, comments: [{ ...comment, queued: true }, { ...comment, id: 'c2', author: 'agent' }] }),
    withThread({ location: { on: 'commit', sha } }),
    withThread({ location: { on: 'commit', sha: 'f'.repeat(64), file: { ...fileRange, side: 'old' } } }),
    withComment({ at: '2024-02-29T23:59:59+09:00' }),
  ];
  const invalid = [
    { version: 2 },
    { version: 2, threads: [], extra: true },
    withThread({ status: 'closed' }),
    withThread({ comments: [] }),
    withThread({ extra: 1 }),
    withThread({ agent: {} }),
    withThread({ location: { on: 'worktree', sha } }),
    withThread({ location: { on: 'worktree', sha: 'abc', file: fileRange } }),
    withThread({ location: { on: 'commit', sha: '' } }),
    withThread({ location: { on: 'branch', sha } }),
    withFile({ path: '' }),
    withFile({ side: 'both' }),
    withFile({ lines: [0, 1] }),
    withFile({ lines: [1] }),
    withFile({ lines: [1.5, 2] }),
    withFile({ extra: true }),
    withComment({ author: 'bot' }),
    withComment({ body: '  ' }),
    withComment({ at: 'yesterday' }),
    withComment({ queued: 'yes' }),
    withFile({ lines: [1, 1e300] }),
    withComment({ at: '2026-01-01' }),
    withComment({ at: 'Jan 1 2026' }),
    withComment({ at: '2026-02-30T00:00:00Z' }),
  ];
  try {
    for (const document of valid) {
      assert.equal(schema.validate(document), true, `schema rejects ${JSON.stringify(document)}: ${schema.errors()}`);
      assert.equal(await matchesStore(document), true, `store rejects ${JSON.stringify(document)}`);
    }
    for (const document of invalid) {
      assert.equal(schema.validate(document), false, `schema accepts ${JSON.stringify(document)}`);
      assert.equal(await matchesStore(document), false, `store accepts ${JSON.stringify(document)}`);
    }
    // JSON Schema cannot compare two array items, so only the store rejects a reversed range.
    const reversed = withFile({ lines: [3, 1] });
    assert.equal(schema.validate(reversed), true);
    assert.equal(await matchesStore(reversed), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a review that the store writes matches the JSON Schema', async () => {
  const schema = await schemaValidator();
  const directory = await mkdtemp(path.join(tmpdir(), 'review-store-'));
  const file = path.join(directory, 'reviews.json');
  try {
    await updateReview(file, review => {
      const thread = addThread(review, line('a.ts', 'First.'));
      addReply(review, thread.id, { author: 'human', body: 'Queued.', queued: true });
      addAgentReply(review, thread.id, 'Done.', new Set([thread.comments[0].id]), 'session');
      addThread(review, { location: { on: 'commit', sha: 'a'.repeat(40) }, author: 'human', body: 'Commit.' });
    });
    assert.equal(schema.validate(JSON.parse(await readFile(file, 'utf8'))), true, schema.errors());
  } finally { await rm(directory, { recursive: true, force: true }); }
});
