#!/usr/bin/env node
// Publish every three.ws MCP server to npm and the official MCP registry
// (registry.modelcontextprotocol.io), idempotently.
//
// For each stdio package below it:
//   1. checks the version in package.json against npm — publishes to npm if absent
//      (requires `npm whoami` to succeed or NPM_TOKEN in the environment);
//   2. checks the version against the MCP registry — publishes server.json if absent.
//
// Remote-only manifests (root server*.json) skip the npm step.
//
// Registry auth (io.github.nirholas namespace), first match wins:
//   - MCP_REGISTRY_TOKEN env (a registry JWT)
//   - the owner's GitHub PAT from git: the `origin` remote URL, else
//     ~/.git-credentials, exchanged via POST /v0/auth/github-at
//   - GITHUB_TOKEN env, same exchange
//
// The git PAT outranks GITHUB_TOKEN on purpose: in a Codespace the latter can
// belong to a different account, whose io.github.<owner> namespace is not the one
// these manifests publish under, so it authenticates fine and then 403s on publish.
//
// Usage:
//   node scripts/publish-mcp-servers.mjs --dry-run   # validate + report only
//   node scripts/publish-mcp-servers.mjs             # publish what's missing
//   node scripts/publish-mcp-servers.mjs --only pumpfun-mcp,three-token-mcp
//   node scripts/publish-mcp-servers.mjs --npm-only  # skip the registry step entirely

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.modelcontextprotocol.io';

