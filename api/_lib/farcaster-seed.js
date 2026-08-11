// Pure transforms for consent-gated Farcaster memory seeding.
//
// Everything here is deterministic and network-free so the seeding pipeline can
// be tested without a hub, an indexer, or a database:
//   * the consent message a user signs with their wallet (build + parse),
//   * normalisation of the two upstream shapes (hub protobuf-JSON, Neynar),
//   * selection of which casts are worth remembering,
//   * the memory rows written to agent_memories.
//
// The network lane lives in ./farcaster-client.js; the HTTP surface lives in
// api/agents/_id/memory-seed-farcaster.js.

// Farcaster message timestamps are seconds since 2021-01-01T00:00:00Z.
export const FARCASTER_EPOCH_MS = 1_609_459_200_000;

// Read-only, least privilege: we never ask for a Farcaster signer, never write
// a cast, and never touch anything that is not already public on the protocol.
export const CONSENT_SCOPE = 'farcaster:profile.read farcaster:casts.read';

export const CONSENT_TTL_MS = 10 * 60 * 1000;

export const MEMORY_SOURCE = 'farcaster_seed';

export const PROOF_CHAINS = ['solana', 'ethereum'];

const CONSENT_HEADER = 'three.ws memory seeding consent';

const CONSENT_BODY =
	'I authorize three.ws to read my public Farcaster profile and casts and store them as ' +
	'memory for the agent below. Revoking this grant deletes every memory seeded from it.';

// ── Consent message ─────────────────────────────────────────────────────────

/**
 * Build the exact text the user signs in their wallet. Deterministic: the
 * server rebuilds it from the challenge it stored and compares byte for byte,
 * so a tampered field (different agent, different fid) never verifies.
 */
export function buildConsentMessage({
	domain,
	agentId,
	fid,
	fname,
	address,
	chain,
	nonce,
	issuedAt,
	expiresAt,
	castLimit,
}) {
	if (!domain) throw new Error('domain required');
	if (!agentId) throw new Error('agentId required');
	if (!Number.isInteger(fid) || fid <= 0) throw new Error('fid required');
	if (!address) throw new Error('address required');
	if (!PROOF_CHAINS.includes(chain)) throw new Error(`unsupported chain: ${chain}`);
	if (!nonce) throw new Error('nonce required');

	return [
		`${domain} ${CONSENT_HEADER}`,
		'',
		CONSENT_BODY,
		'',
		`Agent: ${agentId}`,
		`Farcaster FID: ${fid}`,
		`Farcaster Name: ${fname || '(none)'}`,
		`Wallet: ${address}`,
		`Chain: ${chain}`,
		`Scope: ${CONSENT_SCOPE}`,
		`Casts: up to ${castLimit}`,
		`Nonce: ${nonce}`,
		`Issued At: ${issuedAt}`,
		`Expiration Time: ${expiresAt}`,
	].join('\n');
}

/** Parse a consent message back into fields. Returns null when malformed. */
export function parseConsentMessage(message) {
	if (typeof message !== 'string') return null;
	const lines = message.split('\n');
	const header = new RegExp(`^(\\S+) ${CONSENT_HEADER}$`).exec(lines[0] || '');
	if (!header) return null;

	const out = { domain: header[1] };
	const keys = {
		Agent: 'agentId',
		'Farcaster FID': 'fid',
		'Farcaster Name': 'fname',
		Wallet: 'address',
		Chain: 'chain',
		Scope: 'scope',
		Casts: 'castLimit',
		Nonce: 'nonce',
		'Issued At': 'issuedAt',
		'Expiration Time': 'expiresAt',
	};
	for (const line of lines.slice(1)) {
		const kv = /^([A-Za-z ]+):\s*(.*)$/.exec(line);
		if (!kv) continue;
		const field = keys[kv[1].trim()];
		if (field) out[field] = kv[2].trim();
	}

	if (!out.agentId || !out.fid || !out.address || !out.nonce) return null;
	out.fid = Number(out.fid);
	if (!Number.isInteger(out.fid) || out.fid <= 0) return null;
	if (out.fname === '(none)') out.fname = null;
	const castLimit = /(\d+)/.exec(out.castLimit || '');
	out.castLimit = castLimit ? Number(castLimit[1]) : null;
	return out;
}

// ── Address matching ────────────────────────────────────────────────────────

/**
 * Solana addresses are base58 and case significant; EVM addresses are hex and
 * are compared case-insensitively so a checksummed wallet still matches the
 * lowercase form the protocol stores.
 */
export function normalizeAddress(address, chain) {
	const raw = String(address ?? '').trim();
	if (!raw) return '';
	return chain === 'ethereum' ? raw.toLowerCase() : raw;
}

