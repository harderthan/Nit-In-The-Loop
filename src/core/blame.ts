import { execFile } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface BlameCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
  lines: number[];
}

function checkedPath(repoRoot: string, filePath: string): void {
  if (!filePath || path.isAbsolute(filePath)
    || filePath.split(/[\\/]/).some(part => part === '.' || part === '..')) {
    throw new Error(`Path must be inside the repository: ${filePath}`);
  }

  const root = realpathSync(repoRoot);
  const target = path.resolve(root, filePath);
  if (target === root || !target.startsWith(root + path.sep)) {
    throw new Error(`Path must be inside the repository: ${filePath}`);
  }

  let parent = path.dirname(target);
  while (!existsSync(parent)) parent = path.dirname(parent);
  const realParent = realpathSync(parent);
  if (realParent !== root && !realParent.startsWith(root + path.sep)) {
    throw new Error(`Path must be inside the repository: ${filePath}`);
  }
  if (existsSync(target) && !lstatSync(target).isSymbolicLink()
    && !realpathSync(target).startsWith(root + path.sep)) {
    throw new Error(`Path must be inside the repository: ${filePath}`);
  }
}

function git(repoRoot: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function parseBlame(output: string): BlameCommit[] {
  const commits: BlameCommit[] = [];
  const byHash = new Map<string, BlameCommit>();
  let hash = '';
  let line = 0;
  let author = '';
  let time = 0;
  let subject = '';

  for (const entry of output.split('\n')) {
    const header = /^(\^?[0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(entry);
    if (header) {
      hash = header[1].replace(/^\^/, '');
      line = Number(header[2]);
      author = '';
      time = 0;
      subject = '';
    } else if (entry.startsWith('author ')) {
      author = entry.slice('author '.length);
    } else if (entry.startsWith('author-time ')) {
      time = Number(entry.slice('author-time '.length));
    } else if (entry.startsWith('summary ')) {
      subject = entry.slice('summary '.length);
    } else if (entry.startsWith('\t') && hash) {
      let commit = byHash.get(hash);
      if (!commit) {
        commit = { hash, author, date: new Date(time * 1000).toISOString(), subject, lines: [] };
        byHash.set(hash, commit);
        commits.push(commit);
      }
      commit.lines.push(line);
    }
  }
  return commits;
}

export async function getFileBlame(repoRoot: string, filePath: string): Promise<BlameCommit[]> {
  checkedPath(repoRoot, filePath);
  try {
    return parseBlame(await git(repoRoot, ['blame', '--line-porcelain', 'HEAD', '--', filePath]));
  } catch (error) {
    try {
      await git(repoRoot, ['rev-parse', '--verify', 'HEAD']);
      await git(repoRoot, ['cat-file', '-e', `HEAD:${filePath}`]);
    } catch {
      return [];
    }
    throw error;
  }
}
