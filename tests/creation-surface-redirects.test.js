/**
 * Route contract for the creation-surface consolidation.
 *
 * Every merged surface is a live URL people have bookmarked, linked from other
 * sites, and pasted into docs. `server/index.mjs` matches `vercel.json` routes
 * against the PATHNAME only and emits `Location` verbatim, so a status-only
 * route silently DROPS the query string. A retired route that carried
 * meaningful configuration therefore needs two rules: a `has`-gated rewrite for
 * the parameter-carrying form (a rewrite keeps the query) and a 301 for the
 * bare path.
 *
 * These assertions run against the production resolver itself
 * (server/route-resolve.mjs), not a re-implementation, so they cannot drift
 * away from what actually serves traffic.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadRouteTable, resolvePhase1 } from '../server/route-resolve.mjs';

const { phase1Routes } = loadRouteTable(fileURLToPath(new URL('../vercel.json', import.meta.url)));

function resolve(target) {
	const url = new URL(`http://three.ws${target}`);
	const r = resolvePhase1(phase1Routes, { headers: {} }, url);
	const location = r.headers?.Location || r.headers?.location || null;
	return { status: r.status || null, location, path: r.path, external: r.external };
}

describe('retired creation surfaces redirect to a live destination', () => {
	it.each([
		['/embed', '/studio'],
		['/embed/', '/studio'],
		['/scan', '/create/selfie'],
		['/agent/new', '/create-agent'],
		['/create/character', '/play'],
		['/create-character', '/play'],
	])('%s 301s to %s', (from, to) => {
		const r = resolve(from);
		expect(r.status).toBe(301);
		expect(r.location).toBe(to);
	});

	it('the retired /avatar-edit landing 301s to a live page', () => {
		const r = resolve('/avatar-edit');
		expect(r.status).toBe(301);
		// The destination is the avatar library rather than the Studio: a bare
		// /avatar-edit means "edit one of my avatars", and Studio's create mode
		// would answer a different question.
		expect(r.location).toBe('/dashboard/avatars');
	});
});

describe('parameter-carrying forms survive as rewrites, not redirects', () => {
	// A rewrite keeps the query string; a 301 would drop it and lose the whole
	// configuration the link was written to carry.
	it.each([
		'/embed?mode=walking&avatar=abc&env=beach&ground=false',
		'/embed?mode=chat&avatar=ada',
		'/embed?avatar=abc',
		'/embed?id=abc',
		'/embed/?mode=idle&avatar=abc',
	])('%s rewrites into the Widget Studio', (target) => {
		const r = resolve(target);
		expect(r.status).toBeNull();
		expect(r.path).toBe('/studio/index.html');
	});

	it('the avatar handoff into the agent wizard keeps its params', () => {
		expect(resolve('/agent/new?avatar_id=abc').path).toBe('/create-agent.html');
		expect(resolve('/agent/new?avatar_glb=https%3A%2F%2Fx%2Fa.glb').path).toBe('/create-agent.html');
	});

	it('the legacy /avatar-edit?id= form still renders the customizer', () => {
		expect(resolve('/avatar-edit?id=abc').path).toBe('/avatar-edit.html');
	});
});

describe('the /embed merge does not shadow the other /embed/* runtimes', () => {
	// These are separate, live embed runtimes that happen to share the prefix.
	// A `/embed/(.*)`-shaped rule would have swallowed every one of them.
	it.each([
		['/embed/v1.js', '/embed/v1.js'],
		['/embed/v1/preview/', '/embed/v1/preview.html'],
		['/embed/avatar', '/avatar-embed.html'],
		['/embed/walk/', '/embed-walk.html'],
		['/embed-demo', '/embed-demo.html'],
	])('%s still resolves to %s', (from, to) => {
		const r = resolve(from);
		expect(r.status).toBeNull();
		expect(r.path).toBe(to);
	});
});

describe('the surfaces the merge kept are still directly reachable', () => {
	it.each([
		['/studio', '/studio/index.html'],
		['/avatar-studio', '/avatar-studio.html'],
		['/avatars/abc/edit', '/avatar-edit.html'],
		['/create-agent', '/create-agent.html'],
		['/start', '/start.html'],
		['/pose', '/pose.html'],
	])('%s serves %s', (from, to) => {
		const r = resolve(from);
		expect(r.status).toBeNull();
		expect(r.path).toBe(to);
	});
});
