// Guards api/_lib/article-extract.js — the /markets/news full-text extraction
// ladder. The bug this fixes: Cloudflare-blocked publishers (The Defiant,
// CoinDesk, …) 403 a direct fetch, so the reader fell straight through to the
// one-line RSS teaser and the story page looked empty. These tests pin the
// pure parsing + ladder-decision logic (no network) so a regression can't
// silently reintroduce the empty page.

import { describe, it, expect } from 'vitest';
import {
	paragraphsFromReaderMarkdown,
	paragraphsFromFeed,
	extractParagraphs,
} from '../api/_lib/article-extract.js';
import { enrichTickers } from '../api/_lib/news-coins.js';

describe('paragraphsFromReaderMarkdown', () => {
	const md = `Title: eToro Takes Strategic Stake in Extended

URL Source: https://thedefiant.io/news/x

Markdown Content:
eToro has become a strategic investor in Extended, an onchain perpetual futures exchange, and said the round begins a partnership with Zengo, the self-custody wallet eToro acquired earlier this year.

Extended said on X that eToro [is now a strategic investor](https://x.com/e) and that the partnership will focus on expanding access to global financial markets through next-generation on-chain infrastructure.

Share
Subscribe to our newsletter

![hero image](https://cdn.example/img.png)

*   Nav item one
*   Nav item two`;

	it('keeps real article prose', () => {
		const paras = paragraphsFromReaderMarkdown(md);
		expect(paras.length).toBe(2);
		expect(paras[0]).toContain('strategic investor in Extended');
	});

	it('strips markdown link syntax, keeping the link text', () => {
		const paras = paragraphsFromReaderMarkdown(md);
		expect(paras[1]).toContain('is now a strategic investor');
		expect(paras[1]).not.toContain('](');
		expect(paras[1]).not.toContain('https://x.com');
	});

	it('drops images, nav lists, and subscribe/share chrome', () => {
		const joined = paragraphsFromReaderMarkdown(md).join(' ');
		expect(joined).not.toContain('hero image');
		expect(joined).not.toContain('Nav item');
		expect(joined).not.toMatch(/subscribe/i);
	});

	it('returns nothing for a page that is all chrome', () => {
		const chrome = `Markdown Content:\n*   Home\n*   About\n\nShare\n\nSubscribe`;
		expect(paragraphsFromReaderMarkdown(chrome)).toEqual([]);
	});
});

describe('paragraphsFromFeed', () => {
	it('coalesces a feed body into readable paragraphs', () => {
		const body =
			'Bitcoin rose 5% today. Analysts point to ETF inflows. ' +
			'The move pushed BTC above a key level that had capped it for weeks.';
		const paras = paragraphsFromFeed(body);
		expect(paras.length).toBeGreaterThan(0);
		expect(paras.join(' ')).toContain('Bitcoin rose 5%');
	});
});

describe('extractParagraphs', () => {
	it('pulls <p> prose from an article container and skips short fragments', () => {
		const html = `<html><body><article>
			<p>Share</p>
			<p>Ethereum's latest upgrade shipped on mainnet this week, lowering fees for rollups and changing how blobs are priced across the network.</p>
			<p>Validators reported a smooth transition with no missed slots during the activation window, according to client teams.</p>
		</article></body></html>`;
		const paras = extractParagraphs(html);
		expect(paras.length).toBe(2); // the 5-char "Share" is dropped
		expect(paras[0]).toContain('Ethereum');
	});
});

describe('enrichTickers', () => {
	it('returns nothing when no ticker maps to a known coin id', async () => {
		// EXTENDED / ZENGO / ETORO are not in TICKER_COIN_IDS — no network call.
		expect(await enrichTickers(['EXTENDED', 'ZENGO'])).toEqual([]);
		expect(await enrichTickers([])).toEqual([]);
	});
});
