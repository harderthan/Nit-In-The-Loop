import { anchorText, reviewLines } from './anchors';
import { getHeadContent, getHeadSha, getWorkingContent, type ChangedFile } from './git';
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
