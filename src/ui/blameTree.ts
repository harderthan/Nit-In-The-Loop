import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BlameCommit } from '../core/blame';
import { getCommitFiles, type HistoryCommit, type HistoryFile } from '../core/history';

export interface HistoryRepository {
  root: string;
  commits: HistoryCommit[];
  hasMore: boolean;
}

const branchColors = ['charts.blue', 'charts.purple', 'charts.green', 'charts.orange', 'charts.red', 'charts.yellow'];
const commitIcon = new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('charts.blue'));
const fileIcons: Record<HistoryFile['status'], vscode.ThemeIcon> = {
  added: new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground')),
  modified: new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')),
  deleted: new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground')),
  renamed: new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.renamedResourceForeground')),
};

export class HistoryRepositoryItem extends vscode.TreeItem {
  constructor(readonly repository: HistoryRepository) {
    super(path.basename(repository.root), vscode.TreeItemCollapsibleState.Expanded);
    this.description = repository.root;
    this.iconPath = new vscode.ThemeIcon('repo');
  }
}

export class HistoryCommitItem extends vscode.TreeItem {
  constructor(readonly repoRoot: string, readonly commit: HistoryCommit, color: string) {
    super(commit.subject, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = commit.refs.length ? commit.refs.join(' · ')
      : `${commit.author} · ${new Date(commit.date).toLocaleString()}`;
    this.tooltip = `${commit.subject}\n${commit.refs.join(' · ')}\n${commit.author} · ${commit.date}\n${commit.hash}`;
    this.iconPath = new vscode.ThemeIcon('git-commit', new vscode.ThemeColor(color));
  }
}

export class HistoryFileItem extends vscode.TreeItem {
  constructor(readonly repoRoot: string, readonly commit: HistoryCommit, readonly file: HistoryFile) {
    super(file.path, vscode.TreeItemCollapsibleState.None);
    this.description = file.status === 'renamed' && file.oldPath ? `renamed from ${file.oldPath}` : file.status;
    this.tooltip = `${file.oldPath ? `${file.oldPath} → ` : ''}${file.path}\n${commit.subject}`;
    this.iconPath = fileIcons[file.status];
    this.command = { command: 'agentReview.openHistoryFile', title: 'Open Commit Change', arguments: [this] };
  }
}

export class HistoryLoadMoreItem extends vscode.TreeItem {
  constructor(readonly repoRoot: string) {
    super('Load more commits', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('ellipsis', new vscode.ThemeColor('charts.blue'));
    this.command = { command: 'agentReview.loadMoreHistory', title: 'Load More Commits', arguments: [this] };
  }
}

export class BlameCommitItem extends vscode.TreeItem {
  constructor(readonly repoRoot: string, readonly filePath: string, readonly commit: BlameCommit) {
    super(commit.subject, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = `${commit.author} · ${new Date(commit.date).toLocaleString()} · ${commit.hash.slice(0, 7)}`;
    this.tooltip = `${commit.subject}\n${commit.author} · ${commit.date}\n${commit.hash}`;
    this.iconPath = commitIcon;
  }
}

export class BlameLineItem extends vscode.TreeItem {
  constructor(readonly repoRoot: string, readonly filePath: string, readonly line: number) {
    super(`${path.basename(filePath)}:${line}`, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('symbol-text', new vscode.ThemeColor('charts.blue'));
    this.command = { command: 'agentReview.openBlameLine', title: 'Open Blamed Line', arguments: [this] };
  }
}

type Item = HistoryRepositoryItem | HistoryCommitItem | HistoryFileItem | HistoryLoadMoreItem | BlameCommitItem | BlameLineItem;

export class BlameTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private repositories: HistoryRepository[] = [];
  private blameFile?: { repoRoot: string; filePath: string; commits: BlameCommit[] };
  private readonly colorsByRepository = new Map<string, Map<string, string>>();
  private readonly currentBranchByRepository = new Map<string, string | undefined>();

  setHistory(repositories: HistoryRepository[]): void {
    this.repositories = repositories;
    this.blameFile = undefined;
    const roots = new Set(repositories.map(repository => repository.root));
    for (const root of this.colorsByRepository.keys()) {
      if (!roots.has(root)) {
        this.colorsByRepository.delete(root);
        this.currentBranchByRepository.delete(root);
      }
    }
    this.changed.fire(undefined);
  }

  setFile(repoRoot: string, filePath: string, commits: BlameCommit[]): void {
    this.blameFile = {
      repoRoot, filePath,
      commits: [...commits].sort((left, right) => right.date.localeCompare(left.date)),
    };
    this.changed.fire(undefined);
  }

  getTreeItem(item: Item): vscode.TreeItem { return item; }

  async getChildren(item?: Item): Promise<Item[]> {
    if (item instanceof HistoryRepositoryItem) return this.commitItems(item.repository);
    if (item instanceof HistoryCommitItem) {
      const files = await getCommitFiles(item.repoRoot, item.commit.hash);
      return files.map(file => new HistoryFileItem(item.repoRoot, item.commit, file));
    }
    if (item instanceof BlameCommitItem) {
      return item.commit.lines.map(line => new BlameLineItem(item.repoRoot, item.filePath, line));
    }
    if (item) return [];
    if (this.blameFile) {
      const { repoRoot, filePath, commits } = this.blameFile;
      return commits.map(commit => new BlameCommitItem(repoRoot, filePath, commit));
    }
    if (this.repositories.length === 1) return this.commitItems(this.repositories[0]);
    return this.repositories.map(repository => new HistoryRepositoryItem(repository));
  }

  private commitItems(repository: HistoryRepository): Item[] {
    const currentBranch = repository.commits.find(commit => commit.refs.includes('HEAD'))?.branch;
    if (this.currentBranchByRepository.get(repository.root) !== currentBranch) {
      this.colorsByRepository.delete(repository.root);
      this.currentBranchByRepository.set(repository.root, currentBranch);
    }
    let colors = this.colorsByRepository.get(repository.root);
    if (!colors) {
      colors = new Map<string, string>();
      this.colorsByRepository.set(repository.root, colors);
    }
    if (currentBranch) colors.set(currentBranch, branchColors[0]);
    const branches = [...new Set(repository.commits.map(commit => commit.branch))]
      .sort((left, right) => left === currentBranch ? -1 : right === currentBranch ? 1 : left.localeCompare(right));
    for (const branch of branches) {
      if (!colors.has(branch)) colors.set(branch, branchColors[colors.size % branchColors.length]);
    }
    const commits: Item[] = repository.commits.map(commit =>
      new HistoryCommitItem(repository.root, commit, colors.get(commit.branch) ?? branchColors[0]));
    if (repository.hasMore) commits.push(new HistoryLoadMoreItem(repository.root));
    return commits;
  }

  dispose(): void { this.changed.dispose(); }
}
