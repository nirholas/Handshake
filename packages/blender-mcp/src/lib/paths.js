// Path handling shared by the tools.
//
// Callers may pass a relative path (resolved against the server's working
// directory) or an absolute one. Outputs are optional everywhere: when omitted
// the file lands in BLENDER_MCP_WORKDIR under a name derived from the input, so
// an agent can chain calls without inventing a filesystem layout.

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

import { WORKDIR } from '../config.js';
import { ensureWorkdir } from './blender.js';

/** Resolve an input path and confirm it is readable, or throw a clean error. */
export async function resolveInput(value, label = 'input') {
	const raw = String(value ?? '').trim();
	if (!raw) {
		throw Object.assign(new Error(`${label} is required.`), { code: 'invalid_input' });
	}
	const resolved = path.resolve(raw);
	try {
		await access(resolved, constants.R_OK);
	} catch {
		throw Object.assign(new Error(`${label} file not found or unreadable: ${resolved}`), { code: 'input_not_found' });
	}
	return resolved;
}

/**
 * Resolve an output path, defaulting into the workdir.
 *
 * @param {string|undefined} value     Caller-supplied path, if any.
 * @param {string} basis               Path the default name is derived from.
 * @param {string} extension           Extension for the default name, with the dot.
 */
export async function resolveOutput(value, basis, extension) {
	const raw = String(value ?? '').trim();
	if (raw) return path.resolve(raw);
	await ensureWorkdir();
	const stem = path.basename(basis, path.extname(basis)) || 'blender';
	return path.join(WORKDIR, `${stem}-${Date.now()}${extension}`);
}
