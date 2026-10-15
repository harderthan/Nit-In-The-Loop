import * as vscode from 'vscode';
import type { ReviewComment, ReviewThread } from '../core/review';
import { threadIsStale } from '../core/anchors';
import { decodeReviewUri, encodeReviewUri, lineRange, reviewLines } from './anchors';
import { authorPresentation } from './author';

export interface RenderedThread {
  id: string;
  repoRoot: string;
  thread: vscode.CommentThread;
}

function asComment(comment: ReviewComment, stale: boolean, author: vscode.CommentAuthorInformation): vscode.Comment {
  return {
    body: comment.body,
    author,
    label: stale ? 'Outdated line' : undefined,
    timestamp: new Date(comment.createdAt),
    mode: vscode.CommentMode.Preview,
  };
}

export class ReviewComments implements vscode.Disposable {
  readonly controller = vscode.comments.createCommentController('agent-review', 'NITL');
  private readonly threads = new Map<string, RenderedThread>();
  private readonly unplaced = new Map<string, Set<string>>();
  private readonly authors: Record<ReviewComment['author'], vscode.CommentAuthorInformation>;

  constructor(extensionUri: vscode.Uri, private readonly isReviewFile: (repoRoot: string, path: string) => boolean) {
    const authorInfo = (author: ReviewComment['author']): vscode.CommentAuthorInformation => {
      const { name, assetPath } = authorPresentation(author);
      return { name, iconPath: vscode.Uri.joinPath(extensionUri, assetPath) };
    };
    this.authors = { agent: authorInfo('agent'), human: authorInfo('human') };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document => {
        const location = decodeReviewUri(document.uri.toString());
        if (!location || !this.isReviewFile(location.repoRoot, location.path)) return [];
        const lineCount = reviewLines(document.getText()).length;
        if (!lineCount) return [];
        return [new vscode.Range(0, 0, lineCount - 1, document.lineAt(lineCount - 1).text.length)];
      },
    };
  }

  render(repoRoot: string, records: ReviewThread[], getContent: (record: ReviewThread) => string): void {
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
      const uri = vscode.Uri.parse(encodeReviewUri(record.side, repoRoot, record.path));
      const content = getContent(record);
      const lines = reviewLines(content);
      const bounds = lineRange(record.startLine, record.endLine);
      const anchored = bounds.start < lines.length && bounds.end < lines.length;
      // Out-of-range anchors are exposed by the review tree, never moved to another line.
      if (!anchored) {
        unplaced.add(record.id);
        this.threads.get(key)?.thread.dispose();
        this.threads.delete(key);
        continue;
      }
      const range = new vscode.Range(bounds.start, 0, bounds.end, lines[bounds.end]?.length ?? 0);
      const stale = threadIsStale(record, lines);
      const comments = record.comments.map(comment => asComment(comment, stale, this.authors[comment.author]));
      let rendered = this.threads.get(key);
      if (!rendered || rendered.thread.uri.toString() !== uri.toString()) {
        rendered?.thread.dispose();
        const thread = this.controller.createCommentThread(uri, range, comments);
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        rendered = { id: record.id, repoRoot, thread };
        this.threads.set(key, rendered);
      } else {
        rendered.thread.range = range;
        rendered.thread.comments = comments;
      }
      rendered.thread.label = stale ? 'Outdated line · review anchor changed' : `Lines ${record.startLine}${record.endLine !== record.startLine ? `–${record.endLine}` : ''}`;
      rendered.thread.contextValue = record.resolved ? 'resolved' : 'open';
      rendered.thread.state = record.resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
      rendered.thread.canReply = record.resolved ? false : this.authors.human;
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
