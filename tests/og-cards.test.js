// Coverage for the three dynamic Open Graph card renderers under api/og/.
//
// These endpoints are the face of every shared three.ws link, and they have one
// hard contract in common: a crawler must ALWAYS get an image. Not one of a
// missing id, an unknown id, a hostile id, or a dead upstream may produce a 5xx,
// an HTML error page, or a broken-image box. The second contract is that nothing
// secret and nothing private may reach the pixels.
//
// Each card exposes its pure renderer via __testInternals precisely so the SVG
// can be asserted without a database, a chain read, or a CDN fetch; the handler
// paths that need no network (validation, visibility, fallback) are driven end to
// end against the real default export.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import sealedDropHandler, { __testInternals as sealedInternals } from '../api/og/sealed-drop.js';
import agentHandler, { renderCard as renderAgentCard, __testInternals as agentInternals } from '../api/og/agent.js';
import { __testInternals as badgeInternals } from '../api/og/three-token-badge.js';
import { createDrop, __resetMemoryStore } from '../api/_lib/sealed-drop-store.js';

// Minimal req/res pair that captures exactly what a crawler would see.
async function invoke(handler, url) {
	const chunks = [];
	const headers = {};
	let statusCode = 200;
	const res = {
		setHeader(k, v) { headers[k.toLowerCase()] = v; },
		getHeader(k) { return headers[k.toLowerCase()]; },
		end(buf) { if (buf) chunks.push(Buffer.from(buf)); },
		get statusCode() { return statusCode; },
		set statusCode(v) { statusCode = v; },
	};
	await handler({ method: 'GET', url, headers: { host: 'three.ws' } }, res);
	return { body: Buffer.concat(chunks).toString('utf8'), headers, statusCode };
}

// An SVG a social crawler will actually rasterize: correct root element, the
// 1200x630 unfurl box every platform crops to, and a closed document.
function expectValidCard(svg) {
	expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
	expect(svg).toContain('width="1200"');
	expect(svg).toContain('height="630"');
	expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
	// Nothing executable ever belongs in an image served to a crawler.
	expect(svg).not.toMatch(/<script|<foreignObject|javascript:/i);
}

