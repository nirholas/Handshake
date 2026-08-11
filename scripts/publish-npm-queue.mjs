#!/usr/bin/env node
// Publishes every npm package release the 2026-08-02 registry audit queued:
// packages whose local source is ahead of the published version, including the
// fleet-wide relicense (Apache-2.0 to all-rights-reserved, commit 8e2f1c447)
// that never shipped. Ordered by monthly downloads so the most-used packages
// update first. Safe to re-run; any package whose local version already exists
// on the registry is skipped, so a partial run (rate limit, network drop,
// prepublishOnly failure) just resumes where it stopped. Packages with a
// prepublishOnly build/test gate run it at publish time; a failure skips that
// package and the run continues.
//
// Usage:
//   node scripts/publish-npm-queue.mjs           # dry run: report what would publish
//   node scripts/publish-npm-queue.mjs --publish # actually publish (needs npm login)
//   NPM_TOKEN=npm_xxx node scripts/publish-npm-queue.mjs --publish  # publish with a
//                                                 # `three-ws` token, leaving ~/.npmrc alone
//
// Auth: `npm whoami` must resolve to an account that MAINTAINS these packages,
// which is a stricter bar than "is logged in". Every package here is owned by
// the `three-ws` account (support@three.ws); a token for any other account
// authenticates fine, reads fine, and then fails the publish PUT with a bare
// E404, because npm reports "not a maintainer" as "not found" rather than 403.
// A 2026-08-04 run burned a full pass discovering that one package at a time,
// so the preflight below resolves the maintainer set from the registry and
// refuses to start unless the logged-in account is actually in it.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * Run npm as the `three-ws` account without touching the machine's ~/.npmrc.
 *
 * The queue can only be published by that account, and this workspace is
 * normally logged in as a different one, so requiring `npm login` here means
 * clobbering whatever session the rest of the machine is using. Setting
 * NPM_TOKEN instead points npm at a throwaway config for this run only:
 *
 *   NPM_TOKEN=npm_xxx node scripts/publish-npm-queue.mjs --publish
 *
 * Unset, npm uses the ambient login exactly as before.
 */
const tokenDir = process.env.NPM_TOKEN ? mkdtempSync(join(tmpdir(), 'npm-queue-')) : null;
if (tokenDir) {
	writeFileSync(join(tokenDir, '.npmrc'), `//registry.npmjs.org/:_authToken=${process.env.NPM_TOKEN}\n`, { mode: 0o600 });
	process.on('exit', () => rmSync(tokenDir, { recursive: true, force: true }));
}

/** npm argv with the throwaway config prepended, when NPM_TOKEN is in play. */
function npmArgs(args) {
	return tokenDir ? ['--userconfig', join(tokenDir, '.npmrc'), ...args] : args;
}

