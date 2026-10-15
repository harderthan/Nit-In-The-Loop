import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewComment, ReviewDocument, ReviewThread } from './review';

export async function readReview(filePath: string): Promise<ReviewDocument> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissing(error)) return { version: 1, threads: [] };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Cannot parse review file ${filePath}: ${message(error)}`);
  }
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
  if (value.version !== 1) throw new Error(`Unsupported review file version in ${filePath}: ${String(value.version)}`);
  if (!Array.isArray(value.threads) || !value.threads.every(validThread)) throw invalid(filePath);
}

function validThread(value: unknown): value is ReviewThread {
  if (!record(value)) return false;
  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.path === 'string' && value.path.length > 0
    && (value.side === 'old' || value.side === 'new')
    && Number.isSafeInteger(value.startLine) && (value.startLine as number) > 0
    && Number.isSafeInteger(value.endLine) && (value.endLine as number) >= (value.startLine as number)
    && typeof value.baseCommit === 'string'
    && typeof value.anchorText === 'string'
    && typeof value.stale === 'boolean'
    && typeof value.resolved === 'boolean'
    && Array.isArray(value.comments) && value.comments.length > 0 && value.comments.every(validComment);
}

function validComment(value: unknown): value is ReviewComment {
  if (!record(value)) return false;
  return typeof value.id === 'string' && value.id.length > 0
    && (value.author === 'human' || value.author === 'agent')
    && typeof value.body === 'string' && value.body.trim().length > 0
    && typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt));
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
