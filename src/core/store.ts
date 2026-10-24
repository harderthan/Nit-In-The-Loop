import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewComment, ReviewDocument, ReviewThread } from './review';

export async function readReview(filePath: string): Promise<ReviewDocument> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissing(error)) return { version: 2, threads: [] };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Cannot parse review file ${filePath}: ${message(error)}`);
  }
  if (record(parsed) && parsed.version === 1) parsed = upgradeV1(parsed, filePath);
  validateReview(parsed, filePath);
  return parsed;
}

export async function writeReview(filePath: string, review: ReviewDocument): Promise<void> {
  validateReview(review, filePath);
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(review, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Read, modify, and atomically replace a review while holding a cross-process lock. */
export async function updateReview<T>(
  filePath: string,
  update: (review: ReviewDocument) => T | Promise<T>,
): Promise<T> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + 10_000;
  const token = randomUUID();
  while (true) {
    try {
      await createLock(lockPath, token);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await recoverDeadOwner(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for review lock: ${lockPath}`);
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    const review = await readReview(filePath);
    const result = await update(review);
    await writeReview(filePath, review);
    return result;
  } finally {
    const owner = await readLockOwner(lockPath);
    if (owner?.token !== token) throw new Error(`Review lock ownership changed: ${lockPath}`);
    await unlink(lockPath);
  }
}

interface LockOwner { pid: number; token: string }

