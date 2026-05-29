// GET /api/bazaar/context?resource=<url>[&toolName=<name>]
//
// Produces a Hunch-style "What's the context?" panel for a single x402
// service. We pull the merged catalog, locate the item, gather peers (same
// capability and same provider), then ask an LLM to write 2–3 sentences
// grounded in inline [n] citations that the UI renders as chips. Generation
// runs on the free platform providers (Groq/OpenRouter); Anthropic is BYOK.
//
// Falls back to a deterministic, citation-only summary if no LLM provider is
// available or the upstream call fails — the panel should always render
// something useful.

import { cors, json, error, wrap } from '../_lib/http.js';
import { llmComplete } from '../_lib/llm.js';
import { Bazaar } from '../_lib/x402/bazaar-client.js';

const STOP_WORDS = new Set([
	'api', 'apis', 'service', 'endpoint', 'endpoints', 'paid', 'free',
	'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'on', 'in', 'by',
	'tool', 'tools', 'mcp', 'http',
]);

function tokenize(s) {
	return String(s || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.map((w) => w.trim())
		.filter((w) => w && !STOP_WORDS.has(w) && w.length >= 2);
}

function tailFromUrl(url) {
	try {
		const u = new URL(url);
		const tail = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
		return tail.replace(/-[a-z0-9]{4,12}$/i, '');
	} catch {
		return '';
	}
}

function capabilityKey(it) {
	if (it.type === 'mcp' && it.toolName) {
		return `mcp:${tokenize(it.toolName).join('')}`;
	}
	const nameTokens = tokenize(it.serviceName).slice(0, 3);
	if (nameTokens.length && nameTokens.join('-').length >= 3) return `http:${nameTokens.join('-')}`;
	const urlTokens = tokenize(tailFromUrl(it.resource)).slice(0, 3);
	if (urlTokens.length >= 2 && urlTokens.join('-').length >= 6) return `http:${urlTokens.join('-')}`;
	return null;
}

function hostOf(url) {
	try { return new URL(url).host; } catch { return ''; }
}

function minUsdcAtomic(item) {
	const accepts = (item.accepts || []).filter((a) => {
		const sym = String(a?.assetInfo?.symbol || '').toUpperCase();
		return sym === 'USDC' || sym === '';
	});
	if (accepts.length === 0) return null;
	let min = null;
	for (const a of accepts) {
		const n = Number(a.amountAtomic);
		if (Number.isFinite(n) && n > 0 && (min == null || n < min)) min = n;
	}
	return min;
}

function priceLabel(atomic) {
	if (atomic == null) return '—';
	const n = atomic / 1_000_000;
	if (n === 0) return '0 USDC';
	if (n < 0.01) return `${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
	if (n < 1) return `${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
	return `${n.toFixed(2)} USDC`;
}

function percentile(sortedAsc, value) {
	if (!sortedAsc.length) return null;
	let i = 0;
	while (i < sortedAsc.length && sortedAsc[i] <= value) i++;
	return Math.round((i / sortedAsc.length) * 100);
}

// Citations is an authored list of {label, url, kind} the model must
// reference by 1-based index. Building it server-side guarantees every
// [n] in the response maps to a real anchor and keeps the LLM from
// hallucinating URLs.
function buildCitations({ target, peers, providerSiblings }) {
	const cits = [];
	if (peers.length) {
		cits.push({
			label: `${peers.length} peer ${peers.length === 1 ? 'listing' : 'listings'}`,
			url: `/bazaar?q=${encodeURIComponent(target.serviceName || target.toolName || '')}`,
			kind: 'peers',
		});
	}
	const host = hostOf(target.resource);
	if (host) {
		cits.push({
			label: host,
			url: `/providers?host=${encodeURIComponent(host)}`,
			kind: 'provider',
		});
	}
	const fac = hostOf(target.facilitator);
	if (fac) {
		cits.push({
			label: fac,
			url: `https://${fac}/discovery/resources`,
			kind: 'facilitator',
			external: true,
		});
	}
	if (providerSiblings.length) {
		cits.push({
			label: `${providerSiblings.length} other ${providerSiblings.length === 1 ? 'service' : 'services'} from this provider`,
			url: `/providers?host=${encodeURIComponent(host)}`,
			kind: 'siblings',
		});
	}
	return cits;
}

function deterministicSummary({ target, targetPrice, peerPrices, providerSiblings, citations }) {
	const sentences = [];
	const peerCount = peerPrices.length;
	const name = target.serviceName || target.toolName || hostOf(target.resource) || 'this service';

	if (peerCount > 0) {
		const sorted = [...peerPrices].sort((a, b) => a - b);
		const pct = percentile(sorted, targetPrice ?? Infinity);
		if (targetPrice != null && pct != null) {
			if (pct <= 25) sentences.push(`${name} is priced in the cheapest 25% of comparable listings [1].`);
			else if (pct >= 75) sentences.push(`${name} sits in the priciest tier among comparable listings [1].`);
			else sentences.push(`${name}'s price sits in the middle of the ${peerCount + 1}-listing peer set [1].`);
		} else {
			sentences.push(`${peerCount + 1} listings cover this capability across the catalog [1].`);
		}
	}

	const host = hostOf(target.resource);
	if (host) {
		if (providerSiblings.length > 0) {
			sentences.push(`Operated by ${host} [2], which exposes ${providerSiblings.length + 1} paid endpoints in the catalog [4].`);
		} else {
			sentences.push(`Operated by ${host} [2], a single-endpoint provider in the current catalog.`);
		}
	}

	const fac = hostOf(target.facilitator);
	if (fac && sentences.length < 3) {
		sentences.push(`Listing currently surfaced via ${fac} [3].`);
	}

	let sentiment = 'neutral';
	if (peerCount && targetPrice != null) {
		const sorted = [...peerPrices].sort((a, b) => a - b);
		const pct = percentile(sorted, targetPrice);
		if (pct != null) {
			if (pct <= 25) sentiment = 'up';
			else if (pct >= 75) sentiment = 'down';
		}
	}

	return {
		summary: sentences.join(' ') || `${name} is listed at ${priceLabel(targetPrice)}.`,
		sentiment,
		citations,
		source: 'deterministic',
	};
}

async function llmSummary({ target, targetPrice, peers, providerSiblings, citations }) {
	const peerLines = peers.slice(0, 8).map((p) => {
		const price = priceLabel(minUsdcAtomic(p));
		return `- ${p.serviceName || p.toolName || '(unnamed)'} @ ${hostOf(p.resource)} — ${price} via ${hostOf(p.facilitator)}`;
	}).join('\n') || '(none discovered)';

	const siblingLines = providerSiblings.slice(0, 8).map((p) => {
		const price = priceLabel(minUsdcAtomic(p));
		return `- ${p.serviceName || p.toolName || p.resource} — ${price}`;
	}).join('\n') || '(none)';

	const citationLines = citations.map((c, i) => `[${i + 1}] ${c.label} — ${c.url}`).join('\n');

	const prompt = `You write the "What's the context?" panel for an x402 paid API listing — a brief, grounded analysis that tells a builder why this listing is interesting right now.

# Rules
- 2 to 3 sentences total, no more.
- Cite every concrete claim with [n] where n is one of the provided citation indices. Do not invent new ones.
- Lead with the most useful comparison (price percentile vs peers, provider breadth, facilitator availability).
- No marketing language. Plain analyst tone.
- Output strict JSON only: {"summary": "...", "sentiment": "up"|"down"|"neutral"}.
  - "up" = this service looks attractively priced or uniquely positioned.
  - "down" = priced above peers or otherwise unfavorable.
  - "neutral" = neither.

# Target service
- Name: ${target.serviceName || target.toolName || '(unnamed)'}
- Resource: ${target.resource}
- Type: ${target.type}${target.toolName ? ` · tool: ${target.toolName}` : ''}
- Provider host: ${hostOf(target.resource)}
- Facilitator host: ${hostOf(target.facilitator)}
- Networks: ${(target.networks || []).join(', ') || '—'}
- Price (min USDC across accepts): ${priceLabel(targetPrice)}
- Description: ${target.description || '(none)'}
- Tags: ${(target.tags || []).join(', ') || '(none)'}

# Peer services (same capability)
${peerLines}

# Other services from the same provider
${siblingLines}

# Available citations (cite by index)
${citationLines}

Respond with only the JSON object.`;

	// Free platform providers (Groq/OpenRouter) handle this; Anthropic is BYOK.
	// If no provider is available llmComplete throws, and the caller falls back
	// to the deterministic summary — so the panel still renders.
	const { text, provider } = await llmComplete({
		system: 'You summarize x402 bazaar services. Respond with only the JSON object the prompt requests.',
		user: prompt,
		maxTokens: 400,
	});
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) throw new Error('no JSON in LLM response');
	const parsed = JSON.parse(match[0]);
	const summary = String(parsed.summary || '').trim();
	if (!summary) throw new Error('empty summary');
	const sentiment = ['up', 'down', 'neutral'].includes(parsed.sentiment) ? parsed.sentiment : 'neutral';
	return { summary, sentiment, citations, source: provider };
}

async function handler(req, res) {
	if (cors(req, res, { origins: '*', methods: 'GET,OPTIONS' })) return;
	if (req.method !== 'GET') return error(res, 405, 'method_not_allowed', 'GET only');

	const url = new URL(req.url, 'http://x');
	const resource = url.searchParams.get('resource');
	const toolName = url.searchParams.get('toolName') || '';
	if (!resource) return error(res, 400, 'bad_request', 'resource is required');

	const baz = new Bazaar();
	let httpRes, mcpRes;
	try {
		[httpRes, mcpRes] = await Promise.all([
			baz.list({ type: 'http', maxItems: 3000 }),
			baz.list({ type: 'mcp', maxItems: 3000 }),
		]);
	} catch (e) {
		return error(res, 502, 'facilitator_error', String(e?.message || e));
	}
	const items = [...(httpRes.items || []), ...(mcpRes.items || [])];

	const wantKey = toolName ? `${resource}#${toolName}` : resource;
	const target = items.find((it) => it.uniqueKey === wantKey);
	if (!target) return error(res, 404, 'not_found', 'service not in current catalog');

	const targetPrice = minUsdcAtomic(target);
	const targetCapKey = capabilityKey(target);
	const targetHost = hostOf(target.resource);

	const peers = items.filter((it) => {
		if (it.uniqueKey === target.uniqueKey) return false;
		const k = capabilityKey(it);
		return k && k === targetCapKey;
	});

	const providerSiblings = items.filter(
		(it) => it.uniqueKey !== target.uniqueKey && hostOf(it.resource) === targetHost,
	);

	const peerPrices = peers.map(minUsdcAtomic).filter((n) => n != null);

	const citations = buildCitations({ target, peers, providerSiblings });

	let result;
	try {
		result = await llmSummary({ target, targetPrice, peers, providerSiblings, citations });
	} catch (e) {
		// Always return something useful — the panel is decorative if
		// missing and frustrating if it 500s.
		result = deterministicSummary({ target, targetPrice, peerPrices, providerSiblings, citations });
		result.fallbackReason = String(e?.message || e);
	}

	res.setHeader('cache-control', 'public, max-age=300, stale-while-revalidate=600');
	return json(res, 200, {
		...result,
		stats: {
			peerCount: peers.length,
			peerPriceMinAtomic: peerPrices.length ? Math.min(...peerPrices) : null,
			peerPriceMaxAtomic: peerPrices.length ? Math.max(...peerPrices) : null,
			peerPriceMedianAtomic: peerPrices.length
				? [...peerPrices].sort((a, b) => a - b)[Math.floor(peerPrices.length / 2)]
				: null,
			targetPriceAtomic: targetPrice,
			providerSiblingsCount: providerSiblings.length,
			pricePercentile: peerPrices.length && targetPrice != null
				? percentile([...peerPrices, targetPrice].sort((a, b) => a - b), targetPrice)
				: null,
		},
	});
}

export default wrap(handler);
