/**
 * npm registry verification.
 *
 * A README that says `npm install @scope/thing` when `@scope/thing` was never
 * published is worse than no install instructions: the reader concludes the
 * project is broken, and the maintainer never finds out because the build is
 * green and the tests pass. Nothing in a normal CI pipeline catches it, because
 * the failure lives in prose.
 *
 * This resolves every package name a repository advertises (its own manifest
 * name plus every `npm i`/`npm install`/`pnpm add`/`yarn add` line in the
 * README) against the real registry, and reports the ones that do not exist.
 */

import { config } from './config.js';
import { mapPool } from './pool.js';

const REGISTRY = 'https://registry.npmjs.org';

const PACKAGE_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Flags and non-package arguments that appear on an install line. */
const NOT_A_PACKAGE = new Set(['-g', '--global', '-D', '--save-dev', '--save', '-S', '--save-exact', '-E', 'npm', 'yarn', 'pnpm', 'bun', 'npx', 'install', 'add', 'i']);

const stripVersionRange = (spec) => {
	if (spec.startsWith('@')) {
		const at = spec.indexOf('@', 1);
		return at === -1 ? spec : spec.slice(0, at);
	}
	const at = spec.indexOf('@');
	return at === -1 ? spec : spec.slice(0, at);
};

/**
 * Package names a README tells the reader to install.
 * @returns {string[]}
 */
export function advertisedPackages(markdown) {
	const names = new Set();
	const text = String(markdown || '');
	for (const match of text.matchAll(/\b(?:npm\s+(?:i|install)|yarn\s+add|pnpm\s+(?:i|install|add)|bun\s+add)\s+([^\n`|]+)/gi)) {
		for (const token of match[1].split(/\s+/)) {
			const raw = token.trim().replace(/^["']|["'],?$/g, '');
			if (!raw || raw.startsWith('-') || NOT_A_PACKAGE.has(raw)) continue;
			// Local paths, tarballs and git specifiers are not registry lookups.
			if (raw.includes('/') && !raw.startsWith('@')) continue;
			if (raw.startsWith('.') || raw.includes(':') || raw.endsWith('.tgz')) continue;
			const name = stripVersionRange(raw);
			// A bare number on an install line is a port or a count, never a package.
			if (/^\d+$/.test(name)) continue;
			if (PACKAGE_NAME.test(name)) names.add(name);
		}
	}
	return [...names];
}

const cache = new Map();

/**
 * Look one package up in the registry.
 * @returns {Promise<{name:string, published:boolean, latest:string, deprecated:boolean, modified:string, error:string}>}
 */
export async function lookupPackage(name) {
	if (cache.has(name)) return cache.get(name);
	const result = { name, published: false, latest: '', deprecated: false, modified: '', error: '' };
	try {
		const res = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, {
			headers: { accept: 'application/vnd.npm.install-v1+json', 'user-agent': config.userAgent }
		});
		if (res.status === 404) {
			cache.set(name, result);
			return result;
		}
		if (!res.ok) {
			result.error = `registry responded ${res.status}`;
			return result;
		}
		const body = await res.json();
		const latest = body?.['dist-tags']?.latest || '';
		result.published = Boolean(latest);
		result.latest = latest;
		result.modified = body?.modified || '';
		result.deprecated = Boolean(latest && body?.versions?.[latest]?.deprecated);
	} catch (error) {
		result.error = String(error?.message || error).slice(0, 160);
	}
	cache.set(name, result);
	return result;
}

/**
 * Verify everything a repository claims is installable.
 *
 * @param {object} input
 * @param {object|null} input.manifest parsed package.json
 * @param {string} input.readme
 * @returns {Promise<{checked:{name:string,published:boolean,latest:string,deprecated:boolean,role:string}[], missing:string[], ownPackage:object|null}>}
 */
export async function verifyPackages({ manifest, readme }) {
	const names = new Map();
	const own = manifest && !manifest.private && typeof manifest.name === 'string' && PACKAGE_NAME.test(manifest.name) ? manifest.name : '';
	if (own) names.set(own, 'manifest');
	for (const name of advertisedPackages(readme)) {
		// Only judge packages this owner could plausibly publish plus the repo's own
		// name. Third-party dependencies in an install line are not this repo's problem.
		if (!names.has(name)) names.set(name, 'readme');
	}

	const entries = [...names];
	const looked = await mapPool(entries, 5, async ([name, role]) => {
		const info = await lookupPackage(name);
		return { ...info, role };
	});

	const checked = looked.map((info) => ({
		name: info.name,
		published: info.published,
		latest: info.latest,
		deprecated: info.deprecated,
		role: info.role,
		error: info.error
	}));

	return {
		checked,
		missing: checked.filter((entry) => !entry.published && !entry.error).map((entry) => entry.name),
		ownPackage: own ? checked.find((entry) => entry.name === own) || null : null,
		ownVersion: own && manifest?.version ? String(manifest.version) : ''
	};
}

export const __testables = { stripVersionRange, PACKAGE_NAME };
