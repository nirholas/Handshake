import { describe, it, expect } from 'vitest';
import { renderBadge } from '../worker/src/badge.js';

describe('renderBadge', () => {
  it('renders each status with its color', () => {
    const cases = [
      ['operational', '#2da44e'],
      ['degraded', '#bf8700'],
      ['down', '#cf222e'],
      ['unknown', '#6e7781'],
    ];
    for (const [status, color] of cases) {
      const svg = renderBadge('robinhood chain', status);
      expect(svg).toContain('<svg');
      expect(svg).toContain(color);
      expect(svg).toContain(`>${status}</text>`);
      expect(svg).toContain('robinhood chain');
    }
  });

  it('unknown fallback for a bogus status', () => {
    const svg = renderBadge('x', 'lol');
    expect(svg).toContain('#6e7781');
    expect(svg).toContain('>unknown</text>');
  });

  it('escapes XML in labels', () => {
    const svg = renderBadge('a<b>&"c', 'operational');
    expect(svg).toContain('a&lt;b&gt;&amp;&quot;c');
    expect(svg).not.toMatch(/<b>/);
  });

  it('is well-formed XML with sane geometry', () => {
    const svg = renderBadge('robinhood chain', 'operational');
    const width = Number(svg.match(/width="(\d+)"/)[1]);
    expect(width).toBeGreaterThan(80);
    expect(width).toBeLessThan(300);
    // balanced tags
    expect((svg.match(/<svg/g) || []).length).toBe(1);
    expect((svg.match(/<\/svg>/g) || []).length).toBe(1);
    expect((svg.match(/<text/g) || []).length).toBe(4);
  });
});
