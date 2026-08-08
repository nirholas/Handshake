// @vitest-environment jsdom
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const source = readFileSync('/workspaces/three.ws/src/game/coincommunities.js','utf8');
const { PlayOnboard } = await import('/workspaces/three.ws/src/game/play-onboard.js');
it('diag', () => {
  const handled=[...new Set([...source.matchAll(/k === '([a-z])'/g)].map(m=>m[1]))];
  new PlayOnboard({coin:{mint:'x',name:'three.ws',symbol:'three'}});
  document.querySelector('.po-ctrl-btn').click();
  const keys=[...document.querySelectorAll('#po-help .po-kbd')].map(k=>k.textContent);
  console.log('HANDLED IN _bindInput():', handled.sort().join(' '));
  console.log('CHIPS IN PANEL        :', JSON.stringify(keys));
  console.log('GROUPS                :', [...document.querySelectorAll('#po-help .po-ctrl-group')].map(g=>g.textContent).join(' | '));
  expect(true).toBe(true);
});
