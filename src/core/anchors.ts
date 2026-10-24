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

/** Whether a file range's text no longer matches the lines it points at. */
export function rangeIsStale(file: { lines: [number, number]; text: string }, lines: string[]): boolean {
  const [start, end] = file.lines;
  return end > lines.length || anchorText(lines, start, end) !== file.text.replace(/\r(?=\n|$)/g, '');
}