describe('og/sealed-drop', () => {
	beforeEach(() => { __resetMemoryStore(); });

	// The record shape api/vanity/drops.js stores, secrets included, so the test
	// proves the card reads the public projection rather than the raw record.
	const SEALED_ENVELOPE = 'c2VhbGVkLWNpcGhlcnRleHQtbmV2ZXItcmVuZGVyZWQ';
	const CLAIM_TOKEN_HASH = 'f'.repeat(64);
	const DROP_ID = 'a1b2c3d4e5f607182930a1b2';

	async function seedDrop(over = {}) {
		return createDrop({
			id: DROP_ID,
			protocol: 'three-drop/v1',
			address: 'THREEsynthetic1111111111111111111111111111',
			asset: 'THREE',
			amount: 250,
			amountAtomics: '250000000',
			network: 'solana',
			sealMode: 'claim-time',
			status: 'funded',
			theme: 'birthday',
			senderLabel: 'Ada',
			vanity: { prefix: 'THREE' },
			createdAt: 1_760_000_000_000,
			expiresAt: 1_760_600_000_000,
			fundingConfirmed: true,
			// Secrets that must never reach the card:
			sealedEnvelope: SEALED_ENVELOPE,
			claimTokenHash: CLAIM_TOKEN_HASH,
			...over,
		});
	}

	it('renders a real funded drop from its public projection, and never a secret', async () => {
		await seedDrop();
		const { statusCode, headers, body } = await invoke(sealedDropHandler, `/api/og/sealed-drop?id=${DROP_ID}`);

		expect(statusCode).toBe(200);
		expect(headers['content-type']).toBe('image/svg+xml; charset=utf-8');
		expect(headers['cache-control']).toContain('s-maxage=');
		expectValidCard(body);

		// Real fields off the stored record.
		expect(body).toContain('250 $THREE');
		expect(body).toContain('from Ada');
		expect(body).toContain('Happy birthday');
		expect(body).toContain('SEALED · UNCLAIMED');
		expect(body).toContain('vanity THREE…');

		// The privacy boundary.
		expect(body).not.toContain(SEALED_ENVELOPE);
		expect(body).not.toContain(CLAIM_TOKEN_HASH);
		expect(body).not.toContain('claimTokenHash');
	});

	it('reflects a claimed drop in the status line', async () => {
		await seedDrop({ status: 'claimed', claimedAt: 1_760_100_000_000 });
		const { body } = await invoke(sealedDropHandler, `/api/og/sealed-drop?id=${DROP_ID}`);
		expect(body).toContain('CLAIMED');
		expect(body).not.toContain('UNCLAIMED');
	});

	// Failure path: crawlers hitting a stale, mistyped, or hostile link.
	it.each([
		['no id', '/api/og/sealed-drop'],
		['malformed id', '/api/og/sealed-drop?id=not-a-drop-id'],
		['unknown but well-formed id', '/api/og/sealed-drop?id=0123456789abcdef01234567'],
		['injection attempt', '/api/og/sealed-drop?id=%3Cscript%3Ealert(1)%3C%2Fscript%3E'],
	])('still serves a branded card for %s', async (_label, url) => {
		const { statusCode, headers, body } = await invoke(sealedDropHandler, url);
		expect(statusCode).toBe(200);
		expect(headers['content-type']).toBe('image/svg+xml; charset=utf-8');
		expectValidCard(body);
		expect(body).toContain('A sealed gift');
	});

	it('escapes hostile record text instead of emitting markup', () => {
		const svg = sealedInternals.buildCard({
			status: 'funded',
			amount: 1,
			asset: 'SOL',
			address: 'THREEsynthetic1111111111111111111111111111',
			theme: 'default',
			senderLabel: '"><script>alert(1)</script>',
			vanity: null,
		});
		expectValidCard(svg);
		expect(svg).toContain('&lt;script&gt;');
	});

	// A stored theme is validated at creation (api/vanity/drops.js), but the card
	// must not paint "undefined" if a record ever carries an inherited key.
	it('falls back to the default theme for a non-theme key', () => {
		const svg = sealedInternals.buildCard({
			status: 'funded',
			amount: 5,
			asset: 'SOL',
			address: 'THREEsynthetic1111111111111111111111111111',
			theme: 'constructor',
			senderLabel: null,
			vanity: null,
		});
		expectValidCard(svg);
		expect(svg).toContain('A sealed gift');
		expect(svg).not.toContain('undefined');
	});

	it('shortens a full base58 address and leaves a short one alone', () => {
		const { shortAddr } = sealedInternals;
		expect(shortAddr('THREEsynthetic1111111111111111111111111111')).toBe('THREEsyn…111111');
		expect(shortAddr('short')).toBe('short');
		expect(shortAddr(null)).toBe('');
	});
});

