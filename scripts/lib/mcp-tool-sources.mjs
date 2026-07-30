// Shared discovery of every MCP tool-definition source file in this repo.
//
// Two build gates consume this list, and they MUST agree on it:
//   - scripts/audit-mcp-golden.mjs: snapshots each tool's public contract
//     (name, description, schema, annotations) and fails on undeclared drift.
//   - scripts/audit-mcp-safety.mjs: checks each tool's declared safety
//     annotations against what its handler actually does.
//
// Keeping the list here means a file that is invisible to one gate is invisible
// to neither: adding a hosted server or an MCP package brings both gates along.
// Hosted entries are named explicitly (their directory layout differs per
// server); packages are discovered from disk, because a hand-listed set silently
// drifts as packages land and an unlisted file is an unguarded public contract.

import { readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Hosted servers whose tool defs live in a per-server directory.
const HOSTED_TOOL_DIRS = ['api/_mcp/tools', 'api/_mcp3d/tools'];

// Hosted servers that declare every tool in one file.
const HOSTED_TOOL_FILES = [
	'api/_mcp-studio/tools.js',
	'api/_mcpagent/tools.js',
	'api/_mcpbazaar/tools.js',
	'api/_mcpibm/tools.js',
];

/**
 * Every `packages/*-mcp/src/tools/*.js` tool-definition file, as repo-relative
 * forward-slash paths. `index.js` barrels are skipped: they re-export, they do
 * not declare contracts.
 * @returns {string[]}
 */
function packageToolSources() {
	const pkgRoot = join(ROOT, 'packages');
	if (!existsSync(pkgRoot)) return [];
	return readdirSync(pkgRoot, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name.endsWith('-mcp'))
		.flatMap((d) => {
			const rel = `packages/${d.name}/src/tools`;
			if (!existsSync(join(ROOT, rel))) return [];
			return readdirSync(join(ROOT, rel))
				.filter((f) => f.endsWith('.js') && f !== 'index.js')
				.map((f) => `${rel}/${f}`);
		});
}

// Tool-definition files that carry real MCP annotations but sit outside the
// layouts above: the stdio flagship's tool factories, the OKX A2MCP variant, and
// the pump.fun server's single registry module.
const EXTRA_TOOL_DIRS = ['mcp-server/src/tools'];
const EXTRA_TOOL_FILES = ['api/_okx3d/tools.js', 'src/pump/mcp-tools.js'];

/**
 * Sorted, repo-relative paths of every MCP tool-definition file in the repo.
 * Both gates read this same list, so a public tool contract cannot be guarded by
 * one and invisible to the other.
 * @returns {string[]}
 */
export function mcpToolSources() {
	const fromDirs = (dirs) =>
		dirs
			.filter((d) => existsSync(join(ROOT, d)))
			.flatMap((d) => readdirSync(join(ROOT, d)).map((f) => `${d}/${f}`));

	return [
		...new Set([
			...fromDirs(HOSTED_TOOL_DIRS),
			...fromDirs(EXTRA_TOOL_DIRS),
			...HOSTED_TOOL_FILES,
			...EXTRA_TOOL_FILES,
			...packageToolSources(),
		]),
	]
		.filter((f) => f.endsWith('.js') && existsSync(join(ROOT, f)))
		.sort();
}
