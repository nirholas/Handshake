// okx-chat-bot: does the AI credential actually work, right now?
//
// config.js answers "is a credential configured". That is a weaker question than
// it looks, and on this project the two answers came apart in both directions on
// 2026-09-04: the GCP project's Vertex access answers
// `PERMISSION_DENIED: Lightning dunning decision is deny` (a billing hold that
// reads like an IAM problem), and the `openai-api-key` secret is a valid,
// well-formed key whose account answers `billing_not_active`. Either one would
// have satisfied a presence check, booted green, received a buyer's message and
// never answered it, which is precisely the silent failure this worker exists to
// kill, rebuilt one level up.
//
// So the credential is asked, not assumed. One tiny request to the provider's own
// API, classified into a verdict readiness is judged on:
//
//   ok            the provider answered; a reply can be authored
//   unauthorized  the provider refused the credential (expired, revoked, unpaid)
//   unreachable   the network or the provider blipped; not the credential's fault
//   unprobed      no cheap, honest probe exists for this transport
//
// `unreachable` deliberately does NOT fail readiness. A provider outage is real
// but transient and self-heals; treating it like a dead key would page a human
// for something no human can fix, and a page nobody can act on is how alerts get
// ignored.

import { execFile } from 'node:child_process';
import { getGcpAccessToken } from '../../api/_lib/gcp-auth.js';
import { cliEnv } from './cli.js';
import { log } from './log.js';

const PROBE_TIMEOUT_MS = 20_000;

// Small on purpose: the probe exists to exercise auth, not to generate text.
const VERTEX_PROBE_MODEL = 'claude-haiku-4-5@20251001';
const ANTHROPIC_PROBE_MODEL = 'claude-haiku-4-5-20251001';
const OPENAI_PROBE_MODEL = 'gpt-4o-mini';

/**
 * Turn an HTTP status into a credential verdict.
 *
 * 400 and 404 count as `ok`: the provider had to authenticate the caller before
 * it could object to the model id or the request shape, so a quibble about the
 * body is proof the credential was accepted. Only an explicit refusal
 * (401/403/402, or a 429 that names billing rather than rate) is the credential's
 * fault; everything else is the provider having a bad minute.
 */
export function classifyProbeStatus(status, body = '') {
	if (status >= 200 && status < 300) return { code: 'ok', detail: 'the provider answered' };
	if (status === 400 || status === 404) {
		return { code: 'ok', detail: `credential accepted (provider returned ${status} on the probe request itself)` };
	}
	if (status === 401 || status === 403 || status === 402) {
		return { code: 'unauthorized', detail: `the provider refused the credential (${status}): ${summarize(body)}` };
	}
	if (status === 429) {
		// A rate limit is transient and is not the credential's fault. A suspended
		// or unpaid account also answers 429, and that one no retry will fix.
		const billing = /billing|not active|quota|insufficient|suspend/i.test(body);
		return billing
			? { code: 'unauthorized', detail: `the provider account cannot serve requests: ${summarize(body)}` }
			: { code: 'unreachable', detail: 'rate limited by the provider' };
	}
	return { code: 'unreachable', detail: `provider returned ${status}: ${summarize(body)}` };
}

function summarize(body) {
	const text = String(body || '').replace(/\s+/g, ' ').trim();
	try {
		const j = JSON.parse(text);
		return String(j?.error?.message || j?.error?.status || text).slice(0, 200);
	} catch {
		return text.slice(0, 200);
	}
}

async function postJson(url, headers, body) {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			body: JSON.stringify(body),
			signal: ctl.signal,
		});
		return classifyProbeStatus(res.status, await res.text());
	} catch (err) {
		return { code: 'unreachable', detail: `probe request failed: ${err?.message || err}` };
	} finally {
		clearTimeout(timer);
	}
}

function vertexLocation(env) {
	return (env.CLOUD_ML_REGION || env.GOOGLE_CLOUD_LOCATION_CLAUDE || 'global').trim();
}

