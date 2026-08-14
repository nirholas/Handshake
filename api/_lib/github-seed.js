// Pure transform core for consent-first GitHub memory seeding.
//
// The privacy contract this module enforces: a seed run may only ever read the
// items the user ticked. Every stage below is a narrowing. buildCatalog turns
// the GitHub API response into the inventory the user is shown, resolveSelection
// rejects anything the user sent that is not in that inventory, and
// buildSeedDocument renders ONLY the resolved items into the text handed to the
// LLM. Nothing in here fetches or writes, so the narrowing is directly testable
// without a network or a database.

import { z } from 'zod';

export const GITHUB_SEED_SOURCE = 'github_seed';
export const GITHUB_SEED_TAGS = ['github', 'github_seed'];

export const MAX_CATALOG_REPOS = 40;
export const MAX_SELECTED_REPOS = 12;
export const MAX_README_CHARS = 8000;
export const MAX_FACTS = 20;
export const MAX_FACT_CHARS = 600;
/**
 * Top-ranked facts promoted to the always-in-context working tier. The rest
 * land in `recall`, where they surface only when a message happens to match
 * them. Without this promotion a GitHub seed answers "what do you know about
 * my work?" with nothing, because the working context the agent always carries
 * is `pinned = true OR tier = 'working'` and the column defaults to `recall`.
 */
export const WORKING_TIER_FACTS = 5;

const REPO_KEY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export const selectionSchema = z
	.object({
		include_profile: z.boolean().default(false),
		repos: z.array(z.string().trim().regex(REPO_KEY)).max(MAX_SELECTED_REPOS).default([]),
		readmes: z.array(z.string().trim().regex(REPO_KEY)).max(MAX_SELECTED_REPOS).default([]),
	})
	.strict();

// ── Catalog ───────────────────────────────────────────────────────────────────

function repoKey(raw) {
	if (raw?.full_name) return raw.full_name;
	const owner = raw?.owner?.login ?? raw?.owner ?? '';
	return owner && raw?.name ? `${owner}/${raw.name}` : '';
}

function toCatalogRepo(raw, pinned) {
	const key = repoKey(raw);
	if (!key) return null;
	return {
		key,
		name: raw.name ?? key.split('/')[1],
		owner: key.split('/')[0],
		description: raw.description ?? null,
		language: raw.language ?? raw.primaryLanguage?.name ?? null,
		stars: raw.stargazers_count ?? raw.stargazerCount ?? 0,
		topics: Array.isArray(raw.topics) ? raw.topics.slice(0, 8) : [],
		pushed_at: raw.pushed_at ?? raw.pushedAt ?? null,
		fork: Boolean(raw.fork ?? raw.isFork ?? false),
		url: raw.html_url ?? raw.url ?? `https://github.com/${key}`,
		pinned,
	};
}

function toCatalogProfile(raw) {
	if (!raw?.login) return null;
	return {
		login: raw.login,
		name: raw.name ?? null,
		bio: raw.bio ?? null,
		company: raw.company ?? null,
		location: raw.location ?? null,
		blog: raw.blog || null,
		public_repos: raw.public_repos ?? 0,
		followers: raw.followers ?? 0,
		url: raw.html_url ?? `https://github.com/${raw.login}`,
	};
}

/**
 * Build the inventory the user picks from. Pinned repos lead because they are
 * what the developer chose to show on their own profile, then the rest by most
 * recently pushed. Private repos never enter the catalog: the OAuth scope is
 * read-only public, and a private repo appearing in a consent list the user
 * cannot meaningfully audit is exactly the surprise this feature exists to
 * avoid.
 */
