#!/usr/bin/env node
// Erase withdrawn news records from the durable stores.
// ---------------------------------------------------------------------------
// api/_lib/news-rights.js suppresses withdrawn stories at every READ path, so
// the site stops serving them the moment that code deploys. This script is the
// second half: it deletes the underlying rows, so we are not merely hiding a
// copy we continue to hold.
//
//   • gs://three-ws-news-archive/articles/<month>.jsonl — rewrites each month
//     file without the suppressed records, guarded with if-generation-match so
//     it cannot clobber a concurrent append from the hourly cron.
//   • news_knowledge (Neon)                             — deletes the rows
//     carrying the extracted body text.
//
// Usage:
//   node scripts/news-takedown-purge.mjs --dry-run     # report only (default)
//   node scripts/news-takedown-purge.mjs --apply       # actually delete
//
// Requires GCP credentials (GCP_SERVICE_ACCOUNT_JSON or an authenticated
// gcloud) and DATABASE_URL, the same as the rest of the ops scripts.

import { getGcpAccessToken } from '../api/_lib/gcp-auth.js';
import { getMonths } from '../api/_lib/news-archive-store.js';
import { isSuppressed, TAKEDOWN_IDS, RESTRICTED_HOSTS } from '../api/_lib/news-rights.js';
import { sql } from '../api/_lib/db.js';

const BUCKET = 'three-ws-news-archive';
const API = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o`;
const UPLOAD = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o`;

const APPLY = process.argv.includes('--apply');

async function getObject(token, name) {
	const metaResp = await fetch(`${API}/${encodeURIComponent(name)}`, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(15_000),
	});
	if (metaResp.status === 404) return null;
	if (!metaResp.ok) throw new Error(`GCS meta ${name} → ${metaResp.status}`);
	const meta = await metaResp.json();
	const dataResp = await fetch(`${API}/${encodeURIComponent(name)}?alt=media`, {
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(120_000),
	});
	if (!dataResp.ok) throw new Error(`GCS read ${name} → ${dataResp.status}`);
	return { generation: meta.generation, text: await dataResp.text() };
}

async function putObject(token, name, body, generation) {
	const resp = await fetch(`${UPLOAD}?uploadType=media&name=${encodeURIComponent(name)}&ifGenerationMatch=${generation}`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/x-ndjson',
			'x-goog-if-generation-match': generation,
		},
		body,
		signal: AbortSignal.timeout(120_000),
	});
	if (resp.status === 412) throw new Error(`${name} changed underneath us (concurrent append) — re-run`);
	if (!resp.ok) throw new Error(`GCS write ${name} → ${resp.status} ${(await resp.text()).slice(0, 200)}`);
}

async function purgeArchive() {
	const token = await getGcpAccessToken();
	const months = await getMonths();
	let scanned = 0;
	let removed = 0;
	const touched = [];

	for (const month of months) {
		const name = `articles/${month}.jsonl`;
		const obj = await getObject(token, name).catch((e) => {
			console.warn(`  ! ${name}: ${e.message}`);
			return null;
		});
		if (!obj) continue;

		const lines = obj.text.split('\n').filter(Boolean);
		scanned += lines.length;
		const kept = [];
		let dropped = 0;
		for (const line of lines) {
			let rec;
			try {
				rec = JSON.parse(line);
			} catch {
				kept.push(line); // unparseable line: leave it exactly as found
				continue;
			}
			if (isSuppressed(rec)) {
				dropped++;
				continue;
			}
			kept.push(line);
		}
		if (!dropped) continue;

		removed += dropped;
		touched.push({ month, dropped, kept: kept.length });
		console.log(`  ${month}: dropping ${dropped} of ${lines.length}`);
		if (APPLY) {
			await putObject(token, name, `${kept.join('\n')}\n`, obj.generation);
			console.log(`    rewritten (${kept.length} records)`);
		}
	}
	return { scanned, removed, touched };
}

async function purgeKnowledge() {
	const ids = [...TAKEDOWN_IDS];
	const hostPatterns = [...RESTRICTED_HOSTS].map((h) => `%://${h}/%`);

	const doomed = await sql`
		select id, url from news_knowledge
		where id = any(${ids}) or url ilike any(${hostPatterns})
	`;
	console.log(`  ${doomed.length} news_knowledge row(s) match`);
	for (const r of doomed) console.log(`    ${r.id}  ${r.url}`);
	if (APPLY && doomed.length) {
		await sql`delete from news_knowledge where id = any(${ids}) or url ilike any(${hostPatterns})`;
		console.log(`    deleted ${doomed.length}`);
	}
	return doomed.length;
}

console.log(`news takedown purge — ${APPLY ? 'APPLY (destructive)' : 'DRY RUN (use --apply to delete)'}`);
console.log(`  ${TAKEDOWN_IDS.size} taken-down id(s), restricted hosts: ${[...RESTRICTED_HOSTS].join(', ')}\n`);

// The two stores are independent: a missing GCP credential must not stop the
// database purge, and vice versa. Each half reports its own outcome, and the
// exit code tells a caller whether anything still needs doing.
const failures = [];

console.log('GCS archive:');
const archive = await purgeArchive().catch((e) => {
	console.error(`  FAILED: ${e.message}`);
	if (e.code === 'unconfigured') {
		console.error('  → needs GCP_SERVICE_ACCOUNT_JSON, or an authenticated gcloud (`gcloud auth login`).');
	}
	failures.push('archive');
	return null;
});

console.log('\nknowledge base:');
const knowledge = await purgeKnowledge().catch((e) => {
	console.error(`  FAILED: ${e.message}`);
	console.error('  → needs DATABASE_URL.');
	failures.push('knowledge');
	return null;
});

console.log('');
if (archive) {
	console.log(`scanned ${archive.scanned} archive records across ${archive.touched.length} affected month(s)`);
	console.log(`archive records ${APPLY ? 'removed' : 'to remove'}: ${archive.removed}`);
}
if (knowledge !== null) console.log(`knowledge rows ${APPLY ? 'removed' : 'to remove'}: ${knowledge}`);

if (failures.length) {
	console.error(`\nincomplete: ${failures.join(' and ')} could not be reached. Re-run once credentials are available.`);
	console.error('Note: the read path already suppresses these records (api/_lib/news-rights.js), so nothing is being served meanwhile.');
	process.exit(1);
}
if (!APPLY) console.log('\nnothing was changed. re-run with --apply to execute.');
process.exit(0);
