// The Agent Symphony is only useful if you can reach it from where the money
// is. Three cross-links carry that weight, and all three are plain markup that
// nothing else type-checks:
//
//   1. every agent profile's Wallet Story card offers "Listen →", which must
//      deep-link into /symphony soloed to THAT agent (src/agent-detail.js sets
//      the href at render time; the anchor has to exist for it to find),
//   2. /pulse points at /symphony (the same stream, heard instead of read),
//   3. the nav lists /symphony next to Money Pulse.
//
// A rename or a well-meaning markup cleanup silently severs any of these, and
// the page becomes a URL nobody can find. Assert them statically.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

describe('symphony cross-links', () => {
	it('agent profiles carry a Listen anchor for the symphony to fill in', () => {
		const html = read('pages/agent-detail.html');
		expect(html).toMatch(/id="ad-pulse-listen"/);
		// Inside the Wallet Story card, next to the existing "All activity" link.
		const card = html.slice(html.indexOf('id="ad-pulse-card"'), html.indexOf('id="ad-pulse-feed"'));
		expect(card).toMatch(/id="ad-pulse-listen"/);
		expect(card).toMatch(/href="\/symphony"/);
	});

	it('agent-detail.js points that anchor at the soloed symphony for the rendered agent', () => {
		const js = read('src/agent-detail.js');
		expect(js).toMatch(/ad-pulse-listen/);
		expect(js).toMatch(/\/symphony\?agent=\$\{encodeURIComponent\(agent\.id\)\}/);
	});

	it('/pulse links to /symphony', () => {
		expect(read('pages/pulse.html')).toMatch(/href="\/symphony"/);
	});

	it('the nav lists /symphony', () => {
		const nav = read('public/nav-data.js');
		expect(nav).toMatch(/href: '\/symphony'/);
		expect(nav).toMatch(/Agent Symphony/);
	});

	it('a dead feed reads as a dead feed, never as a quiet economy', () => {
		const js = read('src/symphony.js');
		// Two different verdicts about the platform, so two different blocks: for
		// a while an unreachable feed rendered "The economy is quiet right now",
		// which is a claim about the platform made while we cannot see it.
		expect(js).toMatch(/function offlineLedgerHTML/);
		expect(js).toMatch(/function emptyLedgerHTML/);
		expect(js).toMatch(/The live event feed is unreachable/);
		// ...and it is actionable, not a dead end.
		expect(js).toMatch(/class="sy-retry"/);
		expect(js).toMatch(/async function retryFeed/);
		// The status pill is derived from facts rather than assigned ad hoc,
		// which is what let a page that had never reached the API say "live".
		expect(js).toMatch(/function syncStatus/);
		expect(js).toMatch(/if \(!state\.feedOk\)/);
	});

	it('the styles back every ledger state the script can render', () => {
		const css = read('src/symphony.css');
		for (const cls of ['.sy-empty-error', '.sy-retry', '.sy-skeleton', '.sy-skel-row']) {
			expect(css).toContain(cls);
		}
	});

	it('live nodes are held against the async i18n catalog pass', () => {
		const js = read('src/symphony.js');
		// src/i18n.js applies its catalog after an async /api/locale fetch and
		// reverts every annotated node. data-i18n-owned is the documented opt-out.
		expect(js).toMatch(/data-i18n-owned/);
		// The soloing sentence is translated markup carrying its own EMPTY
		// <strong id="sy-solo-label">, so the catalog replaces the element the
		// participant's name lives in. The event alone is a race, so the bar is
		// observed too.
		expect(js).toMatch(/i18n:change/);
		expect(js).toMatch(/new MutationObserver\([\s\S]{0,400}sy-solo-label/);
	});

	it('the solo sentence really does ship an empty label element per locale', () => {
		// The bug above is only reachable because the catalog value contains the
		// element. If a future extraction stops shipping the <strong>, the
		// observer is dead weight and this test says so.
		const en = JSON.parse(read('public/locales/en.json'));
		expect(en.symphony.soloing_everything_else_is_muted).toMatch(/<strong id="sy-solo-label"><\/strong>/);
	});

	it('/symphony declares the solo affordance its own copy promises', () => {
		const html = read('pages/symphony.html');
		expect(html).toMatch(/id="sy-solo-bar"/);
		expect(html).toMatch(/id="sy-solo-clear"/);
		// The ledger must not be an aria-live region: it re-renders in bulk.
		const ledger = html.match(/<div class="sy-ledger"[^>]*>/)[0];
		expect(ledger).not.toMatch(/aria-live/);
		// ...a dedicated throttled region announces arrivals instead.
		expect(html).toMatch(/id="sy-announce"[^>]*aria-live="polite"/);
	});
});
