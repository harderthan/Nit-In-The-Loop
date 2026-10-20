import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const cli = join(process.cwd(), 'src', 'cli.ts');
const tsxLoader = require.resolve('tsx');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-review-cli-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'review@example.test');
  git('config', 'user.name', 'Review Test');
  writeFileSync(join(root, 'hello.ts'), 'const answer = 41;\n');
  git('add', 'hello.ts');
  git('commit', '-qm', 'base');
  writeFileSync(join(root, 'hello.ts'), 'const answer = 42;\n');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, ['--import', tsxLoader, cli, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('agent can add a line thread, list it, reply, and resolve it', () => {
  const repo = fixture();
  try {
    const added = run(repo.root, 'add', '--file', 'hello.ts', '--side', 'new', '--line', '1', '--body', 'Check this value');
    assert.equal(added.status, 0, added.stderr);
    const thread = JSON.parse(added.stdout);
    assert.equal(thread.path, 'hello.ts');
    assert.equal(thread.comments[0].author, 'agent');

    const listed = run(repo.root, 'threads');
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).length, 1);

    const reply = run(repo.root, 'reply', '--thread', thread.id, '--body', 'I changed it', '--author', 'human');
    assert.equal(reply.status, 0, reply.stderr);
    assert.equal(JSON.parse(reply.stdout).author, 'human');

    const resolved = run(repo.root, 'resolve', '--thread', thread.id);
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(JSON.parse(resolved.stdout).resolved, true);
    assert.deepEqual(JSON.parse(run(repo.root, 'threads').stdout), []);
    assert.equal(JSON.parse(run(repo.root, 'threads', '--all').stdout)[0].comments.length, 2);
  } finally {
    repo.cleanup();
  }
});

test('agent cannot attach a thread outside changed files or beyond its line count', () => {
  const repo = fixture();
  try {
    const outside = run(repo.root, 'add', '--file', '../elsewhere.ts', '--side', 'new', '--line', '1', '--body', 'No');
    assert.notEqual(outside.status, 0);
    assert.match(outside.stderr, /outside|changed|path/i);

    const badLine = run(repo.root, 'add', '--file', 'hello.ts', '--side', 'new', '--line', '2', '--body', 'No');
    assert.notEqual(badLine.status, 0);
    assert.match(badLine.stderr, /line|range/i);

    const oldContent = readFileSync(join(repo.root, 'hello.ts'), 'utf8');
    assert.equal(oldContent, 'const answer = 42;\n');
    assert.deepEqual(JSON.parse(run(repo.root, 'threads', '--all').stdout), []);
  } finally {
    repo.cleanup();
  }
});

test('CRLF content creates a normalized anchor that remains current in thread output', () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo.root, 'hello.ts'), 'const answer = 42;\r\n');
    const added = run(repo.root, 'add', '--file', 'hello.ts', '--side', 'new', '--line', '1', '--body', 'Check this value');
    assert.equal(added.status, 0, added.stderr);
    assert.equal(JSON.parse(added.stdout).anchorText, 'const answer = 42;');
    const listed = run(repo.root, 'threads');
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout)[0].stale, false);
  } finally {
    repo.cleanup();
  }
});

test('thread output marks an anchor stale after its line is edited', () => {
  const repo = fixture();
  try {
    const added = run(repo.root, 'add', '--file', 'hello.ts', '--side', 'new', '--line', '1', '--body', 'Check this value');
    assert.equal(added.status, 0, added.stderr);
    writeFileSync(join(repo.root, 'hello.ts'), 'const answer = 43;\n');
    const listed = run(repo.root, 'threads');
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout)[0].stale, true);
  } finally {
    repo.cleanup();
  }
});

test('a changed line remains current when its CRLF endings are normalized', () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo.root, 'hello.ts'), 'first\r\nsecond\r\n');
    const added = run(repo.root, 'add', '--file', 'hello.ts', '--side', 'new', '--line', '1', '--end-line', '2', '--body', 'Check');
    assert.equal(added.status, 0, added.stderr);
    assert.equal(JSON.parse(run(repo.root, 'threads').stdout)[0].stale, false);
  } finally { repo.cleanup(); }
});

test('add waits for a review file lock before writing', async () => {
  const repo = fixture();
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo.root, encoding: 'utf8' }).trim();
  const lock = join(gitDir, 'agent-review', 'review.json.lock');
  mkdirSync(join(gitDir, 'agent-review'), { recursive: true });
  writeFileSync(lock, 'held');
  try {
    const child = spawn(process.execPath, ['--import', tsxLoader, cli, 'add', '--file', 'hello.ts', '--side', 'new', '--line', '1', '--body', 'Check this value'], {
      cwd: repo.root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let finished = false;
    child.once('close', () => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(finished, false);
    unlinkSync(lock);
    const [status] = await once(child, 'close');
    assert.equal(status, 0);
    assert.equal(JSON.parse(run(repo.root, 'threads').stdout).length, 1);
  } finally {
    rmSync(lock, { force: true });
    repo.cleanup();
  }
});

test('agent can comment on changed commit lines and on the commit body, and filter by commit', () => {
  const repo = fixture();
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo.root, encoding: 'utf8' }).trim();
    git('commit', '-qam', 'answer');
    const commit = git('rev-parse', 'HEAD');

    const line = run(repo.root, 'add', '--commit', commit.slice(0, 7), '--file', 'hello.ts', '--side', 'old', '--line', '1', '--body', 'Why 41?');
    assert.equal(line.status, 0, line.stderr);
    assert.deepEqual({ ...JSON.parse(line.stdout), id: '', comments: [] }, {
      id: '', path: 'hello.ts', side: 'old', startLine: 1, endLine: 1, baseCommit: commit,
      anchorText: 'const answer = 41;', commit, stale: false, resolved: false, comments: [],
    });

    const body = run(repo.root, 'add', '--commit', commit, '--body', 'Looks good overall');
    assert.equal(body.status, 0, body.stderr);
    assert.equal(JSON.parse(body.stdout).path, '');

    const unchanged = run(repo.root, 'add', '--commit', 'HEAD~1', '--file', 'hello.ts', '--side', 'old', '--line', '1', '--body', 'No');
    assert.notEqual(unchanged.status, 0);
    assert.match(unchanged.stderr, /not changed in commit/);
    const lineWithoutFile = run(repo.root, 'add', '--commit', commit, '--line', '1', '--body', 'No');
    assert.match(lineWithoutFile.stderr, /need --file/);

    writeFileSync(join(repo.root, 'hello.ts'), 'const answer = 43;\n');
    assert.equal(run(repo.root, 'add', '--file', 'hello.ts', '--side', 'new', '--line', '1', '--body', 'Working tree').status, 0);
    assert.equal(JSON.parse(run(repo.root, 'threads').stdout).length, 3);
    const forCommit = JSON.parse(run(repo.root, 'threads', '--commit', commit.slice(0, 7)).stdout);
    assert.deepEqual(forCommit.map((thread: { path: string; stale: boolean }) => [thread.path, thread.stale]), [['hello.ts', false], ['', false]]);
  } finally {
    repo.cleanup();
  }
});
