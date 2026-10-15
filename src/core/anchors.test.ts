import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorText, reviewLines, threadIsStale } from './anchors';

test('anchor helpers normalize CRLF and detect edited or removed lines', () => {
  const lines = reviewLines('first\r\nsecond\r\n');
  assert.deepEqual(lines, ['first', 'second']);
  assert.equal(anchorText(lines, 1, 2), 'first\nsecond');
  const thread = { startLine: 1, endLine: 2, anchorText: 'first\nsecond', stale: false };
  assert.equal(threadIsStale(thread, lines), false);
  assert.equal(threadIsStale(thread, ['first', 'changed']), true);
  assert.equal(threadIsStale(thread, ['first']), true);
});
