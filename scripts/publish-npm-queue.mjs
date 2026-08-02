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
//
// Auth: `npm whoami` must resolve to an account with publish rights on the
// three-ws scope (npm login, or an automation token in ~/.npmrc).

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

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
	"x402-modal-sdk", // @three-ws/x402-modal 0.2.2 (283 dl/mo)
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
];

const publish = process.argv.includes('--publish');

function registryVersion(name) {
	try {
		const res = execFileSync('npm', ['view', name, 'version'], { encoding: 'utf8' });
		return res.trim();
	} catch {
		return null; // unpublished
	}
}

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
		execFileSync('npm', ['publish', '--access', 'public'], {
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
