import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `three-ws-avatar hash <path>` — SHA-256 of file bytes, lowercase hex.
 *
 * Returns the hash as a single line on stdout so it can be piped:
 *   sha=$(three-ws-avatar hash ./avatar.glb)
 */
export async function hash({ positional, flags }) {
	const [filePath] = positional;
	if (!filePath) {
		process.stderr.write('hash: missing <path> argument\n');
		return 1;
	}
	const full = resolve(process.cwd(), filePath);
	const stat = statSync(full);
	if (!stat.isFile()) {
		process.stderr.write(`hash: not a file: ${filePath}\n`);
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