export function buildCatalog({ profile, pinned = [], repos = [] } = {}) {
	const pinnedKeys = new Set();
	const out = [];

	for (const raw of Array.isArray(pinned) ? pinned : []) {
		const entry = toCatalogRepo(raw, true);
		if (!entry || pinnedKeys.has(entry.key)) continue;
		pinnedKeys.add(entry.key);
		out.push(entry);
	}

	const rest = (Array.isArray(repos) ? repos : [])
		.filter((r) => !r?.private)
		.map((r) => toCatalogRepo(r, false))
		.filter((r) => r && !pinnedKeys.has(r.key))
		.sort((a, b) => String(b.pushed_at ?? '').localeCompare(String(a.pushed_at ?? '')));

	out.push(...rest);

	return {
		profile: toCatalogProfile(profile),
		repos: out.slice(0, MAX_CATALOG_REPOS),
	};
}

// ── Selection ─────────────────────────────────────────────────────────────────

/**
 * Narrow a user selection against the catalog. Anything the caller asked for
 * that is not in the catalog, or a README for a repo they did not also select,
 * comes back in `rejected` so the endpoint can refuse the whole run rather than
 * silently seeding a different set than the user believes they approved.
 */
export function resolveSelection(catalog, selection) {
	const byKey = new Map((catalog?.repos ?? []).map((r) => [r.key, r]));
	const rejected = [];

	const repos = [];
	const seen = new Set();
	for (const key of selection.repos ?? []) {
		if (seen.has(key)) continue;
		seen.add(key);
		const entry = byKey.get(key);
		if (!entry) {
			rejected.push({ key, reason: 'not_in_catalog' });
			continue;
		}
		repos.push(entry);
	}

	const readmeKeys = [];
	const seenReadme = new Set();
	for (const key of selection.readmes ?? []) {
		if (seenReadme.has(key)) continue;
		seenReadme.add(key);
		if (!byKey.has(key)) {
			rejected.push({ key, reason: 'not_in_catalog' });
			continue;
		}
		if (!seen.has(key)) {
			rejected.push({ key, reason: 'readme_without_repo' });
			continue;
		}
		readmeKeys.push(key);
	}

	const includeProfile = Boolean(selection.include_profile);
	if (includeProfile && !catalog?.profile) {
		rejected.push({ key: 'profile', reason: 'not_in_catalog' });
	}

	return {
		profile: includeProfile && catalog?.profile ? catalog.profile : null,
		repos,
		readmeKeys,
		rejected,
		isEmpty: !includeProfile && repos.length === 0,
	};
}

/**
 * The preset used by the older non-granular seed route: the developer's public
 * profile plus the repos they pinned to it. It is the smallest selection that
 * still says something real about their work, and it reads nothing the visitor
 * to their GitHub profile page cannot already see.
 */
export function defaultSelection(catalog) {
	return {
		include_profile: Boolean(catalog?.profile),
		repos: (catalog?.repos ?? []).filter((r) => r.pinned).map((r) => r.key),
		readmes: [],
	};
}

// ── README normalisation ──────────────────────────────────────────────────────

/**
 * Strip a README down to prose. Badge rows, raw HTML blocks, and image links
 * are pure noise to a fact distiller and burn the token budget that the actual
 * project description needs.
 */
export function readmeExcerpt(markdown, limit = MAX_README_CHARS) {
	if (typeof markdown !== 'string') return '';
	const cleaned = markdown
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^[ \t]*\|.*\|[ \t]*$/gm, ' ')
		.replace(/[ \t]+/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return cleaned.length > limit ? `${cleaned.slice(0, limit).trimEnd()}…` : cleaned;
}

// ── Seed document ─────────────────────────────────────────────────────────────

function repoBlock(repo, readme) {
	const lines = [`### ${repo.key}${repo.pinned ? ' (pinned)' : ''}`];
	if (repo.description) lines.push(`Description: ${repo.description}`);
	if (repo.language) lines.push(`Primary language: ${repo.language}`);
	if (repo.topics.length) lines.push(`Topics: ${repo.topics.join(', ')}`);
	if (repo.stars) lines.push(`Stars: ${repo.stars}`);
	if (readme) lines.push(`README:\n${readme}`);
	return lines.join('\n');
}

