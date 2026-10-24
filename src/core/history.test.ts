import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { getCommitHunkLines, getCommitContent, getCommitFiles, getCommitParent, getCommitSummary, getCurrentBranch, getRepositoryHistory, rangeIsChanged, resolveCommit } from './history';

const repositories: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nitl-history-'));
  repositories.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  return root;
}

function commit(root: string, subject: string, author: string, date: string): string {
  git(root, 'add', '-A');
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

test('returns an empty timeline for an unborn repository', async () => {
  assert.deepEqual(await getRepositoryHistory(repository()), []);
});

test('surfaces invalid repository errors', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nitl-not-repository-'));
  repositories.push(directory);
  await assert.rejects(getRepositoryHistory(directory));
});

test('lists repository commits newest first with author, date, subject, and limit', async () => {
  const root = repository();
  writeFileSync(path.join(root, 'a.txt'), 'one\n');
  const first = commit(root, 'Initial commit', 'Alice', '2020-01-02T03:04:05+0000');
  writeFileSync(path.join(root, 'a.txt'), 'two\n');
  const second = commit(root, 'Change content', 'Bob', '2020-02-03T04:05:06+0000');
  const branch = git(root, 'branch', '--show-current');

  assert.deepEqual(await getRepositoryHistory(root), [
    { hash: second, author: 'Bob', date: '2020-02-03T04:05:06.000Z', subject: 'Change content', refs: ['HEAD', branch], branch },
    { hash: first, author: 'Alice', date: '2020-01-02T03:04:05.000Z', subject: 'Initial commit', refs: [], branch },
  ]);
  assert.deepEqual(await getRepositoryHistory(root, 1), [
    { hash: second, author: 'Bob', date: '2020-02-03T04:05:06.000Z', subject: 'Change content', refs: ['HEAD', branch], branch },
  ]);
  assert.deepEqual(await getCommitFiles(root, second), [{ path: 'a.txt', status: 'modified' }]);
});

test('lists the current branch, its upstream, and the default branch but no other branch', async () => {
  const origin = repository();
  writeFileSync(path.join(origin, 'base.txt'), 'base\n');
  const base = commit(origin, 'Base', 'Alice', '2020-01-01T00:00:00+0000');
  const main = git(origin, 'branch', '--show-current');
  git(origin, 'checkout', '-qb', 'pushed');
  writeFileSync(path.join(origin, 'pushed.txt'), 'pushed\n');
  const pushed = commit(origin, 'Pushed', 'Alice', '2020-03-01T00:00:00+0000');
  git(origin, 'checkout', '-qb', 'unrelated', base);
  writeFileSync(path.join(origin, 'unrelated.txt'), 'unrelated\n');
  commit(origin, 'Unrelated', 'Bob', '2020-05-01T00:00:00+0000');
  git(origin, 'checkout', '-q', main);
  writeFileSync(path.join(origin, 'main.txt'), 'main\n');
  const mainTip = commit(origin, 'Main', 'Bob', '2020-06-01T00:00:00+0000');

  const root = mkdtempSync(path.join(tmpdir(), 'nitl-history-clone-'));
  repositories.push(root);
  git(origin, 'clone', '-q', origin, root);
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'checkout', '-qb', 'topic', 'origin/pushed');
  writeFileSync(path.join(root, 'topic.txt'), 'topic\n');
  const topic = commit(root, 'Topic', 'Alice', '2020-04-01T00:00:00+0000');

  assert.equal(await getCurrentBranch(root), 'topic');
  assert.deepEqual((await getRepositoryHistory(root)).map(({ hash, refs, branch }) => ({ hash, refs, branch })), [
    { hash: topic, refs: ['HEAD', 'topic'], branch: 'topic' },
    { hash: pushed, refs: ['origin/pushed'], branch: 'topic' },
    { hash: mainTip, refs: [`origin/${main}`], branch: `origin/${main}` },
    { hash: base, refs: [], branch: 'topic' },
  ]);
  assert.deepEqual((await getRepositoryHistory(root, 1)).map(({ hash }) => hash), [topic]);
});

test('lists only a detached HEAD when it has no upstream or default branch', async () => {
  const root = repository();
  writeFileSync(path.join(root, 'base.txt'), 'base\n');
  const base = commit(root, 'Base', 'Alice', '2020-01-01T00:00:00+0000');
  writeFileSync(path.join(root, 'branch.txt'), 'branch\n');
  commit(root, 'Tip', 'Bob', '2020-02-01T00:00:00+0000');
  git(root, 'checkout', '--detach', '-q', base);
  writeFileSync(path.join(root, 'detached.txt'), 'detached\n');
  const detached = commit(root, 'Detached', 'Alice', '2020-03-01T00:00:00+0000');

  assert.equal(await getCurrentBranch(root), '');
  assert.deepEqual((await getRepositoryHistory(root)).map(({ hash, refs, branch }) => ({ hash, refs, branch })), [
    { hash: detached, refs: ['HEAD'], branch: 'HEAD' },
    { hash: base, refs: [], branch: 'HEAD' },
  ]);
});

