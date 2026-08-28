/**
 * Terminal output.
 * ----------------
 * Three ladders, best first:
 *   1. Kitty graphics protocol, and the iTerm2 inline-image escape. Both put
 *      the real PNG on the screen at full resolution.
 *   2. Truecolor half-blocks. Each cell holds two vertical pixels: the upper
 *      half-block glyph U+2580 painted with the top pixel as foreground and the
 *      bottom pixel as background. That doubles vertical resolution and is what
 *      makes a terminal render read as an avatar rather than as mosaic art.
 *   3. The 256-colour cube, for terminals that never learned truecolor.
 *
 * Colour codes are emitted only when they change from the previous cell, which
 * roughly halves the bytes on a streamed animation.
 */

const ESC = '\x1b';
const UPPER_HALF = '▀';
const RESET = `${ESC}[0m`;

/** Nearest xterm-256 index for an 8-bit RGB triple. */
export function to256(r, g, b) {
	// Greys have their own 24-step ramp and quantize badly in the 6x6x6 cube.
	if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8 && Math.abs(r - b) < 8) {
		if (r < 8) return 16;
		if (r > 248) return 231;
		return 232 + Math.round(((r - 8) / 247) * 23);
	}
	const q = (v) => Math.round((Math.max(0, Math.min(255, v)) / 255) * 5);
	return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function fgCode(r, g, b, truecolor) {
	return truecolor ? `${ESC}[38;2;${r};${g};${b}m` : `${ESC}[38;5;${to256(r, g, b)}m`;
}

function bgCode(r, g, b, truecolor) {
	return truecolor ? `${ESC}[48;2;${r};${g};${b}m` : `${ESC}[48;5;${to256(r, g, b)}m`;
}

function composite(data, offset, backdrop) {
	const a = data[offset + 3] / 255;
	if (a >= 0.999) return [data[offset], data[offset + 1], data[offset + 2], 1];
	if (a <= 0.002) return [0, 0, 0, 0];
	if (!backdrop) return [data[offset], data[offset + 1], data[offset + 2], a];
	return [
		Math.round(data[offset] * a + backdrop[0] * (1 - a)),
		Math.round(data[offset + 1] * a + backdrop[1] * (1 - a)),
		Math.round(data[offset + 2] * a + backdrop[2] * (1 - a)),
		1,
	];
}

/**
 * Turn an RGBA frame into half-block ANSI. The frame's height should be even;
 * an odd last row is drawn as a foreground-only cell.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} frame
 * @param {{truecolor?:boolean, backdrop?:number[]|null, indent?:number}} options
 */
export function toHalfBlocks(frame, { truecolor = true, backdrop = null, indent = 0 } = {}) {
	const { width, height, data } = frame;
	const pad = ' '.repeat(Math.max(0, indent));
	const lines = [];
	for (let y = 0; y < height; y += 2) {
		let line = pad;
		let lastFg = null;
		let lastBg = null;
		for (let x = 0; x < width; x++) {
			const top = composite(data, (y * width + x) * 4, backdrop);
			const bottom = y + 1 < height ? composite(data, ((y + 1) * width + x) * 4, backdrop) : [0, 0, 0, 0];

			if (top[3] === 0 && bottom[3] === 0) {
				if (lastFg !== null || lastBg !== null) {
					line += RESET;
					lastFg = null;
					lastBg = null;
				}
				line += ' ';
				continue;
			}

			const fgKey = top[3] === 0 ? 'none' : `${top[0]},${top[1]},${top[2]}`;
			const bgKey = bottom[3] === 0 ? 'none' : `${bottom[0]},${bottom[1]},${bottom[2]}`;

			if (bgKey === 'none' && lastBg !== 'none') {
				line += `${ESC}[49m`;
				lastBg = 'none';
			} else if (bgKey !== 'none' && bgKey !== lastBg) {
				line += bgCode(bottom[0], bottom[1], bottom[2], truecolor);
				lastBg = bgKey;
			}
			if (fgKey !== 'none' && fgKey !== lastFg) {
				line += fgCode(top[0], top[1], top[2], truecolor);
				lastFg = fgKey;
			}
			line += fgKey === 'none' ? ' ' : UPPER_HALF;
		}
		lines.push(`${line}${RESET}`);
	}
	return lines.join('\n');
}

/** Kitty graphics protocol payload for a PNG buffer. */
export function toKitty(png, { columns } = {}) {
	const base64 = Buffer.from(png).toString('base64');
	const chunks = [];
	for (let i = 0; i < base64.length; i += 4096) chunks.push(base64.slice(i, i + 4096));
	const size = columns ? `,c=${columns}` : '';
	return chunks
		.map((chunk, index) => {
			const more = index === chunks.length - 1 ? 0 : 1;
			const head = index === 0 ? `a=T,f=100${size},m=${more}` : `m=${more}`;
			return `${ESC}_G${head};${chunk}${ESC}\\`;
		})
		.join('');
}

/** iTerm2 inline image escape for a PNG buffer. */
export function toITerm(png, { columns } = {}) {
	const base64 = Buffer.from(png).toString('base64');
	const size = columns ? `;width=${columns}` : '';
	return `${ESC}]1337;File=inline=1${size};preserveAspectRatio=1:${base64}`;
}

/**
 * What this terminal can actually do. Honest about the difference between
 * "supports truecolor" and "claims 256 colours".
 */
export function detectTerminal(env = process.env, stream = process.stdout) {
	const term = env.TERM || '';
	const program = env.TERM_PROGRAM || '';
	const colorterm = env.COLORTERM || '';
	const kitty = Boolean(env.KITTY_WINDOW_ID) || term.includes('kitty') || program === 'ghostty' || program === 'WezTerm';
	const iterm = program === 'iTerm.app' || Boolean(env.ITERM_SESSION_ID);
	const truecolor =
		/truecolor|24bit/i.test(colorterm) || term.includes('24bit') || kitty || iterm || program === 'vscode';
	return {
		columns: stream?.columns || Number(env.COLUMNS) || 80,
		rows: stream?.rows || Number(env.LINES) || 24,
		truecolor: Boolean(truecolor),
		kitty,
		iterm,
		tty: Boolean(stream?.isTTY),
	};
}

export const CURSOR = {
	hide: `${ESC}[?25l`,
	show: `${ESC}[?25h`,
	home: `${ESC}[H`,
	clear: `${ESC}[2J${ESC}[H`,
	up: (n) => (n > 0 ? `${ESC}[${n}A` : ''),
	altScreen: `${ESC}[?1049h`,
	mainScreen: `${ESC}[?1049l`,
};
