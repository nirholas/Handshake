#!/usr/bin/env node
// Backfill model_category for existing forge_creations.
//
// The category classifier now runs on every new generation (api/_lib/forge-store
// createCreation → api/_lib/forge-classify.js), but the corpus generated before
// it landed is ~99% 'other'. This one-shot, idempotent pass reclassifies those
// rows from their prompts so the coloured category badges, filtering, and the
// Forge-Off board's category dimension come alive across the whole back catalogue.
//
// Only rows currently marked 'other' are touched, and only updated when the
// classifier produces a *non*-'other' category — so a re-run is a safe no-op once
// the classifiable rows are done, and a genuinely uncategorizable prompt is left
// alone rather than churned.
//
// Usage:
//   DATABASE_URL=... node scripts/backfill-forge-categories.mjs            # dry run (default)
//   DATABASE_URL=... node scripts/backfill-forge-categories.mjs --apply    # write changes
//   flags: --batch=1000  --limit=0 (0 = all)
//
// Prints the before → after category distribution and per-category counts.

import { neon } from '@neondatabase/serverless';
import { classifyModelCategory } from '../api/_lib/forge-classify.js';

const APPLY = process.argv.includes('--apply');
const BATCH = Number((process.argv.find((a) => a.startsWith('--batch=')) || '').split('=')[1]) || 1000;
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is required');
	process.exit(1);
}
const sql = neon(url);

function pct(n, total) {
	return total ? `${((n / total) * 100).toFixed(1)}%` : '0%';
}

async function distribution(label) {
	const rows = await sql`
		select coalesce(model_category,'other') cat, count(*)::int c
		from forge_creations group by 1 order by c desc`;
	const total = rows.reduce((n, r) => n + r.c, 0);
	console.log(`\n[${label}] category distribution (${total} rows):`);
	for (const r of rows) console.log(`  ${r.cat.padEnd(10)} ${String(r.c).padStart(6)}  ${pct(r.c, total)}`);
	return total;
}

async function main() {
	console.log(APPLY ? '=== APPLY MODE (writing) ===' : '=== DRY RUN (no writes; pass --apply to write) ===');
	await distribution('before');

	const changed = Object.create(null);
	let scanned = 0;
	let updated = 0;
	let lastCreated = null; // keyset cursor so we never re-scan a page

	while (true) {
		const page = lastCreated
			? await sql`
				select id, prompt, created_at from forge_creations
				where model_category = 'other' and created_at < ${lastCreated}
				order by created_at desc limit ${BATCH}`
			: await sql`
				select id, prompt, created_at from forge_creations
				where model_category = 'other'
				order by created_at desc limit ${BATCH}`;
		if (page.length === 0) break;
		lastCreated = page[page.length - 1].created_at;
		scanned += page.length;

		// Classify in JS; collect only rows that resolve to a real category.
		const byCat = Object.create(null);
		for (const row of page) {
			const cat = classifyModelCategory(row.prompt);
			if (cat === 'other') continue;
			(byCat[cat] ||= []).push(row.id);
			changed[cat] = (changed[cat] || 0) + 1;
		}

		if (APPLY) {
			for (const [cat, ids] of Object.entries(byCat)) {
				// Guarded on model_category='other' so a concurrent writer that set a
				// real category in the meantime is never clobbered.
				await sql`
					update forge_creations set model_category = ${cat}, updated_at = now()
					where id = any(${ids}) and model_category = 'other'`;
				updated += ids.length;
			}
		} else {
			updated += Object.values(byCat).reduce((n, ids) => n + ids.length, 0);
		}

		process.stdout.write(`\r  scanned ${scanned}, ${APPLY ? 'updated' : 'would update'} ${updated} ...`);
		if (LIMIT && scanned >= LIMIT) break;
	}
	console.log('');

	console.log('\nreclassified by category:');
	for (const [cat, n] of Object.entries(changed).sort((a, b) => b[1] - a[1])) {
		console.log(`  ${cat.padEnd(10)} ${String(n).padStart(6)}`);
	}
	console.log(`\nscanned ${scanned} 'other' rows; ${APPLY ? 'updated' : 'would update'} ${updated}.`);

	if (APPLY) await distribution('after');
	else console.log('\n(dry run — re-run with --apply to write these changes)');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