test('reuses unchanged history and refreshes labels when refs or the current branch change', async () => {
  const root = repository();
  writeFileSync(path.join(root, 'file.txt'), 'content\n');
  const tip = commit(root, 'Initial', 'Alice', '2020-01-01T00:00:00+0000');
  const main = git(root, 'branch', '--show-current');
  const tracePath = path.join(root, 'git-trace.log');
  const previousTrace = process.env.GIT_TRACE;
  process.env.GIT_TRACE = tracePath;
  const ancestryWalks = () => (readFileSync(tracePath, 'utf8').match(/built-in: git rev-list /g) ?? []).length;

  try {
    assert.equal((await getRepositoryHistory(root))[0].hash, tip);
    const firstWalks = ancestryWalks();
    assert.ok(firstWalks > 0);
    await getRepositoryHistory(root);
    assert.equal(ancestryWalks(), firstWalks);

    git(root, 'branch', 'other');
    assert.deepEqual((await getRepositoryHistory(root))[0].refs, ['HEAD', main]);
    git(root, 'checkout', '-q', 'other');
    const switched = (await getRepositoryHistory(root))[0];
    assert.deepEqual(switched.refs, ['HEAD', 'other']);
    assert.equal(switched.branch, 'other');
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previousTrace;
  }
});

test('lists root and later commit files including rename and paths with spaces', async () => {
  const root = repository();
  mkdirSync(path.join(root, 'some dir'));
  writeFileSync(path.join(root, 'some dir', 'old name.txt'), 'same\n');
  writeFileSync(path.join(root, 'deleted.txt'), 'remove\n');
  const first = commit(root, 'Initial', 'Alice', '2020-01-02T03:04:05+0000');
  assert.deepEqual(await getCommitFiles(root, first), [
    { path: 'deleted.txt', status: 'added' },
    { path: 'some dir/old name.txt', status: 'added' },
  ]);
  assert.equal(await getCommitParent(root, first), '');

  git(root, 'mv', 'some dir/old name.txt', 'some dir/new name.txt');
  git(root, 'rm', 'deleted.txt');
  writeFileSync(path.join(root, 'added file.txt'), 'new\n');
  const second = commit(root, 'Rename and delete', 'Bob', '2020-02-03T04:05:06+0000');
  assert.equal(await getCommitParent(root, second), first);
  assert.deepEqual(await getCommitFiles(root, second), [
    { path: 'added file.txt', status: 'added' },
    { path: 'deleted.txt', status: 'deleted' },
    { path: 'some dir/new name.txt', oldPath: 'some dir/old name.txt', status: 'renamed' },
  ]);
});

test('reads content from its commit and returns empty content for absent paths', async () => {
  const root = repository();
  writeFileSync(path.join(root, 'old name.txt'), 'original\n');
  const first = commit(root, 'Initial', 'Alice', '2020-01-02T03:04:05+0000');
  git(root, 'mv', 'old name.txt', 'new name.txt');
  const second = commit(root, 'Rename', 'Bob', '2020-02-03T04:05:06+0000');

  assert.equal(await getCommitContent(root, first, 'old name.txt'), 'original\n');
  assert.equal(await getCommitContent(root, first, 'new name.txt'), '');
  assert.equal(await getCommitContent(root, second, 'new name.txt'), 'original\n');
  assert.equal(await getCommitContent(root, second, 'old name.txt'), '');
});

test('shows a preview marker for binary or oversized committed blobs', async () => {
  const root = repository();
  writeFileSync(path.join(root, 'nul.bin'), Buffer.from([65, 0, 66]));
  writeFileSync(path.join(root, 'invalid.bin'), Buffer.from([0xc3, 0x28]));
  writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(32 * 1024 * 1024 + 1, 65));
  const hash = commit(root, 'Binary files', 'Alice', '2020-01-02T03:04:05+0000');

  for (const name of ['nul.bin', 'invalid.bin', 'large.txt']) {
    assert.equal(await getCommitContent(root, hash, name), 'Binary file: preview unavailable.');
  }
});

