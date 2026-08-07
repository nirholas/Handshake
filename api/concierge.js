// POST /api/concierge, the answer engine behind @three-ws/concierge.
//
// The embeddable site-concierge widget (concierge-sdk/) posts the visitor's
// question, the running conversation, and a bounded snapshot of the HOST page
// (title/description/headings/nav/main text + optional curated `knowledge`).
// This handler grounds a system prompt in that snapshot and streams the answer
// back as SSE, the same { chunk → done } event shape /api/chat uses:
//
//   Body:     { message, history[], site{...}, persona?, lang? }
//   Response: SSE  data: { type: 'chunk', text }
//                  data: { type: 'done', provider, model }
//                  data: { type: 'error', code, message }
//
// Differences from /api/chat, and why this is its own route:
//   - CORS is `*`: the whole point is embedding on ANY third-party site, which
//     the /api/chat allowlist forbids. No cookies/credentials cross this lane.
//   - Anonymous-only, with its own IP + global rate buckets (limits.conciergeIp
//     / conciergeGlobal) so widget traffic can't starve signed-in chat.
//   - No tool calls, no persona store, no BYOK: one job, grounded answers.
//   - Providers come from the shared free-first chain (api/_lib/llm.js
//     providerChain), streamed. Anthropic-shaped rungs are skipped: their SSE
//     wire format differs and every OpenAI-compatible rung (incl. the
//     credits-funded vertex-gemini anchor) already covers availability.

import { cors, method, readJson, wrap, error, rateLimited } from './_lib/http.js';
import { parse } from './_lib/validate.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { providerChain, LlmUnavailableError } from './_lib/llm.js';
import { markProviderCooldown, providersInCooldown, AUTH_COOLDOWN_SECONDS } from './_lib/provider-health.js';
import { recordEvent } from './_lib/usage.js';
import { captureException } from './_lib/sentry.js';
import { z } from 'zod';

export const maxDuration = 60;

const MAX_ANSWER_TOKENS = 700;
const CONNECT_TIMEOUT_MS = 20_000;
const TOTAL_BUDGET_MS = 40_000;

const siteSchema = z
	.object({
		url: z.string().max(600).optional(),
		name: z.string().max(120).optional(),
		title: z.string().max(200).optional(),
		description: z.string().max(500).optional(),
		headings: z.array(z.string().max(160)).max(24).optional(),
		nav: z.array(z.string().max(60)).max(24).optional(),
		knowledge: z.string().max(8000).optional(),
		content: z.string().max(6000).optional(),
	})
	.partial()
	.default({});

// Shopping mode: a bounded snapshot of the store the widget already retrieved
// against the question (see @three-ws/concierge shopify.js). Only the handful
// of relevant products, a store summary, collection names, and the pertinent
// policy travel here, never the whole catalog.
const shoppingSchema = z
	.object({
		store: z.string().max(160).optional(),
		currency: z.string().max(10).optional(),
		summary: z.string().max(600).optional(),
		collections: z.array(z.string().max(80)).max(40).optional(),
		policies: z.string().max(4000).optional(),
		products: z.string().max(4000).optional(),
	})
	.partial()
	.optional();

const bodySchema = z.object({
	message: z.string().trim().min(1).max(2000),
	history: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant']),
				content: z.string().min(1).max(4000),
			}),
		)
		.max(20)
		.default([]),
	site: siteSchema,
	shopping: shoppingSchema,
	persona: z.string().trim().max(200).optional(),
	lang: z.string().trim().max(20).optional(),
});

// Anthropic-shaped rungs stream a different SSE dialect than the OpenAI reader
// below understands; skip them (see header note).
const NON_OPENAI_STYLES = new Set(['anthropic', 'vertex-anthropic']);

