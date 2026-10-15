import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getChanges, getHeadSha } from './git';
import { prepareThread } from './prepareThread';

test('prepareThread builds a normalized anchor from a changed file snapshot', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'review-prepare-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  try {
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    writeFileSync(path.join(root, 'file.txt'), 'before\n');
    git('add', 'file.txt');
    git('commit', '-qm', 'base');
    writeFileSync(path.join(root, 'file.txt'), 'first\r\nsecond\r\n');
    const changes = getChanges(root);
    const input = { path: 'file.txt', side: 'new' as const, startLine: 1, endLine: 2,
      author: 'agent' as const, body: 'Check.' };
    assert.deepEqual(prepareThread(root, changes, input), {
      ...input, baseCommit: getHeadSha(root), anchorText: 'first\nsecond',
    });
    assert.throws(() => prepareThread(root, changes, { ...input, path: 'missing.txt' }), /outside changed files/);
    assert.throws(() => prepareThread(root, changes, { ...input, endLine: 3 }), /outside the new side/);
    assert.throws(() => prepareThread(root, [{ ...changes[0], binary: true }], input), /binary file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
