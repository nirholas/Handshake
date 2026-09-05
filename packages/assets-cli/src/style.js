// Zero-dependency terminal styling for the three-ws-assets CLI.
//
// Decoration is applied only to human-facing framing (messages, headers, help).
// Machine payloads (`--json` output, embed snippets, file paths) are always
// emitted uncolored so they stay pipe- and paste-safe.
//
// Color is honored unless disabled by the NO_COLOR convention
// (https://no-color.org), a `--no-color` flag, or a non-TTY stdout, and is
// forced on by FORCE_COLOR.

const noColorEnv = process.env.NO_COLOR != null && process.env.NO_COLOR !== '';
const noColorFlag = process.argv.includes('--no-color');
const forceColor = ['1', '2', '3', 'true'].includes(process.env.FORCE_COLOR ?? '');

export const colorEnabled =
	!noColorFlag &&
	!noColorEnv &&
	(forceColor || Boolean(process.stdout.isTTY) || Boolean(process.stderr.isTTY));

const CODES = {
	bold: 1,
	dim: 2,
	red: 31,
	green: 32,
	yellow: 33,
	cyan: 36,
	gray: 90,
};

function paint(code, text) {
	if (!colorEnabled) return text;
	return `\x1b[${code}m${text}\x1b[0m`;
}

export const style = {
	bold: (t) => paint(CODES.bold, t),
	dim: (t) => paint(CODES.dim, t),
	red: (t) => paint(CODES.red, t),
	green: (t) => paint(CODES.green, t),
	yellow: (t) => paint(CODES.yellow, t),
	cyan: (t) => paint(CODES.cyan, t),
	gray: (t) => paint(CODES.gray, t),
};

// Glyphs degrade to ASCII when stdout is not a TTY (CI logs, pipes).
const unicode = Boolean(process.stdout.isTTY) || forceColor;
export const symbols = {
	tick: unicode ? '✔' : 'ok',
	cross: unicode ? '✖' : 'x',
	warn: unicode ? '⚠' : '!',
	arrow: unicode ? '›' : '>',
	bullet: unicode ? '•' : '-',
};

/** Success line to stdout (human framing only). */
export function success(message) {
	process.stdout.write(`${style.green(symbols.tick)} ${message}\n`);
}

/** Failure line to stderr. */
export function failure(message) {
	process.stderr.write(`${style.red(symbols.cross)} ${message}\n`);
}

/** Warning line to stderr. */
export function warn(message) {
	process.stderr.write(`${style.yellow(symbols.warn)} ${message}\n`);
}

/** Dim hint line to stderr, indented under a preceding message. */
export function hint(message) {
	process.stderr.write(`  ${style.dim(message)}\n`);
}

/** Section header for human-readable stdout blocks. */
export function heading(text) {
	return style.dim(`${symbols.arrow} ${text}`);
}
