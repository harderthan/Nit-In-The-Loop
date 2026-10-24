export type ReviewSide = 'old' | 'new';

export function lineRange(startLine: number, endLine: number): { start: number; end: number } {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error('Invalid review line range');
  }
  return { start: startLine - 1, end: endLine - 1 };
}

export function reviewLocation(startLine: number, endLine: number, endCharacter: number): { startLine: number; endLine: number } {
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

/** A side of a commit diff, or the commit body document that commit body comments attach to. */
export interface HistoryLocation { repoRoot: string; commit: string; side: ReviewSide | 'commit'; path: string }

export function encodeHistoryUri(location: HistoryLocation): string {
  const url = new URL('agent-review-history://review/');
  // The commit body has no file, so its path is only a readable tab title.
  const path = location.side === 'commit' ? `${location.commit.slice(0, 7)}.commit` : location.path;
  url.pathname = `/${path.split('/').map(encodeURIComponent).join('/')}`;
  url.search = Buffer.from(JSON.stringify([location.repoRoot, location.commit, location.side]), 'utf8').toString('base64url');
  return url.toString();
}

export function decodeHistoryUri(value: string): HistoryLocation | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'agent-review-history:' || !url.search) return undefined;
    const [repoRoot, commit, side] = JSON.parse(Buffer.from(url.search.slice(1), 'base64url').toString('utf8')) as unknown[];
    if (typeof repoRoot !== 'string' || !repoRoot || typeof commit !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)
      || (side !== 'old' && side !== 'new' && side !== 'commit')) return undefined;
    const path = side === 'commit' ? '' : url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
    if (side !== 'commit' && !path) return undefined;
    return { repoRoot, commit, side, path };
  } catch {
    return undefined;
  }
}