export function addressMatches(candidate, verified, chain) {
	const needle = normalizeAddress(candidate, chain);
	if (!needle) return false;
	return (verified || []).some((v) => normalizeAddress(v, chain) === needle);
}

// ── Upstream normalisation: hub protobuf-JSON ───────────────────────────────

const USER_DATA_FIELDS = {
	USER_DATA_TYPE_PFP: 'pfpUrl',
	USER_DATA_TYPE_DISPLAY: 'displayName',
	USER_DATA_TYPE_BIO: 'bio',
	USER_DATA_TYPE_URL: 'url',
	USER_DATA_TYPE_USERNAME: 'fname',
};

/** Fold a hub `/v1/userDataByFid` message list into a flat profile. */
export function normalizeHubUserData(messages) {
	const profile = { fname: null, displayName: null, bio: null, pfpUrl: null, url: null };
	for (const msg of messages || []) {
		const body = msg?.data?.userDataBody;
		const field = USER_DATA_FIELDS[body?.type];
		if (field && typeof body.value === 'string' && body.value) profile[field] = body.value;
	}
	return profile;
}

/**
 * Fold a hub `/v1/verificationsByFid` message list into the addresses the fid
 * has publicly proved control of, split by protocol. These are the only
 * wallets allowed to grant consent for this fid.
 */
export function normalizeVerifications(messages) {
	const out = { solana: [], ethereum: [] };
	for (const msg of messages || []) {
		const body = msg?.data?.verificationAddAddressBody;
		const address = body?.address;
		if (!address) continue;
		const chain = body.protocol === 'PROTOCOL_SOLANA' ? 'solana' : 'ethereum';
		const normalized = normalizeAddress(address, chain);
		if (normalized && !out[chain].includes(normalized)) out[chain].push(normalized);
	}
	return out;
}

/** Fold a hub `/v1/castsByFid` message list into normalized casts. */
export function normalizeHubCasts(messages) {
	const casts = [];
	for (const msg of messages || []) {
		const data = msg?.data;
		if (data?.type !== 'MESSAGE_TYPE_CAST_ADD') continue;
		const body = data.castAddBody;
		if (!body) continue;
		casts.push({
			hash: msg.hash || null,
			text: typeof body.text === 'string' ? body.text : '',
			timestamp: farcasterTimeToMs(data.timestamp),
			isReply: Boolean(body.parentCastId || body.parentUrl),
			engagement: null,
		});
	}
	return casts;
}

export function farcasterTimeToMs(seconds) {
	const n = Number(seconds);
	if (!Number.isFinite(n)) return null;
	return FARCASTER_EPOCH_MS + n * 1000;
}

// ── Upstream normalisation: Neynar ──────────────────────────────────────────

/** Fold Neynar's indexed cast objects into the same shape as the hub lane. */
export function normalizeNeynarCasts(casts) {
	const out = [];
	for (const cast of casts || []) {
		const likes = cast?.reactions?.likes_count ?? 0;
		const recasts = cast?.reactions?.recasts_count ?? 0;
		const replies = cast?.replies?.count ?? 0;
		const ts = cast?.timestamp ? Date.parse(cast.timestamp) : NaN;
		out.push({
			hash: cast?.hash || null,
			text: typeof cast?.text === 'string' ? cast.text : '',
			timestamp: Number.isFinite(ts) ? ts : null,
			isReply: Boolean(cast?.parent_hash || cast?.parent_url),
			engagement: likes + recasts * 2 + replies * 3,
		});
	}
	return out;
}

export function normalizeNeynarUser(user) {
	if (!user) return null;
	return {
		fid: user.fid ?? null,
		fname: user.username || null,
		displayName: user.display_name || null,
		bio: user.profile?.bio?.text || null,
		pfpUrl: user.pfp_url || null,
		url: null,
		followerCount: user.follower_count ?? null,
		followingCount: user.following_count ?? null,
	};
}

// ── Cast selection ──────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/\S+/g;
const MENTION_RE = /(^|\s)@[\w.-]+/g;

