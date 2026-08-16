// The X OAuth scope sets and the guards each lane holds a connection to.
//
// What this pins is a privacy property, not a formatting one: an owner who
// connects X only to seed an agent's memory must never be asked for permission
// to post as them. That is true only while the read set stays free of write
// scopes, an unrecognised scope name falls back to the full set (so a typo can
// never silently narrow a posting connect), and the guards read a connection's
// recorded scopes the same way on both sides.

import { describe, it, expect } from 'vitest';
import {
	X_SCOPE_SETS,
	X_DEFAULT_SCOPE_SET,
	X_SEED_REQUIRED_SCOPES,
	X_POST_REQUIRED_SCOPES,
	resolveScopeSet,
	parseScopes,
	missingScopes,
	hasScopes,
	isReadOnlyConnection,
} from '../../api/_lib/x-scopes.js';

const WRITE_SCOPES = ['tweet.write', 'media.write', 'like.write', 'follows.write', 'dm.write'];

describe('scope sets', () => {
	it('asks for nothing that writes in the read set', () => {
		for (const scope of X_SCOPE_SETS.read) {
			expect(WRITE_SCOPES).not.toContain(scope);
			expect(scope.endsWith('.write')).toBe(false);
		}
	});

	it('covers everything seeding reads in the read set', () => {
		for (const required of X_SEED_REQUIRED_SCOPES) {
			expect(X_SCOPE_SETS.read).toContain(required);
		}
	});

	it('covers both lanes in the full set', () => {
		for (const required of [...X_SEED_REQUIRED_SCOPES, ...X_POST_REQUIRED_SCOPES]) {
			expect(X_SCOPE_SETS.full).toContain(required);
		}
	});

	it('keeps offline.access in both sets so connections survive a token expiry', () => {
		expect(X_SCOPE_SETS.read).toContain('offline.access');
		expect(X_SCOPE_SETS.full).toContain('offline.access');
	});
});

describe('resolveScopeSet', () => {
	it('resolves the read set by name', () => {
		const set = resolveScopeSet('read');
		expect(set.name).toBe('read');
		expect(set.value).toBe('tweet.read users.read offline.access');
	});

	it('resolves the full set by name', () => {
		expect(resolveScopeSet('full').name).toBe('full');
	});

	it('tolerates case and surrounding space in a query param', () => {
		expect(resolveScopeSet(' READ ').name).toBe('read');
	});

	it('falls back to the full set for anything unrecognised', () => {
		for (const input of [undefined, null, '', 'write', 'admin', 42, {}, 'constructor', '__proto__']) {
			expect(resolveScopeSet(input).name).toBe(X_DEFAULT_SCOPE_SET);
		}
	});

	it('hands back a space-separated value ready for the authorize URL', () => {
		const set = resolveScopeSet('full');
		expect(set.value.split(' ')).toEqual([...set.scopes]);
	});
});

describe('parseScopes', () => {
	it('reads the space-separated string X returns', () => {
		expect(parseScopes('tweet.read users.read offline.access')).toEqual([
			'tweet.read', 'users.read', 'offline.access',
		]);
	});

	it('tolerates commas and repeated whitespace', () => {
		expect(parseScopes('tweet.read,  users.read')).toEqual(['tweet.read', 'users.read']);
	});

	it('reads an array unchanged and an absent value as empty', () => {
		expect(parseScopes(['tweet.read'])).toEqual(['tweet.read']);
		expect(parseScopes(null)).toEqual([]);
		expect(parseScopes(undefined)).toEqual([]);
		expect(parseScopes('   ')).toEqual([]);
	});
});

describe('missingScopes', () => {
	it('names exactly what a narrow connection lacks', () => {
		expect(missingScopes('users.read offline.access', X_SEED_REQUIRED_SCOPES)).toEqual(['tweet.read']);
		expect(missingScopes('tweet.read users.read', X_POST_REQUIRED_SCOPES)).toEqual(['tweet.write']);
	});

	it('finds nothing missing when the connection covers the lane', () => {
		expect(missingScopes(X_SCOPE_SETS.read.join(' '), X_SEED_REQUIRED_SCOPES)).toEqual([]);
		expect(missingScopes(X_SCOPE_SETS.full.join(' '), X_POST_REQUIRED_SCOPES)).toEqual([]);
	});

	it('treats unrecorded scopes as unknown rather than as nothing granted', () => {
		// Connections made before the callback stored scopes must keep working.
		expect(missingScopes('', X_SEED_REQUIRED_SCOPES)).toEqual([]);
		expect(missingScopes(null, X_POST_REQUIRED_SCOPES)).toEqual([]);
		expect(hasScopes('', X_POST_REQUIRED_SCOPES)).toBe(true);
	});
});

describe('isReadOnlyConnection', () => {
	it('recognises a connection made for seeding', () => {
		expect(isReadOnlyConnection(X_SCOPE_SETS.read.join(' '))).toBe(true);
	});

	it('does not call a posting connection read-only', () => {
		expect(isReadOnlyConnection(X_SCOPE_SETS.full.join(' '))).toBe(false);
	});

	it('does not guess about a connection with no recorded scopes', () => {
		expect(isReadOnlyConnection('')).toBe(false);
		expect(isReadOnlyConnection(null)).toBe(false);
	});
});
