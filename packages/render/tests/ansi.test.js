// Terminal encoding.
//
// The half-block encoder is the fallback everything else degrades to, so it has
// to be exactly right: two vertical pixels per cell, colours emitted only on
// change, and transparent pixels left as real gaps rather than black squares.

import { describe, it, expect } from 'vitest';
import { toHalfBlocks, to256, toKitty, toITerm, detectTerminal, CURSOR } from '../src/ansi.js';

const ESC = '\x1b';

/** A frame of solid colour, optionally transparent. */
function solid(width, height, [r, g, b, a = 255]) {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		data[i * 4] = r;
		data[i * 4 + 1] = g;
		data[i * 4 + 2] = b;
		data[i * 4 + 3] = a;
	}
	return { width, height, data };
}

describe('toHalfBlocks', () => {
	it('emits one line per two pixel rows', () => {
		expect(toHalfBlocks(solid(4, 8, [200, 100, 50])).split('\n')).toHaveLength(4);
		// An odd height still renders its last row.
		expect(toHalfBlocks(solid(4, 7, [200, 100, 50])).split('\n')).toHaveLength(4);
	});

	it('writes truecolor foreground and background for a solid frame', () => {
		const out = toHalfBlocks(solid(2, 2, [10, 20, 30]));
		expect(out).toContain(`${ESC}[48;2;10;20;30m`);
		expect(out).toContain(`${ESC}[38;2;10;20;30m`);
		expect(out).toContain('▀');
	});

	it('repeats a colour code only when the colour changes', () => {
		const out = toHalfBlocks(solid(20, 2, [10, 20, 30]));
		expect(out.split(`${ESC}[38;2;10;20;30m`).length - 1).toBe(1);
	});

	it('leaves fully transparent pixels as spaces', () => {
		const out = toHalfBlocks(solid(3, 2, [255, 0, 0, 0]));
		expect(out).not.toContain('▀');
		expect(out.replace(/\x1b\[[0-9;]*m/g, '')).toBe('   ');
	});

	it('composites semi-transparent pixels over a backdrop', () => {
		const half = solid(1, 2, [255, 255, 255, 128]);
		const out = toHalfBlocks(half, { backdrop: [0, 0, 0] });
		// 255 at alpha 128/255 over black lands near the midpoint.
		expect(out).toMatch(/38;2;12[0-9];/);
	});

	it('falls back to the 256-colour cube', () => {
		const out = toHalfBlocks(solid(2, 2, [10, 20, 30]), { truecolor: false });
		expect(out).toContain(`${ESC}[38;5;`);
		expect(out).not.toContain(';2;10;20;30m');
	});
});

describe('to256', () => {
	it('maps greys onto the grey ramp, not the colour cube', () => {
		expect(to256(0, 0, 0)).toBe(16);
		expect(to256(255, 255, 255)).toBe(231);
		const mid = to256(128, 128, 128);
		expect(mid).toBeGreaterThanOrEqual(232);
		expect(mid).toBeLessThanOrEqual(255);
	});

	it('maps saturated colours into the 6x6x6 cube', () => {
		const red = to256(255, 0, 0);
		expect(red).toBe(16 + 36 * 5);
		expect(to256(0, 255, 0)).toBe(16 + 6 * 5);
		expect(to256(0, 0, 255)).toBe(16 + 5);
	});
});

describe('inline image protocols', () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

	it('wraps a PNG in the kitty graphics protocol', () => {
		const out = toKitty(png, { columns: 40 });
		expect(out.startsWith(`${ESC}_Ga=T,f=100,c=40,m=0;`)).toBe(true);
		expect(out.endsWith(`${ESC}\\`)).toBe(true);
	});

	it('chunks a large payload with continuation markers', () => {
		const big = Buffer.alloc(8000, 1);
		const out = toKitty(big);
		expect(out.split(`${ESC}_G`).length - 1).toBeGreaterThan(1);
		expect(out).toContain('m=1;');
	});

	it('wraps a PNG in the iTerm2 inline escape', () => {
		expect(toITerm(png)).toContain(']1337;File=inline=1');
	});
});

describe('detectTerminal', () => {
	it('reads truecolor support from COLORTERM', () => {
		expect(detectTerminal({ COLORTERM: 'truecolor' }, null).truecolor).toBe(true);
		expect(detectTerminal({ TERM: 'xterm-256color' }, null).truecolor).toBe(false);
	});

	it('recognizes terminals that draw real images', () => {
		expect(detectTerminal({ KITTY_WINDOW_ID: '1' }, null).kitty).toBe(true);
		expect(detectTerminal({ TERM_PROGRAM: 'ghostty' }, null).kitty).toBe(true);
		expect(detectTerminal({ TERM_PROGRAM: 'iTerm.app' }, null).iterm).toBe(true);
	});

	it('falls back to a sane size with no tty', () => {
		const term = detectTerminal({}, null);
		expect(term.columns).toBe(80);
		expect(term.tty).toBe(false);
	});
});

describe('CURSOR', () => {
	it('moves up by a positive count only', () => {
		expect(CURSOR.up(3)).toBe(`${ESC}[3A`);
		expect(CURSOR.up(0)).toBe('');
		expect(CURSOR.up(-1)).toBe('');
	});
});
