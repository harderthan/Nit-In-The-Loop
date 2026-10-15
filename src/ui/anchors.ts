export type ReviewSide = 'old' | 'new';
export { reviewLines } from '../core/anchors';

export function lineRange(startLine: number, endLine: number): { start: number; end: number } {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error('Invalid review line range');
  }
  return { start: startLine - 1, end: endLine - 1 };
}

export function reviewLocation(startLine: number, startCharacter: number, endLine: number, endCharacter: number): { startLine: number; endLine: number } {
  if (endLine < startLine || startLine < 0) throw new Error('Invalid editor selection');
  const inclusiveEnd = endLine > startLine && endCharacter === 0 ? endLine - 1 : endLine;
  return { startLine: startLine + 1, endLine: inclusiveEnd + 1 };
}

export function encodeReviewUri(side: ReviewSide, repoRoot: string, path: string): string {
  const repository = Buffer.from(repoRoot, 'utf8').toString('base64url');
  const url = new URL(`agent-review-${side}://review/`);
  // The actual filename in the URI path lets VS Code pick its language mode.
  url.pathname = `/${path.split('/').map(encodeURIComponent).join('/')}`;
  url.search = repository;
  return url.toString();
}

export function decodeReviewUri(value: string): { side: ReviewSide; repoRoot: string; path: string } | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'agent-review-old:' && url.protocol !== 'agent-review-new:') return undefined;
    if (!url.search) return undefined;
    const repoRoot = Buffer.from(url.search.slice(1), 'base64url').toString('utf8');
    const path = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
    if (!repoRoot || !path) return undefined;
    return { side: url.protocol === 'agent-review-old:' ? 'old' : 'new', repoRoot, path };
  } catch {
    return undefined;
  }
}