function buildSystemPrompt({ site, shopping, persona, lang }) {
	const shop = shopping && (shopping.products || shopping.summary) ? shopping : null;
	const name = (shop && shop.store) || site.name || site.title || 'this website';

	const role = shop
		? [
				`You are the AI shopping assistant for ${name}, embedded as a chat widget on the store.`,
				'Help the shopper find the right product, compare options, and answer questions about products, pricing, shipping, and returns.',
				'Be warm, concise, and genuinely helpful, like a great in-store associate: two short paragraphs at most, or a compact list.',
				'The shopper is ALSO shown clickable product cards for the products listed below, with images, live prices, and links. Recommend from those products by name, say why each fits their need, and mention the price. Do not paste raw URLs or restate the price list as a table; the cards already show them.',
				'If none of the listed products fit, say so honestly and point them to a relevant collection to browse or to contact the store. Never invent products, prices, variants, or stock status, and never promise a discount that is not stated.',
			]
		: [
				`You are the AI concierge for ${name}, embedded as a chat widget on the site itself.`,
				"Answer the visitor's questions about the site, its product, content, and how to use it.",
				'Be genuinely helpful, warm, and concise: two short paragraphs at most, or a compact list.',
				'Ground every claim in the site information below. If it does not contain the answer, say so honestly and point the visitor to the closest thing that does (a nav item, a page, or contacting the team). Never invent prices, features, or policies.',
			];

	const lines = [
		...role,
		'You may use light markdown: **bold**, `code`, links, and bullet lists.',
		'Only link to URLs that appear in the information below.',
		persona ? `Tone instruction from the store owner: ${persona}` : '',
		lang ? `Reply in the visitor's language (${lang}) when their message is in it.` : '',
	];

	if (shop) {
		lines.push(
			'',
			`--- ${name.toUpperCase()} STORE ---`,
			shop.summary ? `Store overview: ${shop.summary}` : '',
			shop.collections?.length ? `Collections available to browse: ${shop.collections.join(', ')}` : '',
			shop.products ? `Products matching the shopper's question (these are shown as cards):\n${shop.products}` : 'No products in the catalog matched this question.',
			shop.policies ? `\nStore policies (authoritative):\n${shop.policies}` : '',
		);
	}

	lines.push(
		'',
		'--- PAGE THE SHOPPER IS ON ---',
		site.url ? `URL: ${site.url}` : '',
		site.title ? `Page title: ${site.title}` : '',
		site.description ? `Description: ${site.description}` : '',
		site.nav?.length ? `Navigation: ${site.nav.join(' · ')}` : '',
		site.headings?.length ? `Page headings: ${site.headings.join(' · ')}` : '',
		site.knowledge ? `Curated site knowledge (authoritative):\n${site.knowledge}` : '',
		site.content ? `Current page content:\n${site.content}` : '',
	);
	return lines.filter(Boolean).join('\n');
}

// Read one OpenAI-compatible SSE stream, forwarding text deltas. Returns the
// accumulated reply text; throws on transport failure mid-stream.
async function pumpOpenAIStream(upstream, onText) {
	const decoder = new TextDecoder();
	let buf = '';
	let reply = '';
	for await (const chunk of upstream.body) {
		buf += decoder.decode(chunk, { stream: true });
		let idx;
		while ((idx = buf.indexOf('\n')) !== -1) {
			const line = buf.slice(0, idx).trim();
			buf = buf.slice(idx + 1);
			if (!line.startsWith('data:')) continue;
			const payload = line.slice(5).trim();
			if (!payload || payload === '[DONE]') continue;
			let evt;
			try {
				evt = JSON.parse(payload);
			} catch {
				continue; // partial/malformed frame, never fatal
			}
			const delta = evt.choices?.[0]?.delta?.content;
			if (typeof delta === 'string' && delta) {
				reply += delta;
				onText(delta);
			}
		}
	}
	return reply;
}

function isBillingAuthStatus(status) {
	return status === 401 || status === 402 || status === 403;
}

