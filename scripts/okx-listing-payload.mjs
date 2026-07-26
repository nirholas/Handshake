#!/usr/bin/env node
// Builds the `onchainos agent update --service` delta for OKX.AI agent #2632
// from the canonical catalog module (api/_lib/okx-catalog.js), so the listing
// submission can never drift from the live endpoints.
//
// Usage:
//   node scripts/okx-listing-payload.mjs                # create-format entries (no live list)
//   onchainos agent service-list --agent-id 2632 \
//     | node scripts/okx-listing-payload.mjs --delta    # full replace delta vs the live list
//
// With --delta, every live service whose name is NOT in the catalog becomes an
// "operation":"delete" entry, and every catalog row becomes either an
// "operation":"update" (live row with the same name exists) or
// "operation":"create". Output is a single JSON array ready for --service.

import { OKX_CATALOG, listingDescription, validateCatalog } from '../api/_lib/okx-catalog.js';

validateCatalog();

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

if (!wantDelta) {
	console.log(JSON.stringify(OKX_CATALOG.map(catalogEntryToService), null, 2));
	process.exit(0);
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const parsed = JSON.parse(raw);
// service-list shape: { ok, data: [{ total, rows|list|services: [...] }] } or a bare array.
const container = Array.isArray(parsed) ? parsed : (parsed.data?.[0] ?? parsed.data ?? parsed);
const live =
	container.rows ?? container.list ?? container.services ?? (Array.isArray(container) ? container : null);
if (!Array.isArray(live)) {
	console.error('Could not find the service array in the input JSON. Top-level keys:', Object.keys(parsed));
	process.exit(1);
}

const catalogByName = new Map(OKX_CATALOG.map((e) => [e.name, e]));
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
		});
	}
}
for (const e of OKX_CATALOG) {
	const liveRow = liveByName.get(e.name);
	const entry = catalogEntryToService(e);
	if (liveRow) {
		delta.push({ operation: 'update', id: String(liveRow.id ?? liveRow.serviceId), ...entry });
	} else {
		delta.push({ operation: 'create', ...entry });
	}
}

console.log(JSON.stringify(delta, null, 2));
