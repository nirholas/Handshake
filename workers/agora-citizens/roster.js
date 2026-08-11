// agora-citizens — the roster: profession bitmap + who lives in the world.
//
// Professions are AgenC u64 capability bits (the labor market's type system).
// This map MUST stay in sync with docs/agora.md and the PROFESSIONS array in
// api/agora/[action].js. Open registry — add a bit + a real backing skill, never
// a hardcoded allowlist.
//
// Citizens are seeded from REAL platform agents (agent_identities) where
// possible, so the world is populated by the same agents users built. When too
// few real agents exist to reach the floor, we fill with standalone agent
// citizens (still real on-chain AgenC agents — they register, work, and earn;
// they just aren't linked to a user's agent record). We NEVER invent a human
// citizen here (humans join via wallet-auth in Task 08).

// Profession bit map — keep in lockstep with api/agora/[action].js PROFESSIONS.
export const PROFESSIONS = [
	{ bit: 0, key: 'fetcher', label: 'Fetcher', skill: 'x402 service call' },
	{ bit: 1, key: 'sculptor', label: 'Sculptor', skill: 'text/image → rigged GLB (forge)' },
	{ bit: 2, key: 'scribe', label: 'Scribe', skill: 'research / write (brain)' },
	{ bit: 3, key: 'cartographer', label: 'Cartographer', skill: '3D scene / diorama' },
	{ bit: 4, key: 'crier', label: 'Crier', skill: 'TTS / voice / audio2face' },
	{ bit: 5, key: 'appraiser', label: 'Appraiser', skill: 'token / market intel' },
	{ bit: 6, key: 'verifier', label: 'Verifier', skill: 're-derive proofHash + attest' },
	{ bit: 7, key: 'namekeeper', label: 'Namekeeper', skill: '.sol / ENS resolve' },
];

const PROF_BY_KEY = new Map(PROFESSIONS.map((p) => [p.key, p]));

/** OR the bits for a set of profession keys into a u64 BigInt. */
export function professionBits(keys) {
	let bits = 0n;
	for (const k of keys) {
		const p = PROF_BY_KEY.get(k);
		if (p) bits |= 1n << BigInt(p.bit);
	}
	return bits;
}

/** The primary (lowest-bit) profession key for a capability bitmap. */
export function primaryProfession(bits) {
	const b = typeof bits === 'bigint' ? bits : BigInt(bits || 0);
	for (const p of PROFESSIONS) {
		if ((b & (1n << BigInt(p.bit))) !== 0n) return p.key;
	}
	return null;
}

/** Does `caps` satisfy a task's `required` capability bitmap (required ⊆ caps)? */
export function capabilitiesSatisfy(caps, required) {
	const c = typeof caps === 'bigint' ? caps : BigInt(caps || 0);
	const r = typeof required === 'bigint' ? required : BigInt(required || 0);
	return (r & ~c) === 0n;
}