test('lists merge commit files relative to its first parent', async () => {
  const root = repository();
  writeFileSync(path.join(root, 'base.txt'), 'base\n');
  commit(root, 'Initial', 'Alice', '2020-01-02T03:04:05+0000');
  const branch = git(root, 'branch', '--show-current');
  git(root, 'checkout', '-qb', 'feature');
  writeFileSync(path.join(root, 'feature.txt'), 'feature\n');
  commit(root, 'Feature', 'Alice', '2020-02-03T04:05:06+0000');
  git(root, 'checkout', '-q', branch);
  writeFileSync(path.join(root, 'base.txt'), 'main update\n');
  const mainCommit = commit(root, 'Main update', 'Bob', '2020-03-04T05:06:07+0000');
  git(root, 'merge', '--no-ff', '-qm', 'Merge feature', 'feature');
  const merge = git(root, 'rev-parse', 'HEAD');

  assert.equal(await getCommitParent(root, merge), mainCommit);
  assert.deepEqual(await getCommitFiles(root, merge), [{ path: 'feature.txt', status: 'added' }]);
});

test('rejects unsafe hashes and repository-escaping content paths', async () => {
  const root = repository();
  await assert.rejects(getCommitFiles(root, 'HEAD; echo unsafe'), /hash/i);
  await assert.rejects(getCommitParent(root, 'HEAD'), /hash/i);
  await assert.rejects(getCommitContent(root, 'a'.repeat(40), '../outside.txt'), /repository/i);
  await assert.rejects(getCommitContent(root, 'a'.repeat(40), '/tmp/outside.txt'), /repository/i);
  await assert.rejects(getCommitContent(root, 'a'.repeat(40), 'missing.txt'));
});

test('reports changed line ranges per side, including added, deleted, and renamed files', async () => {
  const root = repository();
  const kept = 'abcdefghijkl'.split('');
  writeFileSync(path.join(root, 'kept.txt'), kept.join('\n') + '\n');
  writeFileSync(path.join(root, 'gone.txt'), 'x\ny\n');
  writeFileSync(path.join(root, 'old name.txt'), 'same\nsame\nsame\n');
  const first = commit(root, 'Initial', 'Alice', '2020-01-02T03:04:05+0000');
  assert.deepEqual(await getCommitHunkLines(root, first, 'kept.txt', 'new'), [[1, 12]]);
  assert.deepEqual(await getCommitHunkLines(root, first, 'kept.txt', 'old'), []);

  writeFileSync(path.join(root, 'kept.txt'), ['a', 'B', ...kept.slice(2), 'm'].join('\n') + '\n');
  git(root, 'rm', '-q', 'gone.txt');
  git(root, 'mv', 'old name.txt', 'new name.txt');
  writeFileSync(path.join(root, 'new name.txt'), 'same\nsame\nchanged\n');
  const second = commit(root, 'Change', 'Bob', '2020-02-03T04:05:06+0000');
  // Each hunk holds its change and up to three context lines on either side.
  assert.deepEqual(await getCommitHunkLines(root, second, 'kept.txt', 'new'), [[1, 5], [10, 13]]);
  assert.deepEqual(await getCommitHunkLines(root, second, 'kept.txt', 'old'), [[1, 5], [10, 12]]);
  assert.deepEqual(await getCommitHunkLines(root, second, 'gone.txt', 'old'), [[1, 2]]);
  assert.deepEqual(await getCommitHunkLines(root, second, 'gone.txt', 'new'), []);
  assert.deepEqual(await getCommitHunkLines(root, second, 'new name.txt', 'new'), [[1, 3]]);
  assert.deepEqual(await getCommitHunkLines(root, second, 'old name.txt', 'old'), [[1, 3]]);
  assert.deepEqual(await getCommitHunkLines(root, second, 'missing.txt', 'new'), []);
  writeFileSync(path.join(root, '[id].ts'), 'one\n');
  writeFileSync(path.join(root, 'i.ts'), Array.from({ length: 9 }, (_, index) => `${index}`).join('\n') + '\n');
  const third = commit(root, 'Glob names', 'Bob', '2020-03-03T04:05:06+0000');
  writeFileSync(path.join(root, 'i.ts'), Array.from({ length: 9 }, (_, index) => index === 8 ? 'nine' : `${index}`).join('\n') + '\n');
  writeFileSync(path.join(root, '[id].ts'), 'ONE\n');
  const fourth = commit(root, 'Change both', 'Bob', '2020-04-03T04:05:06+0000');
  assert.ok(third);
  assert.deepEqual(await getCommitHunkLines(root, fourth, '[id].ts', 'new'), [[1, 1]]);
  assert.equal(rangeIsChanged([[2, 4]], 2, 4), true);
  assert.equal(rangeIsChanged([[2, 2], [4, 4]], 2, 4), false);

  assert.equal(await resolveCommit(root, second.slice(0, 7)), second);
  await assert.rejects(resolveCommit(root, '--all'), /Invalid commit/);
  assert.match(await getCommitSummary(root, second), /Change[\s\S]*kept\.txt/);
});
