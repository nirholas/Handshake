// POST /api/agent-vanity-grind — live Solana vanity address grind (feature #11).
//
// The owner of an agent triggers a grind ("grind a wallet starting with pump")
// from the /agent-screen task bar. This route runs the REAL ed25519 keyspace
// search in-process and, as it burns through attempts, renders a keyspace frame
// for every progress sample and publishes it to the agent's live screen so any
// viewer watching /agent-screen (and the /agents-live card) sees the grind
// unfold: attempts/sec spinning, the expected-iterations ring creeping up,
// candidate addresses flickering by — then the MATCH reveal resolving the
// winning PUBLIC address character by character.
//
// Security boundary: the secret key NEVER touches the screen stream, the
// activity log, or agent_actions. It is returned ONLY in this HTTP response, to
// the authenticated owner who triggered the grind.

import { cors, error, json, method, readJson, wrap } from './_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { getRedis } from './_lib/redis.js';
import { sql } from './_lib/db.js';
import bs58 from 'bs58';
import { grindMintKeypair, estimateAttempts, isValidVanityPrefix, BASE58_ALPHABET } from './_lib/pump-vanity.js';
import { computeGrindStats, formatGrindActivity, abbrev } from './_lib/vanity-grind-stats.js';
import { renderGrindFrame, renderRevealFrame, renderSpinupFrame } from './_lib/vanity-frame.js';
import { writeScreenFrame } from './_lib/agent-screen-frame.js';
import { hasThreeWsMark } from '../src/solana/vanity/brand.js';

