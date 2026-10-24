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

export const BINARY_PREVIEW = 'Binary file: preview unavailable.';

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
  const allRefs = (await git(repoRoot, [
    'for-each-ref', '--format=%(refname)%00%(refname:short)%00%(objectname)',
    'refs/heads', 'refs/remotes',
  ])).trimEnd().split('\n').filter(Boolean).map(line => {
    const [ref, name, hash] = line.split('\0');
    return { ref, name, hash };
  }).filter(({ ref }) => !ref.endsWith('/HEAD'));
  // Every ref in a large repository buries HEAD under unrelated work and costs a
  // walk each, so show only the current branch, its upstream, and the default branch.
  const defaultRef = await optionalRef(repoRoot, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])
    || ['refs/remotes/origin/main', 'refs/remotes/origin/master'].find(ref => allRefs.some(item => item.ref === ref));
  const scope = new Set([
    currentBranch && `refs/heads/${currentBranch}`,
    await optionalRef(repoRoot, ['rev-parse', '--symbolic-full-name', '@{upstream}']),
    defaultRef,
  ]);
  const refs = allRefs.filter(({ ref }) => scope.has(ref));
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

  // Commits the default branch lacks come first, so the current branch's own work
  // leads even when the default branch has moved on since it forked.
  const tips = [...(head ? ['HEAD'] : []), ...refs.filter(({ ref }) => ref !== defaultRef).map(({ ref }) => ref)];
  const base = refs.some(({ ref }) => ref === defaultRef) ? defaultRef : undefined;
  const log = (count: number, revisions: string[]) => count > 0 && revisions.length > 0
    ? git(repoRoot, ['log', '-z', `--max-count=${count}`, '--format=%H%x00%an%x00%aI%x00%s', ...revisions, '--'])
    : Promise.resolve('');
  const own = (await log(limit, base ? [...tips, `^${base}`] : tips)).split('\0');
  own.pop();
  const fields = [...own, ...(await log(limit - own.length / 4, base ? [base] : [])).split('\0')];
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

async function optionalRef(repoRoot: string, args: string[]): Promise<string> {
  try {
    return (await git(repoRoot, args)).trim();
  } catch {
    return '';
  }
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
  if (size >= 32 * 1024 * 1024) return BINARY_PREVIEW;
  const content = await gitBytes(repoRoot, ['show', `${hash}:${filePath}`]);
  if (content.includes(0)) return BINARY_PREVIEW;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return BINARY_PREVIEW;
  }
}

/** Full hash of a commit named by any revision, such as a short hash. */
export async function resolveCommit(repoRoot: string, revision: string): Promise<string> {
  if (!revision || revision.startsWith('-')) throw new Error(`Invalid commit: ${revision}`);
  try {
    return checkedHash((await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`])).trim());
  } catch {
    throw new Error(`Commit not found: ${revision}`);
  }
}

/** Header, message, and file statistics shown as the commit body that commit comments attach to. */
export async function getCommitSummary(repoRoot: string, hash: string): Promise<string> {
  return git(repoRoot, ['show', '--stat', '--format=fuller', '--no-color', checkedHash(hash), '--']);
}

/**
 * Inclusive one-based line ranges of each diff hunk on one side of a commit's file
 * diff, with three context lines like a pull request diff. The old side is the
 * first parent, so a merge shows what it brought in.
 */
export async function getCommitHunkLines(
  repoRoot: string, hash: string, filePath: string, side: 'old' | 'new',
): Promise<Array<[number, number]>> {
  const file = (await getCommitFiles(repoRoot, hash))
    .find(candidate => (side === 'new' ? candidate.path : candidate.oldPath ?? candidate.path) === checkedPath(filePath));
  if (!file || (side === 'old' && file.status === 'added') || (side === 'new' && file.status === 'deleted')) return [];
  const parent = await getCommitParent(repoRoot, hash);
  // Literal pathspecs keep a name such as `[id].ts` from matching `i.ts` as a glob.
  const patch = await git(repoRoot, [
    '--literal-pathspecs', 'diff-tree', '--root', '-r', '-p', '-U3', '--find-renames', '--no-commit-id', '--no-color', '--no-ext-diff',
    ...(parent ? [parent] : []), hash, '--', ...(file.oldPath ? [file.oldPath] : []), file.path,
  ]);
  const ranges: Array<[number, number]> = [];
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(side === 'old' ? match[1] : match[3]);
    const count = Number((side === 'old' ? match[2] : match[4]) ?? 1);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  return ranges;
}

/** Whether a line range lies inside one diff hunk, where line threads are allowed. */
export function rangeIsChanged(ranges: Array<[number, number]>, startLine: number, endLine: number): boolean {
  return ranges.some(([start, end]) => start <= startLine && endLine <= end);
}
