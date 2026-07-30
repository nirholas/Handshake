import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { failure } from '../style.js';

/**
 * `three-ws-avatar hash <path>` — SHA-256 of file bytes, lowercase hex.
 *
 * Prints the hash as a single line on stdout so it can be piped:
 *   sha=$(three-ws-avatar hash ./michelle.glb)
 * Stdout stays the raw hex (or JSON with --json) — never decorated.
 */
export async function hash({ positional, flags }) {
	const [filePath] = positional;
	if (!filePath) {
		failure('hash: missing <path> argument');
		return 1;
	}
	const full = resolve(process.cwd(), filePath);
	let stat;
	try {
		stat = statSync(full);
	} catch {
		failure(`file not found: ${filePath}`);
		return 1;
	}
	if (!stat.isFile()) {
		failure(`not a file: ${filePath}`);
		return 1;
	}
	const hex = createHash('sha256').update(readFileSync(full)).digest('hex');
	if (flags.json) {
		console.log(JSON.stringify({ path: filePath, sha256: hex, bytes: stat.size }));
	} else {
		console.log(hex);
	}
	return 0;
}
