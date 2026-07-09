// IRL World Lines — the SDK twin of /api/irl/world-lines. Agent-placed
// proof-of-presence AR quests: travel to the spot, prove co-location with the
// same fix token every IRL read enforces, finish the interaction, and the
// agent's own wallet signs an independently verifiable, ownable proof — without
// a precise coordinate ever entering the proof.

import { ThreeWsError } from './http.js';
import { presenceFix, fixHeader, prune, normalizeEnum, requireId } from './shared.js';

const CHALLENGE_KINDS = ['tap', 'quiz', 'phrase'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const REWARD_KINDS = ['collectible', 'three_pool'];
// A ~5 km region cell is a precision-5 geohash (browse aggregation unit).
const REGION_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{5}$/;

/**
 * Build the world-lines slice of the IRL client. `request` is the bound HTTP
 * core and `deviceHeader` merges the caller's anonymous device token in.
 */
export function createWorldLinesApi({ request, deviceHeader }) {
	/**
	 * Quests near where you checked in. Wraps `GET /api/irl/world-lines/nearby`
	 * with the presence token in `x-irl-fix`. Discovery is deliberately wider
	 * than the 60 m pin read (default 250 m, max 600 m) so a walker can head
	 * toward a quest; distance comes back coarsened to 10 m.
	 */
	async function nearbyWorldLines(presence, opts = {}) {
		const { lat, lng, token } = presenceFix(presence, 'nearbyWorldLines()');
		const radius = opts.radius;
		if (radius !== undefined && !Number.isFinite(radius)) {
			throw new ThreeWsError('nearbyWorldLines() radius must be a finite number of metres.', { code: 'invalid_input' });
		}
		const res = await request('/api/irl/world-lines/nearby', {
			query: { lat, lng, radius },
			headers: deviceHeader(opts, fixHeader(token, opts.headers)),
			signal: opts.signal,
		});
		return (res?.world_lines || []).map(shapeWorldLine);
	}

	/**
	 * Public, coordinate-free discovery. With no arguments: the region roll-up —
	 * how many active quests per ~5 km region cell. With `{ region }` (a
	 * precision-5 geohash from the roll-up): that region's quest list, optionally
	 * filtered by `{ difficulty }`. Never carries a location beyond the region cell.
	 */
	async function browseWorldLines(opts = {}) {
		const region = opts.region;
		if (region !== undefined && !REGION_RE.test(String(region))) {
			throw new ThreeWsError('browseWorldLines() region must be a precision-5 geohash cell (from the region roll-up).', { code: 'invalid_input' });
		}
		const difficulty = opts.difficulty === undefined ? undefined
			: normalizeEnum(opts.difficulty, DIFFICULTIES, 'difficulty');
		const res = await request('/api/irl/world-lines/browse', {
			query: { region, difficulty },
			signal: opts.signal,
		});
		if (region) {
			return {
				region: res?.region ?? region,
				quests: (res?.quests || []).map((q) => ({
					id: q.id,
					title: q.title,
					rewardKind: q.reward_kind ?? null,
					difficulty: q.difficulty ?? null,
					completionCount: Number(q.completion_count) || 0,
					capacityReached: Boolean(q.capacity_reached),
					raw: q,
				})),
				raw: res,
			};
		}
		return {
			regions: (res?.regions || []).map((r) => ({
				regionCell: r.region_cell,
				quests: Number(r.quests) || 0,
				hard: Number(r.hard) || 0,
				completions: Number(r.completions) || 0,
				raw: r,
			})),
			raw: res,
		};
	}

	/**
	 * One World Line for the AR detail view. Pass your `presence` to prove
	 * co-location — a co-located caller gets the full challenge spec (quiz
	 * answer included, so the interaction can grade locally); a remote caller
	 * gets a redacted spec plus the coarse cell for the "travel here" state.
	 */
	async function getWorldLine(id, opts = {}) {
		requireId(id, 'getWorldLine()');
		let query;
		let headers = deviceHeader(opts);
		if (opts.presence) {
			const { lat, lng, token } = presenceFix(opts.presence, 'getWorldLine()');
			query = { lat, lng };
			headers = deviceHeader(opts, fixHeader(token));
		}
		const res = await request(`/api/irl/world-lines/${encodeURIComponent(id)}`, {
			query,
			headers,
			signal: opts.signal,
		});
		return { worldLine: shapeWorldLine(res?.world_line), colocated: Boolean(res?.colocated), raw: res };
	}

	/**
	 * Place a quest anchored to a pin you own, signed by an agent you own.
	 * Wraps `POST /api/irl/world-lines`. Requires a signed-in identity — pass
	 * `apiKey` to `createIrl()` (bearer sessions are CSRF-exempt); the agent's
	 * custodial wallet signs every proof this quest mints.
	 */
	async function createWorldLine(input, opts = {}) {
		const p = input || {};
		const pinId = requireId(p.pinId, 'createWorldLine() (`pinId` — the anchor pin you own)');
		const title = typeof p.title === 'string' ? p.title.trim() : '';
		if (!title) throw new ThreeWsError('createWorldLine() needs a `title`.', { code: 'invalid_input' });

		const challenge = normalizeChallengeInput(p.challenge);
		const difficulty = normalizeEnum(p.difficulty, DIFFICULTIES, 'difficulty');
		const rewardKind = normalizeEnum(p.rewardKind, REWARD_KINDS, 'rewardKind');

		const res = await request('/api/irl/world-lines', {
			method: 'POST',
			body: prune({
				pinId,
				agentId: p.agentId,
				title,
				prompt: p.prompt,
				challenge,
				rewardKind,
				// The endpoint reads these two in snake_case only.
				reward_ref: p.rewardRef,
				difficulty,
				maxCompletions: p.maxCompletions,
				lifetime_days: p.lifetimeDays,
			}),
			signal: opts.signal,
		});
		return { worldLine: shapeWorldLine(res?.world_line), raw: res };
	}

	/** Your placed quests + a coarse completion heatmap. Wraps `GET /mine` (signed-in). */
	async function myWorldLines(opts = {}) {
		const res = await request('/api/irl/world-lines/mine', {
			signal: opts.signal,
		});
		return {
			worldLines: (res?.world_lines || []).map(shapeWorldLine),
			heatmap: (res?.heatmap || []).map((h) => ({
				worldLineId: h.world_line_id,
				coarseCell: h.coarse_cell,
				completions: Number(h.completions) || 0,
			})),
			raw: res,
		};
	}

	/**
	 * The proofs you've earned, as ownable collectibles. Wraps
	 * `GET /api/irl/world-lines/collectibles` — scoped to your session or your
	 * anonymous device token.
	 */
	async function myCollectibles(opts = {}) {
		const res = await request('/api/irl/world-lines/collectibles', {
			headers: deviceHeader(opts),
			signal: opts.signal,
		});
		return (res?.collectibles || []).map(shapeCollectible);
	}

	/**
	 * Start a completion at the spot: issues a single-use nonce and reveals the
	 * full challenge (you are proven co-located). Wraps `POST /challenge`.
	 * Returns `{ alreadyCompleted: true, proofId }` if you've done this quest.
	 */
	async function challengeWorldLine(input, opts = {}) {
		const p = input || {};
		const worldLineId = requireId(p.worldLineId ?? p.id, 'challengeWorldLine()');
		const { lat, lng, token } = presenceFix(p.presence, 'challengeWorldLine()');
		const res = await request('/api/irl/world-lines/challenge', {
			method: 'POST',
			body: { world_line_id: worldLineId, lat, lng },
			headers: deviceHeader(opts, fixHeader(token)),
			signal: opts.signal,
		});
		if (res?.already_completed) {
			return {
				alreadyCompleted: true,
				proofId: res.proof_id ?? null,
				collectibleMint: res.collectible_mint ?? null,
				raw: res,
			};
		}
		return {
			alreadyCompleted: false,
			nonce: res?.nonce ?? null,
			expiresIn: res?.expires_in ?? null,
			challenge: res?.challenge ?? null,
			agentId: res?.agent_id ?? null,
			worldLine: res?.world_line ?? null,
			raw: res,
		};
	}

	/**
	 * The proof ceremony: finish the interaction at the spot and receive the
	 * agent-signed, independently verifiable proof-of-presence collectible.
	 * Wraps `POST /complete` — co-location is re-proven, the nonce must be the
	 * one `challengeWorldLine()` issued, and quiz/phrase challenges are graded
	 * server-side (`answer` is the quiz choice index, `phrase` the passphrase).
	 */
	async function completeWorldLine(input, opts = {}) {
		const p = input || {};
		const worldLineId = requireId(p.worldLineId ?? p.id, 'completeWorldLine()');
		if (!p.nonce || typeof p.nonce !== 'string') {
			throw new ThreeWsError('completeWorldLine() needs the `nonce` from challengeWorldLine().', { code: 'invalid_input' });
		}
		const { lat, lng, token } = presenceFix(p.presence, 'completeWorldLine()');
		const res = await request('/api/irl/world-lines/complete', {
			method: 'POST',
			body: prune({ world_line_id: worldLineId, nonce: p.nonce, lat, lng, answer: p.answer, phrase: p.phrase }),
			headers: deviceHeader(opts, fixHeader(token)),
			signal: opts.signal,
		});
		return {
			ok: Boolean(res?.ok || res?.already_completed),
			alreadyCompleted: Boolean(res?.already_completed),
			proof: shapeProof(res?.proof),
			collectible: shapeCollectible(res?.collectible),
			raw: res,
		};
	}

	/**
	 * Independently re-verify a proof's agent signature — the same public check
	 * anyone can run. Wraps `GET /api/irl/world-lines/verify/:proofId`.
	 */
	async function verifyProof(proofId, opts = {}) {
		requireId(proofId, 'verifyProof()');
		const res = await request(`/api/irl/world-lines/verify/${encodeURIComponent(proofId)}`, {
			signal: opts.signal,
		});
		return { verified: Boolean(res?.verified), proof: shapeProof(res?.proof), raw: res };
	}

	return {
		nearbyWorldLines, browseWorldLines, getWorldLine, createWorldLine,
		myWorldLines, myCollectibles, challengeWorldLine, completeWorldLine, verifyProof,
	};
}

// Mirror the server's normalizeChallengeSpec preconditions client-side so a
// malformed quest fails fast with a clear message instead of a 400 round-trip.
function normalizeChallengeInput(raw) {
	if (raw === undefined || raw === null) return undefined; // server defaults to 'tap'
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		throw new ThreeWsError('challenge must be an object like { kind: "tap" | "quiz" | "phrase", ... }.', { code: 'invalid_input' });
	}
	const kind = raw.kind === undefined ? 'tap' : normalizeEnum(raw.kind, CHALLENGE_KINDS, 'challenge.kind');
	if (kind === 'quiz') {
		if (!raw.question || typeof raw.question !== 'string') {
			throw new ThreeWsError('a quiz challenge needs a `question`.', { code: 'invalid_input' });
		}
		if (!Array.isArray(raw.choices) || raw.choices.filter(Boolean).length < 2) {
			throw new ThreeWsError('a quiz challenge needs at least two `choices`.', { code: 'invalid_input' });
		}
		if (!Number.isInteger(raw.answer) || raw.answer < 0 || raw.answer >= raw.choices.length) {
			throw new ThreeWsError('a quiz challenge needs `answer` — the index of the correct choice.', { code: 'invalid_input' });
		}
	}
	if (kind === 'phrase' && (!raw.phrase || typeof raw.phrase !== 'string')) {
		throw new ThreeWsError('a phrase challenge needs the `phrase` passphrase.', { code: 'invalid_input' });
	}
	return { ...raw, kind };
}

