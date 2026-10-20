import { anchorText, reviewLines } from './anchors';
import { getHeadContent, getHeadSha, getWorkingContent, type ChangedFile } from './git';
import { BINARY_PREVIEW, getCommitChangedLines, getCommitContent, getCommitParent, rangeIsChanged, resolveCommit } from './history';
import type { NewThread } from './review';

type ThreadRequest = Pick<NewThread, 'path' | 'side' | 'startLine' | 'endLine' | 'author' | 'body'>;

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
  return { ...request, baseCommit: getHeadSha(repoRoot), anchorText: anchorText(lines, startLine, endLine) };
}

/**
 * Bind a comment to a commit. Without a path it is a commit body comment. With a
 * path, its lines must lie in one block that the commit changed on that side.
 */
export async function prepareCommitThread(
  repoRoot: string, commit: string, request: Pick<NewThread, 'author' | 'body'> & Partial<ThreadRequest>,
): Promise<NewThread> {
  const hash = await resolveCommit(repoRoot, commit);
  if (!request.path) {
    return { path: '', side: 'new', startLine: 1, endLine: 1, baseCommit: hash, anchorText: '', commit: hash, author: request.author, body: request.body };
  }
  const { path, side, startLine = 0, endLine = 0 } = request;
  if (side !== 'old' && side !== 'new') throw new Error('--side must be old or new');
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error('Invalid thread line range');
  }
  const ranges = await getCommitChangedLines(repoRoot, hash, path, side);
  if (!rangeIsChanged(ranges, startLine, endLine)) {
    throw new UnchangedLinesError(`Lines ${startLine}-${endLine} on the ${side} side of ${path} are not changed in commit ${hash.slice(0, 7)}. Leave a commit body comment instead.`);
  }
  const content = await getCommitContent(repoRoot, side === 'new' ? hash : await getCommitParent(repoRoot, hash), path);
  if (content === BINARY_PREVIEW) throw new Error(`Cannot comment on binary file: ${path}`);
  return {
    path, side, startLine, endLine, baseCommit: hash,
    anchorText: anchorText(reviewLines(content), startLine, endLine), commit: hash, author: request.author, body: request.body,
  };
}

export class UnchangedLinesError extends Error {}
