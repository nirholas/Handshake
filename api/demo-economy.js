// GET /api/demo-economy
// ---------------------
// SSE endpoint that runs the live agent economy demo:
//   Agent A (payer) discovers a service on the x402 bazaar,
//   pays Agent B (provider) in SOL on Solana mainnet,
//   and receives a live crypto market briefing in return.
//
// Streams structured SSE events so the frontend can animate each step
// in real time. Real blockchain transaction only for authenticated callers
// when AVATAR_WALLET_SECRET + a recipient are configured; explicit simulation
// mode otherwise (no real money, no fabricated tx data, full UI still plays).

import { cors, method, wrap, setRateLimitHeaders } from './_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { Bazaar } from './_lib/x402/bazaar-client.js';
import { fetchUpstreamJson, lastGood } from './_lib/upstream-fetch.js';

// ── Wallet imports (lazy, only when live mode is active) ─────────────────────
async function walletDeps() {
	const mod = await import('./_lib/avatar-wallet.js');
	return mod;
}

// ── Live crypto market briefing via GeckoTerminal (no API key needed) ────────
async function fetchMarketBriefing() {
	try {
		// Retried, breaker-guarded and backed by a last-known-good tier: the
		// briefing is the product the demo actually transacts, so a single
		// throttled GeckoTerminal read used to leave the whole demo with nothing
		// to sell. A few minutes of staleness is a far better answer than that,
		// and the payload says which it is.
		const { value: data, stale, ageMs } = await lastGood(
			'demo-economy:trending-pools',
			() => fetchUpstreamJson(
				'https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1',
				{ headers: { Accept: 'application/json' } },
				{ name: 'geckoterminal:trending-pools', timeoutMs: 8_000, attempts: 2 },
			),
			{ maxAgeMs: 30 * 60_000 },
		);
		const pools = (data.data || []).slice(0, 5).map((p) => {
			const attr = p.attributes || {};
			const priceUsd = parseFloat(attr.base_token_price_usd || 0);
			const change24 = parseFloat(attr.price_change_percentage?.h24 || 0);
			const vol24 = parseFloat(attr.volume_usd?.h24 || 0);
			return {
				name: attr.name || p.id,
				price: priceUsd < 0.0001 ? priceUsd.toExponential(2) : priceUsd.toFixed(6),
				change24h: (change24 >= 0 ? '+' : '') + change24.toFixed(1) + '%',
				vol24h:
					vol24 > 1e6
						? '$' + (vol24 / 1e6).toFixed(1) + 'M'
						: '$' + (vol24 / 1e3).toFixed(0) + 'K',
				up: change24 >= 0,
			};
		});
		const topGainer = pools
			.filter((p) => p.up)
			.sort((a, b) => parseFloat(b.change24h) - parseFloat(a.change24h))[0];
		return {
			headline: topGainer
				? `${topGainer.name} leads Solana with ${topGainer.change24h} in 24h`
				: 'Live Solana market data',
			pools,
			fetchedAt: new Date().toISOString(),
			stale,
			as_of: stale ? new Date(Date.now() - ageMs).toISOString() : null,
		};
	} catch {
		// No invented market data: a GeckoTerminal failure degrades to an explicit
		// "unavailable" signal handled by the caller, never fabricated numbers.
		return null;
	}
}

// One source of truth for the transfer amount. The listed price, the narration
// and the payment panel all read from it, so the page can never advertise one
// figure and settle another (it advertised 0.001 SOL while sending 0.000001).
const DEMO_LAMPORTS = 1000; // 0.000001 SOL, ~$0.0002, trivially cheap
const DEMO_AMOUNT_SOL = (DEMO_LAMPORTS / 1e9).toFixed(6);
const DEMO_AMOUNT_USD = '~$0.0002';

// The service NOVA actually buys from ORACLE: three.ws's own live Solana market
// briefing, delivered by fetchMarketBriefing() below. This is the real product
// the demo transacts (not a fabricated listing), so it is always present.
const THREEWS_BRIEFING_SERVICE = {
	name: 'Solana market briefing (live)',
	resource: 'https://three.ws/api/demo-economy',
	price: `${DEMO_AMOUNT_SOL} SOL`,
	network: 'solana',
};

