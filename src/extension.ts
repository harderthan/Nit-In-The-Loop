import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { addAgentReply, addReply, addThread, setResolved, type ReviewDocument } from './core/review';
import { AgentError, buildAgentPrompt, parseAgentCommand, parseAgentReplies, runAgent, withSession } from './core/agent';
import { readReview, updateReview } from './core/store';
import { discoverRepository, getChangesAsync, getHeadContent, getHeadSha, getStorePath, getWorkingContent, type ChangedFile } from './core/git';
import { prepareCommitThread, prepareThread, UnchangedLinesError } from './core/prepareThread';
import { decodeHistoryUri, decodeReviewUri, encodeHistoryUri, encodeReviewUri, reviewLocation, type HistoryLocation } from './ui/anchors';
import { ReviewComments } from './ui/comments';
import { ChangeItem, UnplacedThreadItem, ReviewTreeProvider, type ReviewRepository, type ReviewFile } from './ui/reviewTree';
import { CoalescedRefresh } from './ui/refreshQueue';
import { selectRepositoryRoot } from './ui/repositorySelection';
import { StoreWatchers } from './ui/storeWatchers';
import { commentableReviewFileFor, reviewFileFor } from './ui/reviewAccess';
import { getFileBlame } from './core/blame';
import { getCommitChangedLines, getCommitContent, getCommitParent, getCommitSummary, getCurrentBranch, getRepositoryHistory } from './core/history';
import { BlameLineItem, BlameTreeProvider, HistoryCommitItem, HistoryFileItem, HistoryLoadMoreItem, type HistoryRepository } from './ui/blameTree';

interface RepoState extends ReviewRepository { storePath: string; changedFiles: ChangedFile[] }

/** An error whose message the user already saw. */
class SilentError extends Error {}

