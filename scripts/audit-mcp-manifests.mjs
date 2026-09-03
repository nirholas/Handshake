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
// Plus the public directory at public/.well-known/mcp.json, which agents fetch
// to enumerate the hosted fleet in one request: it must list exactly the remote
// manifests on disk (no orphan entry, no unlisted endpoint), agree with each
// manifest on transport, and point every documentation link at a doc that
// exists. /docs/<slug> is served by an SPA shell that answers 200 for any slug,
// so a live probe cannot catch a dead docs link; only docs/<slug>.md can.
//
// Run: node scripts/audit-mcp-manifests.mjs   (exit 1 on any violation)

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// stdio package manifests live next to their package.json. Discovered from
// disk, never hand-listed: a hardcoded list silently drifts as packages are
// added, and an unlisted manifest is an unvalidated one that only fails on
// publish day. mcp-server, mcp-bridge and robinhood/hood-mcp sit outside packages/
// so they are named.
const FIXED_PACKAGE_DIRS = ['mcp-server', 'mcp-bridge', 'robinhood/hood-mcp'];
const PACKAGE_MANIFESTS = [
	...FIXED_PACKAGE_DIRS,
	...readdirSync(resolve(root, 'packages'), { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => join('packages', e.name))
		.filter((d) => existsSync(resolve(root, d, 'server.json'))),
]
	.map((d) => join(d, 'server.json'))
	.sort();

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

// Every manifest on disk must be reachable by the publisher. A manifest that
// validates here but is absent from publish-mcp-servers.mjs can never be
// published or version-bumped on the registry: it silently pins to whatever
// version was pushed by hand, while npm moves on.
{
	const publisher = 'scripts/publish-mcp-servers.mjs';
	const src = readFileSync(resolve(root, publisher), 'utf8');
	const listed = new Set(
		[...src.matchAll(/manifest:\s*'([^']+)'/g)].map((m) => m[1]),
	);
	for (const path of PACKAGE_MANIFESTS) {
		if (!existsSync(resolve(root, path))) continue;
		if (!listed.has(path)) {
			fail(path, `not listed in ${publisher}, so it can never be published or updated`);
		}
	}
}

// The hosted-fleet directory must describe the same servers the repo ships.
{
	const dirPath = 'public/.well-known/mcp.json';
	const dir = load(dirPath);
	const entries = Array.isArray(dir?.servers) ? dir.servers : null;
	if (dir && !entries) fail(dirPath, 'missing servers[]');

	if (entries) {
		const byEndpoint = new Map();
		for (const s of entries) {
			for (const field of ['name', 'endpoint', 'transport', 'auth', 'description', 'documentation']) {
				if (!s[field]) fail(dirPath, `entry "${s.name || s.endpoint || '?'}" missing ${field}`);
			}
			if (s.endpoint) {
				if (byEndpoint.has(s.endpoint)) fail(dirPath, `endpoint listed twice: ${s.endpoint}`);
				byEndpoint.set(s.endpoint, s);
			}
			const doc = s.documentation || '';
			const slug = doc.startsWith('https://three.ws/docs/') ? doc.slice('https://three.ws/docs/'.length) : null;
			if (!slug) {
				fail(dirPath, `documentation must be an https://three.ws/docs/<slug> link (${doc})`);
			} else if (!existsSync(resolve(root, 'docs', `${slug}.md`))) {
				fail(dirPath, `documentation ${doc} has no docs/${slug}.md behind it`);
			}
		}

		for (const path of remoteManifests) {
			const m = load(path);
			for (const r of m?.remotes ?? []) {
				const entry = byEndpoint.get(r.url);
				if (!entry) {
					fail(dirPath, `${path} serves ${r.url} but the directory does not list it`);
					continue;
				}
				if (entry.transport !== r.type) {
					fail(dirPath, `${r.url}: directory says transport "${entry.transport}", ${path} says "${r.type}"`);
				}
				byEndpoint.delete(r.url);
			}
		}
		for (const url of byEndpoint.keys()) {
			fail(dirPath, `lists ${url}, which no server*.json at the repo root declares`);
		}
	}
}

const total = PACKAGE_MANIFESTS.length + remoteManifests.length;
if (violations) {
	console.error(`[audit:mcp] ${violations} violation(s) across ${total} manifests`);
	process.exit(1);
}
console.log(`[audit:mcp] ${total} MCP manifests consistent`);
