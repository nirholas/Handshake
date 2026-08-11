/**
 * Newsroom Anchor — pure feed-merge + script-split unit tests.
 *
 * Covers the deterministic core of workers/agent-anchor/brief.js: merging the
 * three raw intel feeds into a compact briefing (with graceful offline-feed
 * handling), building the brain prompt, and splitting a scripted read into a
 * lower-third headline + spoken body. No network, no avatar — just data in,
 * data out, so the broadcast logic is verifiable without the live stack.
 */

import { describe, it, expect } from 'vitest';
import {
	mergeBrief,
	briefDigest,
	buildAnchorMessages,
	splitScript,
	sentimentLabel,
	fmtUsd,
	HEADLINE_MAX,
	BODY_MAX,
	MAX_ITEMS,
} from '../workers/agent-anchor/brief.js';

const intelFeed = {
	intel: [
		{ category: 'narrative', description: 'Restaking flows accelerating across L2s', observations: 12, official_source: false, project: 'EigenLayer', ticker: 'EIGEN' },
		{ category: 'launch', description: 'New AI agent framework gaining mindshare', observations: 30, official_source: true, project: 'SomeProj' },
		{ category: 'narrative', description: 'DePIN sector heating up again', observations: 5 },
		{ category: 'macro', description: 'Low-signal chatter', observations: 1 },
	],
};
const sentimentFeed = {
	ok: true,
	overall: { score: 0.42, posPct: 58, negPct: 16, neuPct: 26, count: 100 },
};
const pumpFeed = {
	priceUsd: 0.0415,
	price: { priceChange24hPct: 2.5 },
	volume24h: { volume24hUsd: 270780, dex: 'raydium' },
	meta: { name: 'three.ws', symbol: 'THREE' },
};

describe('mergeBrief', () => {
	it('merges all three feeds and ranks narratives by official + observations', () => {
		const brief = mergeBrief({ intel: intelFeed, sentiment: sentimentFeed, pump: pumpFeed });
		expect(brief.items).toHaveLength(MAX_ITEMS);
		// Official-sourced item leads even though another has more observations? No —
		// official wins the tiebreak first: SomeProj is official, so it leads.
		expect(brief.items[0].headline).toMatch(/AI agent framework/);
		expect(brief.moreItems).toBe(1); // 4 valid items, top 3 read
		expect(brief.available).toEqual({ narrative: true, sentiment: true, flow: true });
		expect(brief.offline).toEqual([]);
		expect(brief.isQuiet).toBe(false);
		expect(brief.sentiment.label).toBe('bullish');
		expect(brief.market.symbol).toBe('THREE');
		expect(brief.market.change24h).toBe(2.5);
	});

	it('reports offline feeds instead of inventing data', () => {
		const brief = mergeBrief({ intel: null, sentiment: null, pump: null });
		expect(brief.offline).toEqual(expect.arrayContaining(['narrative', 'sentiment', 'flow']));
		expect(brief.items).toHaveLength(0);
		expect(brief.sentiment).toBeNull();
		expect(brief.market).toBeNull();
		expect(brief.isQuiet).toBe(true);
	});

	it('treats a failed sentiment payload (ok:false) as offline', () => {
		const brief = mergeBrief({ intel: intelFeed, sentiment: { ok: false }, pump: pumpFeed });
		expect(brief.offline).toContain('sentiment');
		expect(brief.sentiment).toBeNull();
		expect(brief.available.narrative).toBe(true);
	});

	it('treats an empty pump snapshot as offline flow', () => {
		const brief = mergeBrief({ intel: intelFeed, sentiment: sentimentFeed, pump: { meta: {}, volume24h: {} } });
		expect(brief.offline).toContain('flow');
		expect(brief.market).toBeNull();
	});

	it('drops intel items with no description', () => {
		const brief = mergeBrief({ intel: { intel: [{ category: 'x' }, { description: 'real one' }] } });
		expect(brief.items).toHaveLength(1);
		expect(brief.items[0].headline).toBe('real one');
	});

	it('accepts a bare intel array as well as the wrapped shape', () => {
		const brief = mergeBrief({ intel: [{ description: 'bare array item' }] });
		expect(brief.items[0].headline).toBe('bare array item');
	});
});

