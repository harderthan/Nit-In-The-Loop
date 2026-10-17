import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { addReply, addThread, setResolved, type ReviewDocument } from './core/review';
import { readReview, updateReview } from './core/store';
import { discoverRepository, getChangesAsync, getHeadContent, getHeadSha, getStorePath, getWorkingContent, type ChangedFile } from './core/git';
import { prepareThread } from './core/prepareThread';
import { decodeReviewUri, encodeReviewUri, reviewLocation } from './ui/anchors';
import { ReviewComments } from './ui/comments';
import { ChangeItem, UnplacedThreadItem, ReviewTreeProvider, type ReviewRepository, type ReviewFile } from './ui/reviewTree';
import { CoalescedRefresh } from './ui/refreshQueue';
import { selectRepositoryRoot } from './ui/repositorySelection';
import { StoreWatchers } from './ui/storeWatchers';
import { commentableReviewFileFor, reviewFileFor } from './ui/reviewAccess';
import { getFileBlame } from './core/blame';
import { getCommitContent, getCommitParent, getCurrentBranch, getRepositoryHistory } from './core/history';
import { BlameLineItem, BlameTreeProvider, HistoryFileItem, HistoryLoadMoreItem, type HistoryRepository } from './ui/blameTree';

interface RepoState extends ReviewRepository { storePath: string; changedFiles: ChangedFile[] }

