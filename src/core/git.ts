import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import path from 'node:path';

export type ChangedFile = {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary?: boolean;
};

function statusEntries(entries: string[]): ChangedFile[] {
  const changes: ChangedFile[] = [];
  for (let i = 0; i < entries.length && entries[i]; i++) {
    const entry = entries[i];
    const state = entry.slice(0, 2);
    const oldPath = state.includes('R') ? entries[++i] : undefined;
    changes.push({
      path: entry.slice(3),
      ...(oldPath ? { oldPath } : {}),
      status: oldPath ? 'renamed' : state.includes('D') ? 'deleted'
        : state === '??' || state.includes('A') ? 'added' : 'modified',
    });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function git(root: string, args: string[]): Buffer {
  return execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitAsync(root: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout as Buffer);
    });
  });
}

function checkedPath(root: string, file: string): string {
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).some(part => part === '..' || part === '.')) {
    throw new Error(`Path must be inside the repository: ${file}`);
  }
  const resolvedRoot = realpathSync(root);
  const target = path.resolve(resolvedRoot, file);
  if (target === resolvedRoot || !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path must be inside the repository: ${file}`);
  }
  if (existsSync(target) && !lstatSync(target).isSymbolicLink()) {
    const realTarget = realpathSync(target);
    if (!realTarget.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`Path must be inside the repository: ${file}`);
    }
  }
  // A symlink is Git content in its own right. Its link text can be read safely
  // without following the target, but its parent must still be inside the repo.
  let parent = path.dirname(target);
  while (!existsSync(parent)) parent = path.dirname(parent);
  const realParent = realpathSync(parent);
  if (realParent !== resolvedRoot && !realParent.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path must be inside the repository: ${file}`);
  }
  return target;
}

function workingBytes(fullPath: string): Buffer | undefined {
  let stat;
  try {
    stat = lstatSync(fullPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (stat.isSymbolicLink()) return Buffer.from(readlinkSync(fullPath));
  return stat.isFile() ? readFileSync(fullPath) : undefined;
}

export function discoverRepository(cwd: string): string {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  } catch {
    throw new Error(`No Git repository found from ${cwd}`);
  }
}

export function getHeadSha(repoRoot: string): string {
  try {
    return git(repoRoot, ['rev-parse', 'HEAD']).toString('utf8').trim();
  } catch {
    return '';
  }
}

export function getStorePath(repoRoot: string): string {
  const gitDir = git(repoRoot, ['rev-parse', '--absolute-git-dir']).toString('utf8').trim();
  return path.join(gitDir, 'agent-review', 'review.json');
}

function binaryAtHead(repoRoot: string, file: string): boolean {
  try {
    return git(repoRoot, ['show', `HEAD:${file}`]).includes(0);
  } catch {
    return false;
  }
}

function binaryInWorkingTree(repoRoot: string, file: string): boolean {
  const fullPath = checkedPath(repoRoot, file);
  return workingBytes(fullPath)?.includes(0) ?? false;
}

export function getChanges(repoRoot: string): ChangedFile[] {
  const entries = git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'])
    .toString('utf8').split('\0');
  const changes = statusEntries(entries);
  for (const change of changes) {
    change.binary = (change.status !== 'added' && binaryAtHead(repoRoot, change.oldPath ?? change.path))
      || (change.status !== 'deleted' && binaryInWorkingTree(repoRoot, change.path));
  }
  return changes;
}

/** Discover changes without running Git or reading file contents on the caller's event loop. */
export async function getChangesAsync(repoRoot: string): Promise<ChangedFile[]> {
  const entries = (await gitAsync(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames']))
    .toString('utf8').split('\0');
  const changes = statusEntries(entries);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, changes.length) }, async () => {
    while (next < changes.length) {
      const change = changes[next++];
      const atHead = change.status !== 'added'
        && await gitOutputHasNul(repoRoot, ['show', `HEAD:${change.oldPath ?? change.path}`]);
      change.binary = atHead || (change.status !== 'deleted' && await workingHasNul(checkedPath(repoRoot, change.path)));
    }
  }));
  return changes;
}

function gitOutputHasNul(root: string, args: string[]): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    let binary = false;
    child.stdout.on('data', (chunk: Buffer) => { binary ||= chunk.includes(0); });
    child.once('error', reject);
    child.once('close', code => resolve(code === 0 && binary));
  });
}

async function workingHasNul(fullPath: string): Promise<boolean> {
  const stat = await lstat(fullPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return false;
  if (stat.isSymbolicLink()) return (await readlink(fullPath)).includes('\0');
  if (!stat.isFile()) return false;
  const file = await open(fullPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (let position = 0; ; position += buffer.length) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return false;
      if (buffer.subarray(0, bytesRead).includes(0)) return true;
    }
  } finally { await file.close(); }
}

export function getHeadContent(repoRoot: string, file: string): string {
  checkedPath(repoRoot, file);
  try {
    return git(repoRoot, ['show', `HEAD:${file}`]).toString('utf8');
  } catch (error) {
    const entries = git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'])
      .toString('utf8').split('\0');
    const change = statusEntries(entries).find(candidate => candidate.path === file);
    if (change?.oldPath) return git(repoRoot, ['show', `HEAD:${change.oldPath}`]).toString('utf8');
    if (change?.status === 'added') return '';
    throw error;
  }
}

export function getWorkingContent(repoRoot: string, file: string): string {
  const fullPath = checkedPath(repoRoot, file);
  return workingBytes(fullPath)?.toString('utf8') ?? '';
}
