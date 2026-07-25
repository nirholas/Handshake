// @ts-check
// GET /api/cron/avaturn-seed-cron — per-minute cron that grows the public
// gallery with randomized, fully-rigged **Avaturn** avatars.
//
// Unlike the forge seeder (text→image→mesh, returns a GLB inline from a server
// API), Avaturn has no headless export endpoint — the GLB only comes out of the
// editor via the SDK's postMessage protocol. So each tick:
//
//   1. Claims an OG single-word username for a fresh synthetic account.
//   2. Boots headless chromium against Avaturn's public demo editor (no API
//      key, same iframe the demo uses) and lets the SDK randomize a body +
//      assets + colors from the public catalog.
//   3. Exports a rigged GLB, stores it in R2, and inserts a public avatar row
//      (source=avaturn).
//
// One avatar per tick — the headless export runs to completion inside the
// invocation (no poll table needed). A Redis blocking slot stops a slow export
// on one instance from overlapping the next minute's tick. A circuit breaker
// goes quiet during Avaturn outages so the cron doesn't burn quota into a dead
// lane. Gated behind AVATURN_SEED_ENABLED so it's a no-op until an operator
// opts in (cadence is set by the cron schedule in vercel.json — start at 1/min).

import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { sql } from '../_lib/db.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { OG_USERNAMES } from '../_lib/seed-prompts.js';
import {
	circuitState,
	circuitRecordFailure,
	circuitRecordSuccess,
	acquireBlockingSlot,
} from '../_lib/forge-scale.js';
import { putObject } from '../_lib/r2.js';
import { inspectGlb } from '../_lib/glb-inspect.js';
import { fetchModel } from '../_lib/fetch-model.js';
import { isFlagEnabled } from '../_lib/flags.js';
import { pickDiversityProfile, describeProfile } from '../_lib/avaturn-seed.js';
import { pickBaseBody, pickColorway, pickScale, recolorGlb } from '../_lib/studio-avatar.js';
import { composeStudioAvatar } from '../_lib/avatar-composer/index.js';
import { randomUUID } from 'node:crypto';

const CIRCUIT_NAME = 'avaturn-seed';
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_BASE_MS = 10 * 60_000; // 10 min × consecutive failures
// One recolor at a time across all instances (fast, but keeps the tick serial).
const SLOT_TTL_MS = 280_000;

// Origin the rigged base bodies are served from (/avatars/*.glb).
const ORIGIN = () => env.APP_ORIGIN || 'https://three.ws';

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) {
		res.status(503).json({ error: 'not_configured', message: 'CRON_SECRET unset' });
		return false;
	}
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) {
		res.status(401).json({ error: 'unauthorized' });
		return false;
	}
	return true;
}

// Try to claim `word` as a username, skipping to the next free numbered slot.
// Returns the claimed username or null. (Mirrors the forge seeder's helper.)
async function claimUsername(word) {
	const existing = await sql`
		select username from users where username = ${word} or username like ${word + '%'} limit 100
	`;
	const taken = new Set(existing.map((r) => r.username));
	if (!taken.has(word)) return word;
	for (let n = 2; n <= 99; n++) {
		const candidate = `${word}${n}`;
		if (!taken.has(candidate)) return candidate;
	}
	return `${word}_${randomUUID().slice(0, 4)}`;
}

function toSlug(name) {
	const base = String(name)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
	return `${base || 'avatar'}-${randomUUID().slice(0, 6)}`;
}

