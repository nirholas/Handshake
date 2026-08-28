// Coverage for solana-mobile/scripts/assetlinks.mjs, the Digital Asset Links
// statement builder shared by build-apk.sh and update-assetlinks.sh.
//
// The load-bearing property: the file lists EVERY certificate the app can be
// signed with. three.ws ships through channels that sign differently (our own
// release key for the Solana dApp Store and direct download, Google's Play App
// Signing key for Play), and a statement file missing one of them costs that
// channel full-screen mode with no local symptom.

import { describe, it, expect } from 'vitest';
import { buildAssetLinks, normalizeFingerprint, extraFingerprintsFrom } from '../solana-mobile/scripts/assetlinks.mjs';

const RELEASE = '98:0A:1A:AB:A3:ED:28:D6:3D:06:69:86:7F:9A:C1:4D:EC:05:F7:78:6D:3A:30:0F:84:00:4D:E8:55:11:13:D7';
const PLAY = 'AB:CD:' + '11:'.repeat(29) + '22';

describe('normalizeFingerprint', () => {
	it('accepts keytool output as-is', () => {
		expect(normalizeFingerprint(RELEASE)).toBe(RELEASE);
	});

	it('upper-cases and re-inserts colons, so a Play Console paste round-trips', () => {
		expect(normalizeFingerprint(RELEASE.replace(/:/g, '').toLowerCase())).toBe(RELEASE);
	});

	it('tolerates surrounding whitespace from a copy/paste', () => {
		expect(normalizeFingerprint(`  ${RELEASE}\n`)).toBe(RELEASE);
	});

	it('rejects anything that is not 32 hex bytes', () => {
		expect(normalizeFingerprint('')).toBeNull();
		expect(normalizeFingerprint(null)).toBeNull();
		expect(normalizeFingerprint('DE:AD:BE:EF')).toBeNull();
		expect(normalizeFingerprint(RELEASE + ':00')).toBeNull();
		expect(normalizeFingerprint('ZZ'.repeat(32))).toBeNull();
	});
});

describe('buildAssetLinks', () => {
	it('emits both relations Chrome needs for a TWA', () => {
		const [stmt] = buildAssetLinks({ packageId: 'ws.three.app', fingerprints: [RELEASE] });
		expect(stmt.relation).toEqual([
			'delegate_permission/common.handle_all_urls',
			'delegate_permission/common.use_as_origin',
		]);
		expect(stmt.target).toMatchObject({ namespace: 'android_app', package_name: 'ws.three.app' });
	});

	it('carries every channel certificate, not just the first', () => {
		const [stmt] = buildAssetLinks({ packageId: 'ws.three.app', fingerprints: [RELEASE, PLAY] });
		expect(stmt.target.sha256_cert_fingerprints).toEqual([RELEASE, PLAY]);
	});

	it('de-duplicates a certificate declared twice in different casing', () => {
		const [stmt] = buildAssetLinks({
			packageId: 'ws.three.app',
			fingerprints: [RELEASE, RELEASE.toLowerCase(), RELEASE.replace(/:/g, '')],
		});
		expect(stmt.target.sha256_cert_fingerprints).toEqual([RELEASE]);
	});

	it('refuses to write a statement file with no certificate', () => {
		expect(() => buildAssetLinks({ packageId: 'ws.three.app', fingerprints: [] })).toThrow(/at least one/);
	});

	it('refuses a malformed fingerprint rather than emitting one Google will not match', () => {
		expect(() => buildAssetLinks({ packageId: 'ws.three.app', fingerprints: ['nope'] })).toThrow(/not a SHA-256/);
	});

	it('requires a package id', () => {
		expect(() => buildAssetLinks({ packageId: '', fingerprints: [RELEASE] })).toThrow(/packageId/);
	});
});

describe('extraFingerprintsFrom', () => {
	it('reads the checked-in config shape', () => {
		expect(extraFingerprintsFrom({ $comment: 'x', fingerprints: [PLAY] })).toEqual([PLAY]);
	});

	it('accepts annotated entries so a key can carry its channel note', () => {
		expect(extraFingerprintsFrom({ fingerprints: [{ channel: 'play', sha256: PLAY }] })).toEqual([PLAY]);
	});

	it('treats a missing or empty config as no extra certificates', () => {
		expect(extraFingerprintsFrom(null)).toEqual([]);
		expect(extraFingerprintsFrom({})).toEqual([]);
		expect(extraFingerprintsFrom({ fingerprints: [] })).toEqual([]);
	});
});
