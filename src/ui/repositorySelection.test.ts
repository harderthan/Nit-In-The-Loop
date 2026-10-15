import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRepositoryRoot } from './repositorySelection';

test('selects the repository of an active review URI', () => {
  assert.equal(selectRepositoryRoot(['/repo/a', '/repo/b'], '/repo/b', undefined), '/repo/b');
});

test('selects the deepest repository containing an active file', () => {
  assert.equal(selectRepositoryRoot(['/repo', '/repo/nested'], undefined, '/repo/nested/file.ts'), '/repo/nested');
  assert.equal(selectRepositoryRoot(['/repo/a', '/repo/b'], undefined, '/repo/b/file.ts'), '/repo/b');
});

test('does not guess between unrelated repositories', () => {
  assert.equal(selectRepositoryRoot(['/repo/a', '/repo/b'], undefined, '/other/file.ts'), undefined);
  assert.equal(selectRepositoryRoot(['/repo/a'], undefined, undefined), '/repo/a');
});