/**
 * Render the resolved selection into the text the distiller sees. `readmes` is
 * consulted only for keys in `resolved.readmeKeys`, so a README fetched for a
 * repo the user did not tick can never reach the prompt.
 */
export function buildSeedDocument(resolved, readmes = new Map()) {
	const allowed = new Set(resolved.readmeKeys ?? []);
	const sections = [];

	if (resolved.profile) {
		const p = resolved.profile;
		const bits = [`## Public profile`, `Handle: @${p.login}`];
		if (p.name) bits.push(`Name: ${p.name}`);
		if (p.bio) bits.push(`Bio: ${p.bio}`);
		if (p.company) bits.push(`Company: ${p.company}`);
		if (p.location) bits.push(`Location: ${p.location}`);
		if (p.blog) bits.push(`Site: ${p.blog}`);
		bits.push(`Public repos: ${p.public_repos}`, `Followers: ${p.followers}`);
		sections.push(bits.join('\n'));
	}

	if (resolved.repos.length) {
		const blocks = resolved.repos.map((repo) =>
			repoBlock(repo, allowed.has(repo.key) ? readmes.get(repo.key) || '' : ''),
		);
		sections.push(['## Selected repositories', ...blocks].join('\n\n'));
	}

	return sections.join('\n\n');
}

export const SEED_SYSTEM_PROMPT =
	'You distill a developer\'s GitHub material into concise memory facts for their AI agent. ' +
	'Each fact is one self-contained sentence the agent can say out loud about this person: ' +
	'what they build, the stack they reach for, the problems their projects solve, and how they ' +
	'describe their own work. Use only what the material states; never guess or extrapolate. ' +
	`Output ONLY a JSON array of at most ${MAX_FACTS} strings, no other text.`;

// ── Fact parsing ──────────────────────────────────────────────────────────────

/**
 * Parse the model's reply into clean fact strings. Models fence JSON often
 * enough that an unfenced parse silently seeds zero memories and reads to the
 * user as "GitHub had nothing to say about me".
 */
export function parseFacts(raw, max = MAX_FACTS) {
	if (typeof raw !== 'string') return [];
	let body = raw.trim();
	const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced) body = fenced[1].trim();
	const start = body.indexOf('[');
	const end = body.lastIndexOf(']');
	if (start < 0 || end <= start) return [];

	let parsed;
	try {
		parsed = JSON.parse(body.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const seen = new Set();
	const facts = [];
	for (const item of parsed) {
		if (typeof item !== 'string') continue;
		const fact = item.trim().slice(0, MAX_FACT_CHARS);
		if (!fact) continue;
		const dedupeKey = fact.toLowerCase();
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		facts.push(fact);
		if (facts.length >= max) break;
	}
	return facts;
}

// ── Memory rows ───────────────────────────────────────────────────────────────

/** The audit trail stored on every seeded memory: exactly what the user ticked. */
export function selectionManifest(resolved) {
	return {
		profile: Boolean(resolved.profile),
		repos: resolved.repos.map((r) => r.key),
		readmes: [...(resolved.readmeKeys ?? [])],
	};
}

export function toMemoryRows(agentId, facts, { login, resolved, seededAt }) {
	const selection = selectionManifest(resolved);
	return facts.map((fact, index) => ({
		agent_id: agentId,
		type: 'reference',
		content: fact,
		tags: GITHUB_SEED_TAGS,
		// `rank` preserves the order the distiller emitted, which the salience
		// below encodes for retrieval and the UI reads back to show the user
		// which facts their agent leads with.
		context: {
			source: GITHUB_SEED_SOURCE,
			login,
			seeded_at: seededAt,
			rank: index + 1,
			selection,
		},
		// Chat keeps the ten highest-salience memories, so a flat score would
		// truncate the distiller's ranking arbitrarily.
		salience: Number((0.7 - index * 0.01).toFixed(2)),
		tier: index < WORKING_TIER_FACTS ? 'working' : 'recall',
	}));
}