async function createLock(lockPath: string, token: string): Promise<void> {
  const temporary = `${lockPath}.${process.pid}.${token}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
    // A hard link makes the complete owner record visible in one atomic operation.
    await link(temporary, lockPath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function recoverDeadOwner(lockPath: string): Promise<void> {
  const guardPath = `${lockPath}.reclaim`;
  let guard;
  try {
    guard = await open(guardPath, 'wx');
  } catch (error) {
    if (isAlreadyExists(error)) return;
    throw error;
  }
  try {
    const owner = await readLockOwner(lockPath);
    if (owner && !isProcessAlive(owner.pid)) {
      await unlink(lockPath).catch(error => { if (!isMissing(error)) throw error; });
    }
  } finally {
    await guard.close();
    await unlink(guardPath);
  }
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  let raw: string;
  try { raw = await readFile(lockPath, 'utf8'); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
  try {
    const owner: unknown = JSON.parse(raw);
    if (record(owner) && Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0
      && typeof owner.token === 'string' && owner.token.length > 0) {
      return owner as unknown as LockOwner;
    }
  } catch { /* An unknown lock must not be stolen. */ }
  return undefined;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !record(error) || error.code !== 'ESRCH'; }
}

function validateReview(value: unknown, filePath: string): asserts value is ReviewDocument {
  if (!record(value)) throw invalid(filePath);
  if (value.version !== 2) throw new Error(`Unsupported review file version in ${filePath}: ${String(value.version)}`);
  if (!keys(value, ['version', 'threads']) || !Array.isArray(value.threads) || !value.threads.every(validThread)) throw invalid(filePath);
}

// These checks mirror schema/review.schema.json. A test holds the two in agreement.
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function validThread(value: unknown): value is ReviewThread {
  return record(value) && keys(value, ['id', 'status', 'location', 'agent', 'comments'])
    && typeof value.id === 'string' && value.id.length > 0
    && (value.status === 'open' || value.status === 'resolved')
    && validLocation(value.location)
    && (value.agent === undefined || (record(value.agent) && keys(value.agent, ['session'])
      && typeof value.agent.session === 'string' && value.agent.session.length > 0))
    && Array.isArray(value.comments) && value.comments.length > 0 && value.comments.every(validComment);
}

function validLocation(value: unknown): boolean {
  if (!record(value) || !keys(value, ['on', 'sha', 'file']) || typeof value.sha !== 'string') return false;
  if (value.on === 'worktree') return (value.sha === '' || HASH.test(value.sha)) && validFile(value.file);
  return value.on === 'commit' && HASH.test(value.sha) && (value.file === undefined || validFile(value.file));
}

function validFile(value: unknown): boolean {
  if (!record(value) || !keys(value, ['path', 'side', 'lines', 'text'])) return false;
  const lines = value.lines;
  return typeof value.path === 'string' && value.path.length > 0
    && (value.side === 'old' || value.side === 'new')
    && Array.isArray(lines) && lines.length === 2 && lines.every(line => Number.isSafeInteger(line) && line > 0) && lines[1] >= lines[0]
    && typeof value.text === 'string';
}

function validComment(value: unknown): value is ReviewComment {
  return record(value) && keys(value, ['id', 'author', 'body', 'at', 'queued'])
    && typeof value.id === 'string' && value.id.length > 0
    && (value.author === 'human' || value.author === 'agent')
    && typeof value.body === 'string' && value.body.trim().length > 0
    && typeof value.at === 'string' && isDateTime(value.at)
    && (value.queued === undefined || typeof value.queued === 'boolean');
}

// RFC 3339 date-time, as the schema's `format: date-time` requires. Date.parse alone accepts
// a bare date and rolls February 30 over to March.
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):?[0-5]\d)$/i;

function isDateTime(value: string): boolean {
  const match = DATE_TIME.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

/** Version 1 kept every thread field flat. Reading upgrades it, and the next write saves version 2. */
function upgradeV1(value: unknown, filePath: string): ReviewDocument {
  if (!record(value) || !Array.isArray(value.threads) || !value.threads.every(validV1Thread)) throw invalid(filePath);
  return {
    version: 2,
    threads: value.threads.map(thread => {
      const file = thread.path
        ? { path: thread.path, side: thread.side, lines: [thread.startLine, thread.endLine] as [number, number], text: thread.anchorText }
        : undefined;
      return {
        id: thread.id,
        status: thread.resolved ? 'resolved' : 'open',
        location: thread.commit ? { on: 'commit', sha: thread.commit, ...(file ? { file } : {}) }
          : { on: 'worktree', sha: thread.baseCommit, file: file! },
        ...(thread.agentSession ? { agent: { session: thread.agentSession } } : {}),
        comments: thread.comments.map(comment => ({
          id: comment.id, author: comment.author, body: comment.body, at: comment.createdAt,
          ...(comment.queued ? { queued: true } : {}),
        })),
      };
    }),
  };
}

interface V1Thread {
  id: string; path: string; side: 'old' | 'new'; startLine: number; endLine: number; baseCommit: string;
  anchorText: string; commit?: string; agentSession?: string; resolved: boolean;
  comments: Array<{ id: string; author: 'human' | 'agent'; body: string; createdAt: string; queued?: boolean }>;
}

function validV1Thread(value: unknown): value is V1Thread {
  if (!record(value)) return false;
  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.path === 'string' && (value.path.length > 0 || value.commit !== undefined)
    && (value.commit === undefined || (typeof value.commit === 'string' && HASH.test(value.commit)))
    && (value.side === 'old' || value.side === 'new')
    && Number.isSafeInteger(value.startLine) && (value.startLine as number) > 0
    && Number.isSafeInteger(value.endLine) && (value.endLine as number) >= (value.startLine as number)
    && typeof value.baseCommit === 'string'
    && typeof value.anchorText === 'string'
    && (value.agentSession === undefined || typeof value.agentSession === 'string')
    && typeof value.resolved === 'boolean'
    && Array.isArray(value.comments) && value.comments.length > 0 && value.comments.every(comment => record(comment)
      && typeof comment.id === 'string' && (comment.author === 'human' || comment.author === 'agent')
      && typeof comment.body === 'string' && typeof comment.createdAt === 'string'
      && (comment.queued === undefined || typeof comment.queued === 'boolean'));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(filePath: string): Error {
  return new Error(`Invalid review file: ${filePath}`);
}

function isMissing(error: unknown): boolean {
  return record(error) && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return record(error) && error.code === 'EEXIST';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
