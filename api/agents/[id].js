/**
 * /api/agents/:id                 — agent CRUD
 * /api/agents/:id/wallet          — link / update EVM wallet
 * /api/agents/:id/solana          — agent's Solana wallet (address + balance, provision)
 * /api/agents/:id/solana/activity — recent on-chain signatures for the wallet
 * /api/agents/:id/solana/airdrop  — devnet airdrop (1 SOL)
 * /api/agents/:id/sns             — list owned .sol domains and attach one as the agent's SNS id
 * /api/agents/:id/actions         — paginated signed action log
 * /api/agents/:id/animations      — owner-only: replace meta.animations
 * /api/agents/:id/embed-policy    — read/write embed policy
 * /api/agents/:id/manifest        — public canonical manifest JSON
 * /api/agents/:id/sign            — owner-only: sign message with server wallet
 * /api/agents/:id/usage           — owner-only: LLM usage stats
 *
 * /api/agents/:id/livekit-token     — GET short-lived LiveKit room JWT
 * /api/agents/:id/embed             — POST text → 1024-dim embedding vector
 * /api/agents/:id/voice             — GET/DELETE voice status; POST /voice/clone to clone
 * /api/agents/:id/pumpfun/* is routed directly to api/agents/pumpfun/[action].js
 * by vercel.json — see the rewrite for that path family.
 */
import { handleGetOne, handleWallet } from '../agents.js';
import { cors, error, wrap } from '../_lib/http.js';

const CID_RE = /^[a-zA-Z0-9]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default wrap(async function handler(req, res) {
	const url = new URL(req.url, 'http://x');
	const parts = url.pathname.split('/').filter(Boolean);
	const id = parts[2];
	const sub = parts[3];
	const action = parts[4];

	if (!id) {
		if (cors(req, res)) return;
		return error(res, 400, 'bad_request', 'missing agent id');
	}

	// Every sub-resource under /api/agents/:id queries `WHERE id = $1` against
	// a uuid column. A malformed id otherwise leaks Postgres error 22P02 to
	// the caller as a 500. Return a clean 404 instead.
	if (!UUID_RE.test(id)) {
		if (cors(req, res)) return;
		return error(res, 404, 'not_found', 'agent not found');
	}

	if (sub === 'wallet') return handleWallet(req, res, id);

	if (sub === 'solana') {
		const mod = await import('./solana-wallet.js');
		return mod.default(req, res, id, action);
	}

	if (sub === 'eth-vanity') {
		const mod = await import('./eth-vanity.js');
		return mod.default(req, res, id, action);
	}

	if (sub === 'sns') {
		const mod = await import('./sns.js');
		return mod.default(req, res, id, action);
	}

	if (sub === 'actions') {
		const mod = await import('./_id/_sub.js');
		return mod.handleActions(req, res, id);
	}

	if (sub === 'animations') {
		const mod = await import('./_id/_sub.js');
		return mod.handleAnimations(req, res, id);
	}

	if (sub === 'embed-policy') {
		const mod = await import('./_id/_sub.js');
		return mod.handleEmbedPolicy(req, res, id);
	}

	if (sub === 'manifest') {
		const mod = await import('./_id/_sub.js');
		return mod.handleManifest(req, res, id);
	}

	if (sub === 'sign') {
		const mod = await import('./_id/_sub.js');
		return mod.handleSign(req, res, id);
	}

	if (sub === 'usage') {
		const mod = await import('./_id/_sub.js');
		return mod.handleUsage(req, res, id);
	}

	if (sub === 'memories') {
		const mod = await import('./_id/_sub.js');
		return mod.handleMemories(req, res, id, action);
	}

	if (sub === 'memory') {
		if (action === 'pin') {
			const mod = await import('./_id/memory/pin.js');
			return mod.default(req, res);
		}
		if (action === 'seed') {
			const mod = await import('./_id/memory-seed-farcaster.js');
			return mod.default(req, res);
		}
		if (action && CID_RE.test(action)) {
			const mod = await import('./_id/memory/[cid].js');
			return mod.default(req, res);
		}
		return error(res, 404, 'not_found', 'unknown memory sub-resource');
	}

	if (sub === 'livekit-token') {
		const mod = await import('./_id/livekit-token.js');
		return mod.handleLiveKitToken(req, res, id);
	}

	if (sub === 'embed') {
		const mod = await import('./_id/embed.js');
		return mod.handleEmbed(req, res, id);
	}

	if (sub === 'voice') {
		const mod = await import('./_id/voice.js');
		return mod.handleVoice(req, res, id, action);
	}

	if (sub === 'persona') {
		const mod = await import('./_id/persona.js');
		return mod.handlePersona(req, res, id, action);
	}

	if (sub === 'payments') {
		const mod = await import('./_id/payments.js');
		return mod.handlePayments(req, res, id);
	}

	if (sub === 'pricing') {
		if (action) {
			const mod = await import('./_id/pricing/[skill].js');
			return mod.default(req, res);
		}
		const mod = await import('./_id/pricing/index.js');
		return mod.default(req, res);
	}

	if (sub === 'reputation') {
		const mod = await import('./_id/reputation.js');
		return mod.handleReputation(req, res, id);
	}

	if (sub === 'memory-seed') {
		const mod = await import('./_id/memory-seed.js');
		return mod.default(req, res, id);
	}

	return handleGetOne(req, res, id);
});
