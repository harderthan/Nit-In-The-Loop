import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addAgentReply, addReply, addThread, setResolved, type FileRange, type ReviewDocument } from './review';

const empty = (): ReviewDocument => ({ version: 2, threads: [] });
const sha = 'a'.repeat(40);
const file = (extra: Partial<FileRange> = {}): FileRange => ({ path: 'a.ts', side: 'new', lines: [1, 1], text: 'line', ...extra });
const lineThread = (extra: Partial<FileRange> = {}) => ({ location: { on: 'worktree' as const, sha, file: file(extra) } });

test('addThread creates an open line thread with a human first comment', () => {
  const review = empty();
  const thread = addThread(review, {
    ...lineThread({ path: 'src/example.ts', lines: [2, 4], text: 'const answer = 42;' }),
    author: 'human', body: 'Please check this.',
  });

  assert.equal(review.threads.length, 1);
  assert.equal(review.threads[0], thread);
  assert.match(thread.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(thread.location, { on: 'worktree', sha, file: { path: 'src/example.ts', side: 'new', lines: [2, 4], text: 'const answer = 42;' } });
  assert.equal(thread.status, 'open');
  assert.equal(thread.comments.length, 1);
  assert.equal(thread.comments[0].author, 'human');
  assert.equal(thread.comments[0].body, 'Please check this.');
  assert.ok(!Number.isNaN(Date.parse(thread.comments[0].at)));
});

test('addThread copies its location so a later change to the input leaves the thread alone', () => {
  const review = empty();
  const input = { ...lineThread(), author: 'human' as const, body: 'Check.' };
  const thread = addThread(review, input);
  input.location.file.lines[0] = 9;
  assert.deepEqual(thread.location.file?.lines, [1, 1]);
});

test('addThread takes a commit thread with or without a file', () => {
  const review = empty();
  const body = addThread(review, { location: { on: 'commit', sha }, author: 'human', body: 'About the whole commit.' });
  assert.deepEqual(body.location, { on: 'commit', sha });
  const line = addThread(review, { location: { on: 'commit', sha, file: file({ side: 'old' }) }, author: 'human', body: 'This line.' });
  assert.equal(line.location.file?.side, 'old');
});

test('addReply appends an agent comment to the requested thread', () => {
  const review = empty();
  const thread = addThread(review, { ...lineThread({ side: 'old' }), author: 'human', body: 'Why?' });

  const reply = addReply(review, thread.id, { author: 'agent', body: 'Fixed.' });

  assert.deepEqual(thread.comments.map(comment => comment.body), ['Why?', 'Fixed.']);
  assert.equal(thread.comments[1], reply);
  assert.equal(reply.author, 'agent');
  assert.notEqual(reply.id, thread.comments[0].id);
});

test('setResolved closes and reopens a thread', () => {
  const review = empty();
  const thread = addThread(review, { ...lineThread(), author: 'agent', body: 'Check.' });

  assert.equal(setResolved(review, thread.id, true).status, 'resolved');
  assert.equal(setResolved(review, thread.id, false).status, 'open');
  assert.equal(thread.comments.length, 1);
});

test('replying to a resolved thread reopens it for review', () => {
  const review = empty();
  const thread = addThread(review, { ...lineThread(), author: 'agent', body: 'Check.' });
  setResolved(review, thread.id, true);

  addReply(review, thread.id, { author: 'human', body: 'One more issue.' });

  assert.equal(thread.status, 'open');
  assert.deepEqual(thread.comments.map(comment => comment.body), ['Check.', 'One more issue.']);
});

test('replying to a missing thread fails without changing the review', () => {
  const review = empty();
  assert.throws(() => addReply(review, 'missing', { author: 'agent', body: 'hello' }), /thread/i);
  assert.deepEqual(review, empty());
});

test('addThread rejects invalid locations before changing the document', () => {
  const review = empty();
  const input = { author: 'agent' as const, body: 'Check.' };
  assert.throws(() => addThread(review, { ...input, ...lineThread({ path: '' }) }), /path/i);
  assert.throws(() => addThread(review, { ...input, ...lineThread({ side: 'both' as 'new' }) }), /side/i);
  assert.throws(() => addThread(review, { ...input, ...lineThread({ lines: [3, 2] }) }), /line range/i);
  assert.throws(() => addThread(review, { ...input, ...lineThread({ text: null as unknown as string }) }), /anchor text/i);
  assert.throws(() => addThread(review, { ...input, location: { on: 'worktree', sha } as never }), /path/i);
  assert.throws(() => addThread(review, { ...input, location: { on: 'elsewhere', sha } as never }), /location/i);
  assert.throws(() => addThread(review, { ...input, location: { on: 'commit', sha: null } as never }), /commit/i);
  assert.deepEqual(review, empty());
});

test('an agent reply marks only the comments it answered as sent and keeps its session', () => {
  const review = empty();
  const thread = addThread(review, { ...lineThread(), author: 'human', body: 'First', queued: true });
  const answered = new Set(thread.comments.map(comment => comment.id));
  const later = addReply(review, thread.id, { author: 'human', body: 'While it ran', queued: true });
  setResolved(review, thread.id, true);
  const reply = addAgentReply(review, thread.id, 'Answer', answered, 'session-1');
  assert.equal(reply.author, 'agent');
  assert.equal(thread.comments[0].queued, undefined);
  assert.equal(later.queued, true);
  assert.deepEqual(thread.agent, { session: 'session-1' });
  assert.equal(thread.status, 'open');
});
