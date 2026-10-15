import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import { URI } from 'vscode-uri';
import type { ReviewThread } from '../core/review';

test('refreshing a replied thread keeps its expanded state', () => {
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
      id: 'thread-1', path: 'src/example.ts', side: 'new', startLine: 1, endLine: 1,
      baseCommit: 'abc', anchorText: 'example', stale: false, resolved: false,
      comments: [{ id: 'comment-1', author: 'agent', body: 'Review this', createdAt: '2026-01-01T00:00:00.000Z' }],
    };
    view.render('/repo', [record], () => 'example');
    const rendered = createdThreads[0];
    assert.equal(rendered.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);

    rendered.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    record.comments.push({ id: 'comment-2', author: 'human', body: 'Will fix', createdAt: '2026-01-01T00:01:00.000Z' });
    view.render('/repo', [record], () => 'example');
    assert.equal(rendered.comments.length, 2);
    assert.equal(rendered.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
    view.dispose();
  } finally {
    loader._load = originalLoad;
  }
});
