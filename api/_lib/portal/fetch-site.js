// @ts-check
// Fetching the page a Portal is built from.
//
// Portal is a crawler that runs on a visitor's request, so it is held to
// crawler manners rather than browser manners:
//
//   identifies itself   a real product token with a URL a webmaster can read.
//   asks first          robots.txt is fetched (and cached) before the page, and
//                       a Disallow for our token is honoured with a clean 403,
//                       not a silent fetch.
//   takes one copy      a built world is cached fleet-wide, so a link shared to
//                       a thousand people is one request to the origin site.
//   stays inside limits SSRF-guarded, IP-pinned, size-capped, time-boxed.
//
// The SSRF guard is not optional decoration here: the URL is caller-supplied by
// definition, so every fetch goes through fetchSafePublicUrlPinned, which
// re-resolves the host, refuses private ranges, pins the socket to the address
// it validated, re-validates every redirect hop, and enforces the byte ceiling
// while streaming.

import { fetchSafePublicUrlPinned, SsrfBlockedError, MaxBytesExceededError } from '../ssrf-guard.js';
import { cacheWrapLastGood } from '../cache.js';
import { isAllowed } from './robots.js';
import { outlineFromHtml } from './outline.js';

/** The token webmasters will see, and the page that explains it. */
export const USER_AGENT = 'ThreeWSPortalBot/1.0 (+https://three.ws/portal)';
export const ROBOTS_TOKEN = 'threewsportalbot';

export const MAX_HTML_BYTES = 3 * 1024 * 1024;
export const MAX_ROBOTS_BYTES = 512 * 1024;
const PAGE_TIMEOUT_MS = 12_000;
const ROBOTS_TIMEOUT_MS = 6_000;
/** A world is stable for an hour; the last good copy outlives an origin outage. */
export const WORLD_TTL_SECONDS = 3600;

/** Thrown for every reason a URL cannot become a world. `code` is the wire code. */
export class PortalFetchError extends Error {
	/** @param {string} code @param {string} message @param {number} [status] */
	constructor(code, message, status = 400) {
		super(message);
		this.name = 'PortalFetchError';
		this.code = code;
		this.status = status;
	}
}

/**
 * Normalize what a human typed into a URL we are willing to fetch.
 * Accepts `example.com`, rejects anything that is not http(s).
 * @param {string} input
 * @returns {URL}
 */
export function normalizeTarget(input) {
	const raw = String(input || '').trim();
	if (!raw) throw new PortalFetchError('invalid_url', 'Pass a website address to explore.');
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
	let u;
	try {
		u = new URL(withScheme);
	} catch {
		throw new PortalFetchError('invalid_url', `${raw} is not a web address.`);
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') {
		throw new PortalFetchError('invalid_url', 'Only http and https addresses can be explored.');
	}
	if (!u.hostname.includes('.')) {
		throw new PortalFetchError('invalid_url', `${u.hostname} is not a public host name.`);
	}
	u.hash = '';
	return u;
}

async function readText(url, { timeoutMs, maxBytes }) {
	const res = await fetchSafePublicUrlPinned(
		url,
		{
			headers: {
				'user-agent': USER_AGENT,
				accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
				'accept-language': 'en',
			},
			signal: AbortSignal.timeout(timeoutMs),
		},
		{ allowHttp: true, maxBytes },
	);
	return { status: res.status, contentType: res.headers.get('content-type') || '', body: await res.text() };
}

/**
 * robots.txt for an origin, cached for an hour and shared across every page of
 * that host. A robots.txt that cannot be read allows everything, which is what
 * RFC 9309 says an unavailable file means.
 * @param {URL} target
 * @returns {Promise<string|null>}
 */
export async function robotsFor(target) {
	const origin = target.origin;
	const { value } = await cacheWrapLastGood(
		`portal:robots:${origin}`,
		WORLD_TTL_SECONDS,
		async () => {
			try {
				const { status, body } = await readText(`${origin}/robots.txt`, {
					timeoutMs: ROBOTS_TIMEOUT_MS,
					maxBytes: MAX_ROBOTS_BYTES,
				});
				// 4xx means "no rules" per the RFC; 5xx means the site is unwell, and
				// treating that as a blanket Disallow would make Portal unusable
				// every time an origin has a bad minute.
				return status >= 200 && status < 300 ? body : '';
			} catch {
				return '';
			}
		},
		{ withMeta: true },
	);
	return value || null;
}

/**
 * Fetch one page and read it into a SiteOutline. Every failure is a
 * PortalFetchError carrying a code the UI can explain to a human.
 * @param {URL} target
 * @returns {Promise<import('./types.js').SiteOutline>}
 */
export async function outlineForUrl(target) {
	const robots = await robotsFor(target);
	if (!isAllowed(robots, `${target.pathname}${target.search}`, ROBOTS_TOKEN)) {
		throw new PortalFetchError(
			'robots_disallowed',
			`${target.host} asks crawlers not to read this page, so Portal will not build it.`,
			403,
		);
	}

	let page;
	try {
		page = await readText(target.toString(), { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: MAX_HTML_BYTES });
	} catch (err) {
		if (err instanceof SsrfBlockedError) {
			throw new PortalFetchError('blocked_host', 'That address does not resolve to a public website.', 400);
		}
		if (err instanceof MaxBytesExceededError) {
			throw new PortalFetchError('too_large', `${target.host} sent more than ${Math.round(MAX_HTML_BYTES / 1e6)} MB of HTML.`, 413);
		}
		const reason = err?.name === 'TimeoutError' ? 'did not answer in time' : err?.message || 'could not be reached';
		throw new PortalFetchError('unreachable', `${target.host} ${reason}.`, 502);
	}

	if (page.status >= 400) {
		throw new PortalFetchError('upstream_status', `${target.host} answered ${page.status}.`, page.status === 404 ? 404 : 502);
	}
	if (page.contentType && !/html|xml|text\/plain/i.test(page.contentType)) {
		throw new PortalFetchError('not_html', `${target.host} served ${page.contentType.split(';')[0]}, which has no page structure to walk.`, 415);
	}
	const outline = outlineFromHtml(page.body, target.toString());
	if (!outline.sections.length) {
		throw new PortalFetchError('no_structure', `${target.host} has no headings or text to build a world from.`, 422);
	}
	return outline;
}
