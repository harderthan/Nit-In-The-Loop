import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AgentError, buildAgentPrompt, parseAgentCommand, parseAgentReplies, runAgent, withSession } from './agent';
import type { ReviewThread } from './review';

test('agent commands split into argv with quotes and reject unclosed quotes', () => {
  assert.deepEqual(parseAgentCommand('claude -p'), ['claude', '-p']);
  assert.deepEqual(parseAgentCommand(`claude --allowedTools "Edit Read" 'a b' "x \\"y\\""`), ['claude', '--allowedTools', 'Edit Read', 'a b', 'x "y"']);
  assert.throws(() => parseAgentCommand('claude "-p'), /Invalid agent command/);
  assert.throws(() => parseAgentCommand('   '), /empty/);
});

test('claude sessions start with a fixed id and resume it later, other agents run as given', () => {
  assert.deepEqual(withSession(['claude', '-p'], { id: 's1', resume: false }), ['claude', '--session-id', 's1', '-p']);
  assert.deepEqual(withSession(['/usr/local/bin/claude', '-p'], { id: 's1', resume: true }), ['/usr/local/bin/claude', '--resume', 's1', '-p']);
  assert.deepEqual(withSession(['codex', 'exec', '-'], { id: 's1', resume: true }), ['codex', 'exec', '-']);
});

const thread = (id: string, extra: Partial<ReviewThread> = {}): ReviewThread => ({
  id, path: 'src/a.ts', side: 'new', startLine: 3, endLine: 4, baseCommit: '', anchorText: 'const a = 1;', stale: false, resolved: false,
  comments: [
    { id: `${id}-1`, author: 'human', body: 'Rename this.', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: `${id}-2`, author: 'agent', body: 'Done.', createdAt: '2026-01-01T00:01:00.000Z' },
    { id: `${id}-3`, author: 'human', body: 'Also add a test.', createdAt: '2026-01-01T00:02:00.000Z', queued: true },
  ],
  ...extra,
});

test('the prompt carries each thread location, code, conversation, and marker', () => {
  const commit = 'd'.repeat(40);
  const prompt = buildAgentPrompt('/repo', [thread('t1'), thread('t2', { path: '', commit, anchorText: '' })]);
  assert.match(prompt, /<<<NITL thread=t1>>>\nLocation: src\/a\.ts, new side, lines 3-4, in the working tree changes against HEAD\nCode:\n```\nconst a = 1;\n```/);
  assert.match(prompt, /\[human, new\]\nAlso add a test\./);
  assert.match(prompt, /<<<NITL thread=t2>>>\nLocation: the body of commit ddddddd/);
  assert.match(prompt, /Do not run the nitl/);
});

test('replies split by thread marker, and a lone thread may answer without one', () => {
  assert.deepEqual([...parseAgentReplies('<<<NITL thread=t1>>>\nFixed.\n\n<<<NITL thread=t2>>>\nKept, because X.\n<<<NITL thread=zz>>>\nIgnored', ['t1', 't2'])],
    [['t1', 'Fixed.'], ['t2', 'Kept, because X.']]);
  assert.deepEqual([...parseAgentReplies('  Fixed it.\n', ['t1'])], [['t1', 'Fixed it.']]);
  assert.deepEqual([...parseAgentReplies('Fixed both.', ['t1', 't2'])], []);
  assert.deepEqual([...parseAgentReplies('<<<NITL thread=t1>>>\n\n', ['t1'])], []);
});

test('runAgent passes the prompt on stdin or as an argument and reports failures', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nitl-agent-'));
  const script = path.join(directory, 'agent.js');
  writeFileSync(script, `
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const mode = process.argv[2];
  if (mode === 'echo') process.stdout.write('stdin:' + input + ' cwd:' + process.cwd() + ' env:' + process.env.NITL_REPO);
  if (mode === 'arg') process.stdout.write('arg:' + process.argv[3] + ' stdin:' + input);
  if (mode === 'fail') { process.stderr.write('boom'); process.exit(3); }
  if (mode === 'big') process.stdout.write('x'.repeat(5000));
  if (mode === 'hang') setInterval(() => {}, 1000);
  if (mode === 'orphan') {
    require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();
    process.stdout.write('done');
  }
});
`);
  const node = process.execPath;
  const run = (args: string[], extra: Partial<Parameters<typeof runAgent>[0]> = {}) =>
    runAgent({ argv: [node, script, ...args], prompt: 'hello', cwd: directory, env: { ...process.env, NITL_REPO: 'r' }, ...extra });
  try {
    const real = (await import('node:fs')).realpathSync(directory);
    assert.equal(await run(['echo']), `stdin:hello cwd:${real} env:r`);
    assert.equal(await run(['arg', '{prompt}']), 'arg:hello stdin:');
    await assert.rejects(run(['fail']), (error: unknown) => error instanceof AgentError && /code 3/.test(error.message) && error.stderr === 'boom');
    await assert.rejects(run(['big'], { maxBytes: 100 }), /exceeded 100 bytes/);
    const started = Date.now();
    assert.equal(await run(['orphan'], { timeoutMs: 20_000 }), 'done');
    assert.ok(Date.now() - started < 10_000);
    await assert.rejects(run(['hang'], { timeoutMs: 200 }), /timed out/);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(run(['hang'], { signal: controller.signal }), /cancelled/);
    await assert.rejects(runAgent({ argv: ['nitl-no-such-agent'], prompt: '', cwd: directory }), /not found: nitl-no-such-agent/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