describe('narrative failover', () => {
	// The aixbt lane is a paid third-party subscription and has gone 503 in
	// production; the anchor must keep a real narrative spine rather than read a
	// price-only bulletin. Publisher attribution replaces the observation count.
	const newsFeed = {
		articles: [
			{ title: 'Regulator opens consultation on stablecoin reserves', source: 'Wire Desk', category: 'policy' },
			{ title: 'Layer two throughput sets a new weekly high', source: 'Chain Report', category: 'defi' },
			{ title: '', source: 'Empty Desk' },
		],
	};

	it('falls back to the publisher feed when the primary lane is down', () => {
		const brief = mergeBrief({ intel: null, news: newsFeed, sentiment: sentimentFeed, pump: pumpFeed });
		expect(brief.narrativeSource).toBe('news');
		expect(brief.offline).not.toContain('narrative');
		expect(brief.available.narrative).toBe(true);
		expect(brief.items).toHaveLength(2); // the untitled article is dropped
		expect(brief.items[0].headline).toMatch(/stablecoin reserves/);
		expect(brief.items[0].attribution).toBe('Wire Desk');
	});

	it('keeps feed order on the failover lane', () => {
		const brief = mergeBrief({ intel: null, news: newsFeed });
		expect(brief.items.map((i) => i.attribution)).toEqual(['Wire Desk', 'Chain Report']);
	});

	it('prefers the primary lane whenever it returns items', () => {
		const brief = mergeBrief({ intel: intelFeed, news: newsFeed, sentiment: sentimentFeed, pump: pumpFeed });
		expect(brief.narrativeSource).toBe('aixbt');
		expect(brief.items.every((i) => i.attribution === null)).toBe(true);
	});

	it('reports the spine offline only when both lanes are empty', () => {
		const brief = mergeBrief({ intel: null, news: { articles: [] } });
		expect(brief.narrativeSource).toBeNull();
		expect(brief.offline).toContain('narrative');
		expect(brief.isQuiet).toBe(true);
	});

	it('attributes the publisher in the digest instead of an observation count', () => {
		const digest = briefDigest(mergeBrief({ intel: null, news: newsFeed }));
		expect(digest).toMatch(/\(via Wire Desk\)/);
		expect(digest).not.toMatch(/obs\)/);
	});
});

describe('briefDigest + buildAnchorMessages', () => {
	it('renders a deterministic digest the brain can read', () => {
		const brief = mergeBrief({ intel: intelFeed, sentiment: sentimentFeed, pump: pumpFeed });
		const digest = briefDigest(brief);
		expect(digest).toMatch(/NARRATIVES:/);
		expect(digest).toMatch(/SENTIMENT: bullish across 100/);
		expect(digest).toMatch(/FLOW: price \$0.04/);
	});

	it('flags offline feeds in the digest so the model omits them', () => {
		const brief = mergeBrief({ intel: intelFeed, sentiment: null, pump: null });
		expect(briefDigest(brief)).toMatch(/OFFLINE FEEDS: sentiment, flow/);
	});

	it('builds a quiet-market prompt when nothing is moving', () => {
		const brief = mergeBrief({ intel: null, sentiment: null, pump: null });
		const { system, messages } = buildAnchorMessages(brief);
		expect(system).toMatch(/market-news anchor/i);
		expect(system).toMatch(/\$THREE/); // the only coin it may name
		expect(messages[0].content).toMatch(/quiet/i);
	});

	it('forbids naming non-$THREE tokens in the system prompt', () => {
		const { system } = buildAnchorMessages(mergeBrief({ intel: intelFeed }));
		expect(system).toMatch(/never name or promote a specific token/i);
	});
});

describe('splitScript', () => {
	it('parses the HEADLINE: marker + spoken body contract', () => {
		const { headline, body } = splitScript(
			'HEADLINE: Restaking flows accelerate\n\nRestaking is heating up across the L2s. Sentiment is leaning bullish into the close.',
		);
		expect(headline).toBe('Restaking flows accelerate');
		expect(body).toMatch(/^Restaking is heating up/);
		expect(body).not.toMatch(/HEADLINE/);
	});

	it('falls back to first-line headline when the marker is missing', () => {
		const { headline, body } = splitScript('Markets cool off\nProfit taking after a strong week, volume thinning out.');
		expect(headline).toBe('Markets cool off');
		expect(body).toMatch(/^Profit taking/);
	});

	it('derives a headline from the first sentence of a single blob', () => {
		const { headline, body } = splitScript('Bitcoin holds steady. Altcoins drift lower into the weekend.');
		expect(headline).toBe('Bitcoin holds steady.');
		expect(body).toMatch(/Altcoins drift lower/);
	});

	it('strips wrapping quotes from the headline', () => {
		const { headline } = splitScript('HEADLINE: "DePIN narrative returns"\n\nThe DePIN sector is moving again.');
		expect(headline).toBe('DePIN narrative returns');
	});

	it('truncates an over-long headline and body', () => {
		const longHeadline = 'x'.repeat(HEADLINE_MAX + 50);
		const longBody = 'y'.repeat(BODY_MAX + 200);
		const { headline, body } = splitScript(`HEADLINE: ${longHeadline}\n\n${longBody}`);
		expect(headline.length).toBeLessThanOrEqual(HEADLINE_MAX);
		expect(headline.endsWith('…')).toBe(true);
		expect(body.length).toBeLessThanOrEqual(BODY_MAX);
	});

	it('returns empty strings for empty input', () => {
		expect(splitScript('')).toEqual({ headline: '', body: '' });
		expect(splitScript(null)).toEqual({ headline: '', body: '' });
	});
});

describe('helpers', () => {
	it('labels sentiment scores', () => {
		expect(sentimentLabel(0.5)).toBe('bullish');
		expect(sentimentLabel(0.2)).toBe('leaning positive');
		expect(sentimentLabel(0)).toBe('mixed');
		expect(sentimentLabel(-0.5)).toBe('bearish');
		expect(sentimentLabel(null)).toBeNull();
	});

	it('formats USD compactly', () => {
		expect(fmtUsd(2_500_000)).toBe('$2.5M');
		expect(fmtUsd(270780)).toBe('$271K');
		expect(fmtUsd(4.2)).toBe('$4.20');
		expect(fmtUsd(0.0415)).toBe('$0.042');
		expect(fmtUsd(null)).toBeNull();
	});
});