async function probeVertex(env) {
	const project = env.ANTHROPIC_VERTEX_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT;
	const location = vertexLocation(env);
	const model = env.OKX_BOT_VERTEX_PROBE_MODEL || VERTEX_PROBE_MODEL;
	let token;
	try {
		token = await getGcpAccessToken();
	} catch (err) {
		// No ADC at all is a configuration fault, not a blip: the CLI will fail the
		// same way on the buyer's first message.
		return { code: 'unauthorized', detail: `no GCP credentials for Vertex: ${err?.message || err}` };
	}
	const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
	return postJson(
		`https://${host}/v1/projects/${project}/locations/${location}/publishers/anthropic/models/${model}:rawPredict`,
		{ authorization: `Bearer ${token}` },
		{ anthropic_version: 'vertex-2023-10-16', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
	);
}

async function probeAnthropicKey(env) {
	return postJson(
		'https://api.anthropic.com/v1/messages',
		{ 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
		{ model: ANTHROPIC_PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
	);
}

async function probeOpenAiKey(env) {
	return postJson(
		'https://api.openai.com/v1/chat/completions',
		{ authorization: `Bearer ${env.OPENAI_API_KEY}` },
		{ model: OPENAI_PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
	);
}

/**
 * Ask the configured provider whether it will serve this host.
 *
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ code: 'ok'|'unauthorized'|'unreachable'|'unprobed', detail: string, transport: string, checkedAt: number }>}
 */
export async function probeProvider(cfg, env = process.env) {
	const wrap = (r) => ({ ...r, transport: cfg.providerTransport, checkedAt: Date.now() });

	if (!cfg.providerCredentialed) {
		return wrap({ code: 'unauthorized', detail: 'no AI-provider credential is configured' });
	}
	if (cfg.providerTransport === 'vertex') return wrap(await probeVertex(env));
	if (cfg.provider === 'claude' && env.ANTHROPIC_API_KEY) return wrap(await probeAnthropicKey(env));
	if (cfg.provider === 'codex' && env.OPENAI_API_KEY) return wrap(await probeOpenAiKey(env));

	// An interactive OAuth grant and a CLAUDE_CODE_OAUTH_TOKEN are refreshed by
	// the CLI itself; there is no endpoint this worker can call that proves the
	// grant without reimplementing that refresh. Claiming a verdict here would be
	// inventing one, so the probe abstains and the presence check stands.
	return wrap({ code: 'unprobed', detail: `no credential probe exists for the ${cfg.providerTransport} transport` });
}

/**
 * Hand the codex CLI its API key.
 *
 * Codex >= 0.153 does NOT authenticate from `OPENAI_API_KEY` in the environment:
 * it reads ~/.codex/auth.json, and without it every request fails
 * `401 Missing bearer or basic authentication in header` while the env var sits
 * there looking correct. `codex login --with-api-key` reads the key from stdin
 * and writes that file, so this runs at boot, before the daemon can spawn a
 * subsession. Keyless providers are a no-op.
 *
 * @param {ReturnType<import('./config.js').loadConfig>} cfg
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{ ran: boolean, ok: boolean, detail: string }>}
 */
export function loginCodex(cfg, env = process.env) {
	if (cfg.provider !== 'codex') return Promise.resolve({ ran: false, ok: true, detail: 'provider is not codex' });
	const key = env.OPENAI_API_KEY;
	if (!key) return Promise.resolve({ ran: false, ok: false, detail: 'codex is the provider but OPENAI_API_KEY is unset' });

	return new Promise((resolve) => {
		const child = execFile(
			'codex',
			['login', '--with-api-key'],
			{ env: cliEnv(cfg), timeout: 60_000, encoding: 'utf8' },
			(err, stdout, stderr) => {
				const detail = (stderr || stdout || '').trim().slice(0, 300);
				if (err) log.error('codex login failed', { detail });
				resolve({ ran: true, ok: !err, detail: detail || (err ? String(err.message) : 'logged in') });
			},
		);
		child.stdin?.end(key);
	});
}
