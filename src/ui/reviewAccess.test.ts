import assert from 'node:assert/strict';
import test from 'node:test';
import { commentableReviewFileFor, reviewFileFor } from './reviewAccess';

test('virtual review content is limited to files in an active repository', () => {
  const file = { path: 'src/changed.ts', status: 'modified' as const };
  const states = new Map([['/active/repo', { files: [file] }]]);

  assert.equal(reviewFileFor(states, '/active/repo', 'src/changed.ts'), file);
  assert.equal(reviewFileFor(states, '/forged/repo', 'src/changed.ts'), undefined);
  assert.equal(reviewFileFor(states, '/active/repo', 'src/secret.ts'), undefined);
  assert.equal(reviewFileFor(states, '/active/repo', '../secret.ts'), undefined);
});

test('new comments require a genuinely changed text file', () => {
  const changed = { path: 'src/changed.ts', status: 'modified' as const };
  const binary = { path: 'image.bin', status: 'added' as const, binary: true };
  const states = new Map([['/repo', {
    files: [changed, binary, { path: 'src/retained.ts', status: 'threadOnly' as const }],
    changedFiles: [changed, binary],
  }]]);

  assert.equal(commentableReviewFileFor(states, '/repo', 'src/changed.ts'), changed);
  assert.equal(commentableReviewFileFor(states, '/repo', 'src/retained.ts'), undefined);
  assert.equal(commentableReviewFileFor(states, '/repo', 'image.bin'), undefined);
  assert.equal(commentableReviewFileFor(states, '/other', 'src/changed.ts'), undefined);
});
