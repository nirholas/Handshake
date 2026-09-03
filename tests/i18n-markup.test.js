/**
 * i18n markup integrity, unit tests.
 *
 * Locale values harvested from `data-i18n-html` elements are raw markup, and the
 * runtime puts them back through innerHTML. That makes an HTML entity load-bearing
 * source syntax rather than typography: a model that "helpfully" decodes
 * `<code>&lt;agent-3d&gt;</code>` into `<code><agent-3d></code>` has not changed a
 * character, it has turned a printed code sample into a live custom element that
 * instantiates a 3D avatar in the middle of the docs.
 *
 * Two properties keep that from shipping, and this file pins both:
 *   1. the masker hides entities from the model the same way it hides tags and
 *      glossary terms, so a round trip is byte-identical;
 *   2. lint fails on markup drift (a tag the source never had, or one it lost)
 *      while staying silent on cosmetic entities like `&amp;` and `&mdash;`,
 *      which decode to the same glyph the reader sees either way.
 */

import { describe, expect, it } from 'vitest';

import { buildMasker, lintLocale, markupDrift, tagSignature } from '../scripts/lib/i18n-shared.mjs';
import { configError, isFatalAuthFailure } from '../scripts/i18n-translate.mjs';

const masker = buildMasker(['$THREE', 'three.ws', 'x402']);
const roundTrip = (text, translate = (s) => s) => {
	const { masked, tokens } = masker.mask(text);
	return masker.unmask(translate(masked), tokens);
};

describe('buildMasker', () => {
	it('hides entities from the model and restores them byte-for-byte', () => {
		const src = '&lt;50<span class="unit">KB</span>';
		const { masked } = masker.mask(src);
		expect(masked).not.toContain('&lt;');
		expect(masked).not.toContain('<span');
		expect(roundTrip(src)).toBe(src);
	});

	it('survives a translation that rewrites everything around the sentinels', () => {
		const src = 'Drop <code>&lt;agent-3d&gt;</code> into any page on three.ws';
		const out = roundTrip(src, (m) => m.replace('Drop', 'Füge').replace('into any page on', 'in jede Seite auf'));
		expect(out).toContain('&lt;agent-3d&gt;');
		expect(out).toContain('three.ws');
		expect(markupDrift(src, out)).toBe(false);
	});

	it('keeps a nested run intact when a tag wraps a placeholder', () => {
		const src = '<a href="{{url}}" title="R&amp;D">{{count}} agents</a>';
		expect(roundTrip(src)).toBe(src);
	});

	it('masks numeric entities as well as named ones', () => {
		const src = 'It&#39;s live &mdash; &#x27;now&#x27;';
		expect(masker.mask(src).masked).not.toContain('&');
		expect(roundTrip(src)).toBe(src);
	});

	it('leaves a bare ampersand alone', () => {
		expect(roundTrip('Buy & sell')).toBe('Buy & sell');
	});
});

describe('tagSignature', () => {
	it('ignores the order tags appear in', () => {
		expect(tagSignature('<b>a</b><i>c</i>')).toBe(tagSignature('<i>c</i><b>a</b>'));
	});

	it('does not count an escaped tag as a tag', () => {
		expect(tagSignature('&lt;agent-3d&gt;')).toBe('');
	});
});

describe('markupDrift', () => {
	it('catches an escaped tag that got decoded into a live element', () => {
		expect(markupDrift('<code>&lt;agent-3d&gt;</code>', '<code><agent-3d></code>')).toBe(true);
	});

	it('catches a tag the translation invented', () => {
		expect(markupDrift('Ship fast', 'Ship <b>fast</b>')).toBe(true);
	});

	it('catches a tag the translation dropped', () => {
		expect(markupDrift('Ship <b>fast</b>', 'Ship fast')).toBe(true);
	});

	it('allows cosmetic entities to decode', () => {
		expect(markupDrift('Buy &amp; sell &mdash; today', 'Buy & sell - today')).toBe(false);
	});

	it('allows the copy around the markup to change completely', () => {
		expect(markupDrift('<strong>Fast</strong> by default', '<strong>Schnell</strong> von Haus aus')).toBe(false);
	});
});

