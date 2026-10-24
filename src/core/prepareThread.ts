import { anchorText, reviewLines } from './anchors';
import { getHeadContent, getHeadSha, getWorkingContent, type ChangedFile } from './git';
import { BINARY_PREVIEW, getCommitHunkLines, getCommitContent, getCommitParent, rangeIsChanged, resolveCommit } from './history';
import type { NewThread, Side } from './review';

interface ThreadRequest extends Pick<NewThread, 'author' | 'body' | 'queued'> {
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
}

/** Bind a requested comment to a specific changed-file snapshot and its current content. */
export function prepareThread(repoRoot: string, changes: readonly ChangedFile[], request: ThreadRequest): NewThread {
  const { path, side, startLine, endLine } = request;
  if (side !== 'old' && side !== 'new') throw new Error('--side must be old or new');
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error('Invalid thread line range');
  }
  const change = changes.find(file => file.path === path);
  if (!change) throw new Error(`File is outside changed files: ${path}`);
  if (change.binary) throw new Error(`Cannot comment on binary file: ${path}`);
  const content = side === 'old' ? getHeadContent(repoRoot, path) : getWorkingContent(repoRoot, path);
  const lines = reviewLines(content);
  if (endLine > lines.length) {
    throw new Error(`Line range ${startLine}-${endLine} is outside the ${side} side of ${path} (${lines.length} lines)`);
  }
  return {
    location: { on: 'worktree', sha: getHeadSha(repoRoot), file: { path, side, lines: [startLine, endLine], text: anchorText(lines, startLine, endLine) } },
    ...comment(request),
  };
}

/**
 * Bind a comment to a commit. Without a path it is a commit body comment. With a
 * path, its lines must lie in one diff hunk on that side, context lines included.
 */
export async function prepareCommitThread(
  repoRoot: string, commit: string, request: Pick<NewThread, 'author' | 'body'> & Partial<ThreadRequest>,
): Promise<NewThread> {
  const hash = await resolveCommit(repoRoot, commit);
  if (!request.path) return { location: { on: 'commit', sha: hash }, ...comment(request) };
  const { path, side, startLine = 0, endLine = 0 } = request;
  if (side !== 'old' && side !== 'new') throw new Error('--side must be old or new');
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error('Invalid thread line range');
  }
  const ranges = await getCommitHunkLines(repoRoot, hash, path, side);
  if (!rangeIsChanged(ranges, startLine, endLine)) {
    throw new UnchangedLinesError(`Lines ${startLine}-${endLine} on the ${side} side of ${path} are outside the diff of commit ${hash.slice(0, 7)}. Leave a commit body comment instead.`);
  }
  const content = await getCommitContent(repoRoot, side === 'new' ? hash : await getCommitParent(repoRoot, hash), path);
  if (content === BINARY_PREVIEW) throw new Error(`Cannot comment on binary file: ${path}`);
  return {
    location: { on: 'commit', sha: hash, file: { path, side, lines: [startLine, endLine], text: anchorText(reviewLines(content), startLine, endLine) } },
    ...comment(request),
  };
}

function comment(request: Pick<NewThread, 'author' | 'body' | 'queued'>): Pick<NewThread, 'author' | 'body' | 'queued'> {
  return { author: request.author, body: request.body, ...(request.queued ? { queued: true } : {}) };
}

export class UnchangedLinesError extends Error {}
