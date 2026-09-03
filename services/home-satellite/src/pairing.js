/**
 * Pairing: how a satellite comes to belong to somebody.
 *
 * A satellite is a screen with a microphone that can hear a house. Letting one
 * attach to an agent without proving it was invited would be an open relay into
 * strangers' homes, so there is exactly one way in: the owner asks three.ws for
 * a pairing code, the code is short, single-use and expires in minutes, and the
 * service redeems it once at first start. What it gets back is a long-lived
 * identity it writes to disk, so the code never has to be handled again.
 *
 * The friction here is the point. It is the minimum that prevents an open
 * relay, and no smaller version of it exists.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const IDENTITY_FILE = 'identity.json';

/**
 * Read the identity written by a previous claim.
 * @param {string} stateDir
 * @returns {Promise<object|null>}
 */
export async function loadIdentity(stateDir) {
	try {
		const raw = await readFile(join(stateDir, IDENTITY_FILE), 'utf8');
		const identity = JSON.parse(raw);
		if (!identity?.satellite_id || !identity?.secret) return null;
		return identity;
	} catch (err) {
		if (err.code === 'ENOENT') return null;
		throw err;
	}
}

/**
 * Persist an identity. Written with mode 0600: it holds the key that lets this
 * process act as somebody's satellite.
 * @param {string} stateDir
 * @param {object} identity
 */
export async function saveIdentity(stateDir, identity) {
	await mkdir(stateDir, { recursive: true });
	await writeFile(join(stateDir, IDENTITY_FILE), `${JSON.stringify(identity, null, '\t')}\n`, { mode: 0o600 });
}

/**
 * Redeem a pairing code.
 *
 * @param {object} options
 * @param {string} options.apiBase   e.g. https://three.ws
 * @param {string} options.code      The code from three.ws/smart-home/satellite.
 * @param {string} options.name      What the satellite should be called.
 * @param {string} options.version   This service's version.
 * @param {string|null} [options.area]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<object>} the identity to persist
 */
export async function claimPairingCode({ apiBase, code, name, version, area = null, fetchImpl = fetch }) {
	const res = await fetchImpl(`${apiBase.replace(/\/+$/, '')}/api/home/satellite`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ action: 'claim', code, name, version, area }),
	});
	const text = await res.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		/* handled below: a non-JSON body is reported verbatim */
	}
	if (!res.ok) {
		const reason = body?.message || body?.error || text.slice(0, 200) || `HTTP ${res.status}`;
		const err = new Error(`pairing failed: ${reason}`);
		err.status = res.status;
		err.code = body?.error || 'pairing_failed';
		throw err;
	}
	if (!body?.satellite_id || !body?.secret) {
		throw new Error('pairing failed: three.ws did not return a satellite identity');
	}
	return {
		satellite_id: body.satellite_id,
		secret: body.secret,
		api_base: apiBase.replace(/\/+$/, ''),
		hub_url: body.hub_url || null,
		hub_token: body.hub_token || null,
		hub_token_exp: body.hub_token_exp || 0,
		agent: body.agent || null,
		name: body.name || name,
		claimed_at: new Date().toISOString(),
	};
}

/**
 * Exchange the stored secret for a fresh hub token. Called at start and again
 * before the current one expires, so a satellite that has been up for a month
 * is still allowed into its own room.
 *
 * @param {object} options
 * @param {object} options.identity
 * @param {typeof fetch} [options.fetchImpl]
 */
export async function refreshHubToken({ identity, fetchImpl = fetch }) {
	const res = await fetchImpl(`${identity.api_base}/api/home/satellite`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ action: 'session', satellite_id: identity.satellite_id, secret: identity.secret }),
	});
	const text = await res.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		/* handled below */
	}
	if (!res.ok) {
		const err = new Error(`hub session refused: ${body?.message || body?.error || `HTTP ${res.status}`}`);
		err.status = res.status;
		err.code = body?.error || 'session_failed';
		throw err;
	}
	return {
		hub_url: body.hub_url || identity.hub_url,
		hub_token: body.hub_token,
		hub_token_exp: body.hub_token_exp || 0,
		agent: body.agent || identity.agent,
	};
}