const QUEUE = [
	"walk-sdk", // @three-ws/walk 0.3.0 (920 dl/mo)
	"avatar-sdk", // @three-ws/avatar 0.2.2 (628 dl/mo)
	"packages/pumpfun-mcp", // @three-ws/pumpfun-mcp 0.2.5 (549 dl/mo)
	"page-agent-sdk", // @three-ws/page-agent 0.2.1 (545 dl/mo)
	"packages/alibaba-cloud-mcp", // @three-ws/alibaba-cloud-mcp 0.1.2 (430 dl/mo)
	"packages/agentcore-payments-mcp", // @three-ws/agentcore-payments-mcp 0.1.3 (377 dl/mo)
	"packages/scene-mcp", // @three-ws/scene-mcp 0.2.1 (372 dl/mo)
	"packages/ibm-x402-mcp", // @three-ws/ibm-x402-mcp 1.1.3 (372 dl/mo)
	"packages/brain-mcp", // @three-ws/brain-mcp 0.1.3 (368 dl/mo)
	"packages/notifications-mcp", // @three-ws/notifications-mcp 0.1.3 (360 dl/mo)
	"mcp-server", // @three-ws/mcp-server 1.2.2 (359 dl/mo)
	"packages/agora-mcp", // @three-ws/agora-mcp 0.1.2 (356 dl/mo)
	"packages/intel-mcp", // @three-ws/intel-mcp 0.1.2 (347 dl/mo)
	"packages/marketplace-mcp", // @three-ws/marketplace-mcp 0.1.2 (345 dl/mo)
	"packages/vanity-mcp", // @three-ws/vanity-mcp 0.1.2 (344 dl/mo)
	"packages/billing-mcp", // @three-ws/billing-mcp 0.1.2 (343 dl/mo)
	"packages/copy-mcp", // @three-ws/copy-mcp 0.1.2 (338 dl/mo)
	"packages/x402-mcp", // @three-ws/x402-mcp 0.2.2 (337 dl/mo)
	"packages/three-token-mcp", // @three-ws/three-token-mcp 1.1.2 (334 dl/mo)
	"mcp-bridge", // @three-ws/mcp-bridge 1.0.2 (330 dl/mo)
	"packages/alerts-mcp", // @three-ws/alerts-mcp 0.1.2 (330 dl/mo)
	"packages/naming-mcp", // @three-ws/naming-mcp 0.1.2 (329 dl/mo)
	"packages/activity-mcp", // @three-ws/activity-mcp 0.1.2 (320 dl/mo)
	"packages/loom-mcp", // @three-ws/loom-mcp 0.1.2 (318 dl/mo)
	"packages/signals-mcp", // @three-ws/signals-mcp 0.1.2 (316 dl/mo)
	"packages/agenc-mcp", // @three-ws/agenc-mcp 0.1.2 (315 dl/mo)
	"packages/audio-mcp", // @three-ws/audio-mcp 0.1.2 (312 dl/mo)
	"packages/clash-mcp", // @three-ws/clash-mcp 0.1.2 (305 dl/mo)
	"packages/provenance-mcp", // @three-ws/provenance-mcp 0.1.2 (297 dl/mo)
	"x402-modal-sdk", // @three-ws/x402-modal 0.3.0 (283 dl/mo)
	"solana-agent-sdk", // @three-ws/solana-agent 0.2.2 (275 dl/mo)
	"sdk", // @three-ws/sdk 0.2.2 (244 dl/mo)
	"packages/react", // @three-ws/react 1.0.2 (228 dl/mo)
	"agent-ui-sdk", // @three-ws/agent-ui 0.2.2 (226 dl/mo)
	"agent-protocol-sdk", // @three-ws/agent-protocol-sdk 0.2.2 (225 dl/mo)
	"packages/readme-3d", // readme-3d 0.1.1 (195 dl/mo)
	"packages/threews-avatar-mcp", // @three-ws/avatar-mcp 0.3.1 (168 dl/mo)
	"packages/assistant-mcp", // @three-ws/assistant-mcp 0.1.1 (163 dl/mo)
	"packages/ibm-watsonx-mcp", // @three-ws/ibm-watsonx-mcp 0.2.1 (151 dl/mo)
	"packages/autopilot-mcp", // @three-ws/autopilot-mcp 0.2.1 (151 dl/mo)
	"packages/retarget", // @three-ws/retarget 0.1.1 (117 dl/mo)
	"packages/x402-fetch", // @three-ws/x402-fetch 1.0.3 (114 dl/mo)
	"packages/kol-mcp", // @three-ws/kol-mcp 0.1.1 (109 dl/mo)
	"packages/tutor-mcp", // @three-ws/tutor-mcp 0.1.1 (104 dl/mo)
	"packages/portfolio-mcp", // @three-ws/portfolio-mcp 0.1.1 (102 dl/mo)
	"x402-payment-modal", // @three-ws/x402-payment-modal 1.2.1 (100 dl/mo)
	"concierge-sdk", // @three-ws/concierge 0.1.1 (95 dl/mo)
	"packages/irl", // @three-ws/irl 0.2.1 (63 dl/mo)
	"packages/guardian", // @three-ws/guardian 0.1.2 (62 dl/mo)
	"packages/vanity", // @three-ws/vanity 0.1.2 (60 dl/mo)
	"packages/mocap", // @three-ws/mocap 0.1.2 (58 dl/mo)
	"packages/intel", // @three-ws/intel 0.1.2 (57 dl/mo)
	"agent-payments-sdk", // @three-ws/agent-payments 3.2.1 (55 dl/mo)
	"packages/names", // @three-ws/names 0.1.2 (55 dl/mo)
	"packages/viewer-presets", // @three-ws/viewer-presets 0.4.0 (52 dl/mo)
	"packages/voice", // @three-ws/voice 0.1.1 (52 dl/mo)
	"packages/pose", // @three-ws/pose 0.1.1 (52 dl/mo)
	"packages/forge", // @three-ws/forge 0.1.1 (48 dl/mo)
	"packages/pumpfun-skills", // @three-ws/pumpfun-skills 0.1.1 (46 dl/mo)
	"packages/glb-tools", // @three-ws/glb-tools 0.1.1 (46 dl/mo)
	"packages/agenc", // @three-ws/agenc 0.1.1 (43 dl/mo)
	"packages/agent-guards", // @three-ws/agent-guards 0.1.1 (42 dl/mo)
	"packages/strategies", // @three-ws/strategies 0.1.1 (42 dl/mo)
	"packages/reputation", // @three-ws/reputation 0.1.1 (41 dl/mo)
	"packages/agent-memory", // @three-ws/agent-memory 0.1.1 (35 dl/mo)
	"packages/skill-license", // @three-ws/skill-license 0.1.1 (34 dl/mo)
	"packages/avatar-schema", // @three-ws/avatar-schema 0.2.1 (25 dl/mo)
	"packages/avatar-cli", // @three-ws/avatar-cli 0.2.1 (23 dl/mo)
	// First releases. No download history to sort by, so they sort last; each
	// ships a README, a LICENSE and a test script, which is the bar for a
	// package the registry has never seen.
	"packages/sign-language", // @three-ws/sign-language 0.1.0 (first release)
	"packages/spatial-mcp", // @three-ws/spatial-mcp 0.1.0 (first release)
	"packages/vscode-x402", // @three-ws/vscode-x402 0.2.0 (first release)
];

