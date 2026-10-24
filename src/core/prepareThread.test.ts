import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getChanges, getHeadSha } from './git';
import { prepareCommitThread, prepareThread, UnchangedLinesError } from './prepareThread';

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
      author: 'agent', body: 'Check.',
      location: { on: 'worktree', sha: getHeadSha(root), file: { path: 'file.txt', side: 'new', lines: [1, 2], text: 'first\nsecond' } },
    });
    assert.throws(() => prepareThread(root, changes, { ...input, path: 'missing.txt' }), /outside changed files/);
    assert.throws(() => prepareThread(root, changes, { ...input, endLine: 3 }), /outside the new side/);
    assert.throws(() => prepareThread(root, [{ ...changes[0], binary: true }], input), /binary file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('prepareCommitThread allows line threads only on lines the commit changed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'review-prepare-commit-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    const lines = Array.from({ length: 12 }, (_, index) => `l${index + 1}`);
    writeFileSync(path.join(root, 'file.txt'), lines.join('\n') + '\n');
    writeFileSync(path.join(root, 'image.bin'), Buffer.from([0, 1]));
    git('add', '-A');
    git('commit', '-qm', 'base');
    writeFileSync(path.join(root, 'file.txt'), ['l1', 'TWO', ...lines.slice(2), 'l13'].join('\n') + '\n');
    writeFileSync(path.join(root, 'image.bin'), Buffer.from([0, 2]));
    git('commit', '-qam', 'change');
    const commit = git('rev-parse', 'HEAD');
    const request = { author: 'agent' as const, body: 'Check.' };

    const text = async (side: 'old' | 'new', startLine: number, endLine: number) =>
      (await prepareCommitThread(root, commit, { ...request, path: 'file.txt', side, startLine, endLine })).location.file?.text;
    assert.deepEqual(await prepareCommitThread(root, commit.slice(0, 7), { ...request, path: 'file.txt', side: 'new', startLine: 2, endLine: 2 }), {
      ...request, location: { on: 'commit', sha: commit, file: { path: 'file.txt', side: 'new', lines: [2, 2], text: 'TWO' } },
    });
    assert.equal(await text('old', 2, 2), 'l2');
    assert.equal(await text('new', 13, 13), 'l13');
    // A range may take in the hunk's context lines, as in a pull request diff.
    assert.equal(await text('new', 2, 5), 'TWO\nl3\nl4\nl5');
    await assert.rejects(prepareCommitThread(root, commit, { ...request, path: 'file.txt', side: 'new', startLine: 7, endLine: 7 }), UnchangedLinesError);
    await assert.rejects(prepareCommitThread(root, commit, { ...request, path: 'file.txt', side: 'new', startLine: 2, endLine: 13 }), UnchangedLinesError);
    await assert.rejects(prepareCommitThread(root, commit, { ...request, path: 'image.bin', side: 'new', startLine: 1, endLine: 1 }), UnchangedLinesError);
    await assert.rejects(prepareCommitThread(root, 'no-such-commit', request), /Commit not found/);
    assert.deepEqual(await prepareCommitThread(root, commit, request), { ...request, location: { on: 'commit', sha: commit } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