// Hostname only, for usage telemetry, never the full URL (query strings from
// third-party pages are not ours to store). Malformed input → null.
function siteHostname(url) {
	if (!url) return null;
	try {
		return new URL(url, 'https://invalid.local').hostname;
	} catch {
		return null;
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { origins: '*', methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const body = parse(bodySchema, await readJson(req));
	const ip = clientIp(req);
	const rl = await limits.conciergeIp(ip);
	if (!rl.success) return rateLimited(res, rl, 'too many questions from this connection, try again shortly');
	const gl = await limits.conciergeGlobal();
	if (!gl.success) return rateLimited(res, gl, 'the concierge is at capacity, try again in a moment');

	const started = Date.now();

	const sseHead = () =>
		res.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			'X-Accel-Buffering': 'no',
		});
	const sendSSE = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

	// No platform-side content filter (same policy as /api/chat): the visitor's
	// question goes to the model as written, and any refusal is the model's own.
	// Owner directive 2026-08-07.

	const system = buildSystemPrompt(body);
	const messages = [
		{ role: 'system', content: system },
		...body.history.map((m) => ({ role: m.role, content: m.content })),
		{ role: 'user', content: body.message },
	];

	const chain = providerChain().filter((p) => !NON_OPENAI_STYLES.has(p.name));
	if (!chain.length) throw new LlmUnavailableError();

	const cooled = await providersInCooldown(chain.map((p) => p.name));
	const ordered = [...chain.filter((p) => !cooled.has(p.name)), ...chain.filter((p) => cooled.has(p.name))];

	let lastFailure = null;
	const attempted = [];
	for (const provider of ordered) {
		if (Date.now() - started > TOTAL_BUDGET_MS) break;
		attempted.push(provider.name);

		let upstream;
		try {
			const headers = provider.getHeaders ? await provider.getHeaders() : provider.headers;
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), Math.min(provider.timeoutMs || CONNECT_TIMEOUT_MS, CONNECT_TIMEOUT_MS));
			upstream = await fetch(provider.url, {
				method: 'POST',
				headers,
				body: JSON.stringify({
					model: provider.model,
					max_tokens: MAX_ANSWER_TOKENS,
					stream: true,
					messages,
				}),
				signal: ctrl.signal,
			}).finally(() => clearTimeout(timer));
		} catch (err) {
			lastFailure = err;
			continue; // transport/timeout, next rung
		}

		if (!upstream.ok) {
			const text = await upstream.text().catch(() => '');
			lastFailure = new Error(`${provider.name} HTTP ${upstream.status}: ${text.slice(0, 200)}`);
			if (isBillingAuthStatus(upstream.status)) {
				void markProviderCooldown(provider.name, AUTH_COOLDOWN_SECONDS, 'auth');
			} else if (upstream.status === 429 || upstream.status >= 500) {
				void markProviderCooldown(provider.name);
			}
			continue;
		}

		// Connected, stream the answer through.
		sseHead();
		let reply = '';
		try {
			reply = await pumpOpenAIStream(upstream, (text) => sendSSE({ type: 'chunk', text }));
		} catch (err) {
			captureException(err, { route: 'concierge', stage: 'stream', provider: provider.name });
			sendSSE({ type: 'error', code: 'stream_error', message: 'stream interrupted' });
			res.end();
			return;
		}
		sendSSE({ type: 'done', provider: provider.name, model: provider.model });
		res.end();
		recordEvent({
			userId: null,
			kind: 'chat',
			tool: 'concierge',
			latencyMs: Date.now() - started,
			meta: {
				provider: provider.name,
				model: provider.model,
				anonymous: true,
				site: siteHostname(body.site?.url),
				shopping: !!(body.shopping && (body.shopping.products || body.shopping.summary)),
				reply_chars: reply.length,
				history_turns: body.history.length,
			},
		});
		return;
	}

	// Every rung failed before a byte streamed, a plain HTTP error the widget
	// renders as its friendly retry bubble.
	captureException(lastFailure || new Error('concierge: no provider reachable'), {
		route: 'concierge',
		stage: 'connect',
	});
	res.setHeader('Retry-After', '15');
	return error(res, 503, 'rate_limited', 'The concierge is at capacity right now. Please try again in a few seconds.', {
		providers_tried: attempted.length,
		retry_after: 15,
	});
});
