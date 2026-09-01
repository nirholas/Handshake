/**
 * Wizard return contract (src/shared/wizard-return.js).
 *
 * The /start wizard sends people to an avatar-producing page and expects the
 * finished avatar handed back. These tests pin the safety rules of that hop:
 * only a same-origin /start path is ever stored, stale entries expire, and
 * the hand-back URL carries the avatar fields the wizard reads.
 */
import { describe, it, expect } from 'vitest';
import {
	sanitizeWizardReturn,
	captureWizardReturn,
	pendingWizardReturn,
	clearWizardReturn,
	wizardReturnUrl,
	WIZARD_RETURN_KEY,
	WIZARD_RETURN_TTL_MS,
} from '../src/shared/wizard-return.js';

const ORIGIN = 'https://three.ws';

function memoryStorage() {
	const map = new Map();
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k),
	};
}

describe('sanitizeWizardReturn', () => {
	it('accepts a bare /start path and keeps its query', () => {
		expect(sanitizeWizardReturn('/start?from=selfie', ORIGIN)).toBe('/start?from=selfie');
	});
	it('accepts an absolute same-origin /start URL', () => {
		expect(sanitizeWizardReturn('https://three.ws/start', ORIGIN)).toBe('/start');
	});
	it('rejects other origins, protocol-relative hosts, and non-wizard paths', () => {
		expect(sanitizeWizardReturn('https://evil.example/start', ORIGIN)).toBeNull();
		expect(sanitizeWizardReturn('//evil.example/start', ORIGIN)).toBeNull();
		expect(sanitizeWizardReturn('/dashboard', ORIGIN)).toBeNull();
		expect(sanitizeWizardReturn('/startup', ORIGIN)).toBeNull();
		expect(sanitizeWizardReturn('javascript:alert(1)', ORIGIN)).toBeNull();
		expect(sanitizeWizardReturn('', ORIGIN)).toBeNull();
		expect(sanitizeWizardReturn(null, ORIGIN)).toBeNull();
	});
});

describe('captureWizardReturn / pendingWizardReturn', () => {
	it('stores a valid next= target and reads it back', () => {
		const storage = memoryStorage();
		const url = new URL('https://three.ws/create/selfie?wizard=1&next=%2Fstart%3Ffrom%3Dselfie');
		expect(captureWizardReturn({ url, storage, now: 1000 })).toBe('/start?from=selfie');
		expect(pendingWizardReturn({ storage, now: 2000 })).toBe('/start?from=selfie');
	});
	it('ignores an invalid next= target and leaves storage untouched', () => {
		const storage = memoryStorage();
		const url = new URL('https://three.ws/create?next=https%3A%2F%2Fevil.example%2Fstart');
		expect(captureWizardReturn({ url, storage })).toBeNull();
		expect(storage.getItem(WIZARD_RETURN_KEY)).toBeNull();
	});
	it('expires an entry older than the TTL', () => {
		const storage = memoryStorage();
		const url = new URL('https://three.ws/create?next=%2Fstart');
		captureWizardReturn({ url, storage, now: 0 });
		expect(pendingWizardReturn({ storage, now: WIZARD_RETURN_TTL_MS + 1 })).toBeNull();
		expect(storage.getItem(WIZARD_RETURN_KEY)).toBeNull();
	});
	it('survives a corrupt entry', () => {
		const storage = memoryStorage();
		storage.setItem(WIZARD_RETURN_KEY, '{not json');
		expect(pendingWizardReturn({ storage })).toBeNull();
	});
	it('clears on demand', () => {
		const storage = memoryStorage();
		captureWizardReturn({ url: new URL('https://three.ws/create?next=%2Fstart'), storage });
		clearWizardReturn({ storage });
		expect(pendingWizardReturn({ storage })).toBeNull();
	});
});

describe('wizardReturnUrl', () => {
	it('appends the avatar fields the wizard reads and preserves the stored query', () => {
		const out = wizardReturnUrl('/start?from=selfie', {
			avatarId: 'ava-1',
			avatarName: 'Luna 100%',
			avatarThumb: 'https://cdn.example/t.png?x=1&y=2',
		});
		const url = new URL(out, ORIGIN);
		expect(url.pathname).toBe('/start');
		expect(url.searchParams.get('from')).toBe('selfie');
		expect(url.searchParams.get('avatarId')).toBe('ava-1');
		expect(url.searchParams.get('avatarName')).toBe('Luna 100%');
		expect(url.searchParams.get('avatarThumb')).toBe('https://cdn.example/t.png?x=1&y=2');
	});
	it('omits empty optional fields', () => {
		expect(wizardReturnUrl('/start', { avatarId: 'a' })).toBe('/start?avatarId=a');
	});
});
