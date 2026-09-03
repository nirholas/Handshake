// Glance widget tokens: the shape and the parts that need no database.

import { describe, it, expect } from 'vitest';
import { mintPlaintext, looksLikeGlanceToken, prefixOf, GLANCE_TOKEN_PREFIX } from '../api/_lib/glance-tokens.js';
import { androidLinkUrl, appleLinkUrl, ANDROID_PACKAGE } from '../api/glance/token.js';

describe('glance widget tokens', () => {
	it('mint a prefixed, url-safe plaintext that the shape check accepts', () => {
		const token = mintPlaintext();
		expect(token.startsWith(GLANCE_TOKEN_PREFIX)).toBe(true);
		expect(token).toHaveLength(36);
		expect(looksLikeGlanceToken(token)).toBe(true);
		expect(prefixOf(token)).toBe(token.slice(0, 10));
		expect(mintPlaintext()).not.toBe(token);
	});

	it('reject everything that is not a widget token, without touching the database', () => {
		for (const bad of ['', null, undefined, 42, 'glw_', 'glw_short', 'sk_live_' + 'a'.repeat(32), `${'x'.repeat(36)}`]) {
			expect(looksLikeGlanceToken(bad)).toBe(false);
		}
	});

	it('hand the token to the Android app through an intent URL only our package can claim', () => {
		const token = mintPlaintext();
		const url = androidLinkUrl(token);
		expect(url.startsWith('intent://glance/link?token=')).toBe(true);
		expect(url).toContain(`package=${ANDROID_PACKAGE}`);
		expect(url).toContain('scheme=threews');
		expect(url).toContain('S.browser_fallback_url=');
		expect(url).toContain(encodeURIComponent(token));
	});

	it('hand the token to an Apple app through the scheme both of them register', () => {
		const token = mintPlaintext();
		const url = appleLinkUrl(token);
		// The Mac app and the iPhone app claim this natively (see
		// apple/GlanceKit/GlanceLink.swift and ios/native/App/App/SceneDelegate.swift),
		// so the credential never reaches a web view.
		expect(url.startsWith('threews://glance/link?token=')).toBe(true);
		expect(url).toContain(encodeURIComponent(token));
		expect(new URL(url).searchParams.get('token')).toBe(token);
	});

	it('escape a token into both link URLs rather than pasting it raw', () => {
		// The plaintext is url-safe base64 by construction, so this is a
		// regression guard on the builders and not on the alphabet.
		const hostile = 'glw_' + 'a'.repeat(28) + '&x=1';
		expect(appleLinkUrl(hostile)).toContain(encodeURIComponent(hostile));
		expect(appleLinkUrl(hostile)).not.toContain('&x=1');
		expect(androidLinkUrl(hostile)).toContain(encodeURIComponent(hostile));
	});
});
