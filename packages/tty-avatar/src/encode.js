// Frame → lines of text. Three encoders share one contract: given a Frame
// whose subpixel grid matches their cell geometry, return an array of strings
// (one per terminal row) with ANSI colour where the mode supports it.
//
//   blocks   1x2 subpixels per cell, truecolor foreground/background on the
//            upper-half-block glyph. Best-looking on any modern terminal.
//   braille  2x4 subpixels per cell, one truecolor foreground per cell. Four
//            times the vertical resolution, monochrome within a cell. Reads
//            like an engraving.
//   ascii    1x2 subpixels per cell, no colour: a luminance ramp. For logs,
//            CI output, and terminals that cannot do colour.

const RESET = '\x1b[0m';
const RAMP = ' .\'`^",:;Il!i~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';

/** Cell geometry for each mode: subpixels per character cell. */
export const MODES = {
	blocks: { sx: 1, sy: 2 },
	braille: { sx: 2, sy: 4 },
	ascii: { sx: 1, sy: 2 },
};

/** Gamma-encode a linear channel to an 8-bit sRGB value. */
function to8(c) {
	const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
	return Math.max(0, Math.min(255, Math.round(s * 255)));
}

function fg(r, g, b) { return `\x1b[38;2;${r};${g};${b}m`; }
function bg(r, g, b) { return `\x1b[48;2;${r};${g};${b}m`; }

/**
 * @param {import('./raster.js').Frame} frame
 * @param {{ mode?: 'blocks'|'braille'|'ascii' }} [opts]
 * @returns {string[]}
 */
export function encode(frame, { mode = 'blocks' } = {}) {
	if (mode === 'braille') return encodeBraille(frame);
	if (mode === 'ascii') return encodeAscii(frame);
	return encodeBlocks(frame);
}

export function encodeBlocks(frame) {
	const { width: W, height: H, hit, rgb } = frame;
	const rows = Math.floor(H / 2);
	const lines = new Array(rows);
	for (let row = 0; row < rows; row++) {
		let line = '';
		let lastFg = '', lastBg = '';
		for (let x = 0; x < W; x++) {
			const ti = row * 2 * W + x, bi = (row * 2 + 1) * W + x;
			const top = hit[ti], bot = hit[bi];
			if (!top && !bot) {
				if (lastFg || lastBg) { line += RESET; lastFg = ''; lastBg = ''; }
				line += ' ';
				continue;
			}
			let glyph, f, b = '';
			if (top && bot) {
				glyph = '▀';
				f = fg(to8(rgb[ti * 3]), to8(rgb[ti * 3 + 1]), to8(rgb[ti * 3 + 2]));
				b = bg(to8(rgb[bi * 3]), to8(rgb[bi * 3 + 1]), to8(rgb[bi * 3 + 2]));
			} else if (top) {
				glyph = '▀';
				f = fg(to8(rgb[ti * 3]), to8(rgb[ti * 3 + 1]), to8(rgb[ti * 3 + 2]));
			} else {
				glyph = '▄';
				f = fg(to8(rgb[bi * 3]), to8(rgb[bi * 3 + 1]), to8(rgb[bi * 3 + 2]));
			}
			if (!b && lastBg) { line += RESET; lastFg = ''; lastBg = ''; }
			if (f !== lastFg) { line += f; lastFg = f; }
			if (b && b !== lastBg) { line += b; lastBg = b; }
			line += glyph;
		}
		if (lastFg || lastBg) line += RESET;
		lines[row] = line;
	}
	return lines;
}

// Unicode braille: dot bit for subpixel (dx, dy) within a 2x4 cell.
const DOT = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]];

export function encodeBraille(frame) {
	const { width: W, height: H, hit, rgb } = frame;
	const cols = Math.floor(W / 2), rows = Math.floor(H / 4);
	const lines = new Array(rows);
	for (let row = 0; row < rows; row++) {
		let line = '';
		let lastFg = '';
		for (let col = 0; col < cols; col++) {
			let bits = 0, n = 0, r = 0, g = 0, b = 0;
			for (let dx = 0; dx < 2; dx++) {
				for (let dy = 0; dy < 4; dy++) {
					const i = (row * 4 + dy) * W + col * 2 + dx;
					if (!hit[i]) continue;
					bits |= DOT[dx][dy];
					n++;
					r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2];
				}
			}
			if (!bits) {
				if (lastFg) { line += RESET; lastFg = ''; }
				line += ' ';
				continue;
			}
			const f = fg(to8(r / n), to8(g / n), to8(b / n));
			if (f !== lastFg) { line += f; lastFg = f; }
			line += String.fromCharCode(0x2800 + bits);
		}
		if (lastFg) line += RESET;
		lines[row] = line;
	}
	return lines;
}

export function encodeAscii(frame) {
	const { width: W, height: H, hit, rgb } = frame;
	const rows = Math.floor(H / 2);
	const lines = new Array(rows);
	for (let row = 0; row < rows; row++) {
		let line = '';
		for (let x = 0; x < W; x++) {
			const ti = row * 2 * W + x, bi = (row * 2 + 1) * W + x;
			const n = hit[ti] + hit[bi];
			if (!n) { line += ' '; continue; }
			let lum = 0;
			if (hit[ti]) lum += 0.2126 * rgb[ti * 3] + 0.7152 * rgb[ti * 3 + 1] + 0.0722 * rgb[ti * 3 + 2];
			if (hit[bi]) lum += 0.2126 * rgb[bi * 3] + 0.7152 * rgb[bi * 3 + 1] + 0.0722 * rgb[bi * 3 + 2];
			lum /= n;
			const idx = Math.min(RAMP.length - 1, 1 + Math.floor(Math.sqrt(lum) * (RAMP.length - 2)));
			line += RAMP[idx];
		}
		lines[row] = line.replace(/\s+$/, '');
	}
	return lines;
}

/** Strip ANSI escapes; used by tests and by `--plain` captures. */
export function stripAnsi(s) {
	return s.replace(/\x1b\[[0-9;]*m/g, '');
}
