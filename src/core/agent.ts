import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ReviewThread } from './review';

/** Split a configured command into argv like a shell would for plain words and quotes, without running a shell. */
export function parseAgentCommand(command: string): string[] {
  const argv: string[] = [];
  for (const match of command.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) {
    // A bare word holding a quote is an unclosed or glued quote, which a shell would read differently.
    if (match[3]?.match(/["']/)) throw new Error(`Invalid agent command: ${command}`);
    argv.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2] ?? match[3]);
  }
  if (argv.length === 0) throw new Error('Agent command is empty');
  return argv;
}

/**
 * Claude Code keeps a conversation per session id, so a thread's later comments
 * resume the session that answered it. Other agents run fresh and read the whole thread.
 */
export function withSession(argv: string[], session: { id: string; resume: boolean }): string[] {
  if (path.basename(argv[0]) !== 'claude') return argv;
  return [argv[0], session.resume ? '--resume' : '--session-id', session.id, ...argv.slice(1)];
}

export const THREAD_MARKER = /^<<<NITL thread=([^>\s]+)>>>[ \t]*$/gm;

export function buildAgentPrompt(repoRoot: string, threads: ReviewThread[]): string {
  const sections = threads.map(thread => {
    const { location } = thread;
    const file = location.file;
    const lines = file && (file.lines[0] === file.lines[1] ? `line ${file.lines[0]}` : `lines ${file.lines[0]}-${file.lines[1]}`);
    const short = location.sha.slice(0, 7);
    const where = location.on === 'commit' ? `commit ${short}` : 'the working tree changes against HEAD';
    const description = file ? `${file.path}, ${file.side} side, ${lines}, in ${where}` : `the body of commit ${short} (a comment on the whole commit)`;
    const conversation = thread.comments.map(comment =>
      `[${comment.author}${comment.queued ? ', new' : ''}]\n${comment.body}`).join('\n\n');
    return [
      `<<<NITL thread=${thread.id}>>>`,
      `Location: ${description}`,
      ...(file?.text ? ['Code:', '```', file.text, '```'] : []),
      'Conversation:',
      conversation,
    ].join('\n');
  });
  return [
    `You are answering code review threads from NITL, a local review tool, in the repository ${repoRoot}.`,
    'Address the newest reviewer comments in each thread. If a comment asks for a code change, edit the files in the working tree. If you disagree, explain why.',
    'Do not run the nitl or agent-review CLI. Your printed answer is posted to the threads for you.',
    'Print one section per thread. Start each section with its marker line exactly as given below, then your reply to that thread in Markdown.',
    '',
    ...sections.flatMap(section => [section, '']),
  ].join('\n');
}

/** Map each thread id to its reply. A single thread may answer without a marker. */
export function parseAgentReplies(output: string, threadIds: string[]): Map<string, string> {
  const replies = new Map<string, string>();
  const markers = [...output.matchAll(THREAD_MARKER)];
  if (markers.length === 0) {
    if (threadIds.length === 1 && output.trim()) replies.set(threadIds[0], output.trim());
    return replies;
  }
  markers.forEach((marker, index) => {
    const body = output.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? output.length).trim();
    if (body && threadIds.includes(marker[1])) replies.set(marker[1], body);
  });
  return replies;
}

export interface AgentRun {
  argv: string[];
  prompt: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Run an agent once. The prompt replaces a `{prompt}` argument, or goes to stdin. Resolves with stdout. */
export function runAgent(run: AgentRun): Promise<string> {
  const { timeoutMs = 10 * 60_000, maxBytes = 1024 * 1024 } = run;
  const inline = run.argv.includes('{prompt}');
  const argv = run.argv.map(arg => arg === '{prompt}' ? run.prompt : arg);
  return new Promise((resolve, reject) => {
    // A process group lets cancellation stop the agent's own child processes too.
    const child = spawn(argv[0], argv.slice(1), {
      cwd: run.cwd, env: run.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let failure: string | undefined;
    const signal = (name: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, name);
        else child.kill(name);
      } catch { /* The process already exited. */ }
    };
    const stop = (reason: string) => {
      failure ??= reason;
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => stop(`Agent timed out after ${Math.round(timeoutMs / 1000)} seconds`), timeoutMs);
    const onAbort = () => stop('Agent run was cancelled');
    if (run.signal?.aborted) onAbort();
    run.signal?.addEventListener('abort', onAbort);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxBytes) stop(`Agent output exceeded ${maxBytes} bytes`);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-maxBytes); });
    child.stdin.on('error', () => { /* An agent may exit without reading stdin. */ });
    child.stdin.end(inline ? '' : run.prompt);
    child.once('error', error => {
      failure ??= (error as NodeJS.ErrnoException).code === 'ENOENT' ? `Agent command not found: ${argv[0]}` : error.message;
    });
    // A background process that the agent left behind can hold stdout open, so
    // the run ends shortly after the agent itself exits.
    child.once('exit', () => setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 1000).unref());
    child.once('close', code => {
      clearTimeout(timer);
      run.signal?.removeEventListener('abort', onAbort);
      if (failure) reject(new AgentError(failure, stderr));
      else if (code !== 0) reject(new AgentError(`Agent exited with code ${code}`, stderr));
      else resolve(stdout);
    });
  });
}

export class AgentError extends Error {
  constructor(message: string, readonly stderr: string) { super(message); }
}
