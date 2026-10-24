import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { URI } from 'vscode-uri';
import type { ReviewThread } from '../core/review';

test('open threads start expanded, resolved ones collapse, and a refresh keeps the user choice', () => {
  const createdThreads: { collapsibleState: number; comments: unknown[] }[] = [];
  const controller = {
    createCommentThread(uri: URI, range: unknown, comments: unknown[]) {
      const thread = { uri, range, comments, collapsibleState: -1, dispose() {} };
      createdThreads.push(thread);
      return thread;
    },
    dispose() {},
  };
  const vscode = {
    comments: { createCommentController: () => controller },
    Uri: { parse: URI.parse, joinPath: (base: URI, path: string) => URI.parse(`${base.toString()}/${path}`) },
    Range: class { constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {} },
    CommentMode: { Preview: 0 },
    CommentThreadState: { Resolved: 1, Unresolved: 0 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  };
  const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = loader._load;
  loader._load = (request, parent, isMain) => request === 'vscode' ? vscode : originalLoad(request, parent, isMain);
  try {
    const { ReviewComments } = require('./comments') as typeof import('./comments');
    const view = new ReviewComments(URI.file('/extension'), () => true);
    const record: ReviewThread = {
      id: 'thread-1', status: 'open',
      location: { on: 'worktree', sha: '', file: { path: 'src/example.ts', side: 'new', lines: [1, 1], text: 'example' } },
      comments: [{ id: 'comment-1', author: 'agent', body: 'Review this', at: '2026-01-01T00:00:00.000Z' }],
    };
    view.render('/repo', [record], () => ({ uri: 'agent-review-new://review/src/example.ts?L3JlcG8', content: 'example' }));
    const rendered = createdThreads[0];
    assert.equal(rendered.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);

    rendered.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    record.comments.push({ id: 'comment-2', author: 'human', body: 'Will fix', at: '2026-01-01T00:01:00.000Z' });
    view.render('/repo', [record], () => ({ uri: 'agent-review-new://review/src/example.ts?L3JlcG8', content: 'example' }));
    assert.equal(rendered.comments.length, 2);
    assert.equal(rendered.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);

    record.status = 'resolved';
    view.render('/repo', [record], () => ({ uri: 'agent-review-new://review/src/example.ts?L3JlcG8', content: 'example' }));
    assert.equal(rendered.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
    record.status = 'open';
    view.render('/repo', [record], () => ({ uri: 'agent-review-new://review/src/example.ts?L3JlcG8', content: 'example' }));
    assert.equal(rendered.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);

    record.comments[1].queued = true;
    view.render('/repo', [record], () => ({ uri: 'agent-review-new://review/src/example.ts?L3JlcG8', content: 'example' }));
    const labels = (rendered.comments as { label?: string }[]).map(comment => comment.label);
    assert.deepEqual(labels, [undefined, 'Queued · not sent to the agent yet']);
    assert.equal((rendered as unknown as { contextValue: string }).contextValue, 'openQueued');
    delete record.comments[1].queued;

    const commit = 'c'.repeat(40);
    const body: ReviewThread = { ...record, id: 'thread-2', location: { on: 'commit', sha: commit } };
    view.render('/repo', [record, body], item => item.location.on === 'commit'
      ? { uri: `agent-review-history://review/${item.id}`, content: '' }
      : { uri: 'agent-review-new://review/src/example.ts?L3JlcG8', content: 'example' });
    const commitThread = createdThreads[1] as unknown as { range: { startLine: number; endLine: number }; label: string };
    assert.deepEqual([commitThread.range.startLine, commitThread.range.endLine, commitThread.label], [0, 0, 'Commit ccccccc']);
    view.dispose();
  } finally {
    loader._load = originalLoad;
  }
});
