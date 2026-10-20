import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addAgentReply, addReply, addThread, setResolved, type ReviewDocument } from './review';

const empty = (): ReviewDocument => ({ version: 1, threads: [] });

test('addThread creates an open line thread with a human first comment', () => {
  const review = empty();
  const thread = addThread(review, {
    path: 'src/example.ts', side: 'new', startLine: 2, endLine: 4,
    baseCommit: 'a1b2c3', anchorText: 'const answer = 42;',
    author: 'human', body: 'Please check this.',
  });

  assert.equal(review.threads.length, 1);
  assert.equal(review.threads[0], thread);
  assert.match(thread.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ path: thread.path, side: thread.side, startLine: thread.startLine, endLine: thread.endLine },
    { path: 'src/example.ts', side: 'new', startLine: 2, endLine: 4 });
  assert.equal(thread.resolved, false);
  assert.equal(thread.stale, false);
  assert.equal(thread.comments.length, 1);
  assert.equal(thread.comments[0].author, 'human');
  assert.equal(thread.comments[0].body, 'Please check this.');
  assert.ok(!Number.isNaN(Date.parse(thread.comments[0].createdAt)));
});

test('addReply appends an agent comment to the requested thread', () => {
  const review = empty();
  const thread = addThread(review, {
    path: 'a.ts', side: 'old', startLine: 1, endLine: 1,
    baseCommit: 'abc', anchorText: 'old line', author: 'human', body: 'Why?',
  });

  const reply = addReply(review, thread.id, { author: 'agent', body: 'Fixed.' });

  assert.deepEqual(thread.comments.map(comment => comment.body), ['Why?', 'Fixed.']);
  assert.equal(thread.comments[1], reply);
  assert.equal(reply.author, 'agent');
  assert.notEqual(reply.id, thread.comments[0].id);
});

test('setResolved closes and reopens a thread', () => {
  const review = empty();
  const thread = addThread(review, {
    path: 'a.ts', side: 'new', startLine: 1, endLine: 1,
    baseCommit: 'abc', anchorText: 'line', author: 'agent', body: 'Check.',
  });

  assert.equal(setResolved(review, thread.id, true).resolved, true);
  assert.equal(setResolved(review, thread.id, false).resolved, false);
  assert.equal(thread.comments.length, 1);
});

test('replying to a resolved thread reopens it for review', () => {
  const review = empty();
  const thread = addThread(review, {
    path: 'a.ts', side: 'new', startLine: 1, endLine: 1,
    baseCommit: 'abc', anchorText: 'line', author: 'agent', body: 'Check.',
  });
  setResolved(review, thread.id, true);

  addReply(review, thread.id, { author: 'human', body: 'One more issue.' });

  assert.equal(thread.resolved, false);
  assert.deepEqual(thread.comments.map(comment => comment.body), ['Check.', 'One more issue.']);
});

test('replying to a missing thread fails without changing the review', () => {
  const review = empty();
  assert.throws(() => addReply(review, 'missing', { author: 'agent', body: 'hello' }), /thread/i);
  assert.deepEqual(review, empty());
});

test('addThread rejects invalid persisted fields before changing the document', () => {
  const review = empty();
  const input = {
    path: 'a.ts', side: 'new' as const, startLine: 1, endLine: 1,
    baseCommit: 'abc', anchorText: 'line', author: 'agent' as const, body: 'Check.',
  };
  assert.throws(() => addThread(review, { ...input, path: '' }), /path/i);
  assert.throws(() => addThread(review, { ...input, baseCommit: null as unknown as string }), /base commit/i);
  assert.throws(() => addThread(review, { ...input, anchorText: null as unknown as string }), /anchor text/i);
  assert.deepEqual(review, empty());
});

test('an agent reply marks only the comments it answered as sent and keeps its session', () => {
  const review: ReviewDocument = { version: 1, threads: [] };
  const thread = addThread(review, {
    path: 'a.ts', side: 'new', startLine: 1, endLine: 1, baseCommit: '', anchorText: 'a', author: 'human', body: 'First', queued: true,
  });
  const answered = new Set(thread.comments.map(comment => comment.id));
  const later = addReply(review, thread.id, { author: 'human', body: 'While it ran', queued: true });
  thread.resolved = true;
  const reply = addAgentReply(review, thread.id, 'Answer', answered, 'session-1');
  assert.equal(reply.author, 'agent');
  assert.equal(thread.comments[0].queued, undefined);
  assert.equal(later.queued, true);
  assert.equal(thread.agentSession, 'session-1');
  assert.equal(thread.resolved, false);
});