// Every publishable MCP server in this repo. `dir` packages publish to npm
// first; `manifest`-only entries are remote Streamable HTTP servers.
const SERVERS = [
	{ key: 'mcp-server', dir: 'mcp-server', manifest: 'mcp-server/server.json' },
	{
		key: 'pumpfun-mcp',
		dir: 'packages/pumpfun-mcp',
		manifest: 'packages/pumpfun-mcp/server.json',
	},
	{
		key: 'ibm-watsonx-mcp',
		dir: 'packages/ibm-watsonx-mcp',
		manifest: 'packages/ibm-watsonx-mcp/server.json',
	},
	{
		key: 'ibm-x402-mcp',
		dir: 'packages/ibm-x402-mcp',
		manifest: 'packages/ibm-x402-mcp/server.json',
	},
	{
		key: 'avatar-agent-mcp',
		dir: 'packages/avatar-agent-mcp',
		manifest: 'packages/avatar-agent-mcp/server.json',
	},
	{
		key: 'threews-avatar-mcp',
		dir: 'packages/threews-avatar-mcp',
		manifest: 'packages/threews-avatar-mcp/server.json',
	},
	{
		key: 'three-token-mcp',
		dir: 'packages/three-token-mcp',
		manifest: 'packages/three-token-mcp/server.json',
	},
	{ key: 'mcp-bridge', dir: 'mcp-bridge', manifest: 'mcp-bridge/server.json' },
	{ key: 'scene-mcp', dir: 'packages/scene-mcp', manifest: 'packages/scene-mcp/server.json' },
	{ key: 'assistant-mcp', dir: 'packages/assistant-mcp', manifest: 'packages/assistant-mcp/server.json' },
	{ key: 'vanity-mcp', dir: 'packages/vanity-mcp', manifest: 'packages/vanity-mcp/server.json' },
	{ key: 'naming-mcp', dir: 'packages/naming-mcp', manifest: 'packages/naming-mcp/server.json' },
	{ key: 'intel-mcp', dir: 'packages/intel-mcp', manifest: 'packages/intel-mcp/server.json' },
	{
		key: 'marketplace-mcp',
		dir: 'packages/marketplace-mcp',
		manifest: 'packages/marketplace-mcp/server.json',
	},
	{ key: 'x402-mcp', dir: 'packages/x402-mcp', manifest: 'packages/x402-mcp/server.json' },
	{
		key: 'metaplex-agent-mcp',
		dir: 'packages/metaplex-agent-mcp',
		manifest: 'packages/metaplex-agent-mcp/server.json',
	},
	{
		key: 'onchain-agent-wallets',
		dir: 'packages/onchain-agent-wallets',
		manifest: 'packages/onchain-agent-wallets/server.json',
	},
	// Autonomous-agent control plane + account/discovery + capability surfaces
	// (the 2025-06 buildout). Each is a stdio npm package with its own server.json.
	{ key: 'autopilot-mcp', dir: 'packages/autopilot-mcp', manifest: 'packages/autopilot-mcp/server.json' },
	{ key: 'portfolio-mcp', dir: 'packages/portfolio-mcp', manifest: 'packages/portfolio-mcp/server.json' },
	{ key: 'provenance-mcp', dir: 'packages/provenance-mcp', manifest: 'packages/provenance-mcp/server.json' },
	{ key: 'copy-mcp', dir: 'packages/copy-mcp', manifest: 'packages/copy-mcp/server.json' },
	{ key: 'signals-mcp', dir: 'packages/signals-mcp', manifest: 'packages/signals-mcp/server.json' },
	{ key: 'alerts-mcp', dir: 'packages/alerts-mcp', manifest: 'packages/alerts-mcp/server.json' },
	{ key: 'notifications-mcp', dir: 'packages/notifications-mcp', manifest: 'packages/notifications-mcp/server.json' },
	{ key: 'billing-mcp', dir: 'packages/billing-mcp', manifest: 'packages/billing-mcp/server.json' },
	{ key: 'activity-mcp', dir: 'packages/activity-mcp', manifest: 'packages/activity-mcp/server.json' },
	{ key: 'agenc-mcp', dir: 'packages/agenc-mcp', manifest: 'packages/agenc-mcp/server.json' },
	{ key: 'vision-mcp', dir: 'packages/vision-mcp', manifest: 'packages/vision-mcp/server.json' },
	{ key: 'brain-mcp', dir: 'packages/brain-mcp', manifest: 'packages/brain-mcp/server.json' },
	{ key: 'audio-mcp', dir: 'packages/audio-mcp', manifest: 'packages/audio-mcp/server.json' },
	{ key: 'kol-mcp', dir: 'packages/kol-mcp', manifest: 'packages/kol-mcp/server.json' },
	{ key: 'clash-mcp', dir: 'packages/clash-mcp', manifest: 'packages/clash-mcp/server.json' },
	{ key: 'tutor-mcp', dir: 'packages/tutor-mcp', manifest: 'packages/tutor-mcp/server.json' },
	{ key: 'loom-mcp', dir: 'packages/loom-mcp', manifest: 'packages/loom-mcp/server.json' },
	{ key: 'agent-sniper', dir: 'packages/agent-sniper', manifest: 'packages/agent-sniper/server.json' },
	{ key: 'concierge-mcp', dir: 'packages/concierge-mcp', manifest: 'packages/concierge-mcp/server.json' },
	{
		key: 'agentcore-payments-mcp',
		dir: 'packages/agentcore-payments-mcp',
		manifest: 'packages/agentcore-payments-mcp/server.json',
	},
	{ key: 'agora-mcp', dir: 'packages/agora-mcp', manifest: 'packages/agora-mcp/server.json' },
	{
		key: 'alibaba-cloud-mcp',
		dir: 'packages/alibaba-cloud-mcp',
		manifest: 'packages/alibaba-cloud-mcp/server.json',
	},
	{ key: 'herald-mcp', dir: 'packages/herald-mcp', manifest: 'packages/herald-mcp/server.json' },
	{ key: 'knock-mcp', dir: 'packages/knock-mcp', manifest: 'packages/knock-mcp/server.json' },
	{ key: 'remote-main', manifest: 'server.json' },
	{ key: 'remote-pumpfun', manifest: 'server-pumpfun.json' },
	{ key: 'remote-3d', manifest: 'server-3d.json' },
	{ key: 'remote-agent', manifest: 'server-agent.json' },
	{ key: 'remote-ibm', manifest: 'server-ibm.json' },
	{ key: 'remote-bazaar', manifest: 'server-bazaar.json' },
	// Free, non-crypto 3D Studio (api/mcp-studio.js) for the OpenAI Apps SDK.
	{ key: 'remote-studio', manifest: 'server-studio.json' },
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const npmOnly = args.includes('--npm-only');
const onlyArg = args.find((a) => a.startsWith('--only'));
const only = onlyArg
	? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1] || '')
			.split(',')
			.filter(Boolean)
	: null;

