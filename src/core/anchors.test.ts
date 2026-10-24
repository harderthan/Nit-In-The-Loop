import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorText, rangeIsStale, reviewLines } from './anchors';

test('anchor helpers normalize CRLF and detect edited or removed lines', () => {
  const lines = reviewLines('first\r\nsecond\r\n');
  assert.deepEqual(lines, ['first', 'second']);
  assert.equal(anchorText(lines, 1, 2), 'first\nsecond');
  const file = { lines: [1, 2] as [number, number], text: 'first\r\nsecond' };
  assert.equal(rangeIsStale(file, lines), false);
  assert.equal(rangeIsStale(file, ['first', 'changed']), true);
  assert.equal(rangeIsStale(file, ['first']), true);
});
