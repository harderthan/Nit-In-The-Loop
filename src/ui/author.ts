import type { ReviewComment } from '../core/review';

export function authorPresentation(author: ReviewComment['author']): { name: string; assetPath: string } {
  return author === 'agent'
    ? { name: 'Agent', assetPath: 'assets/agent-avatar.svg' }
    : { name: 'You', assetPath: 'assets/you-avatar.svg' };
}