describe('og/three-token-badge', () => {
	const FULL = {
		price: 0.001843, change24h: 13.61, marketCap: 1_843_105,
		volume24h: 136_489.61, holders: 15_603, agents: 3140,
	};

	it('renders every live figure on the card', () => {
		const svg = badgeInternals.renderCard(FULL);
		expectValidCard(svg);
		expect(svg).toContain('$THREE');
		expect(svg).toContain('$0.001843');
		expect(svg).toContain('+13.61%');
		expect(svg).toContain('$1.84M');   // market cap
		expect(svg).toContain('15,603');   // holders, the cell that used to be blank
		expect(svg).toContain('$136.5K');  // 24h volume
		expect(svg).toContain('3,140');    // on-chain agents
		// The only coin this card may ever reference.
		expect(svg).toContain('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
	});

	// Failure path: every upstream down. The card must degrade per-figure, never
	// vanish, and never invent a number.
	it('renders a complete branded card when every figure is unavailable', () => {
		const svg = badgeInternals.renderCard({
			price: null, change24h: null, marketCap: null,
			volume24h: null, holders: null, agents: null,
		});
		expectValidCard(svg);
		expect(svg).toContain('$THREE');
		expect(svg).toContain('MARKET CAP');
		expect(svg).toContain('HOLDERS');
		// No change pill without a change datum, and no fabricated zeroes.
		expect(svg).not.toMatch(/[▲▼]/);
		expect(svg).not.toMatch(/<rect x="\d+" y="300"/);
		expect(svg).not.toContain('$0.00');
	});

	it('formats a sub-cent price in plain decimal, never exponent notation', () => {
		const { fmtPrice } = badgeInternals;
		expect(fmtPrice(0.001843)).toBe('$0.001843');
		expect(fmtPrice(0.00000001234)).not.toContain('e');
		expect(fmtPrice(1234.5)).toBe('$1,234.50');
		expect(fmtPrice(0.5)).toBe('$0.5000');
		expect(fmtPrice(null)).toBe('-');
		expect(fmtPrice(Number.NaN)).toBe('-');
	});

	it('keeps the 24h pill clear of the price at any magnitude', () => {
		const { renderCard, heroTextWidth } = badgeInternals;
		expect(heroTextWidth('$0.00000001234', 84)).toBeGreaterThan(heroTextWidth('$1.00', 84));
		// A long price must not push the pill off the 1200px canvas.
		const svg = renderCard({ ...FULL, price: 0.00000001234 });
		const pillX = Number(/<rect x="(\d+)" y="300"/.exec(svg)?.[1]);
		expect(pillX).toBeGreaterThan(0);
		expect(pillX).toBeLessThan(1128);
	});

	it('compacts USD the way the token page does', () => {
		const { fmtCompactUsd, fmtInt, fmtPct } = badgeInternals;
		expect(fmtCompactUsd(1_843_105)).toBe('$1.84M');
		expect(fmtCompactUsd(136_489.61)).toBe('$136.5K');
		expect(fmtCompactUsd(2_400_000_000)).toBe('$2.40B');
		expect(fmtCompactUsd(null)).toBe('-');
		expect(fmtInt(15_603)).toBe('15,603');
		expect(fmtInt(null)).toBe('-');
		expect(fmtPct(-4.2)).toBe('-4.20%');
		expect(fmtPct(null)).toBeNull();
	});
});

describe('og/agent', () => {
	const ROW = {
		name: 'nova',
		visibility: 'public',
		thumbnail_key: null,
		meta: { solana_address: '7bDyhXcwANT3FBKniiGbvgkc4divijBTRtS8oEBcnJdc' },
	};
	const ID = 'c080c68b-2aeb-4746-b739-41b30cbbf517';

	it('renders a fully enriched wallet card', () => {
		const svg = renderAgentCard({
			id: ID,
			row: { ...ROW, meta: { ...ROW.meta, solana_vanity_prefix: '7bDy' } },
			solAddress: ROW.meta.solana_address,
			balances: { tokens: [{ mint: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump', amount: 4200, usd: 7.7 }], usd: 7.7 },
			rep: { tier: 'trusted', tierLabel: 'Trusted', score: 78.4, accent: '#a5b4fc' },
			pnl: { sol: 1.25, wins: 3 },
			tipsCount: 9,
			achievements: { earned: [{ id: 'migrator', title: 'Serial Migrator', tier: 'gold' }], summary: { earnedCount: 4 } },
			avatarData: null,
		});

		expectValidCard(svg);
		expect(svg).toContain('nova');
		expect(svg).toContain('✦ 7bDy…');            // vanity prefix highlighted
		expect(svg).toContain('★ SERIAL MIGRATOR +3'); // headline badge + remainder
		expect(svg).toContain('TRUSTED');
		expect(svg).toContain('◆ $THREE');             // holder mark
		expect(svg).toContain('+1.25 ◎');              // realized P&L
		expect(svg).toContain(`three.ws/agents/${ID}`);
	});

	// Failure path: every enrichment timed out. The card still renders, and says
	// "unknown" rather than "$0" for a balance it could not read.
	it('renders with no enrichments at all', () => {
		const svg = renderAgentCard({ id: ID, row: { ...ROW, meta: {} } });
		expectValidCard(svg);
		expect(svg).toContain('nova');
		expect(svg).toContain('Wallet provisioning');
		expect(svg).toContain('COMMON');
		expect(svg).not.toContain('$THREE');
		// An unreadable balance and an empty wallet read as blank, not as a fake $0.
		expect(svg).toContain('>-</text>');
		expect(svg).not.toContain('>$0<');
	});

	it('escapes a hostile agent name', () => {
		const svg = renderAgentCard({ id: ID, row: { ...ROW, name: '<script>alert(1)</script>' } });
		expectValidCard(svg);
		expect(svg).toContain('&lt;script&gt;');
	});

	it('redirects a crawler to the static card for an unusable id, without touching the database', async () => {
		for (const url of ['/api/og/agent', '/api/og/agent?id=not-a-uuid', "/api/og/agent?id=%27%20OR%201=1--"]) {
			const { statusCode, headers } = await invoke(agentHandler, url);
			expect(statusCode).toBe(302);
			expect(headers.location).toMatch(/\/og-image\.png$/);
			expect(headers['cache-control']).toBe('no-cache');
		}
	});

	it('picks the migration badge over a higher tier, then the highest tier', () => {
		const { headlineAchievement } = agentInternals;
		expect(headlineAchievement([
			{ id: 'whale', title: 'Whale', tier: 'legendary' },
			{ id: 'graduate', title: 'Graduate', tier: 'bronze' },
		]).id).toBe('graduate');
		expect(headlineAchievement([
			{ id: 'whale', title: 'Whale', tier: 'legendary' },
			{ id: 'starter', title: 'Starter', tier: 'bronze' },
		]).id).toBe('whale');
		expect(headlineAchievement([])).toBeNull();
	});

	// The avatar the card inlines comes off the CDN, so both halves of that read are
	// boundaries: where the bytes are fetched from, and what the remote server says
	// they are. Neither may throw, and neither may reach the SVG unvalidated.
	describe('avatar thumbnail resolution', () => {
		const { avatarImageUrl, imageMime } = agentInternals;
		const KEY = 'u/42/thumbs/nova card.png';
		let savedDomain;

		beforeEach(() => { savedDomain = process.env.S3_PUBLIC_DOMAIN; });
		afterEach(() => {
			if (savedDomain === undefined) delete process.env.S3_PUBLIC_DOMAIN;
			else process.env.S3_PUBLIC_DOMAIN = savedDomain;
		});

		it('resolves a bucket key through the CDN domain and passes an absolute one through', () => {
			process.env.S3_PUBLIC_DOMAIN = 'https://three.ws/cdn';
			expect(avatarImageUrl({ visibility: 'public', thumbnail_key: KEY }))
				.toBe('https://three.ws/cdn/u/42/thumbs/nova%20card.png');
			expect(avatarImageUrl({ visibility: 'unlisted', thumbnail_key: 'https://img.example/a b.png' }))
				.toBe('https://img.example/a b.png');
		});

		it('renders no avatar for a private or thumbnail-less agent', () => {
			process.env.S3_PUBLIC_DOMAIN = 'https://three.ws/cdn';
			expect(avatarImageUrl({ visibility: 'private', thumbnail_key: KEY })).toBeNull();
			expect(avatarImageUrl({ visibility: 'public', thumbnail_key: null })).toBeNull();
			expect(avatarImageUrl(null)).toBeNull();
		});

		// Failure path: the bucket domain is unset. env.S3_PUBLIC_DOMAIN throws on a
		// missing var, and that must cost the portrait, never the whole card.
		it('degrades to the gradient portrait when the bucket domain is unconfigured', () => {
			delete process.env.S3_PUBLIC_DOMAIN;
			expect(() => avatarImageUrl({ visibility: 'public', thumbnail_key: KEY })).not.toThrow();
			expect(avatarImageUrl({ visibility: 'public', thumbnail_key: KEY })).toBeNull();
		});

		it('pins a hostile remote content-type to a known image type', () => {
			expect(imageMime('image/webp')).toBe('image/webp');
			expect(imageMime('image/png; charset=binary')).toBe('image/png');
			expect(imageMime('IMAGE/JPEG')).toBe('image/jpeg');
			expect(imageMime('image/svg+xml"/><script>alert(1)</script>')).toBe('image/jpeg');
			expect(imageMime(null)).toBe('image/jpeg');
		});

		it('never lets a content-type escape the image href', () => {
			const svg = renderAgentCard({
				id: ID,
				row: ROW,
				avatarData: { ct: imageMime('image/png"/><script>alert(1)</script>'), b64: 'AAAA' },
			});
			expectValidCard(svg);
			expect(svg).toContain('href="data:image/jpeg;base64,AAAA"');
		});
	});

	it('formats net worth the way the on-page wallet card does', () => {
		const { fmtUsd } = agentInternals;
		expect(fmtUsd(0)).toBe('$0');
		expect(fmtUsd(0.004)).toBe('<$0.01');
		expect(fmtUsd(7.7)).toBe('$7.70');
		expect(fmtUsd(4200)).toBe('$4.2K');
		expect(fmtUsd(2_400_000)).toBe('$2.4M');
		expect(fmtUsd(null)).toBeNull();
	});
});
