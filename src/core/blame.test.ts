import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { getFileBlame } from './blame';

const repositories: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nitl-blame-'));
  repositories.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  return root;
}

function commit(root: string, file: string, content: string, author: string, subject: string, date: string): string {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content);
  git(root, 'add', file);
  execFileSync('git', ['commit', '-qm', subject], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author,
      GIT_AUTHOR_EMAIL: `${author.toLowerCase()}@example.com`,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
  return git(root, 'rev-parse', 'HEAD');
}

afterEach(() => {
  for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('groups lines by their commits in file order with commit metadata', async () => {
  const root = repository();
  const first = commit(root, 'dir/file name.txt', 'alpha\nbeta\ngamma\n', 'Alice', 'Initial lines', '2020-01-02T03:04:05+0000');
  const second = commit(root, 'dir/file name.txt', 'alpha\nchanged\ngamma\n', 'Bob', 'Change middle', '2020-02-03T04:05:06+0000');

  assert.deepEqual(await getFileBlame(root, 'dir/file name.txt'), [
    { hash: first, author: 'Alice', date: '2020-01-02T03:04:05.000Z', subject: 'Initial lines', lines: [1, 3] },
    { hash: second, author: 'Bob', date: '2020-02-03T04:05:06.000Z', subject: 'Change middle', lines: [2] },
  ]);
});

test('uses HEAD content rather than uncommitted working changes', async () => {
  const root = repository();
  const hash = commit(root, 'file.txt', 'committed\n', 'Alice', 'Base', '2020-01-02T03:04:05+0000');
  writeFileSync(path.join(root, 'file.txt'), 'working\nextra\n');

  assert.deepEqual(await getFileBlame(root, 'file.txt'), [
    { hash, author: 'Alice', date: '2020-01-02T03:04:05.000Z', subject: 'Base', lines: [1] },
  ]);
});

test('returns no blame for untracked files and unborn repositories', async () => {
  const root = repository();
  writeFileSync(path.join(root, 'untracked.txt'), 'new\n');
  assert.deepEqual(await getFileBlame(root, 'untracked.txt'), []);
  commit(root, 'tracked.txt', 'tracked\n', 'Alice', 'Base', '2020-01-02T03:04:05+0000');
  assert.deepEqual(await getFileBlame(root, 'untracked.txt'), []);
});

test('rejects paths outside the repository, including symlinked parents', async () => {
  const root = repository();
  const outside = mkdtempSync(path.join(tmpdir(), 'nitl-blame-outside-'));
  repositories.push(outside);
  symlinkSync(outside, path.join(root, 'outside'));
  await assert.rejects(getFileBlame(root, '../outside.txt'), /repository/i);
  await assert.rejects(getFileBlame(root, '/tmp/outside.txt'), /repository/i);
  await assert.rejects(getFileBlame(root, 'outside/file.txt'), /repository/i);
});
