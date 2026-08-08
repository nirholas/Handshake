import { describe, it, expect } from 'vitest';
describe('import probe', () => {
  it('imports combat-system', async () => {
    const m = await import('/workspaces/three.ws/src/game/combat-system.js');
    expect(typeof m.CombatSystem).toBe('function');
  });
});
