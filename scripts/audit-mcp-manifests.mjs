#!/usr/bin/env node
// Build gate: validate every MCP registry manifest in this repo, offline.
//
// The official registry (registry.modelcontextprotocol.io) enforces these
// rules at publish time; a manifest that drifts past them blocks the next
// release without anyone noticing until publish day. This audit fails the
// build instead. Checks, per manifest:
//   - JSON parses, name/description/version present
//   - description ≤ 100 chars (registry schema maxLength)
//   - name is io.github.<owner>/<server> form
//   - icons use https URLs; websiteUrl is https
//   - stdio packages: server.json version matches package.json version,
//     packages[0].identifier/version match, mcpName matches server.json name
//   - remote manifests: every remotes[].url is https
//
// Run: node scripts/audit-mcp-manifests.mjs   (exit 1 on any violation)

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// stdio package manifests live next to their package.json.
const PACKAGE_MANIFESTS = [
	'mcp-server/server.json',
	'mcp-bridge/server.json',
	'packages/pumpfun-mcp/server.json',
	'packages/ibm-watsonx-mcp/server.json',
	'packages/ibm-x402-mcp/server.json',
	'packages/avatar-agent-mcp/server.json',
	'packages/threews-avatar-mcp/server.json',
	'packages/three-token-mcp/server.json',
	'packages/agent-sniper/server.json',
	'packages/concierge-mcp/server.json',
];

// Remote manifests are every server*.json at the repo root.
const remoteManifests = readdirSync(root).filter((f) => /^server(-[\w-]+)?\.json$/.test(f));

let violations = 0;
const fail = (file, msg) => {
	violations += 1;
	console.error(`[audit:mcp] ${file}: ${msg}`);
};

function load(path) {
	try {
		return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
	} catch (err) {
		fail(path, `unreadable or invalid JSON (${err.message})`);
		return null;
	}
}

function checkCommon(path, m) {
	if (!m.name) fail(path, 'missing name');
	else if (!/^io\.github\.[\w-]+\/[\w.-]+$/.test(m.name)) {
		fail(path, `name "${m.name}" is not io.github.<owner>/<server>`);
	}
	if (!m.version) fail(path, 'missing version');
	if (!m.description) fail(path, 'missing description');
	else if (m.description.length > 100) {
		fail(path, `description is ${m.description.length} chars (registry max is 100)`);
	}
	if (m.websiteUrl && !m.websiteUrl.startsWith('https://')) {
		fail(path, `websiteUrl must be https (${m.websiteUrl})`);
	}
	for (const icon of m.icons ?? []) {
		if (!icon.src?.startsWith('https://')) fail(path, `icon src must be https (${icon.src})`);
	}
}

for (const path of PACKAGE_MANIFESTS) {
	if (!existsSync(resolve(root, path))) {
		// mcp-bridge gains its manifest when it goes public; absence is only an
		// error once the package itself is publishable.
		const pkgPath = join(dirname(path), 'package.json');
		const pkg = existsSync(resolve(root, pkgPath)) ? load(pkgPath) : null;
		if (pkg && !pkg.private) fail(path, 'missing server.json for a publishable MCP package');
		continue;
	}
	const m = load(path);
	if (!m) continue;
	checkCommon(path, m);

	const pkg = load(join(dirname(path), 'package.json'));
	if (!pkg) continue;
	if (pkg.version !== m.version) {
		fail(path, `version ${m.version} ≠ package.json ${pkg.version}`);
	}
	if (pkg.mcpName !== m.name) {
		fail(path, `package.json mcpName "${pkg.mcpName}" ≠ name "${m.name}"`);
	}
	const entry = m.packages?.[0];
	if (!entry) fail(path, 'missing packages[0]');
	else {
		if (entry.identifier !== pkg.name) {
			fail(path, `packages[0].identifier "${entry.identifier}" ≠ npm name "${pkg.name}"`);
		}
		if (entry.version !== m.version) {
			fail(path, `packages[0].version ${entry.version} ≠ manifest version ${m.version}`);
		}
	}
}

for (const path of remoteManifests) {
	const m = load(path);
	if (!m) continue;
	checkCommon(path, m);
	const remotes = m.remotes ?? [];
	if (remotes.length === 0 && !m.packages?.length) {
		fail(path, 'declares neither remotes nor packages');
	}
	for (const r of remotes) {
		if (!r.url?.startsWith('https://')) fail(path, `remote url must be https (${r.url})`);
	}
}

const total = PACKAGE_MANIFESTS.length + remoteManifests.length;
if (violations) {
	console.error(`[audit:mcp] ${violations} violation(s) across ${total} manifests`);
	process.exit(1);
}
console.log(`[audit:mcp] ${total} MCP manifests consistent`);
