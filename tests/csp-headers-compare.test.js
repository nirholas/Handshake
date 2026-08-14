// The rule this file pins: a document has to arrive with its `script-src`
// rewritten into hashes, and everything else has to arrive exactly as
// vercel.json declares it.
//
// Both halves have been wrong in production. A page that ships the raw
// `'unsafe-inline'` policy has lost the whole point of per-response hashing and
// must fail. A robots.txt or a .well-known JSON is never rewritten (the server
// only hardens HTML), so demanding hashes of it reports a defect on every
// non-document route the site serves, which is how a real header regression
// gets lost in the noise.

import { describe, it, expect } from 'vitest';
import { headerProblems, policyDiff, parsePolicy } from '../scripts/lib/csp-headers.mjs';

const DECLARED_CSP =
	"base-uri 'self'; object-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://esm.sh; worker-src 'self' blob:; frame-ancestors 'self'";

const HASH = "'sha256-K7gNU3sdo+OL0wNhqoVWhr3g6s1xYv72ol/pe/Unols='";

const declaredBag = () => ({
	'content-security-policy': DECLARED_CSP,
	'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
	'x-content-type-options': 'nosniff',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'cache-control': 'public, max-age=0, must-revalidate',
});

const hardened = DECLARED_CSP.replace("'unsafe-inline'", HASH);

const servedDocument = (csp = hardened) => ({
	...declaredBag(),
	'content-security-policy': csp,
	'content-type': 'text/html; charset=utf-8',
});

const servedText = (csp = DECLARED_CSP) => ({
	...declaredBag(),
	'content-security-policy': csp,
	'content-type': 'text/plain; charset=utf-8',
});

describe('parsePolicy', () => {
	it('splits directives into a source set each', () => {
		const parsed = parsePolicy("script-src 'self' blob:; object-src 'none'");
		expect([...parsed.get('script-src')]).toEqual(["'self'", 'blob:']);
		expect([...parsed.get('object-src')]).toEqual(["'none'"]);
	});

	it('ignores empty segments and trailing semicolons', () => {
		expect([...parsePolicy("base-uri 'self';;").keys()]).toEqual(['base-uri']);
	});
});

describe('policyDiff on a rewritten response', () => {
	it('accepts unsafe-inline replaced by hashes', () => {
		expect(policyDiff(DECLARED_CSP, hardened, true)).toEqual([]);
	});

	it('accepts several hashes in place of the one unsafe-inline', () => {
		const many = DECLARED_CSP.replace("'unsafe-inline'", `${HASH} ${HASH.replace('K7g', 'Zzz')}`);
		expect(policyDiff(DECLARED_CSP, many, true)).toEqual([]);
	});

	it('accepts a document with no inline script at all, which gets no hashes', () => {
		const noInline = DECLARED_CSP.replace(" 'unsafe-inline'", '');
		expect(policyDiff(DECLARED_CSP, noInline, true)).toEqual([]);
	});

	it('rejects a document that kept unsafe-inline instead of hashing', () => {
		const problems = policyDiff(DECLARED_CSP, DECLARED_CSP, true);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("unexpected 'unsafe-inline'");
	});

	it('rejects unsafe-inline smuggled in alongside the hashes', () => {
		const both = DECLARED_CSP.replace("'unsafe-inline'", `'unsafe-inline' ${HASH}`);
		expect(policyDiff(DECLARED_CSP, both, true)[0]).toContain("unexpected 'unsafe-inline'");
	});

	it('rejects a widened source list even when the hashes are right', () => {
		const widened = hardened.replace("script-src 'self'", "script-src 'self' https://evil.example");
		expect(policyDiff(DECLARED_CSP, widened, true)[0]).toContain('https://evil.example');
	});

	it('rejects a dropped directive', () => {
		const dropped = hardened.replace("; object-src 'none'", '');
		expect(policyDiff(DECLARED_CSP, dropped, true)[0]).toContain('"object-src" is missing');
	});

	it('rejects a loosened frame-ancestors', () => {
		const framed = hardened.replace("frame-ancestors 'self'", 'frame-ancestors *');
		expect(policyDiff(DECLARED_CSP, framed, true)[0]).toContain('frame-ancestors');
	});
});

describe('policyDiff on a response the server never rewrites', () => {
	it('accepts the declared policy verbatim', () => {
		expect(policyDiff(DECLARED_CSP, DECLARED_CSP, false)).toEqual([]);
	});

	it('still rejects a policy that differs in any other way', () => {
		const widened = DECLARED_CSP.replace("object-src 'none'", "object-src 'self'");
		expect(policyDiff(DECLARED_CSP, widened, false)[0]).toContain('object-src');
	});
});

describe('headerProblems', () => {
	it('passes a document that carries exactly what is declared', () => {
		expect(headerProblems(declaredBag(), servedDocument())).toEqual([]);
	});

	it('passes a text response that carries the unrewritten policy', () => {
		expect(headerProblems(declaredBag(), servedText())).toEqual([]);
	});

	it('demands the rewrite of a document, not of a text response', () => {
		expect(headerProblems(declaredBag(), servedDocument(DECLARED_CSP))).toHaveLength(1);
		expect(headerProblems(declaredBag(), servedText(DECLARED_CSP))).toEqual([]);
	});

	it('demands the rewrite of any response that already carries hashes', () => {
		const partly = servedText(`${DECLARED_CSP} ${HASH}`);
		expect(headerProblems(declaredBag(), partly)).not.toEqual([]);
	});

	it('reports a security header the response dropped', () => {
		const served = servedDocument();
		delete served['strict-transport-security'];
		expect(headerProblems(declaredBag(), served)).toEqual([
			'strict-transport-security was declared but the response did not carry it',
		]);
	});

	it('reports a weakened HSTS max-age', () => {
		const served = { ...servedDocument(), 'strict-transport-security': 'max-age=300' };
		expect(headerProblems(declaredBag(), served)[0]).toContain('strict-transport-security');
	});

	it('reports a missing declaration, so deleting the rule from vercel.json fails', () => {
		const declared = declaredBag();
		delete declared['x-content-type-options'];
		expect(headerProblems(declared, servedDocument())).toEqual([
			'vercel.json declares no x-content-type-options for this path',
		]);
	});

	it('ignores cache-control, which the CDN legitimately rewrites', () => {
		const served = { ...servedDocument(), 'cache-control': 'public, max-age=31536000, immutable' };
		expect(headerProblems(declaredBag(), served)).toEqual([]);
	});

	it('checks every x- header the route table declares', () => {
		const declared = { ...declaredBag(), 'x-frame-options': 'SAMEORIGIN' };
		const served = { ...servedDocument(), 'x-frame-options': 'ALLOWALL' };
		expect(headerProblems(declared, served)[0]).toContain('x-frame-options');
	});

	it('checks permissions-policy', () => {
		const declared = { ...declaredBag(), 'permissions-policy': 'camera=()' };
		const served = { ...servedDocument(), 'permissions-policy': 'camera=(self)' };
		expect(headerProblems(declared, served)[0]).toContain('permissions-policy');
	});
});
