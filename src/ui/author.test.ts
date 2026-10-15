import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { authorPresentation } from './author';

test('agent and human comments use distinct named SVG avatars', () => {
  const agent = authorPresentation('agent');
  const human = authorPresentation('human');

  assert.deepEqual(agent, { name: 'Agent', assetPath: 'assets/agent-avatar.svg' });
  assert.deepEqual(human, { name: 'You', assetPath: 'assets/you-avatar.svg' });
  assert.notEqual(agent.assetPath, human.assetPath);

  for (const { assetPath, letter, color } of [
    { assetPath: agent.assetPath, letter: 'A', color: '#0969da' },
    { assetPath: human.assetPath, letter: 'Y', color: '#087f5b' },
  ]) {
    const file = path.resolve(process.cwd(), assetPath);
    assert.ok(existsSync(file), `${assetPath} should be packaged with the extension`);
    const svg = readFileSync(file, 'utf8');
    assert.match(svg, /<svg\b/);
    assert.match(svg, new RegExp(`>${letter}<`));
    assert.ok(svg.includes(color));
  }
});
