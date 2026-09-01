// pump-fun skill — proxies tool calls to the in-house MCP route at
// /api/pump-fun-mcp. The route is implemented in api/pump-fun-mcp.js and
// serves on-chain reads (bonding curve, token details, holders) via the
// official @pump-fun/* SDKs + Solana RPC. Indexer-backed tools (search,
// trending, new, graduated, king-of-the-hill, creator profile, trades) are
// proxied through the upstream pumpfun-claims-bot MCP and return a clear
// JSON-RPC error when PUMPFUN_BOT_URL is not configured.
//
// Endpoint resolution: we resolve /api/pump-fun-mcp against the *page*
// origin (window.location.origin) so the skill works whether the host page
// is three.ws, a self-hosted deployment, or localhost during development.
//
// Some handlers return a `sentiment` (-1..1) so the Empathy Layer reacts
// (rug flags → concern, near-graduation → celebration). _onSkillDone in
// agent-avatar.js consumes result.sentiment automatically.

function _endpoint() {
	if (typeof globalThis !== 'undefined' && globalThis.location?.origin) {
		return `${globalThis.location.origin}/api/pump-fun-mcp`;
	}
	// Skill workers run without window — fall back to a same-origin relative
	// fetch which the host shell will resolve. On the three.ws server the skill
	// runtime (api/_lib/skill-runtime.js) hands this handler a fetch that
	// dispatches the relative path in-process, so the same code serves
	// backtests and strategy runs without a loopback HTTP hop.
	return '/api/pump-fun-mcp';
}

let _rpcId = 0;

async function callMcp(name, args, ctx) {
	const fetchImpl = ctx?.fetch ?? globalThis.fetch;
	const res = await fetchImpl(_endpoint(), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: ++_rpcId,
			method: 'tools/call',
			params: { name, arguments: args ?? {} },
		}),
	});

	if (!res.ok) return { ok: false, error: `pump-fun MCP HTTP ${res.status}` };
	const body = await res.json();
	if (body.error) return { ok: false, error: body.error.message ?? 'pump-fun MCP error' };

	const content = body.result?.content ?? [];
	const text = content.find((c) => c.type === 'text')?.text;
	let data = body.result;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = text;
		}
	}
	return { ok: true, data };
}

// Sentiment scorers — used to drive the avatar's Empathy Layer on skill-done.

function _bondingCurveSentiment(data) {
	const pct = Number(
		data?.graduationPercent ?? data?.graduation_percent ?? data?.progress ?? NaN,
	);
	if (!Number.isFinite(pct)) return 0;
	if (pct >= 80) return 0.7;
	if (pct >= 50) return 0.35;
	if (pct < 5) return -0.2;
	return 0.1;
}

function _creatorProfileSentiment(data) {
	const flags = data?.rugFlags ?? data?.risk_flags ?? data?.flags ?? [];
	const rugged = data?.rugCount ?? data?.rug_count ?? 0;
	if (rugged > 0 || (Array.isArray(flags) && flags.length >= 2)) return -0.8;
	if (Array.isArray(flags) && flags.length === 1) return -0.4;
	return 0.2;
}

function _holderSentiment(data) {
	const top = Number(data?.topHolderPercent ?? data?.top_holder_pct ?? NaN);
	if (!Number.isFinite(top)) return 0;
	if (top >= 50) return -0.6; // single whale dominates
	if (top >= 25) return -0.2;
	return 0.1;
}

const SCORERS = {
	getBondingCurve: _bondingCurveSentiment,
	getCreatorProfile: _creatorProfileSentiment,
	getTokenHolders: _holderSentiment,
	getKingOfTheHill: () => 0.4,
};

function makeHandler(toolName) {
	const score = SCORERS[toolName];
	return async (args, ctx) => {
		const result = await callMcp(toolName, args, ctx);
		if (!result.ok) return result;
		ctx?.memory?.note?.(`pump-fun:${toolName}`, { args });
		if (score) {
			const sentiment = score(result.data);
			if (sentiment !== 0) result.sentiment = sentiment;
		}
		return result;
	};
}

export const searchTokens = makeHandler('searchTokens');
export const getTokenDetails = makeHandler('getTokenDetails');
export const getBondingCurve = makeHandler('getBondingCurve');
export const getTokenTrades = makeHandler('getTokenTrades');
export const getTrendingTokens = makeHandler('getTrendingTokens');
export const getNewTokens = makeHandler('getNewTokens');
export const getGraduatedTokens = makeHandler('getGraduatedTokens');
export const getKingOfTheHill = makeHandler('getKingOfTheHill');
export const getCreatorProfile = makeHandler('getCreatorProfile');
export const getTokenHolders = makeHandler('getTokenHolders');
