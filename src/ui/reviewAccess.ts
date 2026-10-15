import type { ChangedFile } from '../core/git';

/** Decoded review URIs only identify a file; current repository state grants access. */
export function reviewFileFor<T extends { path: string; binary?: boolean }>(
  states: ReadonlyMap<string, { files: readonly T[] }>,
  repoRoot: string,
  filePath: string,
): T | undefined {
  return states.get(repoRoot)?.files.find(file => file.path === filePath);
}

/** New comments are permitted only on actual text changes, never retained thread-only files. */
export function commentableReviewFileFor(
  states: ReadonlyMap<string, { changedFiles: readonly ChangedFile[] }>,
  repoRoot: string,
  filePath: string,
): ChangedFile | undefined {
  return states.get(repoRoot)?.changedFiles.find(file => file.path === filePath && !file.binary);
}
