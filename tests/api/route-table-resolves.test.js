// Guards against PHANTOM ROUTES in vercel.json.
//
// vercel.json is a live config file: server/index.mjs reads its `routes` table
// and, for anything under /api/, hands the path to a filesystem resolver. A
// route whose `dest` has no handler file behind it therefore 404s for every
// caller — but nothing fails at build or deploy time, so the dead route sits in
// the table looking legitimate. Two such routes shipped this way
// (/api/marketplace/skill-reviews and /api/users/me/credits: both declared,
// both `src === dest`, neither had a handler).
//
// This mirrors server/index.mjs's resolveApi() rules — exact file, nested dir,
// [param].js, [param]/ dir, [...rest].js — and asserts every literal /api/ dest
// in the table lands on a real file.

import { describe, it, expect } from 'vitest';
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const API_ROOT = join(REPO, 'api');

const listDir = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []);

/** Mirrors resolveApi() in server/index.mjs. Returns the handler path or null. */
function resolveApi(dir, segments) {
	if (segments.length === 0) {
		const index = join(dir, 'index.js');
		return existsSync(index) ? index : null;
	}
	const [head, ...rest] = segments;

	if (rest.length === 0) {
		const exact = join(dir, `${head}.js`);
		if (existsSync(exact)) return exact;
	}

	const exactDir = join(dir, head);
	if (existsSync(exactDir) && statSync(exactDir).isDirectory()) {
		const hit = resolveApi(exactDir, rest);
		if (hit) return hit;
	}

	const entries = listDir(dir);

	if (rest.length === 0) {
		for (const e of entries) {
			if (e.isFile() && e.name.startsWith('[') && e.name.endsWith('].js') && !e.name.startsWith('[...')) {
				return join(dir, e.name);
			}
		}
	}
	for (const e of entries) {
		if (e.isDirectory() && e.name.startsWith('[') && e.name.endsWith(']') && !e.name.startsWith('[...')) {
			const hit = resolveApi(join(dir, e.name), rest);
			if (hit) return hit;
		}
	}
	for (const e of entries) {
		if (e.isFile() && e.name.startsWith('[...') && e.name.endsWith('].js')) return join(dir, e.name);
	}
	return null;
}

const vercel = JSON.parse(readFileSync(join(REPO, 'vercel.json'), 'utf8'));

/** Literal (non-regex, non-capture) /api/ dests we can resolve statically. */
const apiDests = (vercel.routes || [])
	.filter((r) => typeof r.dest === 'string')
	.map((r) => ({ src: r.src, dest: r.dest.split('?')[0] }))
	.filter((r) => r.dest.startsWith('/api/'))
	// Skip dests carrying a capture group ($1) or regex metacharacters — those
	// expand at request time and cannot be resolved from the table alone.
	.filter((r) => !/[$()[\]*+?|\\]/.test(r.dest));

describe('vercel.json /api route table', () => {
	it('declares at least a few resolvable API routes (sanity)', () => {
		expect(apiDests.length).toBeGreaterThan(50);
	});

	it('every literal /api/ dest resolves to a real handler file', () => {
		const phantoms = [];
		for (const { src, dest } of apiDests) {
			const clean = dest.endsWith('.js') ? dest.slice(0, -3) : dest;
			const segments = clean.slice('/api/'.length).split('/').filter(Boolean);
			if (!resolveApi(API_ROOT, segments)) phantoms.push(`${src} -> ${dest}`);
		}
		expect(phantoms).toEqual([]);
	});
});
