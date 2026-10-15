import assert from 'node:assert/strict';
import test from 'node:test';
import { URI } from 'vscode-uri';
import { lineRange, reviewLocation, decodeReviewUri, encodeReviewUri, reviewLines } from './anchors';

test('stored inclusive one-based line range maps to editor range', () => {
  assert.deepEqual(lineRange(3, 5), { start: 2, end: 4 });
});

test('editor selection maps to inclusive one-based line range', () => {
  assert.deepEqual(reviewLocation(2, 4, 5, 0), { startLine: 3, endLine: 5 });
});

test('review URIs preserve side, repository and Unicode path', () => {
  const uri = encodeReviewUri('old', '/tmp/repo', '한글/a b.ts');
  assert.deepEqual(decodeReviewUri(uri), { side: 'old', repoRoot: '/tmp/repo', path: '한글/a b.ts' });
});

test('review URI survives VS Code parsing and serialization before the content provider decodes it', () => {
  const location = { side: 'new' as const, repoRoot: '/tmp/demo & review', path: 'src/a&b 한글.ts' };
  const editorUri = URI.parse(encodeReviewUri(location.side, location.repoRoot, location.path));
  assert.deepEqual(decodeReviewUri(editorUri.toString()), location);
  assert.equal(editorUri.path, '/src/a&b 한글.ts');
});

test('review line count excludes the virtual blank line at EOF', () => {
  assert.deepEqual(reviewLines(''), []);
  assert.deepEqual(reviewLines('one\n'), ['one']);
  assert.deepEqual(reviewLines('one\ntwo\n'), ['one', 'two']);
  assert.deepEqual(reviewLines('one\r\ntwo\r\n'), ['one', 'two']);
});