export function slug(s) {
	return String(s || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
}

// Named home districts in the City. Citizens spawn and idle around their home;
// world coords (x, z) on the City substrate. Spread so the world reads legibly.
const DISTRICTS = [
	{ name: 'The Commons', x: 0, z: 0 },
	{ name: 'Bazaar Row', x: 18, z: -6 },
	{ name: 'Forge Quarter', x: -16, z: 10 },
	{ name: 'Scriptorium', x: 8, z: 20 },
	{ name: 'Wharf', x: -22, z: -14 },
	{ name: 'Beacon Hill', x: 24, z: 16 },
];

function districtFor(i) {
	return DISTRICTS[i % DISTRICTS.length];
}

// Standalone citizens — the founding workforce. Task 04 expands the roster from
// one profession to the full craft: each citizen works a SPECIALTY (its primary
// profession, first in the list — Sculptor forges GLBs, Scribe writes, etc.) and
// also carries the Fetcher bit, so it satisfies the devnet dispatcher's task gate
// and never idles for lack of work. A few also carry the Verifier bit for the
// trust loop (Verifier is only ever a SECONDARY bit — it needs a verification
// bounty's target, so it never runs as a citizen's default WORK). Each becomes a
// real AgenC agent on devnet; names are evocative, not branded; no coin
// references. Bits are additive — see roster PROFESSIONS.
//
// Only professions with a reachable backing skill get a standalone specialist
// (work/index.js WORK_RUNNERS is the active set). Cartographer (bit 3) is
// deferred — its /api/diorama compose route exceeds the serverless function
// budget — so no Cartographer citizen is seeded here (omitted, not stubbed).
const STANDALONE = [
	{ key: 'aria-sculpt', displayName: 'Aria', professions: ['sculptor', 'fetcher', 'verifier'] },
	{ key: 'sol-scribe', displayName: 'Sol', professions: ['scribe', 'fetcher'] },
	{ key: 'echo-crier', displayName: 'Echo', professions: ['crier', 'fetcher'] },
	{ key: 'mira-appraise', displayName: 'Mira', professions: ['appraiser', 'fetcher'] },
	{ key: 'nyx-name', displayName: 'Nyx', professions: ['namekeeper', 'fetcher'] },
	{ key: 'koa-fetch', displayName: 'Koa', professions: ['fetcher', 'verifier'] },
	{ key: 'wren-fetch', displayName: 'Wren', professions: ['fetcher', 'verifier'] },
];

function shapeStandalone(def, i) {
	const home = districtFor(i);
	return {
		key: def.key,
		kind: 'agent',
		displayName: def.displayName,
		profession: def.professions[0],
		professionBits: professionBits(def.professions),
		home,
		agentDbId: null,
		avatarUrl: null,
		// Standalone citizens derive their canonical AgenC id from a stable handle.
		identityRef: { handle: `agora-${def.key}` },
		identityHint: `standalone:${def.key}`,
	};
}

// Shape a real platform agent (agent_identities row) into a citizen spec. Its
// canonical AgenC id is derived from whatever identity proofs it carries
// (composite > erc8004 > mpl-core > handle) via the identity bridge.
function shapeSeeded(agent, i) {
	const home = districtFor(i);
	const handle = slug(agent.name) || `agent-${String(agent.id).slice(0, 8)}`;
	const ref = { handle };
	if (agent.erc8004_agent_id != null) ref.erc8004AgentId = String(agent.erc8004_agent_id);
	const mpl = agent.meta?.onchain?.solana?.asset || agent.meta?.onchain?.mplCoreAsset || agent.meta?.mplCoreAsset;
	if (mpl) ref.mplCoreAsset = String(mpl);
	return {
		key: `agent-${slug(agent.name) || String(agent.id).slice(0, 8)}`,
		kind: 'agent',
		displayName: agent.name,
		profession: 'fetcher',
		// A platform agent primaries Fetcher because its real skills are not mapped
		// to capability bits yet, and Fetcher is the one craft every citizen can do
		// against any board task. The specialist crafts live in STANDALONE_CITIZENS
		// below, which is why they are seated first.
		professionBits: professionBits(['fetcher']),
		home,
		agentDbId: agent.id,
		avatarUrl: agent.avatar_url || agent.profile_image_url || null,
		identityRef: ref,
		identityHint: `agent:${agent.id}`,
	};
}

/**
 * Assemble the fleet: prefer real platform agents, fill to the floor with
 * standalone citizens, cap at maxCitizens. `seededAgents` is the rows returned
 * by store.listSeedAgents() (may be empty). Returns citizen specs the engine
 * registers + runs.
 */
export function buildRoster(seededAgents, cfg) {
	const specs = [];
	const seen = new Set();

	// An isolated fleet (cfg.standaloneOnly) skips the platform-agent seed entirely
	// and runs only the standalone founding workforce. Two engines pointed at the
	// same DB otherwise select the SAME first-N platform agents and would drive one
	// set of keypairs concurrently: double claims and contradictory on-chain state.
	// This is also the deterministic fleet for a local devnet run or a CI smoke.
	const seeds = cfg.standaloneOnly ? [] : seededAgents || [];

	// Standalone specialists are seated FIRST, and the reason is the whole point of
	// the profession roster: every shapeSeeded() platform agent primaries `fetcher`
	// (its real skills are not yet mapped to capability bits), while the crafts
	// (Sculptor, Scribe, Crier, Appraiser, Namekeeper) exist ONLY here. Filling from
	// the platform-agent pool first, as this did, silently rebuilt the Fetcher-only
	// workforce: maxCitizens defaults to 4 and any populated DB returns far more
	// than 4 agents, so the specialists were always cut and no citizen ever sculpted
	// or wrote anything. Seating the crafts first guarantees the labour market
	// actually has labour in it at every cap; platform agents take every remaining
	// slot, which is most of them once the cap is raised past the seven specialists.
	for (let i = 0; specs.length < cfg.maxCitizens && i < STANDALONE.length; i++) {
		const spec = shapeStandalone(STANDALONE[i], specs.length);
		if (seen.has(spec.key)) continue;
		seen.add(spec.key);
		specs.push(spec);
	}

	// Real platform agents fill the rest of the fleet, so the world is populated by
	// the platform's own agents rather than only the founding workforce.
	for (let i = 0; i < seeds.length && specs.length < cfg.maxCitizens; i++) {
		const spec = shapeSeeded(seeds[i], specs.length);
		if (seen.has(spec.key)) continue;
		seen.add(spec.key);
		specs.push(spec);
	}

	return specs.slice(0, cfg.maxCitizens);
}


// ── World-seed: real rigged agents become citizens ───────────────────────────
// The Commons fills from the platform's own 3D agents that carry a rigged
// humanoid GLB (store.listRiggedSeedAgents). Each becomes a citizen with its REAL
// avatar and a profession mapped from its real signals. Presence needs no on-chain
// PDA (agenc_agent_pda stays null until the funded life-engine registers it), so
// the world can be alive immediately without spending SOL.

// Deterministic 32-bit FNV-1a over a string, stable across runs/processes so an
// agent's default profession never flips between seeds.
function hashStr(str) {
	let h = 0x811c9dc5;
	const s = String(str || '');
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

// Craft professions (everything but the universal Fetcher): the palette a
// signal-less agent is spread across so the Commons reads as a varied labour
// market. Every craft is backed by a real platform skill (work/*.js), so the
// assignment is a JOB, never a fabricated capability.
const CRAFTS = ['sculptor', 'scribe', 'crier', 'appraiser', 'namekeeper', 'verifier'];

// Real-signal to profession, checked before the deterministic spread so an agent
// that actually carries a signal works the matching craft.
const SIGNAL_PROFESSION = [
	[/voice|audio|music|speech|sing|podcast|narrat|entertain/i, 'crier'],
	[/design|3d|model|sculpt|render|\bart\b|avatar|blender|mesh/i, 'sculptor'],
	// Scene/world signals route to Sculptor, the nearest craft that actually
	// ships. Cartographer (bit 3) is deferred and has no runner, so labelling a
	// citizen with it would seat a worker that fails every job it is handed.
	[/scene|\bmap\b|world|diorama|architect|spatial|environment/i, 'sculptor'],
	[/market|token|trad|finance|invest|intel|analy|\bdao\b|governance|defi|price/i, 'appraiser'],
	[/name|\bens\b|domain|registr|resolver/i, 'namekeeper'],
	[/verif|audit|proof|security|moderat|fact.?check/i, 'verifier'],
	[/research|writ|summar|translat|academic|scribe|author|essay|\bdoc/i, 'scribe'],
];

/**
 * Map a real agent to the Agora profession it works. Grounded in the agent's own
 * signals (category/tags/name to a matching craft); a signal-less agent is spread
 * deterministically across every profession by a stable hash of its id, so the
 * world is colourful and balanced without inventing anything.
 */
export function professionForAgent(agent) {
	// NB: voice is a platform default on every agent, so it is NOT a signal — a
	// citizen only works Crier when its category/tags/name actually say audio/voice.
	const hay = [agent.category, ...(Array.isArray(agent.tags) ? agent.tags : []), agent.name]
		.filter(Boolean)
		.join(' ');
	for (const [re, prof] of SIGNAL_PROFESSION) if (re.test(hay)) return prof;
	// Signal-less: even deterministic spread across the ACTIVE professions (the
	// shipped crafts plus the universal Fetcher) so the Commons reads as a balanced
	// labour market. Spreading across the full PROFESSIONS bitmap instead would
	// hand some agents a deferred craft with no runner: a citizen that can only
	// ever fail. Deferred bits stay documented in PROFESSIONS; they are just never
	// assigned as somebody's job.
	const all = [...CRAFTS, 'fetcher'];
	return all[hashStr(agent.id) % all.length];
}

// Fan citizens out around their home district (golden-angle scatter on growing
// rings) so a full Commons reads as a crowd, not six stacks of avatars.
function scatteredHome(i) {
	const d = DISTRICTS[i % DISTRICTS.length];
	const ring = Math.floor(i / DISTRICTS.length);
	const ang = (i * 2.399963) % (Math.PI * 2);
	const r = 2 + ring * 1.7;
	const round = (n) => Math.round(n * 100) / 100;
	return { name: d.name, x: round(d.x + Math.cos(ang) * r), z: round(d.z + Math.sin(ang) * r) };
}

/**
 * Shape a real rigged agent (a row from store.listRiggedSeedAgents) into a world-
 * seed citizen spec. Its canonical AgenC id is derived from a per-agent handle
 * (name + short id, so same-named agents stay distinct on-chain); avatarUrl is the
 * avatar UUID the client resolves to the real GLB via /api/avatars/:id. Profession
 * is its mapped craft PLUS the universal Fetcher bit (so it can always take work).
 */
export function shapeRiggedSeed(agent, i) {
	const home = scatteredHome(i);
	const base = slug(agent.name) || `agent-${String(agent.id).slice(0, 8)}`;
	const handle = `${base}-${String(agent.id).replace(/-/g, '').slice(0, 6)}`;
	const ref = { handle };
	if (agent.erc8004_agent_id != null) ref.erc8004AgentId = String(agent.erc8004_agent_id);
	const prof = professionForAgent(agent);
	const avatarId = agent.avatar_id ? String(agent.avatar_id) : null;
	return {
		key: `agent-${handle}`,
		kind: 'agent',
		displayName: agent.name,
		profession: prof,
		professionBits: professionBits([prof, 'fetcher']),
		home,
		agentDbId: agent.id,
		avatarId,
		avatarUrl: avatarId,
		identityRef: ref,
		identityHint: `rigged:${agent.id}`,
	};
}

/** Shape a page of rigged agents into world-seed citizen specs (de-duped by key). */
export function buildWorldSeedRoster(agents, cfg) {
	const specs = [];
	const seen = new Set();
	const cap = cfg && cfg.seedLimit ? cfg.seedLimit : Infinity;
	for (let i = 0; i < (agents || []).length && specs.length < cap; i++) {
		const spec = shapeRiggedSeed(agents[i], specs.length);
		if (!spec.agentDbId || seen.has(spec.key)) continue;
		seen.add(spec.key);
		specs.push(spec);
	}
	return specs;
}
