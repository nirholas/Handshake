// GET /api/animations/signatures
//
// The measured motion signature of every baked animation clip, as an API. The
// data is scripts/build-motion-signatures.mjs output (public/animations/
// signatures.json): energy, tempo, regional shares, loop seam, travel and the
// derived flags, measured from keyframes rather than authored by hand. This
// endpoint adds the three questions callers keep computing client-side:
//
//   ?clip=<name>                     one clip's signature + plain-language line
//   ?clip=<name>&slot=<slot>         does this clip FIT that runtime slot?
//   ?similar=<name>&limit=<1..20>    nearest clips by measured motion
//
// and a filterable listing for everything else:
//
//   ?overlay=true&loop=clean&lead=arms&band=lively
//   &sort=energy|tempo|duration|upperShare|travel&order=asc|desc
//   &limit=<1..200>&offset=<n>
//
// Static measurement only: no database, no session, no per-caller state. It
// changes exactly when a deploy ships re-measured clips, so it caches like
// /api/play/solver does.

import { readFileSync } from 'node:fs';
import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import {
	describe,
	energyBand,
	leadRegion,
	similarTo,
	slotFit,
	REGIONS,
} from '../../src/runtime/motion-signature.js';
import { SLOTS, DEFAULT_ANIMATION_MAP } from '../../src/runtime/animation-slots.js';

// One read per process. The file ships inside the image, so a missing or
// unparsable index is a build defect, not a runtime condition to soften.
const INDEX = JSON.parse(
	readFileSync(new URL('../../public/animations/signatures.json', import.meta.url), 'utf8'),
);

const SORT_KEYS = ['energy', 'tempo', 'duration', 'upperShare', 'travel', 'beat', 'balance'];
const BANDS = ['still', 'calm', 'gentle', 'lively', 'explosive'];
const CACHE = { 'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400' };

/** The signature plus the derived words every consumer ends up recomputing. */
function present(sig) {
	return { ...sig, band: energyBand(sig), lead: sig.lead || leadRegion(sig.regions), description: describe(sig) };
}

/** Parse "true"/"false"/null. Anything else reads as null (no filter). */
function boolParam(v) {
	if (v === 'true') return true;
	if (v === 'false') return false;
	return null;
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');
	const q = url.searchParams;

	// ── Similar-clips mode ────────────────────────────────────────────────
	const similar = q.get('similar');
	if (similar) {
		if (!INDEX.clips[similar]) {
			return error(res, 404, 'unknown_clip', `No signature for "${similar}". GET this endpoint with no parameters to list every measured clip.`);
		}
		const limitRaw = Number.parseInt(q.get('limit') ?? '5', 10);
		const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, limitRaw)) : 5;
		return json(res, 200, {
			version: INDEX.version,
			clip: similar,
			similar: similarTo(similar, INDEX.clips, limit).map((m) => ({
				clip: m.clip,
				distance: Math.round(m.distance * 1000) / 1000,
				band: energyBand(m.signature),
				description: describe(m.signature),
			})),
		}, CACHE);
	}

	// ── Single-clip mode, with optional slot-fit verdict ─────────────────
	const clip = q.get('clip');
	if (clip) {
		const sig = INDEX.clips[clip];
		if (!sig) {
			return error(res, 404, 'unknown_clip', `No signature for "${clip}". GET this endpoint with no parameters to list every measured clip.`);
		}
		const slot = q.get('slot');
		let fit;
		if (slot !== null) {
			if (!SLOTS.includes(slot)) {
				return error(res, 400, 'unknown_slot', `"${slot}" is not a runtime slot. Slots: ${SLOTS.join(', ')}.`);
			}
			fit = { slot, defaultClip: DEFAULT_ANIMATION_MAP[slot] ?? slot, ...slotFit(slot, sig) };
		}
		return json(res, 200, { version: INDEX.version, signature: present(sig), ...(fit ? { fit } : {}) }, CACHE);
	}

	// A slot without a clip is answerable too: report the fit of the slot's
	// own default, which is the question "is this slot healthy right now?".
	const slotOnly = q.get('slot');
	if (slotOnly !== null) {
		if (!SLOTS.includes(slotOnly)) {
			return error(res, 400, 'unknown_slot', `"${slotOnly}" is not a runtime slot. Slots: ${SLOTS.join(', ')}.`);
		}
		const defaultClip = DEFAULT_ANIMATION_MAP[slotOnly] ?? slotOnly;
		const sig = INDEX.clips[defaultClip];
		return json(res, 200, {
			version: INDEX.version,
			fit: { slot: slotOnly, defaultClip, ...(sig ? slotFit(slotOnly, sig) : { level: 'warn', message: `The default clip "${defaultClip}" has no signature.` }) },
			...(sig ? { signature: present(sig) } : {}),
		}, CACHE);
	}

	// ── Listing mode with filters ─────────────────────────────────────────
	const overlay = boolParam(q.get('overlay'));
	const anchored = boolParam(q.get('anchored'));
	const loopClean = q.get('loop') === 'clean' ? true : null;
	const lead = q.get('lead');
	if (lead !== null && !REGIONS.includes(lead)) {
		return error(res, 400, 'unknown_region', `"${lead}" is not a body region. Regions: ${REGIONS.join(', ')}.`);
	}
	const band = q.get('band');
	if (band !== null && !BANDS.includes(band)) {
		return error(res, 400, 'unknown_band', `"${band}" is not an energy band. Bands: ${BANDS.join(', ')}.`);
	}

	let rows = Object.values(INDEX.clips);
	if (overlay !== null) rows = rows.filter((s) => s.overlay === overlay);
	if (anchored !== null) rows = rows.filter((s) => s.anchored === anchored);
	if (loopClean !== null) rows = rows.filter((s) => s.loopClean === true);
	if (lead !== null) rows = rows.filter((s) => s.lead === lead);
	if (band !== null) rows = rows.filter((s) => energyBand(s) === band);

	const sortKey = q.get('sort');
	if (sortKey !== null && !SORT_KEYS.includes(sortKey)) {
		return error(res, 400, 'unknown_sort', `"${sortKey}" is not sortable. Sort keys: ${SORT_KEYS.join(', ')}.`);
	}
	if (sortKey) {
		const dir = q.get('order') === 'asc' ? 1 : -1;
		rows = rows.slice().sort((a, b) => dir * ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)));
	} else {
		rows = rows.slice().sort((a, b) => a.clip.localeCompare(b.clip));
	}

	const total = rows.length;
	const limitRaw = Number.parseInt(q.get('limit') ?? '200', 10);
	const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 200;
	const offsetRaw = Number.parseInt(q.get('offset') ?? '0', 10);
	const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

	return json(res, 200, {
		version: INDEX.version,
		count: INDEX.count,
		total,
		offset,
		clips: rows.slice(offset, offset + limit).map(present),
	}, CACHE);
});
