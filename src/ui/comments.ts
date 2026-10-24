import * as vscode from 'vscode';
import type { ReviewComment, ReviewThread } from '../core/review';
import { rangeIsStale, reviewLines } from '../core/anchors';
import { decodeHistoryUri, decodeReviewUri, lineRange, type HistoryLocation } from './anchors';
import { authorPresentation } from './author';

export interface RenderedThread {
  id: string;
  repoRoot: string;
  thread: vscode.CommentThread;
  resolved: boolean;
}

function asComment(comment: ReviewComment, stale: boolean, author: vscode.CommentAuthorInformation): vscode.Comment {
  return {
    body: comment.body,
    author,
    label: [stale && 'Outdated line', comment.queued && 'Queued · not sent to the agent yet'].filter(Boolean).join(' · ') || undefined,
    timestamp: new Date(comment.at),
    mode: vscode.CommentMode.Preview,
  };
}

export class ReviewComments implements vscode.Disposable {
  readonly controller = vscode.comments.createCommentController('agent-review', 'NITL');
  private readonly threads = new Map<string, RenderedThread>();
  /** `${repoRoot}\0${threadId}` of threads an agent run is answering. */
  readonly running = new Set<string>();
  private readonly unplaced = new Map<string, Set<string>>();
  private readonly authors: Record<ReviewComment['author'], vscode.CommentAuthorInformation>;

  constructor(
    extensionUri: vscode.Uri,
    /** An empty path asks only whether the repository is open. */
    private readonly isReviewFile: (repoRoot: string, path: string) => boolean,
    private readonly commitChangedLines: (location: HistoryLocation) => Promise<Array<[number, number]>> = async () => [],
  ) {
    const authorInfo = (author: ReviewComment['author']): vscode.CommentAuthorInformation => {
      const { name, assetPath } = authorPresentation(author);
      return { name, iconPath: vscode.Uri.joinPath(extensionUri, assetPath) };
    };
    this.authors = { agent: authorInfo('agent'), human: authorInfo('human') };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: async document => {
        const history = decodeHistoryUri(document.uri.toString());
        if (history) {
          if (!this.isReviewFile(history.repoRoot, '')) return [];
          const whole: Array<[number, number]> = document.lineCount ? [[1, document.lineCount]] : [];
          // Line threads go only on diff hunk lines. The commit body takes comments on any line.
          const ranges = history.side === 'commit' ? whole : await this.commitChangedLines(history);
          return ranges.filter(([, end]) => end <= document.lineCount)
            .map(([start, end]) => new vscode.Range(start - 1, 0, end - 1, document.lineAt(end - 1).text.length));
        }
        const location = decodeReviewUri(document.uri.toString());
        if (!location || !this.isReviewFile(location.repoRoot, location.path)) return [];
        const lineCount = reviewLines(document.getText()).length;
        if (!lineCount) return [];
        return [new vscode.Range(0, 0, lineCount - 1, document.lineAt(lineCount - 1).text.length)];
      },
    };
  }

  /** `place` gives the document URI that shows a thread and that document's content. */
  render(repoRoot: string, records: ReviewThread[], place: (record: ReviewThread) => { uri: string; content: string }): void {
    const unplaced = new Set<string>();
    this.unplaced.set(repoRoot, unplaced);
    const validIds = new Set(records.map(record => `${repoRoot}\0${record.id}`));
    for (const [key, rendered] of this.threads) {
      if (rendered.repoRoot === repoRoot && !validIds.has(key)) {
        rendered.thread.dispose();
        this.threads.delete(key);
      }
    }
    for (const record of records) {
      const key = `${repoRoot}\0${record.id}`;
      const placement = place(record);
      const uri = vscode.Uri.parse(placement.uri);
      const lines = reviewLines(placement.content);
      const { file } = record.location;
      const body = !file;
      const resolved = record.status === 'resolved';
      const bounds = file ? lineRange(...file.lines) : { start: 0, end: 0 };
      const anchored = body || (bounds.start < lines.length && bounds.end < lines.length);
      // Out-of-range anchors are exposed by the review tree, never moved to another line.
      if (!anchored) {
        unplaced.add(record.id);
        this.threads.get(key)?.thread.dispose();
        this.threads.delete(key);
        continue;
      }
      const range = new vscode.Range(bounds.start, 0, bounds.end, body ? 0 : lines[bounds.end]?.length ?? 0);
      const stale = !!file && rangeIsStale(file, lines);
      const comments = record.comments.map(comment => asComment(comment, stale, this.authors[comment.author]));
      let rendered = this.threads.get(key);
      if (!rendered || rendered.thread.uri.toString() !== uri.toString()) {
        rendered?.thread.dispose();
        const thread = this.controller.createCommentThread(uri, range, comments);
        rendered = { id: record.id, repoRoot, thread, resolved: !resolved };
        this.threads.set(key, rendered);
      } else {
        rendered.thread.range = range;
        rendered.thread.comments = comments;
      }
      // Open threads start expanded and resolved ones collapsed. Otherwise the user's choice is kept.
      if (rendered.resolved !== resolved) {
        rendered.thread.collapsibleState = resolved
          ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
        rendered.resolved = resolved;
      }
      const queued = record.comments.filter(comment => comment.queued).length;
      const status = this.running.has(key) ? ' · Agent answering…' : queued ? ` · ${queued} queued` : '';
      const [start, end] = file?.lines ?? [0, 0];
      rendered.thread.label = (!file ? `Commit ${record.location.sha.slice(0, 7)}`
        : stale ? 'Outdated line · review anchor changed' : end !== start ? `Lines ${start}–${end}` : `Line ${start}`) + status;
      // `openQueued` shows the thread's send button. Menus match open threads with /^open/.
      rendered.thread.contextValue = resolved ? 'resolved' : queued ? 'openQueued' : 'open';
      rendered.thread.state = resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      rendered.thread.canReply = resolved ? false : this.authors.human;
    }
  }

  unplacedIds(repoRoot: string): Set<string> { return this.unplaced.get(repoRoot) ?? new Set(); }

  idForThread(thread: vscode.CommentThread): { repoRoot: string; id: string } | undefined {
    for (const item of this.threads.values()) if (item.thread === thread) return { repoRoot: item.repoRoot, id: item.id };
    return undefined;
  }

  dispose(): void {
    for (const item of this.threads.values()) item.thread.dispose();
    this.threads.clear();
    this.controller.dispose();
  }
}