// Long-running: a multi-minute grind streams frames while it searches. Budget
// just under Vercel's 300s ceiling so we always return cleanly (with partial
// progress) rather than being hard-killed mid-grind.
export const maxDuration = 300;
const GRIND_MAX_MS = 240_000;
const GRIND_MAX_ITERATIONS = 12_000_000;
const MAX_PREFIX_LEN = 6;
// Push at most ~4 frames/sec to respect the 90s frame TTL and Redis quota.
const PUSH_INTERVAL_MS = 260;
// Sample the real grind often enough to feed a lively counter; pushes are
// throttled independently above.
const PROGRESS_EVERY = 12_000;
const LOCK_TTL_S = 300;

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// wrap() matches every neighbouring handler: a DB outage degrades to a throttled
// 503 rather than a per-request stack trace, and a genuine fault returns a
// correlation ref instead of a bare 500.
export default wrap(async function handleAgentVanityGrind(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	// ── Auth: session user OR bearer (the owner; workers may also drive it). ──
	let userId = null;
	const bearer = extractBearer(req);
	if (bearer) {
		const auth = await authenticateBearer(bearer).catch(() => null);
		if (auth?.userId) userId = auth.userId;
	}
	if (!userId) {
		const auth = await getSessionUser(req, res);
		if (auth?.id) userId = auth.id;
	}
	if (!userId) return error(res, 401, 'unauthorized', 'sign in to grind a wallet for your agent');

	// One concurrent grind per IP — a grind pins a CPU core for minutes.
	const rl = await limits.apiIp(clientIp(req), { limit: 4, window: '60s' });
	if (!rl.success) return error(res, 429, 'rate_limited', 'too many grinds — let the current one finish');

	let body;
	try {
		body = await readJson(req, 16_000);
	} catch {
		return error(res, 400, 'invalid_body', 'request body must be valid JSON');
	}

	const { agentId } = body || {};
	if (!agentId || typeof agentId !== 'string') {
		return error(res, 400, 'missing_agent_id', 'agentId is required');
	}

	// Normalise the requested pattern. prefix is required; suffix optional.
	const prefix = String(body.prefix || '').trim();
	const suffix = String(body.suffix || '').trim();
	const ignoreCase = body.ignoreCase !== false; // default case-insensitive (feasible + brand default)

	if (!prefix) return error(res, 400, 'missing_prefix', 'a base58 prefix is required, e.g. { "prefix": "pump" }');
	if (prefix.length > MAX_PREFIX_LEN || (suffix && suffix.length > MAX_PREFIX_LEN)) {
		return error(
			res,
			400,
			'prefix_too_long',
			`prefix/suffix are capped at ${MAX_PREFIX_LEN} base58 chars — each extra char is exponentially harder to grind`,
		);
	}
	if (!isValidVanityPrefix(prefix) || (suffix && !isValidVanityPrefix(suffix))) {
		return error(
			res,
			400,
			'invalid_prefix',
			`prefix/suffix must be base58 (allowed: ${BASE58_ALPHABET}) — characters 0 O I l are not valid base58`,
		);
	}

	// Ownership: the triggering user must own this agent (same check the task bar uses).
	const [agentRow] = await sql`SELECT id, name FROM agent_identities WHERE id = ${agentId} AND user_id = ${userId} AND deleted_at IS NULL LIMIT 1`;
	if (!agentRow) return error(res, 403, 'forbidden', 'agent not found or not owned by this user');
	const agentName = agentRow.name || 'agent';

	const r = getRedis();
	const lockKey = `agent:vanity:lock:${agentId}`;
	// Best-effort single-flight lock so two triggers don't grind the same agent at
	// once (each grind pins a core). If Redis is down we proceed without the lock.
	if (r) {
		try {
			const ok = await r.set(lockKey, String(Date.now()), { nx: true, ex: LOCK_TTL_S });
			if (!ok) return error(res, 409, 'grind_in_progress', 'a grind is already running for this agent — watch it finish');
		} catch {
			/* lock unavailable — continue without it */
		}
	}

	const expectedIterations = Math.round(estimateAttempts({ prefix, suffix, ignoreCase }));

	// ── Live frame pusher: decoupled from the synchronous grind loop. ─────────
	// onProgress (called from inside the grind) only records the latest real
	// sample; this interval renders + publishes it, throttled to PUSH_INTERVAL_MS.
	// The grind yields periodically, which is what lets this interval fire.
	let latest = null;
	let dirty = false;
	let pushing = false;
	const candidates = [];
	let prevIterations = 0;
	let prevElapsedMs = 0;

	async function publishLatest() {
		if (pushing || !dirty || !latest) return;
		pushing = true;
		dirty = false;
		try {
			const data = await renderGrindFrame(latest);
			await writeScreenFrame(agentId, {
				data,
				activity: formatGrindActivity(latest),
				type: 'analysis',
			});
		} catch {
			/* a dropped frame is cosmetic — never abort the grind */
		} finally {
			pushing = false;
		}
	}

	// Spin-up frame so viewers see the target + real odds before the first sample.
	try {
		const spin = await renderSpinupFrame({ prefix, suffix, expectedIterations });
		await writeScreenFrame(agentId, {
			data: spin,
			activity: `Spinning up grinder · target ${prefix}${suffix ? '…' + suffix : '…'} · expected ~${abbrev(expectedIterations)}`,
			type: 'analysis',
		});
	} catch {
		/* spin-up frame is best-effort */
	}

	const pusher = setInterval(() => { void publishLatest(); }, PUSH_INTERVAL_MS);

	const onProgress = ({ iterations, elapsedMs, sampleAddress }) => {
		if (sampleAddress) {
			candidates.push(sampleAddress);
			if (candidates.length > 6) candidates.shift();
		}
		const stats = computeGrindStats({
			iterations,
			elapsedMs,
			prevIterations,
			prevElapsedMs,
			prefix,
			suffix,
			ignoreCase,
		});
		prevIterations = iterations;
		prevElapsedMs = elapsedMs;
		latest = {
			prefix,
			suffix,
			iterations,
			attemptsPerSec: stats.attemptsPerSec,
			expectedIterations: stats.expectedIterations,
			progress: stats.progress,
			etaSec: stats.etaSec,
			candidates: candidates.slice(),
			agentName,
		};
		dirty = true;
	};

	let grind;
	try {
		grind = await grindMintKeypair({
			prefix,
			suffix: suffix || undefined,
			ignoreCase,
			maxIterations: GRIND_MAX_ITERATIONS,
			maxMs: GRIND_MAX_MS,
			progressEvery: PROGRESS_EVERY,
			onProgress,
		});
	} catch (err) {
		clearInterval(pusher);
		if (r) { try { await r.del(lockKey); } catch { /* */ } }
		// Capped / timed out: a real, honest outcome for a too-hard pattern. Push a
		// final frame with the partial progress and return the real expected cost.
		const capped = err?.code === 'vanity_timeout';
		try {
			await writeScreenFrame(agentId, {
				activity: capped
					? `Grind capped at ${abbrev(prevIterations || GRIND_MAX_ITERATIONS)} attempts · ${prefix}${suffix ? '…' + suffix : '…'} expected ~${abbrev(expectedIterations)} — try a shorter prefix`
					: `Grinder stopped: ${String(err?.message || 'unknown error').slice(0, 160)}`,
				type: 'analysis',
			});
		} catch { /* */ }
		return error(
			res,
			capped ? 504 : 500,
			capped ? 'vanity_capped' : 'grind_failed',
			capped
				? `No match in ${(prevIterations || GRIND_MAX_ITERATIONS).toLocaleString()} attempts (expected ~${expectedIterations.toLocaleString()}). Use a shorter prefix${ignoreCase ? '' : ' or enable ignoreCase'} — each extra base58 char is exponentially harder.`
				: String(err?.message || 'grind failed'),
		);
	}

	clearInterval(pusher);

	const address = grind.keypair.publicKey.toBase58();
	const secretKey = grind.keypair.secretKey; // 64-byte Uint8Array
	// Two encodings of the SAME secret for the owner: base58 (Phantom/Solflare
	// import) and base64 (the launcher's mint_secret_key_b64). Never logged, never
	// pushed to the screen — returned only in this response.
	const privateKey64 = bs58.encode(Buffer.from(secretKey));
	const mintSecretKeyB64 = Buffer.from(secretKey).toString('base64');
	const launchable = hasThreeWsMark(address);

	// ── Reveal: resolve the PUBLIC address character-by-character over 3 frames. ──
	try {
		const steps = [Math.ceil(address.length / 3), Math.ceil((address.length * 2) / 3), address.length];
		for (const revealed of steps) {
			const data = await renderRevealFrame({ address, revealed, prefix, iterations: grind.iterations, agentName });
			await writeScreenFrame(agentId, {
				data,
				activity: revealed >= address.length
					? `MATCH · ${address}`
					: `Resolving match… ${address.slice(0, revealed)}`,
				type: 'analysis',
				// Public-only hand-off sidecar the client renders into the launch CTA.
				// The secret is NEVER included here.
				meta: revealed >= address.length
					? { kind: 'vanity_match', address, launchable, prefix, suffix: suffix || null, iterations: grind.iterations }
					: undefined,
			});
			if (revealed < address.length) await sleep(280);
		}
	} catch {
		/* reveal frames are cosmetic — the owner still gets the result below */
	}

	if (r) { try { await r.del(lockKey); } catch { /* */ } }

	// Owner-only secure response. The hand-off block plugs straight into
	// /api/pump/launch-agent (mint_address + mint_secret_key_b64) — coin-agnostic
	// plumbing; the only coin three.ws promotes is $THREE.
	return json(res, 200, {
		ok: true,
		address,
		privateKey64,
		iterations: grind.iterations,
		estimatedIterations: expectedIterations,
		durationMs: grind.durationMs,
		prefix,
		suffix: suffix || null,
		ignoreCase,
		launchable,
		launch: { mint_address: address, mint_secret_key_b64: mintSecretKeyB64 },
		_secretWarning:
			'privateKey64 and launch.mint_secret_key_b64 are a REAL Solana secret key for this address. ' +
			'Store it securely now and never share it — it was returned only to you and never published to the live screen.',
	});
});
