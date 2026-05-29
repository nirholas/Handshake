// POST /api/agents/:id/memory-seed
// Seeds agent memories from GitHub activity using Claude Haiku to distill facts.
// Requires: session auth, agent ownership, github social connection.
// Rate-limited to 1 seed per agent per 24 hours.

import { webcrypto } from 'node:crypto';
import { sql } from '../../_lib/db.js';
import { getSessionUser, authenticateBearer, extractBearer } from '../../_lib/auth.js';
import { cors, json, method, error } from '../../_lib/http.js';
import { env } from '../../_lib/env.js';
import { llmComplete } from '../../_lib/llm.js';
import { limits } from '../../_lib/rate-limit.js';

const subtle = globalThis.crypto?.subtle || webcrypto.subtle;

// ── Token decryption (mirrors the HKDF derivation in auth/github/[action].js) ─

async function decryptToken(ciphertext) {
	const raw = new TextEncoder().encode(env.JWT_SECRET);
	const base = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
	const key = await subtle.deriveKey(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new TextEncoder().encode('github-token'),
			info: new Uint8Array(0),
		},
		base,
		{ name: 'AES-GCM', length: 256 },
		false,
		['decrypt'],
	);
	const buf = Buffer.from(ciphertext, 'base64');
	const iv = buf.subarray(0, 12);
	const ct = buf.subarray(12);
	const plain = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
	return new TextDecoder().decode(plain);
}

// ── GitHub data fetch ─────────────────────────────────────────────────────────

async function fetchGitHubData(accessToken, login) {
	const headers = {
		authorization: `token ${accessToken}`,
		'user-agent': 'three.ws/1.0',
	};

	const [profileRes, reposRes] = await Promise.all([
		fetch('https://api.github.com/user', { headers }),
		fetch('https://api.github.com/user/repos?sort=pushed&per_page=30', { headers }),
	]);

	if (!profileRes.ok) throw new Error(`GitHub profile fetch failed: ${profileRes.status}`);
	if (!reposRes.ok) throw new Error(`GitHub repos fetch failed: ${reposRes.status}`);

	const profile = await profileRes.json();
	const repos = await reposRes.json();

	// Commits from top 3 non-fork repos
	const topRepos = Array.isArray(repos) ? repos.filter((r) => !r.fork).slice(0, 3) : [];
	const commitLists = await Promise.all(
		topRepos.map((repo) =>
			fetch(
				`https://api.github.com/repos/${repo.full_name}/commits?author=${login}&per_page=5`,
				{ headers },
			)
				.then((r) => (r.ok ? r.json() : []))
				.then((commits) =>
					Array.isArray(commits)
						? commits.map((c) => c.commit?.message).filter(Boolean)
						: [],
				),
		),
	);

	return {
		profile: {
			login: profile.login,
			name: profile.name,
			bio: profile.bio,
			company: profile.company,
			location: profile.location,
			public_repos: profile.public_repos,
			followers: profile.followers,
		},
		repos: (Array.isArray(repos) ? repos : []).slice(0, 20).map((r) => ({
			name: r.name,
			description: r.description,
			language: r.language,
			stars: r.stargazers_count,
			pushed_at: r.pushed_at,
			fork: r.fork,
		})),
		recent_commits: commitLists.flat().slice(0, 20),
	};
}

// ── Claude Haiku distillation ─────────────────────────────────────────────────

async function distillFacts(githubData) {
	const { text: raw } = await llmComplete({
		maxTokens: 1024,
		system:
			'You distill GitHub activity into concise memory facts for an AI agent. ' +
			'Each fact is a single self-contained sentence about the developer — tech stack, ' +
			'project types, commit style, interests, or notable contributions. ' +
			'Output ONLY a JSON array of strings, no other text.',
		user:
			`Extract up to 15 memory facts from this GitHub profile data:\n` +
			JSON.stringify(githubData, null, 2),
	});
	try {
		const facts = JSON.parse(raw);
		return Array.isArray(facts) ? facts.filter((f) => typeof f === 'string').slice(0, 15) : [];
	} catch {
		return [];
	}
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handleMemorySeed(req, res, agentId) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId;
	if (!userId) return error(res, 401, 'unauthorized', 'sign in required');

	// Verify agent ownership
	const [agent] = await sql`
		SELECT id FROM agent_identities
		WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL
	`;
	if (!agent) return error(res, 404, 'not_found', 'agent not found');

	// Verify GitHub connection
	const [conn] = await sql`
		SELECT access_token, username FROM social_connections
		WHERE user_id = ${userId} AND provider = 'github'
	`;
	if (!conn) {
		return error(res, 412, 'not_connected', 'connect GitHub first at /settings?tab=connected-accounts');
	}

	// Rate limit: 1 seed per agent per 24 hours
	const rl = await limits.memorySeed(agentId);
	if (!rl.success) {
		return error(res, 429, 'rate_limited', 'memory seeding is limited to once per 24 hours');
	}

	let accessToken;
	try {
		accessToken = await decryptToken(conn.access_token);
	} catch (e) {
		console.error('[memory-seed] token decrypt failed', e);
		return error(res, 500, 'internal_error', 'could not decrypt stored token');
	}

	let githubData;
	try {
		githubData = await fetchGitHubData(accessToken, conn.username);
	} catch (e) {
		return error(res, 502, 'upstream_error', e.message || 'GitHub API fetch failed');
	}

	let facts;
	try {
		facts = await distillFacts(githubData);
	} catch (e) {
		console.error('[memory-seed] distill failed', e);
		return error(res, 502, 'distill_error', 'could not distill facts from GitHub data');
	}

	if (facts.length === 0) {
		return json(res, 200, { seeded: 0, facts: [], seeded_at: new Date().toISOString() });
	}

	// Replace previous github memories with fresh distillation
	await sql`DELETE FROM agent_memories WHERE agent_id = ${agentId} AND 'github' = ANY(tags)`;

	const seededAt = new Date().toISOString();
	const ctx = JSON.stringify({ source: 'github_seed', seeded_at: seededAt });
	for (const fact of facts) {
		await sql`
			INSERT INTO agent_memories (agent_id, type, content, tags, context, salience)
			VALUES (
				${agentId},
				'reference',
				${fact.slice(0, 10000)},
				${['github']},
				${ctx}::jsonb,
				0.7
			)
		`;
	}

	return json(res, 200, { seeded: facts.length, facts, seeded_at: seededAt });
}
