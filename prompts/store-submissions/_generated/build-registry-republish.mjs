// Generate mcp-registry-republish.sh — the exact `mcp-publisher publish`
// commands for every three.ws MCP server whose local manifest version is newer
// than (or absent from) the official MCP registry. Staged, NOT run: a human
// must `mcp-publisher login github` and review each publish.
//
// Run:  node prompts/store-submissions/_generated/build-registry-republish.mjs
//   (optionally: REGISTRY_JSON=/path/to/registry.json to reuse a cached dump;
//    otherwise it fetches the live registry.)
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const DATE = process.env.STAMP_DATE || new Date().toISOString().slice(0, 10);

function cmp(a, b) {
	const pa = String(a).split(/[.-]/).map((n) => parseInt(n) || 0);
	const pb = String(b).split(/[.-]/).map((n) => parseInt(n) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
	}
	return 0;
}

// The registry paginates. A single `limit=100` page returns 100 VERSION rows,
// which covers only ~44 distinct server names, and hands back a `nextCursor`.
// Reading one page silently marked every server alphabetically at or after the
// cursor as NEW, which is how this batch came to stage 16 redundant publishes
// for servers that were already current. Follow the cursor to the end.
async function loadRegistry() {
	if (process.env.REGISTRY_JSON) return JSON.parse(readFileSync(process.env.REGISTRY_JSON, 'utf8'));
	const base = 'https://registry.modelcontextprotocol.io/v0/servers?search=io.github.nirholas&limit=100';
	const servers = [];
	const seen = new Set();
	let cursor = '';
	for (let page = 0; page < 50; page++) {
		const r = await fetch(cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base);
		if (!r.ok) throw new Error(`registry query failed: HTTP ${r.status}`);
		const j = await r.json();
		const batch = j.servers || j.data || [];
		servers.push(...batch);
		cursor = (j.metadata || j.meta || {}).nextCursor || '';
		if (!cursor || !batch.length || seen.has(cursor)) break;
		seen.add(cursor);
	}
	return { servers };
}

const reg = await loadRegistry();
const entries = (reg.servers || reg.data || []).map((x) => x.server || x);
console.log(`Registry: read ${entries.length} version rows across ${new Set(entries.map((e) => e.name)).size} server names.`);
const latest = {};
for (const s of entries) if (!latest[s.name] || cmp(s.version, latest[s.name]) > 0) latest[s.name] = s.version;

const files = execSync(
	`find ${ROOT} -maxdepth 3 -name "server*.json" -not -path "*/node_modules/*" -not -path "*/.git/*" | sort`,
	{ encoding: 'utf8' },
).trim().split('\n').filter((f) => /\/server[^/]*\.json$/.test(f));

const rows = files.map((f) => {
	const j = JSON.parse(readFileSync(f, 'utf8'));
	const rel = f.replace(ROOT + '/', '');
	const rv = latest[j.name];
	const status = !rv ? 'NEW' : cmp(j.version, rv) > 0 ? 'STALE' : 'OK';
	return { rel, name: j.name, ver: j.version, rv: rv || '—', status };
});
const todo = rows.filter((r) => r.status !== 'OK');
const ok = rows.filter((r) => r.status === 'OK').length;

// Paginated on purpose: one page covers only ~44 of the namespace's servers.
const verify = "node scripts/publish-mcp-servers.mjs --dry-run";

let sh = '#!/usr/bin/env bash\n';
sh += `# Republish stale/new three.ws MCP servers to the official MCP registry.\n`;
sh += `# GENERATED ${DATE} by build-registry-republish.mjs — regenerate after any manifest bump.\n`;
sh += `# DO NOT run unattended. A human must be logged in and review each publish.\n`;
sh += `# ${todo.length} servers need a republish; ${ok} are already current.\n`;
sh += 'set -euo pipefail\n';
sh += 'cd "$(git rev-parse --show-toplevel)"\n\n';
sh += '# 1. Authenticate once (device flow / browser):\n';
sh += '#   mcp-publisher login github\n\n';
sh += '# 2. Publish each manifest whose local version is newer than (or absent from) the registry:\n';
for (const r of todo) {
	sh += `\n# ${r.name}: registry ${r.rv} -> local ${r.ver}   [${r.status}]\n`;
	sh += `mcp-publisher publish "${r.rel}"\n`;
}
sh += '\n# 3. Verify all versions match the manifests:\n';
sh += `# ${verify.replace(/\n/g, '\n# ')}\n`;

writeFileSync(join(HERE, 'mcp-registry-republish.sh'), sh);
console.log(`Wrote mcp-registry-republish.sh — ${todo.length} publish commands (STALE ${todo.filter((r) => r.status === 'STALE').length}, NEW ${todo.filter((r) => r.status === 'NEW').length}); ${ok} already current.`);