const fail = (msg) => {
	console.error(`✗ ${msg}`);
	process.exitCode = 1;
};

function readJson(path) {
	return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

async function npmVersionExists(name, version) {
	const res = await fetch(
		`https://registry.npmjs.org/${encodeURIComponent(name).replace('%2F', '/')}`,
	);
	if (res.status === 404) return false;
	if (!res.ok) throw new Error(`npm registry lookup for ${name} → HTTP ${res.status}`);
	const meta = await res.json();
	return Boolean(meta.versions && meta.versions[version]);
}

async function registryVersionExists(name, version) {
	const res = await fetch(
		`${REGISTRY}/v0/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
	);
	if (res.status === 404) return false;
	if (!res.ok) throw new Error(`MCP registry lookup for ${name}@${version} → HTTP ${res.status}`);
	return true;
}

// The repo owner's GitHub PAT, from wherever git keeps it.
//
// Two locations, because both are normal setups: the token can be embedded in the
// origin remote URL, or (the tidier arrangement, and what `credential.helper=store`
// produces) it can live in ~/.git-credentials with the remote left clean. Reading
// only the remote meant a repo using the credential store looked unauthenticated
// and silently fell through to GITHUB_TOKEN, which is the wrong account.
function patFromGitConfig() {
	try {
		const url = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
			encoding: 'utf8',
		}).trim();
		const m = /https:\/\/[^:]+:([^@]+)@github\.com\//.exec(url);
		if (m) return m[1];
	} catch {
		// no origin remote configured; fall through to the credential store
	}
	try {
		const store = readFileSync(resolve(homedir(), '.git-credentials'), 'utf8');
		for (const line of store.split('\n')) {
			const m = /^https:\/\/[^:]+:([^@]+)@github\.com/.exec(line.trim());
			if (m) return m[1];
		}
	} catch {
		// no credential store, or unreadable
	}
	return null;
}

async function getRegistryToken() {
	if (process.env.MCP_REGISTRY_TOKEN) return process.env.MCP_REGISTRY_TOKEN;
	// The origin-remote PAT outranks GITHUB_TOKEN: it belongs to the repo owner,
	// whose io.github.<owner> namespace is the one these manifests publish under.
	// A Codespace GITHUB_TOKEN can belong to a different account entirely.
	const ghToken = patFromGitConfig() || process.env.GITHUB_TOKEN;
	if (!ghToken) {
		throw new Error(
			'no registry auth: set MCP_REGISTRY_TOKEN or GITHUB_TOKEN, or keep the PAT on the origin remote',
		);
	}
	const res = await fetch(`${REGISTRY}/v0/auth/github-at`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ github_token: ghToken }),
	});
	if (!res.ok) {
		throw new Error(
			`registry github-at exchange failed → HTTP ${res.status}: ${await res.text()}`,
		);
	}
	const body = await res.json();
	if (!body.registry_token)
		throw new Error('registry github-at exchange returned no registry_token');
	return body.registry_token;
}

async function publishToRegistry(manifest, token) {
	const res = await fetch(`${REGISTRY}/v0/publish`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify(manifest),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`registry publish → HTTP ${res.status}: ${text}`);
	return JSON.parse(text);
}

function npmPublish(dir) {
	execFileSync('npm', ['publish', '--access', 'public'], {
		cwd: resolve(root, dir),
		stdio: 'inherit',
	});
}

// This file publishes to npm and the MCP registry from its top level, so merely
// importing it runs a live publish. Nothing imports it today (package.json calls
// it with node, and audit-mcp-manifests reads it as text), and nothing should:
// importing it to reach a helper would ship packages as a side effect. Fail loudly
// instead, so an accidental import rejects rather than publishes.
if (!process.argv[1] || import.meta.url !== pathToFileURL(process.argv[1]).href) {
	throw new Error(
		'publish-mcp-servers.mjs is a CLI, not a module: importing it would run a live publish. ' +
			'Run `node scripts/publish-mcp-servers.mjs --dry-run` instead.',
	);
}

let registryToken = null;

for (const server of SERVERS) {
	if (only && !only.includes(server.key)) continue;
	const manifestPath = resolve(root, server.manifest);
	if (!existsSync(manifestPath)) {
		fail(`${server.key}: manifest ${server.manifest} not found`);
		continue;
	}
	const manifest = readJson(server.manifest);
	const { name, version } = manifest;
	console.log(`\n── ${server.key} → ${name}@${version}`);

	// Consistency checks before anything irreversible.
	if (server.dir) {
		const pkg = readJson(`${server.dir}/package.json`);
		if (pkg.version !== version) {
			fail(`${server.key}: package.json ${pkg.version} ≠ server.json ${version}`);
			continue;
		}
		const pkgEntry = manifest.packages?.[0];
		if (!pkgEntry || pkgEntry.identifier !== pkg.name || pkgEntry.version !== version) {
			fail(`${server.key}: server.json packages[0] does not match ${pkg.name}@${version}`);
			continue;
		}
		if (pkg.mcpName !== name) {
			fail(
				`${server.key}: package.json mcpName "${pkg.mcpName}" ≠ server.json name "${name}"`,
			);
			continue;
		}
	}

	// 1. npm. Isolated per-package: a batch run publishes 40+ independent
	// packages, and one failure (name squatted, auth blip, network hiccup)
	// must not strand every package still queued behind it.
	let npmOk = true;
	if (server.dir) {
		const pkg = readJson(`${server.dir}/package.json`);
		try {
			const onNpm = await npmVersionExists(pkg.name, version);
			if (onNpm) {
				console.log(`   npm: ${pkg.name}@${version} already published`);
			} else if (dryRun) {
				console.log(`   npm: would publish ${pkg.name}@${version}`);
			} else {
				console.log(`   npm: publishing ${pkg.name}@${version}…`);
				npmPublish(server.dir);
			}
		} catch (err) {
			npmOk = false;
			fail(`${server.key}: npm publish failed — ${err.message}`);
		}
	}
	if (!npmOk || npmOnly) continue;

	// 2. MCP registry
	try {
		const onRegistry = await registryVersionExists(name, version);
		if (onRegistry) {
			console.log(`   registry: ${name}@${version} already published`);
		} else if (dryRun) {
			console.log(`   registry: would publish ${name}@${version}`);
		} else {
			if (server.dir) {
				const pkg = readJson(`${server.dir}/package.json`);
				if (!(await npmVersionExists(pkg.name, version))) {
					fail(
						`${server.key}: skipping registry publish — ${pkg.name}@${version} is not on npm yet`,
					);
					continue;
				}
			}
			registryToken ??= await getRegistryToken();
			console.log(`   registry: publishing ${name}@${version}…`);
			const out = await publishToRegistry(manifest, registryToken);
			console.log(`   registry: published (status ${out?.server?.status ?? 'ok'})`);
		}
	} catch (err) {
		fail(`${server.key}: registry step failed — ${err.message}`);
	}
}

console.log(dryRun ? '\nDry run complete.' : '\nPublish run complete.');
