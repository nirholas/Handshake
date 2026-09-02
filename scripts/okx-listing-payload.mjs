#!/usr/bin/env node
// Builds the `onchainos agent update --service` delta for OKX.AI agent #2632
// from the canonical catalog module (api/_lib/okx-catalog.js), so the listing
// submission can never drift from the live endpoints.
//
// Usage:
//   node scripts/okx-listing-payload.mjs                # create-format entries (no live list)
//   onchainos agent service-list --agent-id 2632 \
//     | node scripts/okx-listing-payload.mjs --delta    # full replace delta vs the live list
//   node scripts/okx-listing-payload.mjs --briefing     # chat-responder briefing markdown
//     (write it to ~/.okx-agent-task/workspace/CLAUDE.md so the okx-a2a daemon's AI
//      subsession answers marketplace chat with real catalog knowledge)
//
// The payload is built from the LISTED rows only (`listed: true`). Back-burner
// rows stay deployed and routable but are deliberately absent from the
// marketplace listing, so a row demoted to `listed: false` in the catalog turns
// into an "operation":"delete" here on the next --delta run.
//
// With --delta, every live service whose name is NOT in the listed catalog
// becomes an "operation":"delete" entry, and every listed row becomes either an
// "operation":"update" (live row with the same name exists) or
// "operation":"create". Output is a single JSON array ready for --service.

import { listedCatalog, listingDescription, validateCatalog } from '../api/_lib/okx-catalog.js';
import { buildChatBriefing } from '../api/_lib/okx-chat-briefing.js';

validateCatalog();

const LISTED = listedCatalog();

function catalogEntryToService(e) {
	return {
		serviceName: e.name,
		serviceDescription: listingDescription(e),
		serviceType: 'A2MCP',
		fee: e.priceUsd === '0' ? '0' : e.priceUsd,
		endpoint: e.endpoint,
	};
}

const wantDelta = process.argv.includes('--delta');
const wantBriefing = process.argv.includes('--briefing');

if (wantBriefing) {
	console.log(buildChatBriefing());
	process.exit(0);
}

if (!wantDelta) {
	console.log(JSON.stringify(LISTED.map(catalogEntryToService), null, 2));
	process.exit(0);
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
if (!raw.trim()) {
	// --delta diffs the LIVE listing against the catalog, so it reads that
	// listing on stdin. Run bare it just hangs or dies inside JSON.parse, which
	// reads as a broken script rather than a missing pipe.
	console.error('--delta reads the live listing on stdin. Run:');
	console.error('  onchainos agent service-list --agent-id 2632 | node scripts/okx-listing-payload.mjs --delta');
	process.exit(1);
}
let parsed;
try {
	parsed = JSON.parse(raw);
} catch (err) {
	console.error(`stdin is not JSON (${err.message}). Expected the output of \`onchainos agent service-list --agent-id 2632\`.`);
	console.error(`Got: ${raw.trim().slice(0, 200)}`);
	process.exit(1);
}
// service-list shape: { ok, data: [{ total, rows|list|services: [...] }] } or a bare array.
const container = Array.isArray(parsed) ? parsed : (parsed.data?.[0] ?? parsed.data ?? parsed);
const live =
	container.rows ?? container.list ?? container.services ?? (Array.isArray(container) ? container : null);
if (!Array.isArray(live)) {
	console.error('Could not find the service array in the input JSON. Top-level keys:', Object.keys(parsed));
	process.exit(1);
}

const catalogByName = new Map(LISTED.map((e) => [e.name, e]));
const liveByName = new Map(live.map((s) => [s.serviceName ?? s.name, s]));

const delta = [];
for (const s of live) {
	const name = s.serviceName ?? s.name;
	if (!catalogByName.has(name)) {
		delta.push({
			operation: 'delete',
			id: String(s.id ?? s.serviceId),
			serviceName: name,
			serviceDescription: s.serviceDescription ?? s.description ?? '',
			serviceType: s.serviceType ?? 'A2MCP',
			fee: String(s.fee ?? '0'),
			// The CLI validates every A2MCP entry's shape, delete included, and
			// refuses one without its endpoint (observed 2026-08-27).
			...(s.endpoint ? { endpoint: s.endpoint } : {}),
		});
	}
}
for (const e of LISTED) {
	const liveRow = liveByName.get(e.name);
	const entry = catalogEntryToService(e);
	if (liveRow) {
		delta.push({ operation: 'update', id: String(liveRow.id ?? liveRow.serviceId), ...entry });
	} else {
		delta.push({ operation: 'create', ...entry });
	}
}

console.log(JSON.stringify(delta, null, 2));
