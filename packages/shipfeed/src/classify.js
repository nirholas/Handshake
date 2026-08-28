// Audience classification: which commits are worth a stranger's attention.
//
// A raw commit feed is unreadable not because it is long but because it is
// undifferentiated: a lockfile bump and a new payment rail arrive with the same
// weight. This module scores each commit from 0 to 1 and puts it in one of
// three audiences, and it always says WHY, so a feed that hides something can
// be argued with instead of trusted blindly.
//
//   holder     someone who uses or owns a piece of the product
//   developer  someone who builds against it
//   internal   someone who works on it
//
// Pure and synchronous. Optional `files` sharpen the result but are never
// required, so classification costs no extra API calls.

import { parseCommit } from './parse.js';

/** Base signal per conventional type. Unknown types land mid-scale. */
const TYPE_SIGNAL = {
	feat: 0.72,
	security: 0.72,
	fix: 0.6,
	perf: 0.58,
	revert: 0.5,
	release: 0.55,
	refactor: 0.3,
	docs: 0.34,
	build: 0.2,
	test: 0.16,
	tests: 0.16,
	ci: 0.12,
	chore: 0.14,
	style: 0.1,
	deps: 0.12,
};

const TYPE_AUDIENCE = {
	feat: 'holder',
	fix: 'holder',
	perf: 'holder',
	security: 'holder',
	release: 'holder',
	revert: 'developer',
	docs: 'developer',
	refactor: 'internal',
	build: 'internal',
	test: 'internal',
	tests: 'internal',
	ci: 'internal',
	chore: 'internal',
	style: 'internal',
	deps: 'internal',
};

/** Paths whose presence alone never justifies a post. */
const NOISE_FILE_RE =
	/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|\.gitignore|\.editorconfig)$/;

/** Scopes that mean "the machinery", not "the product". */
const NOISE_SCOPES = new Set(['deps', 'dependencies', 'lockfile', 'ci', 'infra-ci', 'typo']);

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/**
 * @typedef {Object} Classification
 * @property {'holder'|'developer'|'internal'} audience
 * @property {number} signal 0..1, rounded to 2 decimals
 * @property {boolean} noise true when the commit carries no reader-facing meaning
 * @property {{rule: string, delta: number, note: string}[]} reasons
 */

/**
 * Classify one commit.
 *
 * @param {object} commit raw GitHub commit or a parseCommit() record
 * @param {{productScopes?: string[], noiseScopes?: string[]}} [options]
 *   productScopes are the parts of the repo a reader cares about by name;
 *   naming yours is the single highest-leverage tuning knob here.
 * @returns {Classification}
 */
export function classify(commit, options = {}) {
	const c = commit && commit.subject !== undefined ? commit : parseCommit(commit);
	const productScopes = new Set((options.productScopes || []).map((s) => s.toLowerCase()));
	const noiseScopes = new Set([
		...NOISE_SCOPES,
		...(options.noiseScopes || []).map((s) => s.toLowerCase()),
	]);

	const reasons = [];
	const add = (rule, delta, note) => {
		reasons.push({ rule, delta: Number(delta.toFixed(2)), note });
	};

	let signal = c.type && TYPE_SIGNAL[c.type] !== undefined ? TYPE_SIGNAL[c.type] : 0.4;
	add(
		c.type ? `type:${c.type}` : 'type:none',
		signal,
		c.type ? `conventional type "${c.type}"` : 'no conventional type; scored mid-scale',
	);

	let audience = (c.type && TYPE_AUDIENCE[c.type]) || 'developer';
	let noise = false;

	if (c.merge) {
		signal = 0;
		audience = 'internal';
		noise = true;
		add('merge', -1, 'merge commit: the merged commits carry the content');
	}

	const scope = (c.scope || '').toLowerCase();
	if (scope && noiseScopes.has(scope)) {
		signal -= 0.25;
		audience = 'internal';
		noise = true;
		add(`scope:${scope}`, -0.25, 'scope is machinery, not product');
	} else if (scope && productScopes.has(scope)) {
		signal += 0.12;
		add(`scope:${scope}`, 0.12, 'named product scope');
	}

	if (c.breaking) {
		signal += 0.25;
		if (audience === 'internal') audience = 'developer';
		add('breaking', 0.25, 'breaking change: every consumer needs to know');
	}

	if (c.revert) {
		add('revert', 0, 'revert: kept visible, a rollback is news');
		if (audience === 'internal') audience = 'developer';
	}

	if (Array.isArray(c.files) && c.files.length > 0) {
		const meaningful = c.files.filter((f) => !NOISE_FILE_RE.test(f));
		if (meaningful.length === 0) {
			signal = 0;
			audience = 'internal';
			noise = true;
			add('files:lockfile-only', -1, 'touches only lockfiles and dotfiles');
		} else {
			const publicSurface = meaningful.some((f) => /^(api|src|pages|public|packages)\//.test(f));
			if (publicSurface) {
				signal += 0.08;
				add('files:public-surface', 0.08, 'touches a user-reachable surface');
			}
			if (meaningful.every((f) => /^(docs|README|\.github)/.test(f))) {
				audience = audience === 'holder' ? 'developer' : audience;
				add('files:docs-only', 0, 'documentation only');
			}
		}
	}

	const desc = c.description || c.subject || '';
	if (desc.length < 12) {
		signal -= 0.15;
		add('description:terse', -0.15, 'description too short to tell a reader anything');
	} else if (desc.length > 40) {
		signal += 0.06;
		add('description:explanatory', 0.06, 'description explains the change');
	}

	signal = clamp01(signal);
	if (signal >= 0.55 && audience === 'developer' && c.type === 'feat') audience = 'holder';
	if (signal <= 0.15 && !noise) {
		audience = 'internal';
		add('signal:floor', 0, 'scored below the reader-interest floor');
	}

	return { audience, signal: Number(signal.toFixed(2)), noise, reasons };
}

/** Rank order for the three audiences, widest first. */
export const AUDIENCE_RANK = { holder: 3, developer: 2, internal: 1 };

/**
 * Filter a list of commits down to one audience and above.
 * `minAudience: 'developer'` keeps holder + developer, drops internal.
 */
export function filterByAudience(commits, minAudience = 'internal', options = {}) {
	const floor = AUDIENCE_RANK[minAudience] || 1;
	return commits.filter((c) => AUDIENCE_RANK[classify(c, options).audience] >= floor);
}
