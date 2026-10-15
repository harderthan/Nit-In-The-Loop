import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  discoverRepository,
  getChanges,
  getChangesAsync,
  getHeadContent,
  getHeadSha,
  getStorePath,
  getWorkingContent,
} from './git';

const repositories: string[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-review-git-'));
  repositories.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  return root;
}

function commit(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), content);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
}

afterEach(() => {
  for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('discovers repository from nested path and keeps review data inside its Git directory', () => {
  const root = repository();
  commit(root, { 'nested/file.txt': 'base\n' });
  assert.equal(discoverRepository(path.join(root, 'nested')), realpathSync(root));
  assert.equal(getStorePath(root), path.join(realpathSync(root), '.git', 'agent-review', 'review.json'));
  assert.equal(getHeadSha(root), git(root, 'rev-parse', 'HEAD'));
});

test('reports staged and unstaged text changes against HEAD', () => {
  const root = repository();
  commit(root, { 'staged.txt': 'base\n', 'working.txt': 'base\n' });
  writeFileSync(path.join(root, 'staged.txt'), 'staged\n');
  git(root, 'add', 'staged.txt');
  writeFileSync(path.join(root, 'working.txt'), 'working\n');
  assert.deepEqual(getChanges(root), [
    { path: 'staged.txt', status: 'modified', binary: false },
    { path: 'working.txt', status: 'modified', binary: false },
  ]);
  assert.equal(getHeadContent(root, 'staged.txt'), 'base\n');
  assert.equal(getWorkingContent(root, 'staged.txt'), 'staged\n');
  assert.equal(getWorkingContent(root, 'working.txt'), 'working\n');
});

test('async change discovery matches synchronous results for text and binary changes', async () => {
  const root = repository();
  commit(root, { 'tracked.txt': 'base\n', 'binary.dat': '\0before' });
  writeFileSync(path.join(root, 'tracked.txt'), 'changed\n');
  writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
  writeFileSync(path.join(root, 'new.bin'), Buffer.from([0, 3, 4]));
  assert.deepEqual(await getChangesAsync(root), getChanges(root));
});

test('async change discovery handles renames, symlinks, and an unborn repository', async () => {
  const root = repository();
  writeFileSync(path.join(root, 'first.txt'), 'first\n');
  assert.deepEqual(await getChangesAsync(root), [{ path: 'first.txt', status: 'added', binary: false }]);
  git(root, 'add', 'first.txt');
  git(root, 'commit', '-qm', 'base');
  git(root, 'mv', 'first.txt', 'renamed.txt');
  const external = mkdtempSync(path.join(tmpdir(), 'agent-review-external-'));
  repositories.push(external);
  symlinkSync(path.join(external, 'missing'), path.join(root, 'link.txt'));
  assert.deepEqual(await getChangesAsync(root), getChanges(root));
});

test('async binary detection checks content beyond the first read chunk', async () => {
  const root = repository();
  commit(root, { 'tracked.txt': 'base\n' });
  writeFileSync(path.join(root, 'late-nul.bin'), Buffer.concat([Buffer.alloc(70_000, 65), Buffer.from([0])]));
  assert.deepEqual(await getChangesAsync(root), getChanges(root));
  assert.equal((await getChangesAsync(root))[0].binary, true);
});

test('Git content access does not open an untracked FIFO', t => {
  const root = repository();
  commit(root, { 'tracked.txt': 'base\n' });
  const fifo = path.join(root, 'pipe');
  const made = spawnSync('mkfifo', [fifo]);
  if (made.error && (made.error as NodeJS.ErrnoException).code === 'ENOENT') {
    t.skip('mkfifo is unavailable');
    return;
  }
  assert.equal(made.status, 0, made.stderr?.toString());
  const script = `
    const { getChanges, getChangesAsync, getWorkingContent } = await import('./src/core/git.ts');
    const content = getWorkingContent(process.env.REVIEW_TEST_ROOT, 'pipe');
    const changes = process.env.REVIEW_TEST_ASYNC === '1'
      ? await getChangesAsync(process.env.REVIEW_TEST_ROOT)
      : getChanges(process.env.REVIEW_TEST_ROOT);
    process.stdout.write(JSON.stringify({ content, changes }));
  `;
  for (const asyncMode of ['0', '1']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      env: { ...process.env, REVIEW_TEST_ROOT: root, REVIEW_TEST_ASYNC: asyncMode },
      encoding: 'utf8',
      timeout: 2_000,
    });
    assert.equal(result.status, 0, `${asyncMode}: ${result.error?.message ?? result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { content: '', changes: [] });
  }
});

test('uses an empty base for untracked text files', () => {
  const root = repository();
  commit(root, { 'tracked.txt': 'base\n' });
  writeFileSync(path.join(root, 'new file.txt'), 'new\n');
  assert.deepEqual(getChanges(root), [{ path: 'new file.txt', status: 'added', binary: false }]);
  assert.equal(getHeadContent(root, 'new file.txt'), '');
  assert.equal(getWorkingContent(root, 'new file.txt'), 'new\n');
});

test('does not disguise an unknown HEAD path as an added file', () => {
  const root = repository();
  commit(root, { 'tracked.txt': 'base\n' });
  assert.throws(() => getHeadContent(root, 'missing.txt'), /HEAD|path|Git/i);
});

test('uses an empty working side for deleted files', () => {
  const root = repository();
  commit(root, { 'gone.txt': 'before\n' });
  rmSync(path.join(root, 'gone.txt'));
  assert.deepEqual(getChanges(root), [{ path: 'gone.txt', status: 'deleted', binary: false }]);
  assert.equal(getHeadContent(root, 'gone.txt'), 'before\n');
  assert.equal(getWorkingContent(root, 'gone.txt'), '');
});

test('renames use the old HEAD path and the new working path', () => {
  const root = repository();
  commit(root, { 'old name.txt': 'original\n' });
  git(root, 'mv', 'old name.txt', 'new name.txt');
  assert.deepEqual(getChanges(root), [{ path: 'new name.txt', oldPath: 'old name.txt', status: 'renamed', binary: false }]);
  assert.equal(getHeadContent(root, 'new name.txt'), 'original\n');
  assert.equal(getWorkingContent(root, 'new name.txt'), 'original\n');
});

test('marks untracked binary files and excludes Git internal files', () => {
  const root = repository();
  commit(root, { 'tracked.txt': 'base\n' });
  writeFileSync(path.join(root, 'image.bin'), Buffer.from([0, 1, 2]));
  assert.deepEqual(getChanges(root), [{ path: 'image.bin', status: 'added', binary: true }]);
});

test('lists an untracked symlink without reading its external target', () => {
  const root = repository();
  commit(root, { 'tracked.txt': 'base\n' });
  const external = mkdtempSync(path.join(tmpdir(), 'agent-review-external-'));
  repositories.push(external);
  writeFileSync(path.join(external, 'secret.bin'), Buffer.from([0, 1, 2]));
  const target = path.join(external, 'secret.bin');
  symlinkSync(target, path.join(root, 'link.txt'));

  assert.deepEqual(getChanges(root), [{ path: 'link.txt', status: 'added', binary: false }]);
  assert.equal(getWorkingContent(root, 'link.txt'), target);
});

test('reads a tracked HEAD file with an unrelated external symlink present', () => {
  const root = repository();
  commit(root, { 'tracked.txt': 'base\n' });
  const external = mkdtempSync(path.join(tmpdir(), 'agent-review-external-'));
  repositories.push(external);
  writeFileSync(path.join(external, 'other.txt'), 'outside\n');
  symlinkSync(path.join(external, 'other.txt'), path.join(root, 'external-link'));

  assert.equal(getHeadContent(root, 'tracked.txt'), 'base\n');
});

test('rejects repository-relative paths that escape the root', () => {
  const root = repository();
  commit(root, { 'tracked.txt': 'base\n' });
  assert.throws(() => getWorkingContent(root, '../outside.txt'), /repository/i);
  assert.throws(() => getHeadContent(root, '/tmp/outside.txt'), /repository/i);
});
