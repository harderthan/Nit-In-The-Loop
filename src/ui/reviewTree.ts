import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ChangedFile } from '../core/git';
import type { ReviewThread } from '../core/review';

export type ReviewFile = Omit<ChangedFile, 'status'> & { status: ChangedFile['status'] | 'threadOnly' };

export interface ReviewRepository {
  root: string;
  files: ReviewFile[];
  threads: ReviewThread[];
  unplacedIds?: Set<string>;
}

export class ChangeItem extends vscode.TreeItem {
  constructor(readonly repoRoot: string, readonly file: ReviewFile, openCount: number, resolvedCount = 0, readonly unplaced: ReviewThread[] = []) {
    super(file.path, unplaced.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const status = file.status === 'threadOnly' ? 'thread only' : file.status;
    this.description = `${status}${openCount ? ` · 🟢 ${openCount} open` : ''}${resolvedCount ? ` · ${resolvedCount} resolved` : ''}${unplaced.length ? ` · ${unplaced.length} outdated` : ''}`;
    this.tooltip = `${file.oldPath ? `${file.oldPath} → ` : ''}${file.path}\n${status} · ${openCount} open · ${resolvedCount} resolved${unplaced.length ? ` · ${unplaced.length} outdated` : ''}${file.binary ? '\nbinary file (comments unavailable)' : ''}`;
    this.resourceUri = vscode.Uri.file(path.join(repoRoot, file.path));
    this.contextValue = file.binary ? 'binaryChangedFile' : 'changedFile';
    this.command = { command: 'agentReview.openDiff', title: 'Open Review Diff', arguments: [this] };
    this.iconPath = new vscode.ThemeIcon(file.status === 'threadOnly' ? 'comment-discussion' : file.status === 'deleted' ? 'diff-removed' : file.status === 'added' ? 'diff-added' : 'diff-modified');
  }
}

class RepositoryItem extends vscode.TreeItem {
  constructor(readonly repository: ReviewRepository) {
    super(path.basename(repository.root), vscode.TreeItemCollapsibleState.Expanded);
    this.description = repository.root;
    this.iconPath = new vscode.ThemeIcon('repo');
  }
}

export class UnplacedThreadItem extends vscode.TreeItem {
  constructor(readonly repoRoot: string, readonly reviewThread: ReviewThread) {
    const file = reviewThread.location.file;
    super(`Outdated · ${file?.side === 'old' ? 'HEAD' : 'Working'} line ${file?.lines[0]}`, vscode.TreeItemCollapsibleState.None);
    this.description = reviewThread.comments[0]?.body.replace(/\s+/g, ' ').slice(0, 70);
    this.tooltip = `Original line ${file?.lines[0]} is outside the current document.\n${reviewThread.comments.map(comment => `${comment.author}: ${comment.body}`).join('\n')}`;
    this.iconPath = new vscode.ThemeIcon('warning');
    this.command = { command: 'agentReview.showStale', title: 'View Outdated Thread', arguments: [this] };
  }
}

type Item = ChangeItem | RepositoryItem | UnplacedThreadItem;

export class ReviewTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private repositories: ReviewRepository[] = [];

  setRepositories(repositories: ReviewRepository[]): void {
    this.repositories = repositories;
    this.changed.fire(undefined);
  }

  getTreeItem(item: Item): vscode.TreeItem { return item; }

  getChildren(item?: Item): Item[] {
    if (!item) {
      if (this.repositories.length === 1) return this.filesFor(this.repositories[0]);
      return this.repositories.map(repo => new RepositoryItem(repo));
    }
    if (item instanceof RepositoryItem) return this.filesFor(item.repository);
    if (item instanceof ChangeItem) return item.unplaced.map(record => new UnplacedThreadItem(item.repoRoot, record));
    return [];
  }

  private filesFor(repo: ReviewRepository): ChangeItem[] {
    return repo.files.map(file => {
      const threads = repo.threads.filter(thread => thread.location.file?.path === file.path);
      return new ChangeItem(repo.root, file,
        threads.filter(thread => thread.status === 'open').length,
        threads.filter(thread => thread.status === 'resolved').length,
        threads.filter(thread => repo.unplacedIds?.has(thread.id)));
    });
  }

  dispose(): void { this.changed.dispose(); }
}