export function activate(context: vscode.ExtensionContext): void {
  const states = new Map<string, RepoState>();
  const tree = new ReviewTreeProvider();
  const treeView = vscode.window.createTreeView('agentReview.changes', { treeDataProvider: tree, showCollapseAll: true });
  const blameTree = new BlameTreeProvider();
  const blameView = vscode.window.createTreeView('agentReview.blame', { treeDataProvider: blameTree, showCollapseAll: true });
  blameView.message = 'Open a Git repository to inspect its history.';
  const comments = new ReviewComments(context.extensionUri, (root, file) => {
    return file ? !!commentableReviewFileFor(states, root, file) : states.has(root);
  }, location => location.side === 'commit' ? Promise.resolve([])
    : getCommitChangedLines(location.repoRoot, location.commit, location.path, location.side).catch(() => []));
  const virtualChanges = new vscode.EventEmitter<vscode.Uri>();
  const agentLog = vscode.window.createOutputChannel('NITL Agent');
  // Threads of every kind per repository, and the threads an agent run is answering.
  const allThreads = new Map<string, ReviewDocument['threads']>();
  const runningThreads = comments.running;
  const runningSessions = new Set<string>();
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
  context.subscriptions.push(tree, treeView, blameTree, blameView, comments, virtualChanges, agentLog,
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
      provideTextDocumentContent: async uri => {
        const location = decodeHistoryUri(uri.toString());
        if (!location || !states.has(location.repoRoot)) return '';
        if (location.side === 'commit') return getCommitSummary(location.repoRoot, location.commit);
        const hash = location.side === 'new' ? location.commit : await getCommitParent(location.repoRoot, location.commit);
        return hash ? getCommitContent(location.repoRoot, hash, location.path) : '';
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
      allThreads.set(root, document.threads);
      const working = document.threads.filter(record => !record.commit);
      const commitPlacements = await placeCommitThreads(root, document.threads.filter(record => record.commit));
      const files: ReviewFile[] = [...changedFiles];
      states.set(root, { root, files, changedFiles, threads: working, storePath });
      storeWatchers.ensure(storePath);
      for (const record of working) {
        // Persisted comments remain visible after the file leaves the changed-file list.
        if (!files.some(file => file.path === record.path)) files.push({ path: record.path, status: 'threadOnly' });
      }
      const contentCache = new Map<string, string>();
      comments.render(root, document.threads, record => {
        const placed = commitPlacements.get(record.id);
        if (placed) return placed;
        const uri = encodeReviewUri(record.side, root, record.path);
        const key = `${record.side}\0${record.path}`;
        const cached = contentCache.get(key);
        if (cached !== undefined) return { uri, content: cached };
        let content: string;
        try { content = record.side === 'old' ? getHeadContent(root, record.path) : getWorkingContent(root, record.path); }
        catch { content = ''; }
        contentCache.set(key, content);
        return { uri, content };
      });
      states.get(root)!.unplacedIds = comments.unplacedIds(root);
      for (const file of files) {
        virtualChanges.fire(vscode.Uri.parse(encodeReviewUri('old', root, file.path)));
        virtualChanges.fire(vscode.Uri.parse(encodeReviewUri('new', root, file.path)));
      }
    }
    for (const root of states.keys()) if (!roots.has(root)) {
      comments.render(root, [], () => ({ uri: '', content: '' }));
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
    const history = uri && decodeHistoryUri(uri.toString());
    void vscode.commands.executeCommand('setContext', 'agentReview.reviewEditor', !!file || !!(history && states.has(history.repoRoot)));
  }

  function showError(error: unknown): void {
    if (error instanceof SilentError) return;
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

  async function openHistoryFile(item: HistoryFileItem): Promise<void> {
    const location = { repoRoot: item.repoRoot, commit: item.commit.hash };
    const oldUri = vscode.Uri.parse(encodeHistoryUri({ ...location, side: 'old', path: item.file.oldPath ?? item.file.path }));
    const newUri = vscode.Uri.parse(encodeHistoryUri({ ...location, side: 'new', path: item.file.path }));
    const title = `${item.file.path} (${item.commit.hash.slice(0, 7)})`;
    await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title, { preview: false });
  }

  // Commit content never changes, so it is read from Git once per commit, side, and path.
  const commitContents = new Map<string, string>();
  async function placeCommitThreads(root: string, records: ReviewDocument['threads']): Promise<Map<string, { uri: string; content: string }>> {
    const placements = new Map<string, { uri: string; content: string }>();
    for (const record of records) {
      const commit = record.commit ?? '';
      if (!record.path) {
        placements.set(record.id, { uri: encodeHistoryUri({ repoRoot: root, commit, side: 'commit', path: '' }), content: '' });
        continue;
      }
      const key = `${root}\0${commit}\0${record.side}\0${record.path}`;
      let content = commitContents.get(key);
      if (content === undefined) {
        try {
          const hash = record.side === 'new' ? commit : await getCommitParent(root, commit);
          content = hash ? await getCommitContent(root, hash, record.path) : '';
          commitContents.set(key, content);
        } catch { content = ''; /* A commit that no longer exists leaves its thread unplaced. */ }
      }
      placements.set(record.id, { uri: encodeHistoryUri({ repoRoot: root, commit, side: record.side, path: record.path }), content });
    }
    return placements;
  }

  async function openCommitComments(item: HistoryCommitItem): Promise<void> {
    const uri = vscode.Uri.parse(encodeHistoryUri({ repoRoot: item.repoRoot, commit: item.commit.hash, side: 'commit', path: '' }));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    updateEditorContext();
  }

  async function loadMoreHistory(item: HistoryLoadMoreItem): Promise<void> {
    historyLimits.set(item.repoRoot, (historyLimits.get(item.repoRoot) ?? 50) + 50);
    await refresh();
  }

  async function createThread(input?: vscode.CommentReply, queue = false): Promise<void> {
    const native = input && 'thread' in input && 'text' in input ? input : undefined;
    const editor = vscode.window.activeTextEditor;
    const uri = native?.thread.uri ?? editor?.document.uri;
    const range = native?.thread.range ?? editor?.selection;
    if (!uri || !range) throw new Error('Open a review diff and select a line.');
    const history = decodeHistoryUri(uri.toString());
    if (history) {
      await createCommitThread(history, range, native, queue);
      return;
    }
    const location = decodeReviewUri(uri.toString());
    if (!location) throw new Error('Comments can be added from a diff in NITL.');
    const state = states.get(location.repoRoot);
    const file = commentableReviewFileFor(states, location.repoRoot, location.path);
    if (!state || !file) throw new Error('This file is not available for line review.');
    const body = native?.text ?? await vscode.window.showInputBox({ title: 'Add Review Comment', prompt: 'Comment on the selected line or range', ignoreFocusOut: true });
    if (!body?.trim()) return;
    const { startLine, endLine } = reviewLocation(range.start.line, range.start.character, range.end.line, range.end.character);
    const thread = prepareThread(location.repoRoot, state.changedFiles, {
      path: location.path, side: location.side, startLine, endLine, author: 'human', body, queued: true,
    });
    await saveThread(location.repoRoot, thread, native, queue);
  }

  /** Every reviewer comment starts queued. Send dispatches its thread to the agent right away. */
  async function saveThread(root: string, thread: Parameters<typeof addThread>[1], native: vscode.CommentReply | undefined, queue: boolean): Promise<void> {
    let id = '';
    await mutate(root, document => { id = addThread(document, thread).id; });
    if (native) native.thread.dispose();
    if (!queue) await sendToAgent(root, [id]);
  }

  async function createCommitThread(
    location: HistoryLocation, range: vscode.Range, native: vscode.CommentReply | undefined, queue: boolean,
  ): Promise<void> {
    if (!states.has(location.repoRoot)) throw new Error('Open the commit from NITL Git Blame.');
    const body = native?.text ?? await vscode.window.showInputBox({ title: 'Add Review Comment', prompt: 'Comment on this commit', ignoreFocusOut: true });
    if (!body?.trim()) return;
    const { startLine, endLine } = reviewLocation(range.start.line, range.start.character, range.end.line, range.end.character);
    const request = { author: 'human' as const, body, queued: true };
    let thread;
    if (location.side === 'commit') {
      thread = await prepareCommitThread(location.repoRoot, location.commit, request);
    } else {
      try {
        thread = await prepareCommitThread(location.repoRoot, location.commit, { ...request, path: location.path, side: location.side, startLine, endLine });
      } catch (error) {
        if (!(error instanceof UnchangedLinesError)) throw error;
        // Unchanged lines take no line thread, so the comment goes on the commit body with a reference.
        const lines = endLine === startLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
        thread = await prepareCommitThread(location.repoRoot, location.commit, { ...request, body: `\`${location.path}\` ${lines} (${location.side}):\n\n${body}` });
        void vscode.window.showInformationMessage(`${location.path} ${lines} is unchanged in this commit, so NITL added the comment to the commit body.`);
      }
    }
    await saveThread(location.repoRoot, thread, native, queue);
  }

  async function reply(input: vscode.CommentReply, queue = false): Promise<void> {
    const target = comments.idForThread(input.thread);
    if (!target) throw new Error('Select an existing review thread.');
    if (!input.text?.trim()) return;
    await mutate(target.repoRoot, document => { addReply(document, target.id, { author: 'human', body: input.text, queued: true }); });
    if (!queue) await sendToAgent(target.repoRoot, [target.id]);
  }

  async function sendQueue(): Promise<void> {
    if (states.size === 0) await refresh();
    const batches = [...states.values()].map(state => ({
      root: state.root,
      ids: allThreads.get(state.root)?.filter(thread => !thread.resolved && thread.comments.some(comment => comment.queued)).map(thread => thread.id) ?? [],
    })).filter(batch => batch.ids.length);
    if (batches.length === 0) {
      await vscode.window.showInformationMessage('No queued comments to send.');
      return;
    }
    const argv = agentCommand();
    await Promise.all(batches.map(batch => sendToAgent(batch.root, batch.ids, argv)));
  }

  function agentCommand(): string[] {
    const command = vscode.workspace.getConfiguration('agentReview').get<string>('agentCommand', '').trim();
    if (!command) {
      void vscode.window.showErrorMessage('NITL: Set agentReview.agentCommand, for example "claude -p". Your comment stays queued until you send it.', 'Open Settings')
        .then(choice => { if (choice) void vscode.commands.executeCommand('workbench.action.openSettings', 'agentReview.agentCommand'); });
      throw new SilentError();
    }
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before NITL runs the agent in it.');
    return parseAgentCommand(command);
  }

  /**
   * Send open threads to the agent in one run. Threads that one session already
   * answered resume it, so a thread keeps talking to the same agent session.
   */
  async function sendToAgent(root: string, threadIds: string[], argv = agentCommand()): Promise<void> {
    // Claim the threads before any await, so a second send cannot run them twice.
    const claimed = threadIds.filter(id => !runningThreads.has(`${root}\0${id}`));
    for (const id of claimed) runningThreads.add(`${root}\0${id}`);
    if (claimed.length < threadIds.length) {
      void vscode.window.showInformationMessage('NITL: The agent is still answering this thread. Your comment is queued. Send it after the answer arrives.');
    }
    let session: string | undefined;
    try {
      const document = await readReview(states.get(root)?.storePath ?? getStorePath(root));
      const threads = claimed.map(id => document.threads.find(thread => thread.id === id))
        .filter((thread): thread is ReviewDocument['threads'][number] => !!thread && !thread.resolved);
      if (threads.length === 0) return;
      const answered = new Set(threads.flatMap(thread => thread.comments.map(comment => comment.id)));
      const sessions = new Set(threads.map(thread => thread.agentSession));
      const shared = sessions.size === 1 ? threads[0].agentSession : undefined;
      // Two runs must not resume one session at once, so a busy session gives way to a new one.
      const previous = shared && !runningSessions.has(shared) ? shared : undefined;
      await refresh();
      const prompt = buildAgentPrompt(root, threads);
      const env = { ...process.env, NITL_REPO: root, NITL_THREAD_IDS: threads.map(thread => thread.id).join(',') };
      const title = threads.length === 1 ? 'NITL: Agent is answering the thread' : `NITL: Agent is answering ${threads.length} threads`;
      const output = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        async (_progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          const attempt = (id: string, resume: boolean) => {
            session = id;
            runningSessions.add(id);
            return runAgent({ argv: withSession(argv, { id, resume }), prompt, cwd: root, env, signal: controller.signal });
          };
          if (!previous) return attempt(randomUUID(), false);
          try {
            return await attempt(previous, true);
          } catch (error) {
            // Only a session that the agent no longer has starts over. Any other failure is reported.
            if (!(error instanceof AgentError) || !/no conversation found/i.test(error.stderr)) throw error;
            runningSessions.delete(previous);
            agentLog.appendLine(`Session ${previous} is gone. Starting a new session.`);
            return attempt(randomUUID(), false);
          }
        });
      agentLog.appendLine(`Agent output for ${threads.map(thread => thread.id).join(', ')}:\n${output}`);
      const replies = parseAgentReplies(output, threads.map(thread => thread.id));
      await mutate(root, current => {
        for (const [id, body] of replies) {
          if (current.threads.some(thread => thread.id === id)) addAgentReply(current, id, body, answered, session);
        }
      });
      const missing = threads.filter(thread => !replies.has(thread.id));
      if (missing.length) {
        void vscode.window.showWarningMessage(`NITL: The agent did not answer ${missing.length} thread(s). Their comments stay queued.`, 'Show Output')
          .then(choice => { if (choice) agentLog.show(); });
      }
    } catch (error) {
      if (error instanceof AgentError && error.stderr) agentLog.appendLine(`${error.message}\n${error.stderr}`);
      throw error;
    } finally {
      for (const id of claimed) runningThreads.delete(`${root}\0${id}`);
      if (session) runningSessions.delete(session);
      await refresh();
    }
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
    command('agentReview.openCommitComments', openCommitComments),
    command('agentReview.loadMoreHistory', loadMoreHistory),
    command('agentReview.showStale', async (item: UnplacedThreadItem) => {
      const record = item.reviewThread;
      const detail = record.comments.map(comment => `${comment.author}: ${comment.body}`).join('\n\n');
      await vscode.window.showInformationMessage(`Outdated thread at ${record.path}:${record.startLine} (${record.side}). ${detail}`);
    }),
    command('agentReview.refresh', refresh),
    command('agentReview.copyCliCommand', copyCliCommand),
    command('agentReview.createThread', input => createThread(input)),
    command('agentReview.queueThread', input => createThread(input, true)),
    command('agentReview.reply', input => reply(input)),
    command('agentReview.queueReply', input => reply(input, true)),
    command('agentReview.sendQueue', sendQueue),
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