/** Text left once links and mentions are stripped: what actually carries meaning. */
export function substantiveText(text) {
	return String(text ?? '')
		.replace(URL_RE, ' ')
		.replace(MENTION_RE, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Pick the casts worth remembering: drop link-only and near-empty posts,
 * de-duplicate reposted text, then rank by engagement when the lane reports it
 * (Neynar) and by recency when it does not (a hub serves raw messages with no
 * reaction counts).
 */
export function selectSeedCasts(casts, { limit = 40, minChars = 16, includeReplies = false } = {}) {
	const seen = new Set();
	const kept = [];
	for (const cast of casts || []) {
		if (!includeReplies && cast.isReply) continue;
		const body = substantiveText(cast.text);
		if (body.length < minChars) continue;
		const key = body.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push({ ...cast, body });
	}

	const ranked = kept.some((c) => typeof c.engagement === 'number')
		? kept.sort(
				(a, b) => (b.engagement ?? 0) - (a.engagement ?? 0) || (b.timestamp ?? 0) - (a.timestamp ?? 0),
			)
		: kept.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

	return ranked.slice(0, Math.max(0, limit));
}

// ── Memory rows ─────────────────────────────────────────────────────────────

const MAX_CONTENT_CHARS = 10_000;
const DEFAULT_CAST_MEMORIES = 12;

function isoDay(ms) {
	return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/**
 * Turn a verified profile, its selected casts, and any LLM-distilled facts into
 * agent_memories rows. Every row carries the consent id so revocation can
 * delete exactly what this grant wrote and nothing else.
 *
 * The profile and cast rows are derived without an LLM, so a seed still
 * produces real memory when the distillation lane is unavailable.
 */
export function buildSeedMemories({
	fid,
	fname = null,
	profile = {},
	casts = [],
	facts = [],
	consentId,
	castMemoryLimit = DEFAULT_CAST_MEMORIES,
}) {
	if (!Number.isInteger(fid) || fid <= 0) throw new Error('fid required');
	if (!consentId) throw new Error('consentId required');

	const handle = fname || profile.fname || String(fid);
	const base = { source: MEMORY_SOURCE, fid, consent_id: consentId, fname: handle };
	const rows = [];

	const identity = [
		profile.displayName ? `Display name: ${profile.displayName}` : null,
		`Farcaster: @${handle} (FID ${fid})`,
		profile.bio ? `Bio: ${profile.bio}` : null,
		Number.isFinite(profile.followerCount) ? `Followers: ${profile.followerCount}` : null,
	]
		.filter(Boolean)
		.join('. ');

	rows.push({
		type: 'user',
		content: clip(`The user's Farcaster identity. ${identity}`),
		tags: ['farcaster', 'profile'],
		context: { ...base, kind: 'profile' },
		salience: 0.8,
	});

	for (const fact of facts) {
		const content = typeof fact === 'string' ? fact.trim() : '';
		if (!content) continue;
		rows.push({
			type: 'user',
			content: clip(content),
			tags: ['farcaster', 'fact'],
			context: { ...base, kind: 'fact' },
			salience: 0.7,
		});
	}

	const topCasts = casts.slice(0, Math.max(0, castMemoryLimit));
	topCasts.forEach((cast, index) => {
		const body = cast.body || substantiveText(cast.text);
		if (!body) return;
		const day = isoDay(cast.timestamp);
		const dated = day ? ` on ${day}` : '';
		// Rank decay keeps the loudest casts above the tail without ever pushing a
		// raw post into the working core, which is reserved for distilled facts.
		const salience = Math.max(0.4, 0.62 - index * 0.015);
		rows.push({
			type: 'reference',
			content: clip(`The user cast${dated} on Farcaster: "${body}"`),
			tags: ['farcaster', 'cast'],
			context: { ...base, kind: 'cast', cast_hash: cast.hash ?? null, cast_at: cast.timestamp ?? null },
			salience: Number(salience.toFixed(3)),
		});
	});

	return rows;
}

function clip(text) {
	return text.length > MAX_CONTENT_CHARS ? `${text.slice(0, MAX_CONTENT_CHARS - 1)}…` : text;
}

/** Prompt input for the distillation lane: newest-first cast text, bounded. */
export function distillationInput({ profile = {}, casts = [], maxCasts = 50 }) {
	const lines = casts
		.slice(0, maxCasts)
		.map((c) => c.body || substantiveText(c.text))
		.filter(Boolean);
	const header = [
		profile.displayName ? `Display name: ${profile.displayName}` : null,
		profile.fname ? `Handle: @${profile.fname}` : null,
		profile.bio ? `Bio: ${profile.bio}` : null,
		Number.isFinite(profile.followerCount) ? `Followers: ${profile.followerCount}` : null,
	]
		.filter(Boolean)
		.join(', ');
	return { header: header || '(no profile data)', casts: lines };
}

/** Parse the distillation model's reply into a bounded list of fact strings. */
export function parseDistilledFacts(raw, { max = 15 } = {}) {
	if (typeof raw !== 'string') return [];
	const stripped = raw
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```\s*$/i, '')
		.trim();
	let parsed;
	try {
		parsed = JSON.parse(stripped);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	return parsed
		.filter((f) => typeof f === 'string')
		.map((f) => f.trim())
		.filter(Boolean)
		.slice(0, max);
}