const publish = process.argv.includes('--publish');

function registryVersion(name) {
	try {
		const res = execFileSync('npm', npmArgs(['view', name, 'version']), { encoding: 'utf8' });
		return res.trim();
	} catch {
		return null; // unpublished
	}
}

function whoami() {
	try {
		return execFileSync('npm', npmArgs(['whoami']), { encoding: 'utf8' }).trim();
	} catch {
		return null;
	}
}

function maintainersOf(name) {
	try {
		const raw = execFileSync('npm', npmArgs(['view', name, 'maintainers', '--json']), { encoding: 'utf8' });
		const parsed = JSON.parse(raw);
		// npm renders maintainers either as objects or as "name <email>" strings.
		return parsed.map((m) => (typeof m === 'string' ? m.split('<')[0].trim() : m.name));
	} catch {
		return [];
	}
}

// Do NOT replace the maintainer check below with a "try to republish an
// existing version and see which error comes back" probe. It looks like a
// direct test of write access and is not one: npm rejects a duplicate version
// BEFORE it checks publish rights, so an account with no access to the scope
// still gets `EPUBLISHCONFLICT` and the probe reads as success. That mistake
// turned a correct block into a green light, and every publish in the run then
// failed with `404 ... PUT` (npm answers an unauthorized write with 404 so it
// does not leak which packages exist). The maintainers list is the honest
// signal available without a write.

// Preflight. Read-only, so it runs on dry runs too: the whole point is that a
// dry run tells you whether the real run could ever have worked.
function preflight() {
	const account = whoami();
	if (!account) {
		console.error('BLOCKED: not logged in to npm.');
		console.error('  Fix: npm login   (or put an automation token in ~/.npmrc)');
		return false;
	}
	// Sample a published package from the queue to learn who actually owns these.
	const sample = QUEUE.map((dir) => resolve(ROOT, dir, 'package.json'))
		.filter((p) => existsSync(p))
		.map((p) => JSON.parse(readFileSync(p, 'utf8')).name)
		.find((name) => maintainersOf(name).length > 0);
	if (!sample) {
		console.log(`npm account: ${account} (no published package to check ownership against)`);
		return true;
	}
	const owners = maintainersOf(sample);
	if (owners.includes(account)) {
		console.log(`npm account: ${account} (maintainer of ${sample}) OK\n`);
		return true;
	}
	console.error(`BLOCKED: npm account "${account}" does not maintain these packages.`);
	console.error(`  ${sample} is maintained by: ${owners.join(', ')}`);
	console.error('  Publishing would fail with a bare 404 on the PUT for every package in the queue.');
	console.error('  Fix, either one:');
	console.error(`    1. Use a token for the "${owners[0]}" account.`);
	console.error(`    2. From "${owners[0]}", grant this account write access:`);
	console.error(`         npm owner add ${account} <each package>`);
	return false;
}

if (!preflight()) process.exit(2);

let failures = 0;
for (const dir of QUEUE) {
	const pkgPath = resolve(ROOT, dir, 'package.json');
	if (!existsSync(pkgPath)) {
		console.error(`SKIP ${dir}: no package.json`);
		failures++;
		continue;
	}
	const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
	const current = registryVersion(pkg.name);
	if (current === pkg.version) {
		console.log(`ok   ${pkg.name}@${pkg.version} already on the registry`);
		continue;
	}
	console.log(`${publish ? 'PUB ' : 'PLAN'} ${pkg.name}: ${current ?? 'unpublished'} -> ${pkg.version}`);
	if (!publish) continue;
	try {
		execFileSync('npm', npmArgs(['publish', '--access', 'public']), {
			cwd: resolve(ROOT, dir),
			stdio: 'inherit',
		});
	} catch (err) {
		console.error(`FAIL ${pkg.name}: ${err.message}`);
		failures++;
	}
}

if (!publish) console.log('\nDry run only. Re-run with --publish after npm login.');
process.exit(failures ? 1 : 0);
