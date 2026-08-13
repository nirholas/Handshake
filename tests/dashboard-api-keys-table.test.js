// @vitest-environment jsdom
//
// The API keys table on /dashboard/api.
//
// GET /api/keys deliberately returns the caller's whole key history, revoked
// and expired rows included, so the dashboard can show it (docs/developer-
// platform.md pins that contract). The table used to ignore both flags: a
// revoked key rendered exactly like a live one and kept an armed Revoke button
// whose only possible answer was 404, and an expired key looked healthy until a
// request failed somewhere else with no explanation. These pin the status
// derivation and the button gating that fixed it.

import { describe, it, expect } from 'vitest';

const { keyStatus, renderKeysTable } = await import('../src/dashboard-next/pages/api.js');

const DAY = 86_400_000;
const base = {
	id: '2c25ec0c-f1a3-475d-9a9f-fe926c832db5',
	name: 'ci runner',
	prefix: 'sk_live_abcd',
	scope: 'avatars:read',
	created_at: new Date(Date.now() - 30 * DAY).toISOString(),
	last_used_at: null,
	expires_at: null,
	revoked_at: null,
};

describe('keyStatus', () => {
	it('calls a usable key active', () => {
		expect(keyStatus(base)).toMatchObject({ label: 'Active', dead: false });
	});

	it('calls a revoked key dead even when its expiry is still in the future', () => {
		const k = { ...base, revoked_at: new Date().toISOString(), expires_at: new Date(Date.now() + DAY).toISOString() };
		expect(keyStatus(k)).toMatchObject({ label: 'Revoked', dead: true });
	});

	it('calls a key past its expiry dead', () => {
		expect(keyStatus({ ...base, expires_at: new Date(Date.now() - DAY).toISOString() })).toMatchObject({
			label: 'Expired',
			dead: true,
		});
	});

	it('leaves a key with a future expiry active', () => {
		expect(keyStatus({ ...base, expires_at: new Date(Date.now() + DAY).toISOString() })).toMatchObject({
			label: 'Active',
			dead: false,
		});
	});
});

describe('renderKeysTable', () => {
	function rowFor(key) {
		const host = document.createElement('div');
		host.innerHTML = renderKeysTable([key]);
		return host.querySelector('tbody tr');
	}

	it('gives a live key a revoke button and no muted styling', () => {
		const row = rowFor(base);
		expect(row.querySelector('[data-act="revoke"]')).toBeTruthy();
		expect(row.classList.contains('dn-row-muted')).toBe(false);
		expect(row.textContent).toContain('Active');
	});

	it('disarms the revoke button on an already-revoked key', () => {
		const row = rowFor({ ...base, revoked_at: new Date().toISOString() });
		expect(row.querySelector('[data-act="revoke"]')).toBeNull();
		expect(row.classList.contains('dn-row-muted')).toBe(true);
		expect(row.textContent).toContain('Revoked');
	});

	it('marks an expired key but leaves it revocable', () => {
		const row = rowFor({ ...base, expires_at: new Date(Date.now() - DAY).toISOString() });
		expect(row.textContent).toContain('Expired');
		expect(row.querySelector('[data-act="revoke"]')).toBeTruthy();
	});

	it('escapes a hostile key name instead of injecting it', () => {
		const row = rowFor({ ...base, name: '<img src=x onerror=alert(1)>' });
		expect(row.querySelector('img')).toBeNull();
		expect(row.textContent).toContain('<img src=x onerror=alert(1)>');
	});

	it('renders one chip per granted scope', () => {
		const row = rowFor({ ...base, scope: 'avatars:read agents:write' });
		const chips = [...row.querySelectorAll('.dn-chip-row .dn-tag')].map((el) => el.textContent);
		expect(chips).toEqual(['avatars:read', 'agents:write']);
	});
});
