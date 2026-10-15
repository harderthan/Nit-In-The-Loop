/** Lines visible on either side of a review diff, without a virtual EOF line. */
export function reviewLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function anchorText(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n');
}

export function threadIsStale(
  thread: { startLine: number; endLine: number; anchorText: string; stale: boolean },
  lines: string[],
): boolean {
  return thread.stale || thread.endLine > lines.length
    || anchorText(lines, thread.startLine, thread.endLine) !== thread.anchorText.replace(/\r(?=\n|$)/g, '');
}
