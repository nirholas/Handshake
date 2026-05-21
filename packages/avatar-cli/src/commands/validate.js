import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validate as schemaValidate } from '@three-ws/avatar-schema';

/**
 * `three-ws-avatar validate <path>` — validate a manifest file against the schema.
 *
 * Exit code 0 if valid, 1 otherwise.
 */
export async function validate({ positional, flags }) {
	const [filePath] = positional;
	if (!filePath) {
		process.stderr.write('validate: missing <path> argument\n');
		return 1;
	}
	const full = resolve(process.cwd(), filePath);
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(full, 'utf8'));
	} catch (err) {
		process.stderr.write(`validate: could not parse JSON at ${filePath}: ${err.message}\n`);
		return 1;
	}

	const result = schemaValidate(manifest);
	if (result.valid) {
		if (flags.json) {
			console.log(JSON.stringify({ valid: true, path: filePath }));
		} else {
			console.log(`ok: ${filePath}`);
		}
		return 0;
	}

	if (flags.json) {
		console.log(JSON.stringify({ valid: false, path: filePath, errors: result.errors }));
	} else {
		process.stderr.write(`invalid: ${filePath}\n`);
		for (const err of result.errors) {
			process.stderr.write(`  ${err.instancePath || '/'} ${err.message}\n`);
		}
	}
	return 1;
}
