#!/usr/bin/env node
import { addReply, addThread, setResolved, type Author, type ReviewThread } from './core/review';
import { discoverRepository, getChanges, getHeadContent, getStorePath, getWorkingContent } from './core/git';
import { readReview, updateReview } from './core/store';
import { reviewLines, threadIsStale } from './core/anchors';
import { prepareCommitThread, prepareThread } from './core/prepareThread';
import { resolveCommit } from './core/history';

type Options = Record<string, string | boolean>;

function parseOptions(args: string[]): Options {
  const options: Options = {};
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token.startsWith('--') || token.length < 3) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === 'all') {
      options.all = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    options[name] = value;
  }
  return options;
}

function required(options: Options, key: string): string {
  const value = options[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} is required`);
  return value;
}

function lineNumber(value: string, key: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid ${key} line number: ${value}`);
  return number;
}

function author(options: Options): Author {
  const value = options.author ?? 'agent';
  if (value !== 'human' && value !== 'agent') throw new Error('--author must be human or agent');
  return value;
}

function currentThread(repo: string, thread: ReviewThread): ReviewThread {
  // Commit content never changes, so a commit comment keeps its anchor.
  if (thread.commit) return thread;
  try {
    const content = thread.side === 'old' ? getHeadContent(repo, thread.path) : getWorkingContent(repo, thread.path);
    const lines = reviewLines(content);
    const stale = threadIsStale(thread, lines);
    return { ...thread, stale };
  } catch {
    return { ...thread, stale: true };
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function run(args: string[], cwd = process.cwd()): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write('Usage: nitl <files|threads|add|reply|resolve|reopen> [options]\n');
    return;
  }
  const options = parseOptions(rest);
  const repo = discoverRepository(typeof options.repo === 'string' ? options.repo : cwd);
  if (command === 'files') {
    print(getChanges(repo));
    return;
  }
  const storePath = getStorePath(repo);
  if (command === 'threads') {
    const review = await readReview(storePath);
    const commit = typeof options.commit === 'string' ? await resolveCommit(repo, options.commit) : undefined;
    print(review.threads
      .filter(thread => (options.all || !thread.resolved) && (!commit || thread.commit === commit))
      .map(thread => currentThread(repo, thread)));
    return;
  }
  if (command === 'add' && typeof options.commit === 'string') {
    // Without --file the comment goes on the commit body, like a pull request conversation comment.
    const path = typeof options.file === 'string' ? options.file : undefined;
    if (!path && (options.side || options.line || options['end-line'])) throw new Error('--side and --line need --file');
    const startLine = path ? lineNumber(required(options, 'line'), 'start') : undefined;
    const endLine = path && options['end-line'] ? lineNumber(required(options, 'end-line'), 'end') : startLine;
    const side = path ? required(options, 'side') : undefined;
    if (side !== undefined && side !== 'old' && side !== 'new') throw new Error('--side must be old or new');
    const input = await prepareCommitThread(repo, options.commit, {
      path, side, startLine, endLine, author: author(options), body: required(options, 'body'),
    });
    print(await updateReview(storePath, review => addThread(review, input)));
    return;
  }
  if (command === 'add') {
    const path = required(options, 'file');
    const side = required(options, 'side');
    if (side !== 'old' && side !== 'new') throw new Error('--side must be old or new');
    const startLine = lineNumber(required(options, 'line'), 'start');
    const endLine = options['end-line'] ? lineNumber(required(options, 'end-line'), 'end') : startLine;
    if (endLine < startLine) throw new Error('End line must be at or after start line');
    const input = prepareThread(repo, getChanges(repo), {
      path,
      side,
      startLine,
      endLine,
      author: author(options),
      body: required(options, 'body'),
    });
    const thread = await updateReview(storePath, review => addThread(review, input));
    print(thread);
    return;
  }
  if (command === 'reply') {
    const threadId = required(options, 'thread');
    const input = { author: author(options), body: required(options, 'body') };
    const comment = await updateReview(storePath, review => addReply(review, threadId, input));
    print(comment);
    return;
  }
  if (command === 'resolve' || command === 'reopen') {
    const threadId = required(options, 'thread');
    const thread = await updateReview(storePath, review => setResolved(review, threadId, command === 'resolve'));
    print(thread);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (require.main === module) {
  run(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
