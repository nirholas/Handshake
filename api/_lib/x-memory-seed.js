/**
 * X memory seeding: the consent disclosure and the seeding transform.
 * ------------------------------------------------------------------
 * Everything in this module is pure. The network calls (OAuth token refresh,
 * the X reads, the LLM distillation) live in the handler; what gets *stored*
 * is decided here so it can be pinned by tests and so the consent screen and
 * the writer read the same declaration instead of drifting apart.
 *
 * The contract the consent screen makes is enforced here, not just described:
 *
 *   - only the fields listed in `reads` are ever sent to the distiller,
 *   - raw posts never become a memory (a near-verbatim fact is dropped),
 *   - links are stripped out of stored text,
 *   - every stored row carries its provenance and the scope version the
 *     owner agreed to, so revocation can find and delete exactly these rows.
 */

// Bump when the disclosure below changes in a way an owner would want to
// re-read. A consent recorded against an older version stops authorizing new
// seeds: the handler asks for consent again at the new version.
export const X_SEED_SCOPE_VERSION = '2026-08-11.1';

/** Tag every seeded memory carries. Revocation deletes exactly this tag. */
export const X_SEED_TAG = 'x_seed';

export const X_SEED_LIMITS = {
	/** Most recent original posts read per seed. */
	maxPosts: 100,
	/** Posts shorter than this after link stripping carry no signal. */
	minPostChars: 20,
	/** Facts stored per seed. */
	maxFacts: 15,
	/** Characters per stored fact. */
	maxFactChars: 280,
	/** Top-ranked facts promoted to the always-in-context working tier. */
	workingTierFacts: 5,
};

/**
 * Exactly what the seeder reads and stores. This object is served verbatim to
 * the consent screen, so every line here is a promise the code below keeps.
 */
export const X_SEED_DISCLOSURE = Object.freeze({
	version: X_SEED_SCOPE_VERSION,
	provider: 'x',
	title: 'Seed this agent from your X account',
	summary:
		'Your most recent public posts are read once, distilled into short facts about ' +
		'what you talk about and how you talk, and stored as memories on this agent. ' +
		'Your posts themselves are never stored.',
	reads: Object.freeze([
		'Your X profile: display name, handle, bio, follower and following counts.',
		`Up to ${X_SEED_LIMITS.maxPosts} of your most recent original public posts (text and post date).`,
	]),
	skips: Object.freeze([
		'Reposts and replies are excluded from the read.',
		'Direct messages, drafts, protected accounts you follow, likes, bookmarks, and your follower list are never read.',
	]),
	stores: Object.freeze([
		`Up to ${X_SEED_LIMITS.maxFacts} short distilled facts (max ${X_SEED_LIMITS.maxFactChars} characters each) about your recurring topics, opinions, projects, and tone.`,
		'Your X handle, so the agent can attribute what it learned.',
		'The date of the seed and the version of this disclosure you agreed to.',
	]),
	never: Object.freeze([
		'The text of your posts. A distilled fact that copies a post is discarded before it is written.',
		'Links from your posts. URLs are stripped out of stored text.',
		'Any X credential. Your access token stays encrypted in the connection record and is never copied into a memory.',
	]),
	retention: Object.freeze(
		'Seeded memories live on the agent until you re-seed (which replaces them) or ' +
			'revoke consent (which deletes them).',
	),
	revocation: Object.freeze(
		'Revoking consent, or disconnecting X, deletes every memory this seeding created. ' +
			'Nothing distilled from your account survives.',
	),
});

// ── Text normalisation ────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/\S+/g;

