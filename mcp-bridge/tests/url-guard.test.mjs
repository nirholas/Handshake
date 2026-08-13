// Hermetic tests for src/url-guard.js — no network/DNS required.
//
// We test literal-IP URLs (which skip DNS) and scheme/allowlist policy so the
// suite is deterministic and offline. Run: node tests/url-guard.test.mjs
// Exits non-zero on the first failure.

import { assertPayableUrl, isBlockedAddress, maxPriceAtomic } from '../src/url-guard.js';

let passed = 0;
function pass(msg) {
	passed++;
	console.log('PASS:', msg);
}
function fail(msg) {
	console.error('FAIL:', msg);
	process.exit(1);
}

async function expectReject(url, label) {
	try {
		await assertPayableUrl(url);
		fail(`${label} — expected rejection but it was allowed: ${url}`);
	} catch {
		pass(`${label} (${url})`);
	}
}

async function expectAllow(url, label) {
	try {
		const out = await assertPayableUrl(url);
		if (typeof out !== 'string' || !out) fail(`${label} — returned non-string: ${out}`);
		pass(`${label} (${url})`);
	} catch (err) {
		fail(`${label} — expected allow but rejected: ${url} :: ${err?.message}`);
	}
}

function withEnv(overrides, fn) {
	const saved = {};
	for (const k of Object.keys(overrides)) {
		saved[k] = process.env[k];
		if (overrides[k] === undefined) delete process.env[k];
		else process.env[k] = overrides[k];
	}
	return Promise.resolve()
		.then(fn)
		.finally(() => {
			for (const k of Object.keys(overrides)) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
		});
}

async function main() {
	// --- scheme policy ---
	await expectReject('file:///etc/passwd', 'file:// rejected');
	await expectReject('ftp://example.com/x', 'ftp:// rejected');
	await expectReject('data:text/plain,hi', 'data: rejected');
	await expectReject('gopher://8.8.8.8/x', 'gopher:// rejected');
	await expectReject('not a url', 'unparseable URL rejected');

	// http rejected by default, allowed only behind the dev opt-in.
	await withEnv({ MCP_BRIDGE_ALLOW_HTTP: undefined }, () =>
		expectReject('http://8.8.8.8/x', 'http:// rejected without MCP_BRIDGE_ALLOW_HTTP'),
	);
	await withEnv({ MCP_BRIDGE_ALLOW_HTTP: '1' }, () =>
		expectAllow('http://8.8.8.8/x', 'http:// allowed with MCP_BRIDGE_ALLOW_HTTP=1 (public IP)'),
	);

	// --- SSRF: private / metadata / loopback literal IPs (https, no DNS) ---
	await expectReject('https://169.254.169.254/latest/meta-data/', 'cloud metadata IP rejected');
	await expectReject('https://10.0.0.1/x', '10.0.0.0/8 rejected');
	await expectReject('https://172.16.5.4/x', '172.16.0.0/12 rejected');
	await expectReject('https://192.168.1.1/x', '192.168.0.0/16 rejected');
	await expectReject('https://127.0.0.1/x', 'loopback 127.0.0.1 rejected');
	await expectReject('https://0.0.0.0/x', 'unspecified 0.0.0.0 rejected');
	await expectReject('https://100.64.1.1/x', 'CGNAT 100.64.0.0/10 rejected');
	await expectReject('https://[::1]/x', 'IPv6 loopback ::1 rejected');
	await expectReject('https://[fd00::1]/x', 'IPv6 ULA fc00::/7 rejected');
	await expectReject('https://[fe80::1]/x', 'IPv6 link-local fe80::/10 rejected');
	await expectReject('https://[::ffff:10.0.0.1]/x', 'IPv4-mapped private rejected');

	// http://localhost & http://10.0.0.1 explicitly (require the http opt-in to
	// reach the IP check; without it the scheme rejection fires first — both
	// must reject). localhost resolves via DNS to a loopback address.
	await withEnv({ MCP_BRIDGE_ALLOW_HTTP: '1' }, async () => {
		await expectReject('http://10.0.0.1/x', 'http://10.0.0.1 rejected (private)');
		await expectReject('http://localhost/x', 'http://localhost rejected (resolves loopback)');
	});

	// --- public literal IPs allowed (https) ---
	await expectAllow('https://8.8.8.8/x', 'public 8.8.8.8 allowed');
	await expectAllow('https://93.184.216.34/x', 'public 93.184.216.34 allowed');

	// --- host allowlist mode ---
	await withEnv({ MCP_BRIDGE_ALLOWED_HOSTS: '8.8.8.8' }, async () => {
		await expectAllow('https://8.8.8.8/x', 'allowlisted host allowed');
		await expectReject('https://93.184.216.34/x', 'non-allowlisted host rejected');
	});

	// --- isBlockedAddress unit checks ---
	if (!isBlockedAddress('127.0.0.1')) fail('isBlockedAddress(127.0.0.1) should be true');
	if (isBlockedAddress('8.8.8.8')) fail('isBlockedAddress(8.8.8.8) should be false');
	if (!isBlockedAddress('::1')) fail('isBlockedAddress(::1) should be true');
	if (!isBlockedAddress('not-an-ip')) fail('isBlockedAddress(non-IP) should be true');
	pass('isBlockedAddress literal-IP classification');

	// --- maxPriceAtomic shared helper ---
	await withEnv({ MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC: undefined }, () => {
		if (maxPriceAtomic() !== 100_000n)
			fail('maxPriceAtomic default should be 100_000n even when unset');
	});
	await withEnv({ MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC: '250000' }, () => {
		if (maxPriceAtomic() !== 250_000n)
			fail('maxPriceAtomic should parse env value');
	});
	await withEnv({ MCP_BRIDGE_MAX_PRICE_PER_CALL_ATOMIC: '-5' }, () => {
		try {
			maxPriceAtomic();
			fail('maxPriceAtomic should reject negative');
		} catch {
			/* expected */
		}
	});
	pass('maxPriceAtomic effective-cap semantics');

	console.log(`\nAll ${passed} url-guard checks passed.`);
}

main().catch((err) => {
	console.error('FATAL:', err?.stack || err);
	process.exit(1);
});
