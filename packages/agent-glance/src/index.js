/**
 * @three-ws/agent-glance
 *
 * A glance card is one three.ws agent reduced to what fits in a home screen
 * slot: who it is, one live number, and a way back into it. The platform
 * serves that card as JSON, as an SVG image, and as an Adaptive Card; this
 * package is the client for all three, with no dependencies and no build step.
 *
 *   import { fetchGlanceCard, glanceImageUrl } from '@three-ws/agent-glance';
 *
 *   const card = await fetchGlanceCard('0f3a1c22-9b7e-4d51-8a10-2c6f5d90ab34');
 *   console.log(card.name, card.metric.value, card.metric.label);
 *
 * Every function here works in a browser, in Node 18+, in a service worker,
 * and in an edge runtime: the only I/O is `fetch`.
 */

export const GLANCE_ORIGIN = 'https://three.ws';
export const GLANCE_SIZES = ['small', 'medium', 'large'];
export const GLANCE_THEMES = ['auto', 'light', 'dark'];

// Every network call here is bounded. A card is decoration on someone else's
// page: it must never be the reason that page hangs.
const DEFAULT_TIMEOUT_MS = 8000;

export class GlanceError extends Error {
	constructor(message, { status = 0, agentId = null, cause } = {}) {
		super(message);
		this.name = 'GlanceError';
		this.status = status;
		this.agentId = agentId;
		if (cause) this.cause = cause;
	}
}

function assertAgentId(agentId) {
	const id = String(agentId || '').trim();
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
		throw new GlanceError(`"${agentId}" is not a three.ws agent id (expected a uuid)`, {
			agentId,
		});
	}
	return id;
}

function buildUrl(path, params, origin) {
	const url = new URL(path, origin || GLANCE_ORIGIN);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
	}
	return url.toString();
}

/**
 * The JSON endpoint for one agent's card.
 * @param {string} agentId
 * @param {{ origin?: string }} [opts]
 */
export function glanceCardUrl(agentId, opts = {}) {
	return buildUrl('/api/glance/card', { agent: assertAgentId(agentId) }, opts.origin);
}

/**
 * An <img>-ready SVG of the card. This is the one to put in a README, a Slack
 * message, or any host that only takes a picture.
 * @param {string} agentId
 * @param {{ size?: 'small'|'medium'|'large', theme?: 'auto'|'light'|'dark', origin?: string }} [opts]
 */
export function glanceImageUrl(agentId, opts = {}) {
	const size = GLANCE_SIZES.includes(opts.size) ? opts.size : 'medium';
	const theme = GLANCE_THEMES.includes(opts.theme) ? opts.theme : 'auto';
	return buildUrl(
		'/api/glance/card',
		{ agent: assertAgentId(agentId), format: 'svg', size, theme },
		opts.origin,
	);
}

/**
 * Fetch the card model.
 * @param {string} agentId
 * @param {{ origin?: string, timeoutMs?: number, signal?: AbortSignal, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<object>} the card
 */
export async function fetchGlanceCard(agentId, opts = {}) {
	const id = assertAgentId(agentId);
	const doFetch = opts.fetchImpl || globalThis.fetch;
	if (typeof doFetch !== 'function') {
		throw new GlanceError('no fetch implementation available', { agentId: id });
	}
	const signal = opts.signal || AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
	let res;
	try {
		res = await doFetch(glanceCardUrl(id, opts), {
			headers: { accept: 'application/json' },
			signal,
		});
	} catch (err) {
		throw new GlanceError(`could not reach three.ws: ${err?.message || err}`, {
			agentId: id,
			cause: err,
		});
	}
	if (res.status === 404) throw new GlanceError('no such agent on three.ws', { status: 404, agentId: id });
	if (!res.ok) throw new GlanceError(`three.ws answered ${res.status}`, { status: res.status, agentId: id });
	return res.json();
}

/**
 * Fetch the card already shaped as an Adaptive Card, for a host that renders
 * one directly (Windows widgets board, Teams, an Adaptive Card renderer).
 */
export async function fetchGlanceAdaptiveCard(agentId, opts = {}) {
	const id = assertAgentId(agentId);
	const doFetch = opts.fetchImpl || globalThis.fetch;
	const signal = opts.signal || AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
	const res = await doFetch(
		buildUrl('/api/glance/card', { agent: id, format: 'adaptive' }, opts.origin),
		{ headers: { accept: 'application/json' }, signal },
	);
	if (!res.ok) throw new GlanceError(`three.ws answered ${res.status}`, { status: res.status, agentId: id });
	return res.json();
}

/** Markdown for a README: the card image, linked to the agent. */
export function glanceMarkdown(agentId, opts = {}) {
	const id = assertAgentId(agentId);
	const alt = opts.alt || 'three.ws agent';
	return `[![${alt}](${glanceImageUrl(id, opts)})](${GLANCE_ORIGIN}/agents/${id})`;
}

/** HTML for a page: the live element, with the image as the no-script fallback. */
export function glanceEmbedHtml(agentId, opts = {}) {
	const id = assertAgentId(agentId);
	const size = GLANCE_SIZES.includes(opts.size) ? opts.size : 'medium';
	const theme = GLANCE_THEMES.includes(opts.theme) ? opts.theme : 'auto';
	return [
		`<script type="module" src="${opts.origin || GLANCE_ORIGIN}/glance/element.js"></script>`,
		`<agent-glance agent="${id}" size="${size}" theme="${theme}"></agent-glance>`,
	].join('\n');
}

/**
 * Render the card as ANSI for a terminal (the CLI uses this, and so can any
 * dashboard that lives in a shell).
 * @param {object} card
 * @param {{ color?: boolean, width?: number }} [opts]
 */
export function renderGlanceAnsi(card, opts = {}) {
	const color = opts.color !== false;
	// Wide enough that the agent URL fits whole: a card whose last line is a
	// half-truncated uuid cannot be copied, which is most of why it is there.
	const width = Math.max(40, Math.min(100, opts.width || 68));
	const c = (code, text) => (color ? `\u001b[${code}m${text}\u001b[0m` : String(text));
	const dot = { active: '32', idle: '33', new: '90' }[card.status] || '90';
	const pad = (text) => {
		const clipped = clip(text, width - 4);
		return `${clipped}${' '.repeat(Math.max(0, width - 4 - visibleLength(clipped)))}`;
	};
	const line = (text) => `${c('90', '│')} ${pad(text)} ${c('90', '│')}`;
	const stats = (card.stats || []).map((s) => `${s.label} ${c('1', s.value)}`).join('   ');

	return [
		c('90', `╭${'─'.repeat(width - 2)}╮`),
		line(`${c('1', clip(card.name, 24))}  ${c(dot, '●')} ${c('90', card.status)}`),
		line(c('90', clip(card.description || card.headline, width - 6))),
		line(''),
		line(`${c('1', String(card.metric.value))} ${c('90', card.metric.label.toLowerCase())}`),
		line(c('90', stats)),
		line(''),
		line(c('90', card.url)),
		c('90', `╰${'─'.repeat(width - 2)}╯`),
	].join('\n');
}

function clip(text, max) {
	const value = String(text ?? '');
	return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
}

// Length as the terminal sees it: ANSI escapes take no columns.
function visibleLength(text) {
	// eslint-disable-next-line no-control-regex
	return String(text).replace(/\u001b\[[0-9;]*m/g, '').length;
}