export function activate(context: vscode.ExtensionContext): void {
  const states = new Map<string, RepoState>();
  const tree = new ReviewTreeProvider();
  const treeView = vscode.window.createTreeView('agentReview.changes', { treeDataProvider: tree, showCollapseAll: true });
  const blameTree = new BlameTreeProvider();
  const blameView = vscode.window.createTreeView('agentReview.blame', { treeDataProvider: blameTree, showCollapseAll: true });
  blameView.message = 'Open a Git repository to inspect its history.';
  const comments = new ReviewComments(context.extensionUri, (root, file) => {
    return !!commentableReviewFileFor(states, root, file);
  });
  const virtualChanges = new vscode.EventEmitter<vscode.Uri>();
  let latestBlameRequest = 0;
  const provider = (side: 'old' | 'new'): vscode.TextDocumentContentProvider => ({
    onDidChange: virtualChanges.event,
    provideTextDocumentContent: uri => {
      const location = decodeReviewUri(uri.toString());
      if (!location || location.side !== side) return '';
      const file = reviewFileFor(states, location.repoRoot, location.path);
      if (!file) return '';
      if (file.binary) return 'Binary file: line comments are unavailable.';
      const content = side === 'old'
        ? getHeadContent(location.repoRoot, location.path)
        : getWorkingContent(location.repoRoot, location.path);
      return content;
    },
  });
  context.subscriptions.push(tree, treeView, blameTree, blameView, comments, virtualChanges,
    vscode.workspace.registerTextDocumentContentProvider('agent-review-old', provider('old')),
    vscode.workspace.registerTextDocumentContentProvider('agent-review-new', provider('new')),
    vscode.workspace.registerTextDocumentContentProvider('agent-review-blame', {
      provideTextDocumentContent: uri => {
        const repoRoot = uri.query;
        const filePath = uri.path.slice(1);
        const file = states.get(repoRoot)?.files.find(candidate => (candidate.oldPath ?? candidate.path) === filePath);
        if (!file || file.binary) return '';
        return getHeadContent(repoRoot, filePath);
      },
    }),
    vscode.workspace.registerTextDocumentContentProvider('agent-review-history', {
      provideTextDocumentContent: uri => {
        let location: { repoRoot: string; hash: string };
        try { location = JSON.parse(uri.query); } catch { return ''; }
        if (!location || typeof location.repoRoot !== 'string' || typeof location.hash !== 'string'
          || !states.has(location.repoRoot) || !location.hash) return '';
        return getCommitContent(location.repoRoot, location.hash, uri.path.slice(1));
      },
    }));

  const storeWatchers = new StoreWatchers(storePath => {
    const listener = (current: fs.Stats, previous: fs.Stats) => {
      if (current.mtimeMs !== previous.mtimeMs) void refresh().catch(showError);
    };
    fs.watchFile(storePath, { interval: 750 }, listener);
    return () => fs.unwatchFile(storePath, listener);
  });
  context.subscriptions.push(storeWatchers);

  const fileFingerprints = new Map<string, string>();
  const headFingerprints = new Map<string, string>();
  const historyLimits = new Map<string, number>();
  async function loadHistory(roots: string[]): Promise<HistoryRepository[]> {
    return Promise.all(roots.map(async root => {
      const limit = historyLimits.get(root) ?? 50;
      const commits = await getRepositoryHistory(root, limit + 1);
      return { root, commits: commits.slice(0, limit), hasMore: commits.length > limit };
    }));
  }
  const refreshQueue = new CoalescedRefresh(async () => {
    const roots = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      try { roots.add(discoverRepository(folder.uri.fsPath)); } catch { /* Other workspace folders may not be Git repos. */ }
    }
    for (const root of roots) {
      const storePath = getStorePath(root);
      const changedFiles = await getChangesAsync(root);
      fileFingerprints.set(root, JSON.stringify(changedFiles));
      headFingerprints.set(root, `${getHeadSha(root)}\0${await getCurrentBranch(root)}`);
      const document = await readReview(storePath);
      const files: ReviewFile[] = [...changedFiles];
      states.set(root, { root, files, changedFiles, threads: document.threads, storePath });
      storeWatchers.ensure(storePath);
      for (const record of document.threads) {
        // Persisted comments remain visible after the file leaves the changed-file list.
        if (!files.some(file => file.path === record.path)) files.push({ path: record.path, status: 'threadOnly' });
      }
      const contentCache = new Map<string, string>();
      comments.render(root, document.threads, record => {
        const key = `${record.side}\0${record.path}`;
        const cached = contentCache.get(key);
        if (cached !== undefined) return cached;
        let content: string;
        try { content = record.side === 'old' ? getHeadContent(root, record.path) : getWorkingContent(root, record.path); }
        catch { content = ''; }
        contentCache.set(key, content);
        return content;
      });
      states.get(root)!.unplacedIds = comments.unplacedIds(root);
      for (const file of files) {
        virtualChanges.fire(vscode.Uri.parse(encodeReviewUri('old', root, file.path)));
        virtualChanges.fire(vscode.Uri.parse(encodeReviewUri('new', root, file.path)));
      }
    }
    for (const root of states.keys()) if (!roots.has(root)) {
      comments.render(root, [], () => '');
      states.delete(root);
      fileFingerprints.delete(root);
      headFingerprints.delete(root);
      historyLimits.delete(root);
    }
    storeWatchers.retain([...states.values()].map(state => state.storePath));
    const repositories = [...states.values()];
    tree.setRepositories(repositories);
    const history = await loadHistory(repositories.map(repository => repository.root));
    blameTree.setHistory(history);
    blameView.description = history.length === 1 ? path.basename(history[0].root) : undefined;
    blameView.message = history.length === 0 ? 'Open a Git repository to inspect its history.'
      : history.every(repository => repository.commits.length === 0) ? 'No commits in this repository yet.' : undefined;
    treeView.message = repositories.length ? (repositories.every(repo => repo.files.length === 0) ? 'No changed files. Edit a tracked file or create a new one, then refresh.' : undefined) : 'Open a Git repository to review its changes.';
    updateEditorContext();
  });
  function refresh(): Promise<void> {
    return refreshQueue.request();
  }

  function updateEditorContext(): void {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const location = uri && decodeReviewUri(uri.toString());
    const file = location && commentableReviewFileFor(states, location.repoRoot, location.path);
    void vscode.commands.executeCommand('setContext', 'agentReview.reviewEditor', !!file);
  }

  function showError(error: unknown): void {
    void vscode.window.showErrorMessage(`NITL: ${error instanceof Error ? error.message : String(error)}`);
  }

  async function mutate(root: string, change: (document: ReviewDocument) => void): Promise<void> {
    const state = states.get(root);
    if (!state) throw new Error('Open a Git repository first.');
    await updateReview(state.storePath, change);
    await refresh();
  }

  async function openDiff(item?: ChangeItem): Promise<void> {
    let selected = item;
    if (!selected) {
      const active = vscode.window.activeTextEditor?.document.uri;
      const location = active && decodeReviewUri(active.toString());
      if (location) {
        const file = states.get(location.repoRoot)?.files.find(candidate => candidate.path === location.path);
        if (file) selected = new ChangeItem(location.repoRoot, file, 0);
      }
    }
    if (!selected) throw new Error('Select a changed file in NITL.');
    if (selected.file.binary) {
      await vscode.window.showInformationMessage(`${selected.file.path} is binary; line review is unavailable.`);
      return;
    }
    const oldUri = vscode.Uri.parse(encodeReviewUri('old', selected.repoRoot, selected.file.path));
    const newUri = vscode.Uri.parse(encodeReviewUri('new', selected.repoRoot, selected.file.path));
    const title = `${selected.file.oldPath ? `${selected.file.oldPath} → ` : ''}${selected.file.path} (HEAD ↔ Working Tree)`;
    await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title, { preview: false });
    updateEditorContext();
  }

  async function showBlame(item?: ChangeItem): Promise<void> {
    let selected = item;
    if (!selected) {
      const active = vscode.window.activeTextEditor?.document.uri;
      const location = active && decodeReviewUri(active.toString());
      const root = location?.repoRoot ?? (active?.scheme === 'file'
        ? selectRepositoryRoot([...states.keys()], undefined, active.fsPath) : undefined);
      const filePath = location?.path ?? (root && active?.scheme === 'file'
        ? path.relative(root, active.fsPath).split(path.sep).join('/') : undefined);
      const file = root && states.get(root)?.files.find(candidate => candidate.path === filePath);
      if (root && file) selected = new ChangeItem(root, file, 0);
    }
    if (!selected) throw new Error('Select a changed file in NITL.');
    const request = ++latestBlameRequest;
    if (selected.file.binary) {
      await vscode.window.showInformationMessage(`${selected.file.path} is binary; line blame is unavailable.`);
      return;
    }
    const filePath = selected.file.oldPath ?? selected.file.path;
    const commits = await getFileBlame(selected.repoRoot, filePath);
    if (request !== latestBlameRequest) return;
    blameTree.setFile(selected.repoRoot, filePath, commits);
    blameView.description = selected.file.path;
    blameView.message = commits.length ? undefined : 'No committed lines for this file.';
    await vscode.commands.executeCommand('agentReview.blame.focus');
  }

  async function openBlameLine(item: BlameLineItem): Promise<void> {
    const file = states.get(item.repoRoot)?.files.find(candidate => (candidate.oldPath ?? candidate.path) === item.filePath);
    if (!file) throw new Error('Refresh Changed Files and select the file again.');
    if (file.binary) throw new Error('Line blame is unavailable for binary files.');
    const uri = vscode.Uri.from({
      scheme: 'agent-review-blame', path: `/${item.filePath}`, query: item.repoRoot,
      fragment: getHeadSha(item.repoRoot),
    });
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const position = new vscode.Position(item.line - 1, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  }

  function historyUri(repoRoot: string, hash: string, filePath: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: 'agent-review-history', path: `/${filePath}`, query: JSON.stringify({ repoRoot, hash }),
    });
  }

  async function openHistoryFile(item: HistoryFileItem): Promise<void> {
    const parent = await getCommitParent(item.repoRoot, item.commit.hash);
    const oldUri = historyUri(item.repoRoot, parent, item.file.oldPath ?? item.file.path);
    const newUri = historyUri(item.repoRoot, item.commit.hash, item.file.path);
    const title = `${item.file.path} (${item.commit.hash.slice(0, 7)})`;
    await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title, { preview: false });
  }

  async function loadMoreHistory(item: HistoryLoadMoreItem): Promise<void> {
    historyLimits.set(item.repoRoot, (historyLimits.get(item.repoRoot) ?? 50) + 50);
    await refresh();
  }

  async function createThread(input?: vscode.CommentReply): Promise<void> {
    const native = input && 'thread' in input && 'text' in input ? input : undefined;
    const editor = vscode.window.activeTextEditor;
    const uri = native?.thread.uri ?? editor?.document.uri;
    const range = native?.thread.range ?? editor?.selection;
    if (!uri || !range) throw new Error('Open a review diff and select a line.');
    const location = decodeReviewUri(uri.toString());
    if (!location) throw new Error('Comments can be added from a diff in NITL.');
    const state = states.get(location.repoRoot);
    const file = commentableReviewFileFor(states, location.repoRoot, location.path);
    if (!state || !file) throw new Error('This file is not available for line review.');
    const body = native?.text ?? await vscode.window.showInputBox({ title: 'Add Review Comment', prompt: 'Comment on the selected line or range', ignoreFocusOut: true });
    if (!body?.trim()) return;
    const { startLine, endLine } = reviewLocation(range.start.line, range.start.character, range.end.line, range.end.character);
    const thread = prepareThread(location.repoRoot, state.changedFiles, {
      path: location.path, side: location.side, startLine, endLine, author: 'human', body,
    });
    await mutate(location.repoRoot, document => {
      addThread(document, thread);
    });
    if (native) native.thread.dispose();
  }

  async function reply(input: vscode.CommentReply): Promise<void> {
    const target = comments.idForThread(input.thread);
    if (!target) throw new Error('Select an existing review thread.');
    if (!input.text?.trim()) return;
    await mutate(target.repoRoot, document => { addReply(document, target.id, { author: 'human', body: input.text }); });
  }

  async function changeResolution(thread: vscode.CommentThread, resolved: boolean): Promise<void> {
    const target = comments.idForThread(thread);
    if (!target) throw new Error('Select an existing review thread.');
    await mutate(target.repoRoot, document => { setResolved(document, target.id, resolved); });
  }

  async function copyCliCommand(): Promise<void> {
    if (states.size === 0) await refresh();
    const roots = [...states.keys()];
    if (roots.length === 0) throw new Error('Open a Git repository first.');
    const active = vscode.window.activeTextEditor?.document.uri;
    const reviewRoot = active && decodeReviewUri(active.toString())?.repoRoot;
    const repoRoot = selectRepositoryRoot(roots, reviewRoot, active?.scheme === 'file' ? active.fsPath : undefined)
      ?? (roots.length > 1 ? await vscode.window.showQuickPick(roots, { placeHolder: 'Choose a repository for the NITL CLI' }) : undefined);
    if (!repoRoot) return;
    const quote = (value: string): string => `'${value.replace(/'/g, process.platform === 'win32' ? "''" : "'\\''")}'`;
    const cliPath = path.join(context.extensionPath, 'dist', 'cli.js');
    const invocation = `node ${quote(cliPath)} files --repo ${quote(repoRoot)}`;
    await vscode.env.clipboard.writeText(invocation);
    await vscode.window.showInformationMessage('NITL CLI command copied. Paste it in a terminal to list changed files.');
  }

  function command(name: string, action: (...args: any[]) => Promise<void>): vscode.Disposable {
    return vscode.commands.registerCommand(name, (...args: any[]) => { void action(...args).catch(showError); });
  }
  context.subscriptions.push(
    command('agentReview.openDiff', openDiff),
    command('agentReview.showBlame', showBlame),
    command('agentReview.openBlameLine', openBlameLine),
    command('agentReview.openHistoryFile', openHistoryFile),
    command('agentReview.loadMoreHistory', loadMoreHistory),
    command('agentReview.showStale', async (item: UnplacedThreadItem) => {
      const record = item.reviewThread;
      const detail = record.comments.map(comment => `${comment.author}: ${comment.body}`).join('\n\n');
      await vscode.window.showInformationMessage(`Outdated thread at ${record.path}:${record.startLine} (${record.side}). ${detail}`);
    }),
    command('agentReview.refresh', refresh),
    command('agentReview.copyCliCommand', copyCliCommand),
    command('agentReview.createThread', createThread),
    command('agentReview.reply', reply),
    command('agentReview.resolve', thread => changeResolution(thread, true)),
    command('agentReview.reopen', thread => changeResolution(thread, false)),
    vscode.window.onDidChangeActiveTextEditor(updateEditorContext),
    vscode.workspace.onDidSaveTextDocument(() => { void refresh().catch(showError); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh().catch(showError); }),
  );
  let polling = false;
  async function pollChanges(): Promise<void> {
    if (polling || refreshQueue.isRunning || (!treeView.visible && !blameView.visible)) return;
    polling = true;
    try {
      for (const root of states.keys()) {
        if (`${getHeadSha(root)}\0${await getCurrentBranch(root)}` !== headFingerprints.get(root)) {
          await refresh();
          break;
        }
        const next = JSON.stringify(await getChangesAsync(root));
        if (next !== fileFingerprints.get(root)) {
          await refresh();
          break;
        }
      }
    } finally {
      polling = false;
    }
  }
  context.subscriptions.push(treeView.onDidChangeVisibility(event => {
    if (event.visible) void refresh().catch(showError);
  }));
  const timer = setInterval(() => { void pollChanges().catch(showError); }, 3000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  void refresh().catch(showError);
}

export function deactivate(): void { /* ExtensionContext disposes subscriptions. */ }
