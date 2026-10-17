import { execFile } from 'node:child_process';
import path from 'node:path';

export interface HistoryCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
  refs: string[];
  branch: string;
}

export interface HistoryFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

const historyCache = new Map<string, { signature: string; commits: HistoryCommit[] }>();

function copyCommits(commits: HistoryCommit[]): HistoryCommit[] {
  return commits.map(commit => ({ ...commit, refs: [...commit.refs] }));
}

function gitBytes(repoRoot: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repoRoot, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout as Buffer);
    });
  });
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  return (await gitBytes(repoRoot, args)).toString('utf8');
}

function checkedHash(hash: string): string {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(hash)) {
    throw new Error(`Invalid commit hash: ${hash}`);
  }
  return hash;
}

function checkedPath(filePath: string): string {
  if (!filePath || path.isAbsolute(filePath) || filePath.includes('\0')
    || filePath.split(/[\\/]/).some(part => part === '.' || part === '..')) {
    throw new Error(`Path must be inside the repository: ${filePath}`);
  }
  return filePath;
}

export async function getRepositoryHistory(repoRoot: string, limit = 50): Promise<HistoryCommit[]> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`Invalid history limit: ${limit}`);
  if (limit === 0) return [];

  let head = '';
  try {
    head = (await git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  } catch {
    await git(repoRoot, ['rev-parse', '--git-dir']);
  }

  const currentBranch = await getCurrentBranch(repoRoot);
  const refs = (await git(repoRoot, [
    'for-each-ref', '--format=%(refname)%00%(refname:short)%00%(objectname)',
    'refs/heads', 'refs/remotes',
  ])).trimEnd().split('\n').filter(Boolean).map(line => {
    const [ref, name, hash] = line.split('\0');
    return { ref, name, hash };
  }).filter(({ ref }) => !ref.endsWith('/HEAD'));
  if (!head && refs.length === 0) return [];

  const cacheKey = `${repoRoot}\0${limit}`;
  const signature = JSON.stringify([head, currentBranch, refs]);
  const cached = historyCache.get(cacheKey);
  if (cached?.signature === signature) return copyCommits(cached.commits);

  const orderedRefs = [...refs].sort((left, right) => {
    const leftPriority = left.name === currentBranch ? 0 : left.ref.startsWith('refs/heads/') ? 1 : 2;
    const rightPriority = right.name === currentBranch ? 0 : right.ref.startsWith('refs/heads/') ? 1 : 2;
    return leftPriority - rightPriority || left.name.localeCompare(right.name);
  });

  const fields = (await git(repoRoot, [
    'log', '-z', `--max-count=${limit}`, '--format=%H%x00%an%x00%aI%x00%s',
    ...(head ? ['HEAD'] : []), ...refs.map(({ ref }) => ref),
  ])).split('\0');
  fields.pop();
  const commits: HistoryCommit[] = [];
  for (let i = 0; i < fields.length; i += 4) {
    commits.push({
      hash: fields[i],
      author: fields[i + 1],
      date: new Date(fields[i + 2]).toISOString(),
      subject: fields[i + 3],
      refs: [],
      branch: '',
    });
  }

  const byHash = new Map(commits.map(commit => [commit.hash, commit]));
  for (const { ref, name, hash } of orderedRefs) {
    byHash.get(hash)?.refs.push(name);
    const ancestors = (await git(repoRoot, ['rev-list', `--max-count=${limit}`, ref])).trim().split('\n');
    for (const ancestor of ancestors) {
      const commit = byHash.get(ancestor);
      if (commit && !commit.branch) commit.branch = name;
    }
  }
  if (head) {
    byHash.get(head)?.refs.unshift('HEAD');
    const ancestors = (await git(repoRoot, ['rev-list', `--max-count=${limit}`, 'HEAD'])).trim().split('\n');
    for (const ancestor of ancestors) {
      const commit = byHash.get(ancestor);
      if (commit && !commit.branch) commit.branch = 'HEAD';
    }
  }
  historyCache.delete(cacheKey);
  historyCache.set(cacheKey, { signature, commits });
  if (historyCache.size > 32) {
    const oldest = historyCache.keys().next().value;
    if (oldest !== undefined) historyCache.delete(oldest);
  }
  return copyCommits(commits);
}

export async function getCurrentBranch(repoRoot: string): Promise<string> {
  return (await git(repoRoot, ['branch', '--show-current'])).trim();
}

export async function getCommitFiles(repoRoot: string, hash: string): Promise<HistoryFile[]> {
  checkedHash(hash);
  const parent = await getCommitParent(repoRoot, hash);
  const entries = (await git(repoRoot, [
    'diff-tree', '--root', '-r', '-z', '--name-status', '--find-renames', '--no-commit-id',
    ...(parent ? [parent] : []), hash,
  ])).split('\0');
  const files: HistoryFile[] = [];
  for (let i = 0; i < entries.length && entries[i];) {
    const status = entries[i++];
    const firstPath = entries[i++];
    if (status.startsWith('R')) {
      files.push({ path: entries[i++], oldPath: firstPath, status: 'renamed' });
    } else {
      files.push({
        path: firstPath,
        status: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified',
      });
    }
  }
  return files;
}

export async function getCommitParent(repoRoot: string, hash: string): Promise<string> {
  const parents = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', checkedHash(hash)])).trim().split(' ');
  return parents[1] ?? '';
}

export async function getCommitContent(repoRoot: string, hash: string, filePath: string): Promise<string> {
  checkedHash(hash);
  checkedPath(filePath);
  await git(repoRoot, ['cat-file', '-e', `${hash}^{commit}`]);
  let size: number;
  try {
    size = Number(await git(repoRoot, ['cat-file', '-s', `${hash}:${filePath}`]));
  } catch {
    return '';
  }
  const binaryMarker = 'Binary file: preview unavailable.';
  if (size >= 32 * 1024 * 1024) return binaryMarker;
  const content = await gitBytes(repoRoot, ['show', `${hash}:${filePath}`]);
  if (content.includes(0)) return binaryMarker;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return binaryMarker;
  }
}