async function runOnce() {
	const circuit = await circuitState(CIRCUIT_NAME);
	if (circuit.open) {
		const minsLeft = Math.ceil((circuit.openUntil - Date.now()) / 60_000);
		return {
			skipped: true,
			reason: `circuit open for ${minsLeft}m more (${circuit.failures} failures)`,
		};
	}

	const baseWord = OG_USERNAMES[Math.floor(Math.random() * OG_USERNAMES.length)];
	const username = await claimUsername(baseWord);
	if (!username)
		return { skipped: true, reason: 'could not claim OG username — retry next tick' };

	// Drop claimUsername's collision suffixes before titling: the `_xxxx` uuid
	// fallback first, then a numbered slot. Stripping digits alone turned
	// "fog_1a2b" into the literal display name "Fog_".
	const displayName = username
		.replace(/_[0-9a-f]{4}$/, '')
		.replace(/\d+$/, '')
		.replace(/\b\w/g, (c) => c.toUpperCase());
	const email = `${username}@avaturn.three.ws`;

	const [user] = await sql`
		insert into users (email, display_name, username, plan, email_verified, service_account, created_at, updated_at)
		values (${email}, ${displayName}, ${username}, 'free', false, true, now(), now())
		on conflict do nothing
		returning id
	`;
	if (!user?.id) return { skipped: true, reason: 'user insert conflict — retry next tick' };

	const seed = randomUUID();
	// Draw a person from the diversity matrix, then COMPOSE a rigged avatar for
	// them: mix hair / top / bottom / footwear / glasses across the compatible
	// RPM base bodies onto one shared skeleton, recolor each part, and scale for
	// height. This is the modular Avatar Composer (api/_lib/avatar-composer) — the
	// same one-skeleton-many-parts architecture Ready Player Me and Avaturn use —
	// so two draws almost never land on the same body. Free, self-owned, no
	// external service. If composition fails for any reason, fall back to the
	// legacy single-base recolor so the tick still ships a valid rigged avatar.
	const profile = pickDiversityProfile(seed);

	try {
		let glbBytes;
		let sourceMeta;
		try {
			// Fetch only the bases this recipe needs (identity + compatible donors),
			// cached within the tick so a donor shared by two slots is fetched once.
			const cache = new Map();
			const loadBase = async (id) => {
				if (cache.has(id)) return cache.get(id);
				const { bytes } = await fetchModel(`${ORIGIN()}/avatars/${id}.glb`, { maxBytes: 40 * 1024 * 1024 });
				const u8 = new Uint8Array(bytes);
				cache.set(id, u8);
				return u8;
			};
			const composed = await composeStudioAvatar({ profile, seed, loadBase });
			glbBytes = Buffer.from(composed.bytes);
			const rigInfo = inspectGlb(glbBytes);
			sourceMeta = {
				seed: true,
				studio: true,
				composed: true,
				rig: 'wolf3d',
				base_body: composed.descriptor.identity,
				parts: composed.descriptor.parts,
				glasses: composed.descriptor.glasses,
				body_type: profile.gender,
				is_rigged: rigInfo ? rigInfo.isRigged : true,
				skeleton_joint_count: rigInfo?.skeletonJointCount ?? null,
				skin_count: rigInfo?.skinCount ?? null,
				recolored: composed.recolored,
				scale: composed.descriptor.scale,
				profile: {
					gender: profile.gender,
					age: profile.ageKey,
					ethnicity: profile.ethnicityKey,
					build: profile.build,
				},
			};
		} catch (composeErr) {
			// Legacy path: recolor one whole base body. Same rigged, walk-ready
			// output, just without cross-base part variety.
			console.warn('[avaturn-seed] compose failed, recolor fallback', composeErr?.message);
			const base = pickBaseBody(profile, seed);
			const { bytes } = await fetchModel(`${ORIGIN()}/avatars/${base.file}`, { maxBytes: 40 * 1024 * 1024 });
			const colorway = pickColorway(profile, seed);
			const scale = pickScale(profile, seed);
			const { buffer, recolored } = recolorGlb(Buffer.from(bytes), colorway, scale);
			glbBytes = buffer;
			const rigInfo = inspectGlb(glbBytes);
			sourceMeta = {
				seed: true,
				studio: true,
				composed: false,
				recolor_fallback: true,
				rig: 'wolf3d',
				base_body: base.id,
				body_type: profile.gender,
				is_rigged: rigInfo ? rigInfo.isRigged : true,
				skeleton_joint_count: rigInfo?.skeletonJointCount ?? null,
				skin_count: rigInfo?.skinCount ?? null,
				recolored,
				scale,
				profile: {
					gender: profile.gender,
					age: profile.ageKey,
					ethnicity: profile.ethnicityKey,
					build: profile.build,
				},
			};
		}

		const slug = toSlug(displayName);
		const storageKey = `u/${user.id}/${slug}.glb`;
		await putObject({
			key: storageKey,
			body: glbBytes,
			contentType: 'model/gltf-binary',
			metadata: { source: 'studio-seed' },
		});

		const description = `Rigged, walk-ready avatar — ${describeProfile(profile)} — forged on three.ws`;
		const tags = ['avatar', 'studio', 'human', profile.gender];

		await sql`
			insert into avatars
				(owner_id, slug, name, description, storage_key, size_bytes,
				 content_type, source, source_meta, visibility, tags,
				 model_category, created_at, updated_at)
			values (
				${user.id}, ${slug}, ${displayName},
				${description},
				${storageKey}, ${glbBytes.length}, 'model/gltf-binary',
				'studio',
				${JSON.stringify(sourceMeta)}::jsonb,
				'public',
				${tags}::text[],
				'avatar', now(), now()
			)
			on conflict do nothing
		`;

		await circuitRecordSuccess(CIRCUIT_NAME);
		return {
			ok: true,
			username,
			user_id: user.id,
			slug,
			size_bytes: glbBytes.length,
			body_type: profile.gender,
			base_body: sourceMeta.base_body,
			composed: sourceMeta.composed,
			parts: sourceMeta.parts,
		};
	} catch (err) {
		await circuitRecordFailure(CIRCUIT_NAME, {
			threshold: CIRCUIT_THRESHOLD,
			baseMs: CIRCUIT_BASE_MS,
		});
		// Roll back the synthetic account so the next tick starts clean.
		await sql`delete from users where id = ${user.id}`.catch(() => {});
		return { ok: false, reason: `${err?.code || 'error'}: ${err?.message || err}` };
	}
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	// DB flag is the live control (flip it from the admin console with no
	// redeploy); the AVATURN_SEED_ENABLED env var is the fallback default used
	// only when no app_flags row exists yet, preserving the prior behavior.
	const enabled = await isFlagEnabled('avaturn_seed', { fallback: env.AVATURN_SEED_ENABLED });
	if (!enabled) {
		return json(res, 200, {
			ok: true,
			skipped: 'disabled',
			hint: 'enable instantly via POST /api/admin/flags { "key":"avaturn_seed","enabled":true } (or set AVATURN_SEED_ENABLED=1)',
		});
	}

	// Single headless export in flight at a time, fleet-wide.
	const slot = await acquireBlockingSlot(CIRCUIT_NAME, { max: 1, ttlMs: SLOT_TTL_MS });
	if (!slot.ok) {
		return json(res, 200, {
			ok: true,
			skipped: 'in_flight',
			reason: 'a prior export is still running',
		});
	}
	try {
		const result = await runOnce();
		return json(res, 200, { ok: true, result });
	} finally {
		await slot.release();
	}
});
