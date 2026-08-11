import { describe, it, expect } from 'vitest';
import {
	buildCatalog,
	buildSeedDocument,
	defaultSelection,
	parseFacts,
	readmeExcerpt,
	resolveSelection,
	selectionManifest,
	selectionSchema,
	toMemoryRows,
	GITHUB_SEED_TAGS,
	MAX_CATALOG_REPOS,
	MAX_FACTS,
} from '../api/_lib/github-seed.js';

const profile = {
	login: 'devuser',
	name: 'Dev User',
	bio: 'Builds 3D agent tooling',
	company: 'three.ws',
	location: 'Lisbon',
	blog: 'https://three.ws',
	public_repos: 21,
	followers: 140,
	html_url: 'https://github.com/devuser',
};

const pinnedRepo = {
	full_name: 'devuser/agent-kit',
	name: 'agent-kit',
	description: 'Toolkit for embodied agents',
	language: 'TypeScript',
	stargazerCount: 312,
	topics: ['agents', 'solana'],
	pushedAt: '2026-08-01T00:00:00Z',
	isFork: false,
	url: 'https://github.com/devuser/agent-kit',
};

const restRepos = [
	{
		full_name: 'devuser/render-lab',
		name: 'render-lab',
		description: 'WebGL experiments',
		language: 'JavaScript',
		stargazers_count: 12,
		topics: ['webgl'],
		pushed_at: '2026-07-20T00:00:00Z',
		fork: false,
		html_url: 'https://github.com/devuser/render-lab',
		private: false,
	},
	{
		full_name: 'devuser/older-thing',
		name: 'older-thing',
		description: 'Old CLI',
		language: 'Go',
		stargazers_count: 3,
		pushed_at: '2025-01-05T00:00:00Z',
		fork: false,
		html_url: 'https://github.com/devuser/older-thing',
		private: false,
	},
];

function fullCatalog() {
	return buildCatalog({ profile, pinned: [pinnedRepo], repos: restRepos });
}

