// @ts-check
// GET /api/cron/garment-catalog-audit — daily integrity sweep of the public
// wardrobe catalog.
//
// The catalog (gs://three-ws-garments/garments/catalog.json) is living
// production data fed by the garment forge and consumed by every closet
// client. It can rot silently: an object deleted or overwritten, a bucket
// policy change breaking anonymous reads, a truncated upload. This cron
// verifies, for every entry:
//
//   1. structural validity (spec/slot/region/license/hash-shape — the same
//      contract src/garment-catalog.js enforces client-side),
//   2. the GLB and thumbnail are anonymously reachable (HEAD),
//   3. the GLB bytes still hash to model.sha256 (full check on a rotating
//      subset per run, so a 100-entry catalog stays inside cron budget while
//      every entry gets re-hashed within a few days).
//
// Failures are logged through reportServerError, which the production triage
// sweep (npm run triage:gcp) already classifies — no new alert channel.
// The heavyweight geometric audit (bind + walk-gait deviation) stays in
// `npm run audit:garments`, run on demand after seeding or placement changes.

import { error, json, method, reportServerError, wrapCron } from '../_lib/http.js';
import { requireCron } from '../_lib/cron-auth.js';

const CATALOG_URL = 'https://storage.googleapis.com/three-ws-garments/garments/catalog.json';
const SPEC_URI = 'https://three.ws/specs/garment-manifest-v1';
const SLOTS = new Set([
	'top', 'bottom', 'footwear', 'outerwear', 'hair', 'headwear', 'glasses', 'accessory',
]);
const REGIONS = new Set([
	'torso', 'upperArms', 'lowerArms', 'hands',
	'hips', 'upperLegs', 'lowerLegs', 'feet', 'neck', 'scalp',
]);
const LICENSES = new Set([
	'CC0-1.0', 'CC-BY-4.0', 'MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause',
]);
const SHA256_RE = /^[0-9a-f]{64}$/;
// Full-hash this many entries per run, rotating by day-of-year so the whole
// catalog is re-verified every few days without ever fetching every GLB.
const HASH_SAMPLE = 5;

function structuralErrors(m) {
	const errs = [];
	if (m?.spec !== SPEC_URI) errs.push('unknown spec');
	if (!SLOTS.has(m?.slot)) errs.push(`unknown slot "${m?.slot}"`);
	if (!Array.isArray(m?.occludes) || m.occludes.some((r) => !REGIONS.has(r))) {
		errs.push('bad occludes');
	}
	if (!LICENSES.has(m?.license)) errs.push(`license "${m?.license}"`);
	if (!SHA256_RE.test(m?.model?.sha256 || '')) errs.push('malformed sha256');
	if (!/^https:\/\//.test(m?.model?.uri || '')) errs.push('non-https model.uri');
	return errs;
}

async function head(url) {
	const res = await fetch(url, { method: 'HEAD' }).catch(() => null);
	return res?.ok ? null : `HEAD ${url} -> ${res ? res.status : 'unreachable'}`;
}

async function sha256Of(url) {
	const res = await fetch(url).catch(() => null);
	if (!res?.ok) return null;
	const buf = await res.arrayBuffer();
	const digest = await crypto.subtle.digest('SHA-256', buf);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	const catRes = await fetch(CATALOG_URL).catch(() => null);
	if (!catRes?.ok) {
		reportServerError(new Error(`garment catalog unreachable (${catRes?.status ?? 'network'})`), {
			code: 'garment_catalog_unreachable',
			context: { url: CATALOG_URL },
		});
		return error(res, 502, 'catalog_unreachable', `catalog fetch ${catRes?.status ?? 'failed'}`);
	}
	const catalog = await catRes.json().catch(() => null);
	if (!Array.isArray(catalog)) {
		reportServerError(new Error('garment catalog is not a JSON array'), {
			code: 'garment_catalog_malformed',
		});
		return error(res, 502, 'catalog_malformed', 'catalog is not a JSON array');
	}

	const failures = [];
	for (const m of catalog) {
		const label = `${m?.slot}/${m?.id}`;
		const errs = structuralErrors(m);
		if (errs.length) {
			failures.push({ id: label, errors: errs });
			continue;
		}
		const reach = (await Promise.all([
			head(m.model.uri),
			m.preview?.thumbnail ? head(m.preview.thumbnail) : null,
		])).filter(Boolean);
		if (reach.length) failures.push({ id: label, errors: reach });
	}

	// Rotating full-hash sample: day-of-year picks the window.
	const day = Math.floor(Date.now() / 86_400_000);
	const clean = catalog.filter((m) => !failures.some((f) => f.id === `${m?.slot}/${m?.id}`));
	const hashed = [];
	for (let i = 0; i < Math.min(HASH_SAMPLE, clean.length); i++) {
		const m = clean[(day * HASH_SAMPLE + i) % clean.length];
		const sha = await sha256Of(m.model.uri);
		hashed.push(`${m.slot}/${m.id}`);
		if (sha && sha !== m.model.sha256) {
			failures.push({ id: `${m.slot}/${m.id}`, errors: ['sha256 drift: stored bytes no longer match the manifest'] });
		}
	}

	for (const f of failures) {
		reportServerError(new Error(`garment catalog entry broken: ${f.id}: ${f.errors.join('; ')}`), {
			code: 'garment_catalog_entry_broken',
			context: f,
		});
	}

	return json(res, 200, {
		ok: failures.length === 0,
		entries: catalog.length,
		hashed,
		failures,
	});
});