// ── Response shaping (snake_case → camelCase, with a .raw escape hatch) ──────

function shapeWorldLine(r) {
	if (!r || typeof r !== 'object') return r;
	return {
		id: r.id,
		agentId: r.agent_id ?? null,
		signerPubkey: r.signer_pubkey ?? null,
		pinId: r.pin_id ?? null,
		// ~1.1 km precision-6 cell — the only location a quest ever carries.
		coarseCell: r.coarse_cell ?? null,
		regionCell: r.region_cell ?? null,
		title: r.title,
		prompt: r.prompt ?? null,
		// Redacted unless you are the owner or proven co-located.
		challenge: r.challenge ?? null,
		rewardKind: r.reward_kind ?? null,
		rewardRef: r.reward_ref ?? null,
		difficulty: r.difficulty ?? null,
		maxCompletions: r.max_completions ?? null,
		completionCount: Number(r.completion_count) || 0,
		createdAt: r.created_at ?? null,
		expiresAt: r.expires_at ?? null,
		// Nearby-read extras (absent elsewhere).
		distanceM: r.distance_m ?? null,
		completedByMe: Boolean(r.completed_by_me),
		capacityReached: Boolean(r.capacity_reached),
		// Creator-dashboard extras (absent elsewhere).
		expired: Boolean(r.expired),
		hidden: Boolean(r.hidden),
		raw: r,
	};
}

