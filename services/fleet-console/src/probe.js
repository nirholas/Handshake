/**
 * HTTP prober.
 *
 * "Is it up?" is not a boolean. A suspended hosting account, an expired
 * certificate, a domain that no longer resolves, and a login wall all present
 * as "not 200", and each needs a different fix. This classifies them so the
 * console reports a cause rather than a symptom.
 */

import { config } from './config.js';

/** Every state a probe can end in. The dashboard renders one chip per state. */
export const PROBE_STATES = {
	live: { label: 'Live', tone: 'good' },
	redirected: { label: 'Redirected', tone: 'good' },
	auth_required: { label: 'Auth required', tone: 'warn' },
	payment_required: { label: 'Payment required', tone: 'bad' },
	rate_limited: { label: 'Rate limited', tone: 'warn' },
	not_found: { label: 'Not found', tone: 'bad' },
	server_error: { label: 'Server error', tone: 'bad' },
	dns_failure: { label: 'DNS failure', tone: 'bad' },
	tls_failure: { label: 'TLS failure', tone: 'bad' },
	refused: { label: 'Connection refused', tone: 'bad' },
	timeout: { label: 'Timeout', tone: 'bad' },
	unreachable: { label: 'Unreachable', tone: 'bad' }
};

const classifyError = (error) => {
	const code = error?.cause?.code || error?.code || '';
	const message = String(error?.message || error || '').toLowerCase();
	if (error?.name === 'AbortError' || message.includes('timeout') || code === 'UND_ERR_HEADERS_TIMEOUT') return 'timeout';
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || message.includes('getaddrinfo')) return 'dns_failure';
	if (code === 'ECONNREFUSED') return 'refused';
	if (code === 'ECONNRESET' || code === 'EPIPE') return 'unreachable';
	if (code?.startsWith?.('ERR_TLS') || code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || message.includes('certificate')) {
		return 'tls_failure';
	}
	return 'unreachable';
};

const classifyStatus = (status, redirected) => {
	if (status === 402) return 'payment_required';
	if (status === 401 || status === 403) return 'auth_required';
	if (status === 429) return 'rate_limited';
	if (status === 404 || status === 410) return 'not_found';
	if (status >= 500) return 'server_error';
	if (status >= 200 && status < 400) return redirected ? 'redirected' : 'live';
	return 'unreachable';
};

/**
 * Probe one URL. Never throws.
 * @returns {Promise<{url:string,state:string,status:number|null,ms:number,finalUrl:string,redirected:boolean,detail:string}>}
 */
export async function probeUrl(url, { timeoutMs = config.probeTimeoutMs } = {}) {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	const attempt = async (method) =>
		fetch(url, {
			method,
			redirect: 'follow',
			signal: controller.signal,
			headers: {
				'user-agent': config.userAgent,
				accept: 'text/html,application/json,*/*'
			}
		});

	try {
		let res = await attempt('HEAD');
		// Plenty of static hosts answer HEAD with 403 or 405 while GET is fine.
		if (res.status === 405 || res.status === 501 || res.status === 403) {
			res = await attempt('GET');
		}
		const ms = Date.now() - started;
		const finalUrl = res.url || url;
		const redirected = Boolean(res.redirected) || (finalUrl && finalUrl !== url);
		return {
			url,
			state: classifyStatus(res.status, redirected),
			status: res.status,
			ms,
			finalUrl,
			redirected,
			detail: redirected && finalUrl !== url ? `redirects to ${finalUrl}` : ''
		};
	} catch (error) {
		return {
			url,
			state: classifyError(error),
			status: null,
			ms: Date.now() - started,
			finalUrl: url,
			redirected: false,
			detail: String(error?.cause?.code || error?.message || error).slice(0, 160)
		};
	} finally {
		clearTimeout(timer);
	}
}

export const isHealthyState = (state) => state === 'live' || state === 'redirected';
export const __testables = { classifyStatus, classifyError };