describe('buildCatalog', () => {
	it('leads with pinned repos, then orders the rest by most recent push', () => {
		const catalog = fullCatalog();
		expect(catalog.repos.map((r) => r.key)).toEqual([
			'devuser/agent-kit',
			'devuser/render-lab',
			'devuser/older-thing',
		]);
		expect(catalog.repos[0].pinned).toBe(true);
		expect(catalog.repos[1].pinned).toBe(false);
	});

	it('normalises the GraphQL pinned shape and the REST repo shape to one entry', () => {
		const catalog = fullCatalog();
		const pinned = catalog.repos[0];
		expect(pinned).toMatchObject({
			key: 'devuser/agent-kit',
			owner: 'devuser',
			language: 'TypeScript',
			stars: 312,
			topics: ['agents', 'solana'],
			fork: false,
		});
		expect(catalog.repos[1].stars).toBe(12);
	});

	it('never lists a private repo, so a private repo can never be selected', () => {
		const catalog = buildCatalog({
			profile,
			pinned: [],
			repos: [...restRepos, { full_name: 'devuser/secret', name: 'secret', private: true }],
		});
		expect(catalog.repos.map((r) => r.key)).not.toContain('devuser/secret');
	});

	it('does not list a pinned repo twice when it also comes back in the repo list', () => {
		const catalog = buildCatalog({
			profile,
			pinned: [pinnedRepo],
			repos: [
				{ full_name: 'devuser/agent-kit', name: 'agent-kit', pushed_at: '2026-08-01T00:00:00Z' },
				...restRepos,
			],
		});
		expect(catalog.repos.filter((r) => r.key === 'devuser/agent-kit')).toHaveLength(1);
	});

	it('caps the catalog so the consent list stays reviewable', () => {
		const many = Array.from({ length: MAX_CATALOG_REPOS + 15 }, (_, i) => ({
			full_name: `devuser/repo-${i}`,
			name: `repo-${i}`,
			pushed_at: `2026-07-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
		}));
		expect(buildCatalog({ profile, repos: many }).repos).toHaveLength(MAX_CATALOG_REPOS);
	});

	it('survives an empty GitHub account', () => {
		const catalog = buildCatalog({ profile, pinned: [], repos: [] });
		expect(catalog.repos).toEqual([]);
		expect(catalog.profile.login).toBe('devuser');
	});
});

describe('selectionSchema', () => {
	it('defaults to selecting nothing at all', () => {
		expect(selectionSchema.parse({})).toEqual({ include_profile: false, repos: [], readmes: [] });
	});

	it('refuses a repo key that is not owner/name', () => {
		expect(selectionSchema.safeParse({ repos: ['../../etc/passwd'] }).success).toBe(false);
		expect(selectionSchema.safeParse({ repos: ['no-slash'] }).success).toBe(false);
	});

	it('refuses unknown fields so a caller cannot smuggle in extra scope', () => {
		expect(selectionSchema.safeParse({ include_all: true }).success).toBe(false);
	});
});

describe('resolveSelection', () => {
	it('resolves exactly what the user ticked', () => {
		const resolved = resolveSelection(fullCatalog(), {
			include_profile: true,
			repos: ['devuser/agent-kit'],
			readmes: ['devuser/agent-kit'],
		});
		expect(resolved.rejected).toEqual([]);
		expect(resolved.profile.login).toBe('devuser');
		expect(resolved.repos.map((r) => r.key)).toEqual(['devuser/agent-kit']);
		expect(resolved.readmeKeys).toEqual(['devuser/agent-kit']);
	});

	it('rejects a repo that is not in the catalog the user was shown', () => {
		const resolved = resolveSelection(fullCatalog(), {
			include_profile: false,
			repos: ['someoneelse/private-thing'],
			readmes: [],
		});
		expect(resolved.repos).toEqual([]);
		expect(resolved.rejected).toEqual([
			{ key: 'someoneelse/private-thing', reason: 'not_in_catalog' },
		]);
	});

	it('rejects a README for a repo the user did not also select', () => {
		const resolved = resolveSelection(fullCatalog(), {
			include_profile: false,
			repos: ['devuser/agent-kit'],
			readmes: ['devuser/render-lab'],
		});
		expect(resolved.readmeKeys).toEqual([]);
		expect(resolved.rejected).toEqual([
			{ key: 'devuser/render-lab', reason: 'readme_without_repo' },
		]);
	});

	it('collapses duplicate picks instead of seeding the same repo twice', () => {
		const resolved = resolveSelection(fullCatalog(), {
			include_profile: false,
			repos: ['devuser/agent-kit', 'devuser/agent-kit'],
			readmes: ['devuser/agent-kit', 'devuser/agent-kit'],
		});
		expect(resolved.repos).toHaveLength(1);
		expect(resolved.readmeKeys).toEqual(['devuser/agent-kit']);
		expect(resolved.rejected).toEqual([]);
	});

	it('reports an all-unticked selection as empty', () => {
		const resolved = resolveSelection(fullCatalog(), {
			include_profile: false,
			repos: [],
			readmes: [],
		});
		expect(resolved.isEmpty).toBe(true);
	});

	it('is not empty when only the profile is ticked', () => {
		const resolved = resolveSelection(fullCatalog(), {
			include_profile: true,
			repos: [],
			readmes: [],
		});
		expect(resolved.isEmpty).toBe(false);
	});
});

describe('defaultSelection', () => {
	it('is the public profile plus pinned repos, and never a README', () => {
		expect(defaultSelection(fullCatalog())).toEqual({
			include_profile: true,
			repos: ['devuser/agent-kit'],
			readmes: [],
		});
	});
});

describe('buildSeedDocument', () => {
	const readmes = new Map([
		['devuser/agent-kit', 'Agent kit reads Solana state and speaks in character.'],
		['devuser/render-lab', 'SECRET RENDER LAB NOTES'],
	]);

	it('renders only the repos in the resolved selection', () => {
		const resolved = resolveSelection(fullCatalog(), {
			include_profile: true,
			repos: ['devuser/agent-kit'],
			readmes: [],
		});
		const doc = buildSeedDocument(resolved, new Map());
		expect(doc).toContain('devuser/agent-kit');
		expect(doc).not.toContain('render-lab');
		expect(doc).not.toContain('older-thing');
	});

	it('never leaks a README for a repo whose README was not selected', () => {
		const resolved = resolveSelection(fullCatalog(), {
			include_profile: false,
			repos: ['devuser/agent-kit', 'devuser/render-lab'],
			readmes: ['devuser/agent-kit'],
		});
		const doc = buildSeedDocument(resolved, readmes);
		expect(doc).toContain('Agent kit reads Solana state');
		expect(doc).not.toContain('SECRET RENDER LAB NOTES');
	});

	it('omits the profile block entirely when the profile is not ticked', () => {
		const resolved = resolveSelection(fullCatalog(), {
			include_profile: false,
			repos: ['devuser/agent-kit'],
			readmes: [],
		});
		const doc = buildSeedDocument(resolved, new Map());
		expect(doc).not.toContain('Public profile');
		expect(doc).not.toContain('Lisbon');
	});

	it('includes the profile fields when the profile is ticked', () => {
		const resolved = resolveSelection(fullCatalog(), {
			include_profile: true,
			repos: [],
			readmes: [],
		});
		const doc = buildSeedDocument(resolved, new Map());
		expect(doc).toContain('@devuser');
		expect(doc).toContain('Builds 3D agent tooling');
		expect(doc).toContain('Lisbon');
	});
});

describe('readmeExcerpt', () => {
	it('strips badges, images, html, and comments down to prose', () => {
		const md = [
			'<!-- hidden note -->',
			'# Agent Kit',
			'[![build](https://img.shields.io/x.svg)](https://ci.example/x)',
			'<div align="center">centered</div>',
			'A toolkit for [embodied agents](https://three.ws/agents).',
		].join('\n');
		const out = readmeExcerpt(md);
		expect(out).not.toContain('hidden note');
		expect(out).not.toContain('img.shields.io');
		expect(out).not.toContain('<div');
		expect(out).toContain('A toolkit for embodied agents.');
	});

	it('truncates a huge README instead of blowing the prompt budget', () => {
		const out = readmeExcerpt('x'.repeat(50_000), 100);
		expect(out.length).toBeLessThanOrEqual(101);
		expect(out.endsWith('…')).toBe(true);
	});

	it('returns an empty string for a repo with no README body', () => {
		expect(readmeExcerpt(null)).toBe('');
		expect(readmeExcerpt('')).toBe('');
	});
});

describe('parseFacts', () => {
	it('parses a plain JSON array', () => {
		expect(parseFacts('["Writes TypeScript agents.", "Ships on Solana."]')).toEqual([
			'Writes TypeScript agents.',
			'Ships on Solana.',
		]);
	});

	it('parses a fenced JSON array, which models emit constantly', () => {
		const raw = 'Here you go:\n```json\n["Writes TypeScript agents."]\n```';
		expect(parseFacts(raw)).toEqual(['Writes TypeScript agents.']);
	});

	it('drops non-strings, blanks, and case-insensitive duplicates', () => {
		expect(parseFacts('["Ships on Solana.", 42, "  ", "ships on solana.", null]')).toEqual([
			'Ships on Solana.',
		]);
	});

	it('caps the fact count', () => {
		const many = JSON.stringify(Array.from({ length: 60 }, (_, i) => `Fact number ${i}.`));
		expect(parseFacts(many)).toHaveLength(MAX_FACTS);
	});

	it('returns nothing for unparseable output rather than seeding garbage', () => {
		expect(parseFacts('I could not do that.')).toEqual([]);
		expect(parseFacts('[not json]')).toEqual([]);
		expect(parseFacts(undefined)).toEqual([]);
	});
});

describe('toMemoryRows', () => {
	const resolved = resolveSelection(fullCatalog(), {
		include_profile: true,
		repos: ['devuser/agent-kit'],
		readmes: ['devuser/agent-kit'],
	});

	it('tags every row so one delete revokes the whole seed', () => {
		const rows = toMemoryRows('agent-1', ['Ships on Solana.'], {
			login: 'devuser',
			resolved,
			seededAt: '2026-08-11T10:00:00.000Z',
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			agent_id: 'agent-1',
			type: 'reference',
			content: 'Ships on Solana.',
			tags: GITHUB_SEED_TAGS,
			salience: 0.7,
		});
		expect(rows[0].context.source).toBe('github_seed');
	});

	it('records the exact selection on every row as the consent audit trail', () => {
		const rows = toMemoryRows('agent-1', ['a', 'b'], {
			login: 'devuser',
			resolved,
			seededAt: '2026-08-11T10:00:00.000Z',
		});
		for (const row of rows) {
			expect(row.context.selection).toEqual({
				profile: true,
				repos: ['devuser/agent-kit'],
				readmes: ['devuser/agent-kit'],
			});
			expect(row.context.login).toBe('devuser');
		}
	});

	it('manifests an unticked profile as false', () => {
		const noProfile = resolveSelection(fullCatalog(), {
			include_profile: false,
			repos: ['devuser/render-lab'],
			readmes: [],
		});
		expect(selectionManifest(noProfile)).toEqual({
			profile: false,
			repos: ['devuser/render-lab'],
			readmes: [],
		});
	});
});