// ── Bazaar service discovery ─────────────────────────────────────────────────
// Returns the real three.ws briefing service (always) plus any live listings
// pulled from the Coinbase x402 bazaar. If the bazaar is unreachable we say so
// honestly via bazaarAvailable:false; we never invent competitor listings.
async function discoverServices() {
	try {
		const bazaar = new Bazaar();
		const { resources } = await bazaar.search({ query: 'crypto market data', maxItems: 20 });
		const listings = (resources || [])
			.map((r) => ({
				name: r.description?.slice(0, 60) || r.resource?.split('/').pop() || 'Service',
				resource: r.resource,
				price: r.formattedPrice || r.price || 'price not listed',
				network: r.network || 'base',
			}))
			.filter((s) => s.resource && s.resource !== THREEWS_BRIEFING_SERVICE.resource)
			.slice(0, 3);
		return { services: [THREEWS_BRIEFING_SERVICE, ...listings], bazaarAvailable: true };
	} catch {
		// Live bazaar unreachable: degrade to an explicit "unavailable" signal.
		// The demo still transacts the real three.ws briefing service.
		return { services: [THREEWS_BRIEFING_SERVICE], bazaarAvailable: false };
	}
}

// ── SSE helpers ───────────────────────────────────────────────────────────────
function sseWrite(res, event, data) {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) {
		const retryAfter = Math.max(1, setRateLimitHeaders(res, rl));
		res.setHeader('retry-after', String(retryAfter));
		res.statusCode = 429;
		res.end('rate limited');
		return;
	}

	// The live branch sends REAL SOL from the platform wallet, so it is reserved
	// for authenticated callers (session or bearer). Anonymous visitors still get
	// the full narrated demo on the explicit-simulation path. Best-effort: any
	// auth-resolution failure is treated as anonymous.
	let authed = false;
	try {
		const session = await getSessionUser(req);
		authed = !!session || !!(await authenticateBearer(extractBearer(req)));
	} catch {
		authed = false;
	}

	// SSE setup
	res.statusCode = 200;
	res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
	res.setHeader('Cache-Control', 'no-cache, no-store');
	res.setHeader('Connection', 'keep-alive');
	res.setHeader('X-Accel-Buffering', 'no');
	res.flushHeaders?.();

	const pace = 900; // ms between narration beats

	try {
		// ── Step 1: Agents ready ─────────────────────────────────────────────
		sseWrite(res, 'step', {
			id: 'agents_ready',
			label: 'Agents online',
			detail: 'NOVA and ORACLE are live in the world',
			icon: '🌐',
		});
		await sleep(pace);

		// ── Step 2: Browse x402 bazaar ───────────────────────────────────────
		const { services, bazaarAvailable } = await discoverServices();
		sseWrite(res, 'step', {
			id: 'browsing_bazaar',
			label: 'Browsing x402 bazaar',
			detail: bazaarAvailable
				? 'NOVA is discovering available services on the Coinbase x402 network'
				: 'Live bazaar unavailable, so NOVA falls back to the three.ws briefing service',
			icon: '🔍',
		});
		await sleep(pace * 0.7);

		sseWrite(res, 'bazaar', { services, bazaarAvailable });
		await sleep(pace);

		// ── Step 3: Service selected ─────────────────────────────────────────
		const chosen = services[0];
		sseWrite(res, 'step', {
			id: 'service_found',
			label: 'Service found',
			detail: `NOVA found "${chosen.name}" offered by ORACLE`,
			icon: '✅',
		});
		await sleep(pace);

		// ── Step 4: Payment ──────────────────────────────────────────────────
		sseWrite(res, 'step', {
			id: 'payment_init',
			label: 'Initiating payment',
			detail: `NOVA is sending ${DEMO_AMOUNT_SOL} SOL to ORACLE on Solana mainnet`,
			icon: '💸',
		});
		await sleep(pace * 0.5);

		// Attempt real transfer, authenticated callers only. Anonymous callers
		// always take the explicit-simulation path (no SOL ever leaves the wallet).
		let payment = null;
		let sim = !authed;
		const simReason = authed ? 'wallet_not_configured' : 'auth_required';
		if (!sim) {
			try {
				const {
					avatarWalletConfig,
					loadAvatarKeypair,
					getConnection,
					getSolBalance,
					sendSol,
					explorerTxUrl,
					LAMPORTS_PER_SOL,
					isValidPubkey,
				} = await walletDeps();

				const cfg = avatarWalletConfig();
				const recipient = (
					process.env.DEMO_AGENT_B_ADDRESS ||
					cfg.defaultRecipient ||
					''
				).trim();

				if (!cfg.configured || !recipient || !isValidPubkey(recipient)) {
					sim = true;
				} else {
					const connection = getConnection(cfg.rpcUrl);
					const keypair = loadAvatarKeypair(process.env.AVATAR_WALLET_SECRET);
					const sender = keypair.publicKey.toBase58();
					const { lamports: balBefore } = await getSolBalance(
						connection,
						keypair.publicKey,
					);

					sseWrite(res, 'wallet', {
						agentA: {
							name: 'NOVA',
							address: sender,
							balance_sol: (balBefore / LAMPORTS_PER_SOL).toFixed(6),
						},
						agentB: { name: 'ORACLE', address: recipient },
					});

					const sig = await sendSol({
						connection,
						fromKeypair: keypair,
						to: recipient,
						lamports: DEMO_LAMPORTS,
						memo: 'three.ws agent economy demo',
					});
					const { lamports: balAfter } = await getSolBalance(
						connection,
						keypair.publicKey,
					);

					payment = {
						signature: sig,
						explorer_url: explorerTxUrl(sig, cfg.network),
						amount_sol: (DEMO_LAMPORTS / LAMPORTS_PER_SOL).toFixed(6),
						amount_usd: DEMO_AMOUNT_USD,
						sender,
						recipient,
						balance_before: (balBefore / LAMPORTS_PER_SOL).toFixed(6),
						balance_after: (balAfter / LAMPORTS_PER_SOL).toFixed(6),
					};
				}
			} catch (err) {
				sim = true;
				console.warn('[demo-economy] wallet not configured or send failed:', err.message);
			}
		}

		if (sim) {
			// Explicit simulation: no fabricated signature, explorer link, addresses,
			// or balances. We do surface the intended transfer amount (a real
			// constant, not invented tx data) so the panel isn't blank.
			payment = {
				simulated: true,
				reason: simReason,
				signature: null,
				explorer_url: null,
				amount_sol: DEMO_AMOUNT_SOL,
				amount_usd: DEMO_AMOUNT_USD,
			};
			sseWrite(res, 'wallet', {
				configured: false,
				simulated: true,
				reason: simReason,
				agentA: { name: 'NOVA' },
				agentB: { name: 'ORACLE' },
			});
		}

		sseWrite(res, 'step', {
			id: 'payment_sent',
			label: sim ? 'Payment (simulated)' : 'Transaction submitted',
			detail: sim
				? simReason === 'auth_required'
					? 'Simulated: sign in to run the live on-chain transfer'
					: 'Simulated: set AVATAR_WALLET_SECRET + DEMO_AGENT_B_ADDRESS for live transfers'
				: `Tx broadcast to Solana mainnet`,
			icon: '📡',
		});
		sseWrite(res, 'payment', payment);
		await sleep(pace);

		sseWrite(res, 'step', {
			id: 'payment_confirmed',
			label: sim ? 'Simulation complete' : 'On-chain confirmed',
			detail: sim
				? 'Simulated payment, no funds moved'
				: `${payment.amount_sol} SOL transferred · view on Solscan`,
			icon: '⛓️',
		});
		await sleep(pace * 0.6);

		// ── Step 5: Fetch and deliver the market briefing ────────────────────
		sseWrite(res, 'step', {
			id: 'fetching_content',
			label: 'ORACLE delivering briefing',
			detail: 'Live Solana market data inbound',
			icon: '📡',
		});

		const briefing = await fetchMarketBriefing();
		await sleep(pace * 0.5);

		if (briefing) {
			sseWrite(res, 'content', briefing);
			sseWrite(res, 'step', {
				id: 'done',
				label: 'Briefing received',
				detail: `"${briefing.headline}"`,
				icon: '📺',
			});
		} else {
			// Degraded: market data source did not respond, so say so explicitly
			// instead of inventing numbers.
			sseWrite(res, 'content', { type: 'market_unavailable' });
			sseWrite(res, 'step', {
				id: 'done',
				label: 'Market data unavailable',
				detail: 'Live market data is unavailable right now. Try again shortly.',
				icon: '📡',
			});
		}

		sseWrite(res, 'done', {
			sim,
			services_found: services.length,
			payment: payment.signature,
		});
	} catch (err) {
		sseWrite(res, 'error', { message: err.message });
	} finally {
		res.end();
	}
});

export const maxDuration = 30;
