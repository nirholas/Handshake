/**
 * /symphony score logic: the deterministic grammar that turns live platform
 * events (api/_lib/feed.js shapes) into musical note specs.
 *
 * Pure functions only: no DOM, no WebAudio, no Date.now(). The audio engine
 * (src/symphony.js) renders these specs into sound; keeping the mapping pure
 * makes the whole musical grammar unit-testable (tests/symphony-score.test.js).
 *
 * The core ideas:
 *  - Everything lands on one minor-pentatonic scale, so an arbitrary stream of
 *    unrelated events always harmonizes instead of producing noise.
 *  - Bigger money sits lower: whale-sized events play as bass, dust as sparkle.
 *  - Each actor hashes to a stable motif, so a returning agent is recognizable
 *    by ear across sessions.
 */

// A minor pentatonic (A, C, D, E, G) in semitone offsets from the root.
export const SCALE = [0, 3, 5, 7, 10];
export const ROOT_HZ = 110; // A2
export const OCTAVES = 4;

// Voice categories. Each has its own synth patch in the engine and its own
// color in the visualization + legend.
export const CATEGORIES = ['money', 'bass', 'bell', 'arp', 'alarm', 'jackpot'];

// Feed event type (api/_lib/feed.js ALLOWED_TYPES) to voice category.
const TYPE_TO_CATEGORY = {
	'payment': 'money',
	'agora-earned': 'money',
	'coin-buy': 'bass',
	'agent-deploy': 'bell',
	'agent-onchain': 'bell',
	'member-join': 'bell',
	'agora-registered': 'bell',
	'level-up': 'arp',
	'world-join': 'arp',
	'mission-complete': 'arp',
	'agora-task-posted': 'arp',
	'agora-hired': 'arp',
	'agora-task-claimed': 'arp',
	'agora-task-completed': 'arp',
	'agora-vouched': 'arp',
	'agent-guard': 'alarm',
	'agora-flagged': 'alarm',
	'jackpot': 'jackpot',
};

export function categoryOf(type) {
	return TYPE_TO_CATEGORY[type] || 'bell';
}

