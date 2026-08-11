// Local pose resolution: the same deterministic algorithm the hosted
// pose_model tool runs behind POST /api/mcp-3d, executed in-process over the
// bundled preset library. Ported verbatim from the server implementation
// (api/_mcp3d/tools/studio.js in the three.ws repo) so a zero-config
// poseSeed() needs no network, no key, and no payment, and resolves
// byte-identically to the hosted tool: same token scoring, same sha256
// fallback pick, same seed derivation.
//
// Hashing uses WebCrypto (crypto.subtle), available in Node 18+ and every
// modern browser, so the package stays dependency-free on both runtimes.

import { PRESETS, PRESET_GROUPS } from './pose-presets.js';

function tokensOf(str) {
	return String(str || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.filter(Boolean);
}

const INDEX = PRESETS.map((preset) => {
	const idTokens = tokensOf(preset.id);
	const labelTokens = tokensOf(preset.label);
	const groupTokens = tokensOf(preset.group);
	return {
		preset,
		all: new Set([...idTokens, ...labelTokens, ...groupTokens]),
		idTokens,
		labelTokens,
	};
});

function scorePreset(promptTokens, entry) {
	let score = 0;
	for (const t of promptTokens) {
		if (entry.all.has(t)) score += 3;
		else {
			for (const tok of [...entry.idTokens, ...entry.labelTokens]) {
				if (tok.includes(t) || t.includes(tok)) {
					score += 1;
					break;
				}
			}
		}
	}
	return score;
}

async function sha256Bytes(text) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return new Uint8Array(digest);
}

function toHex(bytes) {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

async function pickPreset(prompt) {
	const tokens = tokensOf(prompt);
	const deterministic = async () => {
		const hash = await sha256Bytes(String(prompt));
		// Same pick as the server's hash.readUInt32BE(0): big-endian first word.
		const idx = new DataView(hash.buffer, hash.byteOffset, hash.byteLength).getUint32(0) % INDEX.length;
		return { entry: INDEX[idx], score: 0, reason: 'no-match-deterministic-pick' };
	};
	if (tokens.length === 0) return deterministic();
	let best = null;
	let bestScore = -1;
	for (const entry of INDEX) {
		const sc = scorePreset(tokens, entry);
		if (sc > bestScore) {
			best = entry;
			bestScore = sc;
		}
	}
	if (bestScore <= 0) return deterministic();
	return { entry: best, score: bestScore, reason: 'token-match' };
}

/**
 * Resolve a prompt to the tool's snake_case structuredContent shape, so the
 * local and remote lanes normalize through the exact same `shape()` step.
 * @param {string} prompt
 * @returns {Promise<object>} structuredContent (snake_case, as on the wire)
 */
export async function resolvePoseLocal(prompt) {
	const picked = await pickPreset(prompt);
	const preset = picked.entry.preset;
	const seed = toHex(await sha256Bytes(`${prompt}|${preset.id}`)).slice(0, 16);
	return {
		seed,
		preset_id: preset.id,
		preset_label: preset.label,
		group: preset.group,
		parameters: preset.pose,
		preview_url: null,
		match: { score: picked.score, reason: picked.reason },
		groups: PRESET_GROUPS,
	};
}