export function stripLinks(text) {
	return String(text ?? '')
		.replace(URL_RE, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeForCompare(text) {
	return stripLinks(text)
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

// ── Read side: which posts feed the distiller ────────────────────────────────

/**
 * Narrow a raw X timeline payload to the posts the disclosure allows: original
 * public posts, link-stripped, long enough to carry signal, de-duplicated, and
 * capped. Only `text` and `created_at` survive; any other field X returned is
 * dropped here so it can never reach the distiller.
 *
 * @param {Array<object>} rawPosts entries from GET /2/users/:id/tweets
 * @returns {Array<{text: string, created_at: string|null}>}
 */
export function selectSeedPosts(rawPosts, { limit = X_SEED_LIMITS.maxPosts } = {}) {
	if (!Array.isArray(rawPosts)) return [];
	const seen = new Set();
	const out = [];
	for (const post of rawPosts) {
		if (!post || typeof post !== 'object') continue;
		// The read already excludes retweets and replies; re-check so a payload
		// shape change cannot quietly widen what gets distilled.
		const refs = Array.isArray(post.referenced_tweets) ? post.referenced_tweets : [];
		if (refs.some((r) => r?.type === 'retweeted' || r?.type === 'replied_to')) continue;
		if (post.in_reply_to_user_id) continue;
		const text = stripLinks(post.text);
		if (text.length < X_SEED_LIMITS.minPostChars) continue;
		if (/^rt @/i.test(text)) continue;
		const key = normalizeForCompare(text);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push({ text, created_at: post.created_at ?? null });
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * The profile fields the disclosure allows, and nothing else. Everything the
 * distiller sees about the account passes through here first.
 */
export function selectSeedProfile(rawProfile) {
	const p = rawProfile && typeof rawProfile === 'object' ? rawProfile : {};
	return {
		username: typeof p.username === 'string' ? p.username : '',
		name: typeof p.name === 'string' ? p.name : '',
		description: stripLinks(p.description).slice(0, 500),
		followers: Number(p.public_metrics?.followers_count) || 0,
		following: Number(p.public_metrics?.following_count) || 0,
	};
}

// ── Topic extraction (deterministic) ─────────────────────────────────────────

const STOPWORDS = new Set([
	'the', 'and', 'for', 'that', 'this', 'with', 'you', 'your', 'are', 'was', 'were', 'but',
	'not', 'have', 'has', 'had', 'from', 'they', 'them', 'their', 'what', 'when', 'where',
	'which', 'who', 'will', 'would', 'could', 'should', 'about', 'there', 'here', 'been',
	'just', 'like', 'more', 'most', 'some', 'such', 'than', 'then', 'they', 'into', 'over',
	'only', 'also', 'very', 'much', 'many', 'even', 'still', 'really', 'get', 'got', 'going',
	'make', 'made', 'use', 'using', 'used', 'new', 'now', 'today', 'time', 'day', 'week',
	'year', 'people', 'thing', 'things', 'way', 'good', 'great', 'best', 'better', 'its',
	'his', 'her', 'she', 'him', 'our', 'out', 'off', 'all', 'any', 'can', 'one', 'two',
	'how', 'why', 'via', 'amp', 'rt', 'dont', 'doesnt', 'cant', 'wont', 'ive', 'im',
]);

/**
 * The topics an account posts about, by frequency. Hashtags count double
 * because an author chose them deliberately. Used both for provenance tags and
 * for the deterministic facts that keep a seed useful when the distiller is
 * unavailable.
 *
 * @returns {Array<{topic: string, count: number}>}
 */
export function deriveTopics(posts, { limit = 8 } = {}) {
	const counts = new Map();
	const bump = (token, weight) => counts.set(token, (counts.get(token) || 0) + weight);
	for (const post of Array.isArray(posts) ? posts : []) {
		const text = typeof post === 'string' ? post : post?.text;
		if (!text) continue;
		for (const tag of String(text).match(/#[A-Za-z][A-Za-z0-9_]{1,30}/g) || []) {
			bump(tag.slice(1).toLowerCase(), 2);
		}
		const words = normalizeForCompare(text).split(' ');
		for (const word of words) {
			if (word.length < 4 || word.length > 30) continue;
			if (STOPWORDS.has(word)) continue;
			if (/^\d+$/.test(word)) continue;
			bump(word, 1);
		}
	}
	return [...counts.entries()]
		.filter(([, count]) => count > 1)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([topic, count]) => ({ topic, count }));
}

// ── Distiller output parsing ─────────────────────────────────────────────────

/**
 * Read a fact list out of whatever the model returned. Models answer this
 * prompt with a bare JSON array, a fenced one, or a numbered list depending on
 * which provider in the chain served it, so all three parse. An unparseable
 * answer yields an empty list and the caller falls back to derived facts
 * rather than storing nothing.
 *
 * @returns {string[]}
 */
export function parseFactList(raw) {
	const text = String(raw ?? '').trim();
	if (!text) return [];

	const unfenced = text
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim();

	const jsonCandidates = [unfenced];
	const arrayMatch = unfenced.match(/\[[\s\S]*\]/);
	if (arrayMatch) jsonCandidates.push(arrayMatch[0]);

	for (const candidate of jsonCandidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (Array.isArray(parsed)) {
				const strings = parsed.filter((f) => typeof f === 'string');
				if (strings.length) return strings;
			}
		} catch {
			// Fall through to the line reader below.
		}
	}

	return unfenced
		.split('\n')
		.map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
		.filter((line) => line.length > 0 && !/^[[\]{}]+$/.test(line));
}

/**
 * Enforce the "stores" and "never" halves of the disclosure on the distiller's
 * output: strip links and wrapping punctuation, cap length and count, drop
 * duplicates, and drop any fact that is really just a copy of a post.
 *
 * @param {string[]} facts raw strings from the distiller
 * @param {{sourcePosts?: Array<{text: string}>}} opts
 */
export function sanitizeFacts(facts, { sourcePosts = [] } = {}) {
	const sources = (Array.isArray(sourcePosts) ? sourcePosts : [])
		.map((p) => normalizeForCompare(typeof p === 'string' ? p : p?.text))
		.filter((s) => s.length >= X_SEED_LIMITS.minPostChars);

	const seen = new Set();
	const out = [];
	for (const candidate of Array.isArray(facts) ? facts : []) {
		if (typeof candidate !== 'string') continue;
		let fact = stripLinks(candidate)
			.replace(/^["'`\s]+|["'`\s]+$/g, '')
			.replace(/^[-*•]\s*/, '')
			.trim();
		if (fact.length < 8) continue;
		if (fact.length > X_SEED_LIMITS.maxFactChars) {
			fact = `${fact.slice(0, X_SEED_LIMITS.maxFactChars - 1).trimEnd()}…`;
		}
		const key = normalizeForCompare(fact);
		if (!key || seen.has(key)) continue;
		if (isVerbatimPost(key, sources)) continue;
		seen.add(key);
		out.push(fact);
		if (out.length >= X_SEED_LIMITS.maxFacts) break;
	}
	return out;
}

/**
 * True when a candidate fact is the text of a post rather than a statement
 * about the author. Containment in either direction catches both the model
 * echoing a post back and the model quoting one with a short preamble.
 */
function isVerbatimPost(normalizedFact, normalizedSources) {
	if (normalizedFact.length < X_SEED_LIMITS.minPostChars) return false;
	return normalizedSources.some(
		(source) => source.includes(normalizedFact) || normalizedFact.includes(source),
	);
}

/**
 * Facts derived without a model, from the profile and the topic histogram.
 * These are what a seed stores when the LLM chain is unavailable or answers
 * with something unparseable: a smaller, blander seed beats a silent zero.
 */
export function deriveFallbackFacts(profile, posts, topics) {
	const p = profile || {};
	const handle = p.username ? `@${p.username}` : 'this account';
	const facts = [];
	if (p.name && p.username) facts.push(`${p.name} posts on X as ${handle}.`);
	if (p.description) facts.push(`${handle} describes themselves as: ${p.description}`);
	const named = (topics || []).slice(0, 6).map((t) => t.topic);
	if (named.length >= 2) {
		facts.push(`${handle} posts most often about ${named.slice(0, -1).join(', ')} and ${named.at(-1)}.`);
	} else if (named.length === 1) {
		facts.push(`${handle} posts most often about ${named[0]}.`);
	}
	const count = Array.isArray(posts) ? posts.length : 0;
	if (count > 0) {
		const avg = Math.round(posts.reduce((n, t) => n + (t.text?.length || 0), 0) / count);
		facts.push(
			`${handle} writes ${avg < 90 ? 'short, punchy' : avg < 180 ? 'medium-length' : 'long-form'} posts, averaging about ${avg} characters.`,
		);
	}
	return facts;
}

// ── Write side: the memory rows ──────────────────────────────────────────────

/**
 * Turn the accepted facts into the exact rows written to `agent_memories`.
 *
 * Salience decays down the ranked list, and the top few are promoted to the
 * `working` tier so they are always in the agent's context rather than only
 * surfacing when a message happens to match them. That promotion is what makes
 * a seed observable in the very next reply.
 *
 * @param {object} opts
 * @param {string[]} opts.facts sanitized facts, most important first
 * @param {object}   opts.profile output of selectSeedProfile
 * @param {Array<{topic:string}>} [opts.topics] provenance tags
 * @param {string}   [opts.source] 'model' or 'derived'
 * @param {string}   [opts.seededAt] ISO timestamp recorded in provenance
 * @returns {Array<{type:string, content:string, tags:string[], context:object, salience:number, tier:string}>}
 */
export function buildSeedMemories({
	facts,
	profile,
	topics = [],
	source = 'model',
	seededAt = null,
	scopeVersion = X_SEED_SCOPE_VERSION,
}) {
	const list = Array.isArray(facts) ? facts.slice(0, X_SEED_LIMITS.maxFacts) : [];
	const username = profile?.username || '';
	const topicTags = topics
		.slice(0, 3)
		.map((t) => t.topic)
		.filter((t) => /^[a-z0-9_]{3,30}$/.test(t));

	return list.map((content, index) => ({
		type: 'reference',
		content,
		tags: ['x', X_SEED_TAG, ...topicTags],
		context: {
			source: 'x_seed',
			username,
			rank: index + 1,
			distilled_by: source,
			scope_version: scopeVersion,
			...(seededAt ? { seeded_at: seededAt } : {}),
		},
		salience: Number((0.8 - index * 0.02).toFixed(2)),
		tier: index < X_SEED_LIMITS.workingTierFacts ? 'working' : 'recall',
	}));
}

/**
 * The whole transform in one call: raw X payloads in, memory rows out. The
 * handler supplies `distil` (the LLM call) so this stays pure and testable;
 * a distiller that throws or returns nothing usable degrades to derived facts
 * instead of failing the seed.
 *
 * @param {object} opts
 * @param {object} opts.rawProfile GET /2/users/me payload `data`
 * @param {Array<object>} opts.rawPosts GET /2/users/:id/tweets payload `data`
 * @param {(profile: object, posts: object[]) => Promise<string>} opts.distil
 * @param {string} [opts.seededAt]
 */
export async function seedFromX({ rawProfile, rawPosts, distil, seededAt = null }) {
	const profile = selectSeedProfile(rawProfile);
	const posts = selectSeedPosts(rawPosts);
	const topics = deriveTopics(posts);

	let facts = [];
	let source = 'model';
	if (posts.length || profile.description) {
		try {
			facts = sanitizeFacts(parseFactList(await distil(profile, posts)), {
				sourcePosts: posts,
			});
		} catch (err) {
			console.warn('[x-seed] distillation failed, falling back to derived facts', err?.message);
			facts = [];
		}
	}
	if (!facts.length) {
		source = 'derived';
		facts = sanitizeFacts(deriveFallbackFacts(profile, posts, topics), { sourcePosts: posts });
	}

	return {
		profile,
		postsRead: posts.length,
		topics,
		source,
		memories: buildSeedMemories({ facts, profile, topics, source, seededAt }),
	};
}