// FNV-1a 32-bit. Stable across sessions and platforms so the same actor keeps
// the same motif and stereo position forever.
export function hashString(str) {
	let h = 0x811c9dc5;
	const s = String(str == null ? '' : str);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

// Scale degree (0 .. SCALE.length * OCTAVES - 1) to frequency in Hz.
export function degreeToHz(degree) {
	const per = SCALE.length;
	const total = per * OCTAVES;
	const d = Math.min(Math.max(Math.round(Number(degree) || 0), 0), total - 1);
	const octave = Math.floor(d / per);
	const semitones = SCALE[d % per];
	return ROOT_HZ * Math.pow(2, octave + semitones / 12);
}

// Pull a displayable amount out of any feed event, tolerating every producer's
// field naming. Returns { value, unit } or null when the event carries none.
export function amountOf(evt) {
	if (!evt || typeof evt !== 'object') return null;
	const num = (v) => {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	};
	const usdc = num(evt.usdcAtomic);
	if (usdc != null) return { value: usdc / 1e6, unit: 'USDC' };
	const sol = num(evt.sol);
	if (sol != null) return { value: sol, unit: 'SOL' };
	const reward = num(evt.reward);
	if (reward != null) return { value: reward, unit: 'SOL' };
	const gold = num(evt.gold);
	if (gold != null) return { value: gold, unit: 'GOLD' };
	const label = typeof evt.rewardLabel === 'string' ? evt.rewardLabel
		: typeof evt.reward === 'string' ? evt.reward : null;
	if (label) {
		const m = label.match(/([\d,]*\.?\d+)\s*([A-Za-z$]+)?/);
		if (m) {
			const v = num(m[1].replace(/,/g, ''));
			if (v != null) return { value: v, unit: m[2] ? m[2].toUpperCase() : null };
		}
	}
	return null;
}

// Reference "loud" amount per unit. Purely a loudness heuristic for the mix,
// never a price feed: an event at or above its reference plays near full send.
const UNIT_SCALE = { USDC: 25, SOL: 0.5, GOLD: 500, THREE: 100000 };

// 0..1 loudness for an event. Amount-less events get a fixed conversational
// level so registrations and joins are audible but never dominate.
export function intensityOf(evt) {
	const amt = amountOf(evt);
	if (!amt || !(amt.value > 0)) return 0.35;
	const ref = UNIT_SCALE[(amt.unit || '').toUpperCase()] || 1;
	const x = amt.value / ref;
	return Math.min(1, Math.max(0.2, 0.55 + 0.45 * Math.log10(x + 0.12)));
}

/**
 * The full note spec for one feed event.
 * @returns {{ category: string, degree: number, hz: number, motifHz: number[],
 *             gain: number, pan: number, intensity: number }}
 */
export function eventToNote(evt) {
	const category = categoryOf(evt && evt.type);
	const h = hashString((evt && (evt.actor || evt.id)) || '');
	const intensity = intensityOf(evt);
	const total = SCALE.length * OCTAVES;

	// Louder events sit in a lower register; the actor hash picks the degree
	// inside that register so two whales still play different notes.
	const band = Math.round((1 - intensity) * (total - SCALE.length));
	const degree = Math.min(band + (h % SCALE.length), total - 1);

	// A stable 3-note ascending motif per actor, used by the arp voice.
	const motif = [
		degree,
		Math.min(degree + 1 + ((h >>> 3) % 3), total - 1),
		Math.min(degree + 3 + ((h >>> 6) % 4), total - 1),
	];

	return {
		category,
		degree,
		hz: degreeToHz(degree),
		motifHz: motif.map(degreeToHz),
		gain: 0.25 + 0.75 * intensity,
		pan: ((h % 1000) / 1000) * 1.6 - 0.8,
		intensity,
	};
}

function shortMint(mint) {
	const s = String(mint || '');
	return s.length > 10 ? `${s.slice(0, 4)}..${s.slice(-4)}` : s;
}

function fmtAmount(amt) {
	if (!amt) return '';
	const v = amt.value;
	const shown = v >= 100 ? Math.round(v).toLocaleString('en-US')
		: v >= 1 ? v.toFixed(2).replace(/\.?0+$/, '')
		: v.toFixed(4).replace(/\.?0+$/, '');
	return amt.unit ? `${shown} ${amt.unit}` : shown;
}

/**
 * Human ledger row for one feed event: { icon, title, detail, href }.
 * `title` and `detail` are plain text (caller escapes for HTML). `href` is a
 * real destination (agent profile or explorer) or null.
 */
export function describeEvent(evt) {
	const e = evt || {};
	const actor = e.actor || 'someone';
	const amt = fmtAmount(amountOf(e));
	const href = typeof e.explorerUrl === 'string' && /^https:\/\//.test(e.explorerUrl)
		? e.explorerUrl
		: e.agentId ? `/agents/${encodeURIComponent(e.agentId)}` : null;
	const narrative = typeof e.narrative === 'string' && e.narrative.trim() ? e.narrative.trim() : null;

	switch (e.type) {
		case 'payment':
			return { icon: '◆', title: `${actor} paid ${e.recipientLabel || 'an agent'}`, detail: amt, href };
		case 'agora-earned':
			return { icon: '◆', title: narrative || `${actor} earned an escrow release`, detail: amt || e.rewardLabel || '', href };
		case 'coin-buy':
			return { icon: '▼', title: `${actor} bought ${shortMint(e.mint)}`, detail: amt, href };
		case 'agent-deploy':
			return { icon: '✦', title: `new agent: ${e.name || actor}`, detail: '', href };
		case 'agent-onchain':
			return { icon: '✦', title: `${e.name || actor} verified on-chain`, detail: e.chain || '', href };
		case 'member-join':
			return { icon: '✦', title: `${e.handle || actor} joined three.ws`, detail: '', href };
		case 'agora-registered':
			return { icon: '✦', title: narrative || `${actor} registered as a citizen`, detail: e.profession || '', href };
		case 'level-up':
			return { icon: '△', title: `${actor} reached level ${e.level ?? '?'}`, detail: e.skill || '', href };
		case 'world-join':
			return { icon: '△', title: `${actor} joined ${e.coinName || e.coin || 'a world'}`, detail: '', href };
		case 'mission-complete':
			return { icon: '△', title: `${actor} completed ${e.mission || 'a mission'}`, detail: amt, href };
		case 'agora-task-posted':
			return { icon: '△', title: `${actor} posted a bounty`, detail: e.rewardLabel || e.profession || '', href };
		case 'agora-hired':
			return { icon: '△', title: `${actor} hired a sub-agent`, detail: e.rewardLabel || e.profession || '', href };
		case 'agora-task-claimed':
			return { icon: '△', title: narrative || `${actor} claimed a task`, detail: e.profession || '', href };
		case 'agora-task-completed':
			return { icon: '△', title: narrative || `${actor} delivered a task`, detail: e.profession || '', href };
		case 'agora-vouched':
			return { icon: '△', title: narrative || `a verifier vouched for ${actor}`, detail: '', href };
		case 'agent-guard':
			return { icon: '⚑', title: `${e.label || actor} refused a buy`, detail: e.reason || 'safety rule', href };
		case 'agora-flagged':
			return { icon: '⚑', title: narrative || `a proof by ${actor} was flagged`, detail: '', href };
		case 'jackpot':
			return { icon: '★', title: `${actor} hit a jackpot`, detail: amt || String(e.reward || ''), href };
		default:
			return { icon: '✦', title: `${actor}: ${String(e.type || 'activity')}`, detail: amt, href };
	}
}