function shapeProof(p) {
	if (!p || typeof p !== 'object') return p ?? null;
	return {
		id: p.id,
		worldLineId: p.world_line_id ?? null,
		worldLineTitle: p.world_line_title ?? null,
		agentId: p.agent_id ?? null,
		signerPubkey: p.signer_pubkey ?? null,
		coarseCell: p.coarse_cell ?? null,
		signature: p.signature ?? null,
		signedMessage: p.signed_message ?? null,
		signatureScheme: p.signature_scheme ?? 'ed25519',
		collectibleMint: p.collectible_mint ?? null,
		collectibleName: p.collectible_name ?? null,
		completedAt: p.completed_at ?? null,
		verifyUrl: p.verify_url ?? null,
		raw: p,
	};
}

function shapeCollectible(c) {
	if (!c || typeof c !== 'object') return c ?? null;
	return {
		mint: c.mint ?? null,
		name: c.name ?? null,
		kind: c.kind ?? 'proof-of-presence',
		rewardKind: c.reward_kind ?? null,
		signerPubkey: c.signer_pubkey ?? null,
		signature: c.signature ?? null,
		proofId: c.proof_id ?? null,
		worldLineId: c.world_line_id ?? null,
		worldLineTitle: c.world_line_title ?? null,
		difficulty: c.difficulty ?? null,
		coarseCell: c.coarse_cell ?? null,
		earnedAt: c.earned_at ?? null,
		verifyUrl: c.verify_url ?? null,
		raw: c,
	};
}
