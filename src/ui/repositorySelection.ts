import path from 'node:path';

/** Picks the repository that owns the active review or local file. */
export function selectRepositoryRoot(roots: readonly string[], reviewRoot?: string, activeFile?: string): string | undefined {
  if (reviewRoot && roots.includes(reviewRoot)) return reviewRoot;
  if (activeFile) {
    const containing = roots.filter(root => {
      const relative = path.relative(root, activeFile);
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    });
    if (containing.length) return containing.sort((a, b) => b.length - a.length)[0];
  }
  return roots.length === 1 ? roots[0] : undefined;
}