describe('lintLocale', () => {
	const source = { sdk: { snippet: 'Drop <code>&lt;agent-3d&gt;</code> in', amp: 'Buy &amp; sell' } };

	it('reports markup drift', () => {
		const problems = lintLocale(source, { sdk: { snippet: 'Setze <code><agent-3d></code> ein', amp: 'Buy & sell' } }, { code: 'de' });
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('[de] markup drift in sdk.snippet:');
	});

	it('formats the problem so --repair can parse the key back out', () => {
		// repairLocale() recovers the failing key with /… in ([^:]+):/, so the
		// message must keep `<key>:` immediately after the rule name or repair
		// silently reports "nothing to repair" on a locale full of drift.
		const [problem] = lintLocale(source, { sdk: { snippet: 'Setze <code><agent-3d></code> ein', amp: 'ok' } }, { code: 'de' });
		expect(/(?:glossary term dropped|placeholder drift|markup drift) in ([^:]+):/.exec(problem)?.[1]).toBe(
			'sdk.snippet',
		);
	});

	it('passes a translation that kept its markup', () => {
		const problems = lintLocale(source, { sdk: { snippet: 'Setze <code>&lt;agent-3d&gt;</code> ein', amp: 'Kaufen & verkaufen' } }, { code: 'de' });
		expect(problems).toEqual([]);
	});
});

/**
 * The English fallback is the pipeline's graceful path for a value a model
 * cannot render as valid JSON. Applied to a credential failure it is a
 * catastrophe instead: the failure repeats identically on every key, so a whole
 * catalog is rewritten into English while lint stays green and the run exits 0.
 * That has now happened three ways in this repo (no .env, no gcloud token, and
 * a token revoked mid-run by a Workspace reauth policy), so the classifier that
 * separates the two is pinned here.
 */
describe('isFatalAuthFailure', () => {
	it('is fatal when the backend is not configured at all', () => {
		expect(isFatalAuthFailure(configError('GOOGLE_CLOUD_PROJECT not set'))).toBe(true);
	});

	it('is fatal on a 401, which is what a revoked token looks like mid-run', () => {
		expect(isFatalAuthFailure(Object.assign(new Error('vertex 401'), { status: 401 }))).toBe(true);
	});

	it('is fatal on a 403', () => {
		expect(isFatalAuthFailure(Object.assign(new Error('vertex 403'), { status: 403 }))).toBe(true);
	});

	// Regression: a spent OpenRouter balance answers every call `402 Insufficient
	// credits`. Classified as retryable, that walked the halve-and-retry path down
	// to single keys and baked English into 198 of them, exiting 0. A payment wall
	// belongs to the account, not to the string, so splitting can never help.
	it('is fatal on a 402, which is a spent balance and not a bad string', () => {
		expect(
			isFatalAuthFailure(
				Object.assign(new Error('openrouter 402: Insufficient credits'), { status: 402 }),
			),
		).toBe(true);
	});

	it('is NOT fatal on a rate limit, which retry and backoff do handle', () => {
		expect(isFatalAuthFailure(Object.assign(new Error('429'), { status: 429 }))).toBe(false);
	});

	// Regression: a free tier that hits its daily cap answers 429 forever. Once
	// the backoff budget is spent that is an exhausted quota, not one bad string,
	// so callBackendWithRetry stamps isQuotaExhausted. Left retryable, the
	// halve-and-retry path walked every key the run had left down to a single
	// key and baked English over each one, then exited as if it had worked.
	it('is fatal once a rate limit has outlived its whole backoff budget', () => {
		expect(
			isFatalAuthFailure(
				Object.assign(new Error('groq 429: rate limit'), { status: 429, isQuotaExhausted: true }),
			),
		).toBe(true);
	});

	it('is NOT fatal on a server error or a bad model reply', () => {
		expect(isFatalAuthFailure(Object.assign(new Error('500'), { status: 500 }))).toBe(false);
		expect(isFatalAuthFailure(new Error('no JSON object in response'))).toBe(false);
	});

	it('tolerates a missing error object', () => {
		expect(isFatalAuthFailure(undefined)).toBe(false);
	});
});
