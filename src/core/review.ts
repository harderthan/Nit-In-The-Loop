import { randomUUID } from 'node:crypto';

export type Side = 'old' | 'new';
export type Author = 'human' | 'agent';

export interface ReviewComment {
  id: string;
  author: Author;
  body: string;
  createdAt: string;
}

export interface ReviewThread {
  id: string;
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  baseCommit: string;
  anchorText: string;
  /** Set for a comment on a commit. An empty path makes it a commit body comment. */
  commit?: string;
  stale: boolean;
  resolved: boolean;
  comments: ReviewComment[];
}

export interface ReviewDocument {
  version: 1;
  threads: ReviewThread[];
}

export type ReviewStore = ReviewDocument;

export interface NewThread {
  path: string;
  side: Side;
  startLine: number;
  endLine: number;
  baseCommit: string;
  anchorText: string;
  commit?: string;
  author: Author;
  body: string;
}

export interface NewReply {
  author: Author;
  body: string;
}

export function addThread(review: ReviewDocument, input: NewThread): ReviewThread {
  if (typeof input.path !== 'string' || (input.path.length === 0 && !input.commit)) throw new Error('Thread path is required');
  if (typeof input.baseCommit !== 'string') throw new Error('Invalid base commit');
  if (typeof input.anchorText !== 'string') throw new Error('Invalid anchor text');
  if (!Number.isSafeInteger(input.startLine) || !Number.isSafeInteger(input.endLine) || input.startLine < 1 || input.endLine < input.startLine) {
    throw new Error('Invalid thread line range');
  }
  if (input.side !== 'old' && input.side !== 'new') {
    throw new Error('Invalid thread side');
  }
  const thread: ReviewThread = {
    id: randomUUID(),
    path: input.path,
    side: input.side,
    startLine: input.startLine,
    endLine: input.endLine,
    baseCommit: input.baseCommit,
    anchorText: input.anchorText,
    ...(input.commit ? { commit: input.commit } : {}),
    stale: false,
    resolved: false,
    comments: [newComment(input)],
  };
  review.threads.push(thread);
  return thread;
}

export function addReply(review: ReviewDocument, threadId: string, input: NewReply): ReviewComment {
  const thread = requireThread(review, threadId);
  const comment = newComment(input);
  thread.comments.push(comment);
  thread.resolved = false;
  return comment;
}

export function setResolved(review: ReviewDocument, threadId: string, resolved: boolean): ReviewThread {
  const thread = requireThread(review, threadId);
  thread.resolved = resolved;
  return thread;
}

function newComment(input: NewReply): ReviewComment {
  if (input.author !== 'human' && input.author !== 'agent') {
    throw new Error('Invalid comment author');
  }
  if (typeof input.body !== 'string' || input.body.trim().length === 0) {
    throw new Error('Comment body is required');
  }
  return { id: randomUUID(), author: input.author, body: input.body, createdAt: new Date().toISOString() };
}

function requireThread(review: ReviewDocument, id: string): ReviewThread {
  const thread = review.threads.find(candidate => candidate.id === id);
  if (!thread) throw new Error(`Review thread not found: ${id}`);
  return thread;
}
