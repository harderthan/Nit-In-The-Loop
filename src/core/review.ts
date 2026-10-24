import { randomUUID } from 'node:crypto';

export type Side = 'old' | 'new';
export type Author = 'human' | 'agent';

export interface ReviewComment {
  id: string;
  author: Author;
  body: string;
  /** ISO 8601 time the comment was written. */
  at: string;
  /** A reviewer comment waiting to be sent to the agent. */
  queued?: boolean;
}

/** Lines of one side of a file diff, and their text when the thread was made. */
export interface FileRange {
  path: string;
  side: Side;
  /** Inclusive one-based first and last line. */
  lines: [number, number];
  text: string;
}

/**
 * Where a thread is attached. A worktree thread is on the diff of the working tree
 * against `sha`, the HEAD when it was made. A commit thread is on the diff of commit
 * `sha`, or on the commit as a whole when it has no file.
 */
export type ThreadLocation =
  | { on: 'worktree'; sha: string; file: FileRange }
  | { on: 'commit'; sha: string; file?: FileRange };

export interface ReviewThread {
  id: string;
  status: 'open' | 'resolved';
  location: ThreadLocation;
  /** The agent session that last answered this thread. */
  agent?: { session: string };
  comments: ReviewComment[];
}

export interface ReviewDocument {
  version: 2;
  threads: ReviewThread[];
}

export interface NewThread {
  location: ThreadLocation;
  author: Author;
  body: string;
  queued?: boolean;
}

export interface NewReply {
  author: Author;
  body: string;
  queued?: boolean;
}

export function addThread(review: ReviewDocument, input: NewThread): ReviewThread {
  const { location } = input;
  if (location?.on !== 'worktree' && location?.on !== 'commit') throw new Error('Invalid thread location');
  if (typeof location.sha !== 'string') throw new Error('Invalid thread commit');
  if (location.on === 'worktree' && !location.file) throw new Error('Thread path is required');
  if (location.file) checkFileRange(location.file);
  const thread: ReviewThread = {
    id: randomUUID(),
    status: 'open',
    location: structuredClone(location),
    comments: [newComment(input)],
  };
  review.threads.push(thread);
  return thread;
}

function checkFileRange(file: FileRange): void {
  if (typeof file.path !== 'string' || file.path.length === 0) throw new Error('Thread path is required');
  if (file.side !== 'old' && file.side !== 'new') throw new Error('Invalid thread side');
  const [start, end] = file.lines ?? [];
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error('Invalid thread line range');
  if (typeof file.text !== 'string') throw new Error('Invalid anchor text');
}

export function addReply(review: ReviewDocument, threadId: string, input: NewReply): ReviewComment {
  const thread = requireThread(review, threadId);
  const comment = newComment(input);
  thread.comments.push(comment);
  thread.status = 'open';
  return comment;
}

export function setResolved(review: ReviewDocument, threadId: string, resolved: boolean): ReviewThread {
  const thread = requireThread(review, threadId);
  thread.status = resolved ? 'resolved' : 'open';
  return thread;
}

/**
 * Post an agent's answer, mark the comments it answered as sent, and remember the
 * session. Comments queued while the agent ran stay queued.
 */
export function addAgentReply(review: ReviewDocument, threadId: string, body: string, answered: ReadonlySet<string>, session?: string): ReviewComment {
  const thread = requireThread(review, threadId);
  for (const comment of thread.comments) if (answered.has(comment.id)) delete comment.queued;
  if (session) thread.agent = { session };
  return addReply(review, threadId, { author: 'agent', body });
}

function newComment(input: NewReply): ReviewComment {
  if (input.author !== 'human' && input.author !== 'agent') {
    throw new Error('Invalid comment author');
  }
  if (typeof input.body !== 'string' || input.body.trim().length === 0) {
    throw new Error('Comment body is required');
  }
  return {
    id: randomUUID(), author: input.author, body: input.body, at: new Date().toISOString(),
    ...(input.queued ? { queued: true } : {}),
  };
}

function requireThread(review: ReviewDocument, id: string): ReviewThread {
  const thread = review.threads.find(candidate => candidate.id === id);
  if (!thread) throw new Error(`Review thread not found: ${id}`);
  return thread;
}
