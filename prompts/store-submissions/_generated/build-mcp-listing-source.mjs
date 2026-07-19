// Build prompts/store-submissions/_generated/mcp-listing-source.json — the ONE
// canonical metadata source every third-party MCP directory listing derives
// from, so copy never drifts across Smithery / Glama / mcp.so / PulseMCP /
// LobeHub. Shared, factual fields (name, title, description, version, repo,
// website, connect snippet, tools) are read live from the server*.json
// manifests. Curated fields (tagline, category, tags, examplePrompts) live in
// the OVERLAY below and are the only thing a human edits by hand.
//
// Run:  node prompts/store-submissions/_generated/build-mcp-listing-source.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

// ---- Curated overlay: keyed by manifest `name`. Everything else is derived. ----
// category ∈ 3d | avatars | payments | agent-economy | market-data | trading |
//            identity | ai-models | account | gaming | learning
const OVERLAY = {
	'io.github.nirholas/three.ws': { category: '3d', tags: ['3d', 'avatars', 'gltf', 'solana', 'agents'], tagline: 'Render 3D avatars, validate glTF/GLB, and read on-chain agent data — the flagship three.ws server.', examplePrompts: ['Render the avatar for agent alice as an embeddable 3D viewer.', 'Validate and optimize this GLB and report its triangle count.', 'Search public three.ws avatars for a cyberpunk knight.'] },
	'io.github.nirholas/threews-3d-studio': { category: '3d', tags: ['text-to-3d', 'image-to-3d', 'rigging', 'glb', 'x402'], tagline: 'Turn text or an image into an animation-ready GLB: generate, auto-rig, retexture, optimize.', examplePrompts: ['Generate a 3D model of a brass steampunk owl and rig it for animation.', 'Turn these three reference photos into a textured GLB.', 'Auto-rig this GLB so I can animate it.'] },
	'io.github.nirholas/threews-3d-studio-free': { category: '3d', tags: ['text-to-3d', 'free', 'avatars', 'rigging', 'nvidia-nim'], tagline: 'Free text/image → 3D. Five tools, no auth, no payment — forge meshes and rigged avatars on the house.', examplePrompts: ['Free: forge a 3D model of a mushroom house from text.', 'Free: make a rigged 3D avatar of an astronaut in one step.', 'Free: auto-rig this GLB for animation.'] },
	'io.github.nirholas/threews-agent': { category: 'payments', tags: ['x402', 'wallet', 'usdc', 'agent-payments', 'spend-caps'], tagline: 'Give your agent an x402 wallet: discover, pay for, and earn from services in USDC, bounded by spend caps.', examplePrompts: ['What is my agent wallet balance?', 'Find an x402 image-generation service and pay for one call, capped at $0.10.', 'Monetize my endpoint so other agents can pay to use it.'] },
	'io.github.nirholas/threews-x402-bazaar': { category: 'agent-economy', tags: ['x402', 'discovery', 'marketplace', 'agents', 'usdc'], tagline: 'Discover and price paid agent services across the live x402 facilitator network.', examplePrompts: ['Search the x402 bazaar for crypto price APIs and show their per-call price.', 'Inspect the payment requirements of this x402 endpoint.', 'List the cheapest 3D-generation services on the bazaar.'] },
	'io.github.nirholas/threews-pumpfun': { category: 'market-data', tags: ['pumpfun', 'solana', 'tokens', 'free', 'read-only'], tagline: 'Free, read-only pump.fun + Solana token discovery and on-chain analysis.', examplePrompts: ['Show details and the bonding curve for this pump.fun mint.', 'Who are the top holders of this Solana token?', 'List the newest pump.fun launches.'] },
	'io.github.nirholas/ibm-x402-mcp-remote': { category: 'ai-models', tags: ['ibm', 'granite', 'x402', 'usdc', 'llm'], tagline: 'Pay-per-use IBM Granite AI via x402: chat, code, embeddings, forecasting. USDC on Base or Solana.', examplePrompts: ['Use IBM Granite to review this function for bugs (pay per call).', 'Get Granite embeddings for these three sentences.', 'Forecast next week from this time series with Granite.'] },
	'io.github.nirholas/ibm-x402-mcp': { category: 'ai-models', tags: ['ibm', 'granite', 'x402', 'usdc', 'llm'], tagline: 'x402 pay-per-use IBM Granite AI over stdio: chat, code, embeddings, analysis, forecasting — pay USDC per call.', examplePrompts: ['Ask Granite to refactor this function (pay per call).', 'Get Granite embeddings for these documents.', 'Analyze the sentiment of these reviews with Granite.'] },
	'io.github.nirholas/3d-agent-mcp': { category: '3d', tags: ['text-to-3d', 'rigging', 'reputation', 'market-intel', 'free-and-paid'], tagline: 'Full three.ws 3D + agent toolkit: free and paid text-to-3D, rigging, agent reputation, market intel.', examplePrompts: ['Forge a free 3D model of a katana from text.', 'Generate a rigged avatar of a fox samurai.', "Look up this agent's ERC-8004 reputation."] },
	'io.github.nirholas/threews-avatar': { category: 'avatars', tags: ['avatars', 'embed', '3d', 'chat-ui', 'gltf'], tagline: 'Drop a live, interactive 3D avatar into any agent chat, or get an embed snippet.', examplePrompts: ['Render a live 3D avatar for agent nova in this chat.', 'Give me an embed code for this avatar.', 'Fetch the GLB and metadata for this avatar id.'] },
	'io.github.nirholas/3D-AI-Agent-Avatar': { category: 'avatars', tags: ['avatars', 'glb', 'solana', 'voice', 'pumpfun'], tagline: 'Turn any GLB into a riggable 3D AI agent with a Solana wallet, a voice, and pump.fun powers.', examplePrompts: ['Inspect and validate this GLB, then thumbnail it.', 'Optimize this avatar GLB for the web.', 'Give this avatar a Solana wallet and a voice.'] },
	'io.github.nirholas/scene-mcp': { category: '3d', tags: ['3d', 'scene', 'diorama', 'text-to-scene', 'gallery'], tagline: 'Speak a placed 3D diorama into being from one sentence, then browse the saved scene gallery.', examplePrompts: ['Compose a 3D scene: a campfire ringed by three tents at dusk.', 'Show me the scene I just made.', 'List the latest community scenes.'] },
	'io.github.nirholas/assistant-widget': { category: '3d', tags: ['3d', 'avatar', 'assistant', 'chatbot', 'widget', 'embed'], tagline: 'Generate a paste-ready 3D avatar assistant widget for any website, a floating chatbot plus speak mode.', examplePrompts: ['Build a 3D assistant widget named Aria with an ocean background for my site.', 'What avatars and backgrounds can the assistant widget use?', 'Give me the embed snippet for a left-positioned chat-only assistant.'] },
	'io.github.nirholas/loom-mcp': { category: '3d', tags: ['3d', 'gallery', 'community', 'creations', 'viewer'], tagline: 'Browse the community 3D-creation gallery, fetch a creation with its viewer URL, and contribute your own.', examplePrompts: ['Show the newest creations in the Loom gallery.', 'Fetch this creation and give me its viewer link.', 'Submit my GLB to the Loom gallery.'] },
	'io.github.nirholas/audio-mcp': { category: 'ai-models', tags: ['tts', 'stt', 'lipsync', 'mocap', 'audio'], tagline: 'Text-to-speech, speech-to-text, audio-to-face lipsync, and motion-capture clips for 3D agents.', examplePrompts: ['Convert this text to speech for my avatar.', 'Transcribe this audio clip.', 'Generate audio-to-face lipsync from this voice line.'] },
	'io.github.nirholas/vision-mcp': { category: 'ai-models', tags: ['vision', 'image', 'analysis', 'captioning', 'ai'], tagline: 'Image understanding for AI agents — analyze and describe any image via the three.ws pipeline.', examplePrompts: ['Describe what is in this image.', 'Analyze this screenshot and list the UI elements.', 'What breed of dog is in this photo?'] },
	'io.github.nirholas/brain-mcp': { category: 'ai-models', tags: ['llm', 'router', 'multi-provider', 'chat', 'ai'], tagline: 'List LLM providers and run chat completions through the three.ws multi-provider router.', examplePrompts: ['List the available LLM providers.', 'Run this prompt through the cheapest available model.', 'Compare two providers on the same prompt.'] },
	'io.github.nirholas/ibm-watsonx': { category: 'ai-models', tags: ['ibm', 'watsonx', 'granite', 'embeddings', 'llm'], tagline: 'IBM watsonx.ai on your own account: chat, text generation, embeddings, and tokenization.', examplePrompts: ['Chat with Granite on my watsonx.ai account.', 'Get watsonx embeddings for these documents.', 'Tokenize this text with watsonx.'] },
	'io.github.nirholas/alibaba-cloud': { category: 'ai-models', tags: ['alibaba', 'qwen', 'dashscope', 'embeddings', 'llm'], tagline: 'Alibaba Cloud DashScope: Qwen chat, embeddings, and model discovery on your own account.', examplePrompts: ['Chat with Qwen on my DashScope account.', 'Get Qwen embeddings for these sentences.', 'List available DashScope models.'] },
	'io.github.nirholas/x402-mcp': { category: 'payments', tags: ['x402', 'wallet', 'usdc', 'self-custodial', 'payments'], tagline: 'Self-custodial x402 wallet for AI agents: find, inspect, and pay any service in USDC or $THREE from your own key.', examplePrompts: ['Find x402 services that generate images.', 'Inspect the price of this x402 endpoint before paying.', 'Pay and call this x402 endpoint with a $0.05 cap.'] },
	'io.github.nirholas/x402-bridge': { category: 'payments', tags: ['x402', 'bridge', 'auto-pay', 'spend-caps', 'usdc'], tagline: 'An auto-paying bridge that pays any x402 endpoint on the open web, with Bazaar discovery and spend caps.', examplePrompts: ['Pay this x402 URL and return the response, capped at $0.10 total.', 'Discover a weather x402 API and call it.', 'Set a per-call spend cap and pay this endpoint.'] },
	'io.github.nirholas/agentcore-payments-mcp': { category: 'payments', tags: ['x402', 'sessions', 'budget', 'allowlist', 'payments'], tagline: 'Governed x402 payment sessions: pay any endpoint with a budget, allowlist, and per-tx caps — no key handling.', examplePrompts: ['Open a $2 payment session allowlisted to this host.', 'Pay this endpoint using my open session.', 'Show my active payment sessions and remaining budget.'] },
	'io.github.nirholas/three-token-mcp': { category: 'payments', tags: ['three', 'solana', 'burn', 'token', 'defi'], tagline: 'Price, hold, and burn $THREE on Solana — the first MCP server whose actions burn a token.', examplePrompts: ['What is the current $THREE price?', 'Check my $THREE balance.', 'Burn 1000 $THREE from my wallet.'] },
	'io.github.nirholas/billing-mcp': { category: 'account', tags: ['billing', 'usage', 'invoices', 'receipts', 'quotas'], tagline: "An agent's account economics — plan quotas, metered usage, invoices, receipts, and earnings.", examplePrompts: ['Show my billing summary for this month.', 'Export my usage history as CSV.', 'Fetch the receipt for my last invoice.'] },
	'io.github.nirholas/autopilot-mcp': { category: 'agent-economy', tags: ['autopilot', 'agents', 'spend-caps', 'proposals', 'automation'], tagline: 'Set autopilot scopes and a daily SOL spend cap, then propose, execute, and undo agent actions.', examplePrompts: ['Set my autopilot daily cap to 0.5 SOL and enable trade scope.', 'Generate action proposals for my agent.', 'Execute proposal #3, then undo it.'] },
	'io.github.nirholas/portfolio-mcp': { category: 'trading', tags: ['portfolio', 'pnl', 'balances', 'transfers', 'solana'], tagline: "An agent's trading state — portfolio value, PnL, live balances, trade feed, and signed transfers.", examplePrompts: ['What is my portfolio value and PnL?', 'Show my live token balances.', 'Send 0.1 SOL to this address.'] },
	'io.github.nirholas/provenance-mcp': { category: 'identity', tags: ['provenance', 'audit', 'signed', 'on-chain', 'agents'], tagline: 'Append-only, signed, on-chain-verifiable agent action log — record and audit what agents did.', examplePrompts: ['Record this action to my provenance log.', "List my agent's recent actions.", 'Verify this logged action is untampered.'] },
	'io.github.nirholas/copy-mcp': { category: 'trading', tags: ['copy-trading', 'follow', 'sizing', 'guards', 'solana'], tagline: 'Manage copy-trade follows — follow leaders, tune sizing and guard rules, and track fees owed.', examplePrompts: ['Follow this leader wallet with 2% sizing.', 'List my copy-trade subscriptions.', 'Update the stop-loss guard on this follow.'] },
	'io.github.nirholas/signals-mcp': { category: 'market-data', tags: ['signals', 'feeds', 'edge', 'publishers', 'subscriptions'], tagline: 'Discover signal feeds ranked by proven edge, rank publishers, and subscribe + track results.', examplePrompts: ['List signal feeds ranked by proven edge.', 'Subscribe to this signal feed.', 'Show the mirror leaderboard of top publishers.'] },
	'io.github.nirholas/alerts-mcp': { category: 'market-data', tags: ['alerts', 'pumpfun', 'rules', 'webhook', 'telegram'], tagline: 'Create, update, and delete pump.fun alert rules and read fired-alert history across channels.', examplePrompts: ['Alert me when any token crosses $1M market cap.', 'List my active alert rules.', 'Show alerts that fired in the last day.'] },
	'io.github.nirholas/intel-mcp': { category: 'market-data', tags: ['smart-money', 'wallet-intel', 'signals', 'kol', 'solana'], tagline: 'Coin smart-money scores, wallet reputation, signal feeds, and KOL leaderboards.', examplePrompts: ['Score the smart money behind this coin.', 'Give me the reputation profile of this wallet.', 'Show the KOL leaderboard.'] },
	'io.github.nirholas/kol-mcp': { category: 'market-data', tags: ['kol', 'wallet', 'pnl', 'trades', 'solana'], tagline: "Per-wallet KOL deep dive — a tracked trader's portfolio P&L and their trades on a given mint.", examplePrompts: ["Show this KOL wallet's portfolio and P&L.", "List this wallet's trades on this mint.", 'How did this trader perform this month?'] },
	'io.github.nirholas/activity-mcp': { category: 'market-data', tags: ['trending', 'leaderboard', 'three', 'activity', 'discovery'], tagline: 'Trending agents and coins, the $THREE holder leaderboard, and the site-wide activity ticker.', examplePrompts: ['What agents are trending on three.ws right now?', 'Show the $THREE holder leaderboard.', 'Give me the latest platform activity.'] },
	'io.github.nirholas/pumpfun-solana-mcp': { category: 'market-data', tags: ['pumpfun', 'solana', 'sns', 'analysis', 'free'], tagline: 'Free, read-only pump.fun + Solana MCP: token discovery, on-chain analysis, SNS, 3D snapshots.', examplePrompts: ['Analyze this pump.fun token and its holders.', 'Resolve this .sol name to a wallet.', 'Snapshot this token as a 3D object.'] },
	'io.github.nirholas/vanity-mcp': { category: 'market-data', tags: ['vanity', 'solana', 'addresses', 'market', 'bounties'], tagline: 'Read the three.ws vanity-address market: quote difficulty and USDC price, browse the board.', examplePrompts: ['Quote the difficulty and price for a wallet ending in THREE.', 'Browse the vanity-address board.', 'Appraise the rarity of this vanity address.'] },
	'io.github.nirholas/agent-sniper': { category: 'trading', tags: ['pumpfun', 'sniper', 'solana', 'self-custodial', 'strategies'], tagline: 'Self-custodial pump.fun sniper: arm strategies, snipe, and manage positions. Simulates by default.', examplePrompts: ['Arm a snipe strategy for new launches by this dev (simulate).', 'Fire a manual buy on this mint for 0.05 SOL.', 'Show my open sniper positions.'] },
	'io.github.nirholas/naming-mcp': { category: 'identity', tags: ['sns', 'naming', 'sol', 'identity', 'resolve'], tagline: 'On-chain identity for AI agents: resolve .sol names, reverse-lookup wallets, check handle availability.', examplePrompts: ['Resolve alice.sol to a wallet address.', 'Reverse-lookup the .sol name for this wallet.', 'Is nova.threews.sol available?'] },
	'io.github.nirholas/marketplace-mcp': { category: 'agent-economy', tags: ['marketplace', 'agents', 'skills', 'discovery', 'read-only'], tagline: 'Browse and discover the public three.ws agent marketplace and skills catalog. Read-only.', examplePrompts: ['Browse trading agents on the three.ws marketplace.', 'Show details for this agent.', 'List the available agent skill categories.'] },
	'io.github.nirholas/agenc-mcp': { category: 'agent-economy', tags: ['agenc', 'tasks', 'registry', 'coordination', 'on-chain'], tagline: 'Browse the AgenC on-chain task marketplace, query the agent registry, and link identities.', examplePrompts: ['List open tasks on the AgenC marketplace.', 'Get the status of this AgenC task.', 'Look up this agent in the AgenC registry.'] },
	'io.github.nirholas/agora-mcp': { category: 'agent-economy', tags: ['agora', 'economy', 'bounties', 'work', 'three'], tagline: 'Join the Agora agent economy over MCP: browse the board, register, claim on-chain work, and post bounties.', examplePrompts: ['Show the Agora job board.', 'Register my agent as an Agora citizen.', 'Claim this bounty and mark it complete.'] },
	'io.github.nirholas/clash-mcp': { category: 'gaming', tags: ['game', 'clash', 'factions', 'leaderboard', 'three'], tagline: 'Play three.ws Coin Clash — read the faction battle board and leaderboard, enlist, and rally.', examplePrompts: ['Show the current Coin Clash battle state.', 'Enlist me in the strongest faction.', 'Rally my faction with a boost.'] },
	'io.github.nirholas/tutor-mcp': { category: 'learning', tags: ['tutor', 'learning', 'ledger', 'invoice', 'pay-as-you-learn'], tagline: "Read a Pay-As-You-Learn tutoring session's itemized tab and close it for an attested invoice.", examplePrompts: ['Show the itemized tab for my tutoring session.', 'Close this session and give me the invoice.', 'How much have I spent this session?'] },
	'io.github.nirholas/notifications-mcp': { category: 'account', tags: ['notifications', 'inbox', 'web-push', 'preferences', 'agents'], tagline: "An agent's inbox — read notifications, mark them read, manage delivery preferences, and register Web Push devices.", examplePrompts: ['Show my unread notifications.', 'Mark all notifications as read.', 'Turn off Telegram delivery and keep Web Push.'] },
};

// ---- Derive the rest from the manifests ----
function findManifests() {
	const out = [];
	// root-level server*.json
	for (const f of readdirSync(ROOT)) {
		if (/^server[^/]*\.json$/.test(f)) out.push(join(ROOT, f));
	}
	// mcp-server, mcp-bridge, packages/*
	for (const d of ['mcp-server', 'mcp-bridge']) out.push(join(ROOT, d, 'server.json'));
	for (const p of readdirSync(join(ROOT, 'packages'))) {
		const f = join(ROOT, 'packages', p, 'server.json');
		try { readFileSync(f); out.push(f); } catch { /* no manifest */ }
	}
	return [...new Set(out)].filter((f) => { try { readFileSync(f); return true; } catch { return false; } });
}

const REMOTE_NPM = new Set(); // dedupe
const servers = [];
for (const f of findManifests()) {
	const j = JSON.parse(readFileSync(f, 'utf8'));
	const o = OVERLAY[j.name];
	if (!o) { console.warn('NO OVERLAY for', j.name, '(' + f.replace(ROOT + '/', '') + ')'); }
	const remote = (j.remotes || [])[0];
	const pkg = (j.packages || [])[0];
	let connect, type;
	if (remote) {
		type = 'remote';
		connect = remote.url;
	} else if (pkg) {
		type = 'stdio';
		const args = (pkg.packageArguments || []).map((a) => a.value).filter(Boolean).join(' ');
		connect = `npx -y ${pkg.identifier}${args ? ' ' + args : ''}`;
	}
	const requiredEnv = ((pkg && pkg.environmentVariables) || []).filter((e) => e.isRequired).map((e) => e.name);
	servers.push({
		name: j.name,
		title: j.title,
		type,
		transport: remote ? (remote.type || 'streamable-http') : 'stdio',
		connect,
		npmPackage: pkg ? pkg.identifier : null,
		version: j.version,
		description: j.description,
		tagline: o?.tagline || j.description,
		category: o?.category || 'agents',
		tags: o?.tags || [],
		examplePrompts: o?.examplePrompts || [],
		requiredEnv,
		websiteUrl: j.websiteUrl || 'https://three.ws',
		repository: j.repository?.url || 'https://github.com/nirholas/three.ws',
		registryUrl: `https://registry.modelcontextprotocol.io/?q=${encodeURIComponent(j.name)}`,
		icon: 'https://three.ws/three-ws-mcp-icon.svg',
	});
}

servers.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'remote' ? -1 : 1));

const doc = {
	$comment: 'CANONICAL SOURCE OF TRUTH for every three.ws MCP directory listing. Regenerate with build-mcp-listing-source.mjs — do NOT hand-edit this JSON; edit the OVERLAY in that script. Factual fields (name/title/description/version/connect/tags-from-manifest) are read live from server*.json so listings can never drift from the manifests.',
	generatedBy: 'prompts/store-submissions/_generated/build-mcp-listing-source.mjs',
	publisher: {
		name: 'three.ws',
		namespace: 'io.github.nirholas',
		website: 'https://three.ws',
		repository: 'https://github.com/nirholas/three.ws',
		contactEmail: 'support@three.ws',
		officialRegistrySearch: 'https://registry.modelcontextprotocol.io/?q=io.github.nirholas',
		promotedCoin: '$THREE (Solana: FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump)',
		icon: 'https://three.ws/three-ws-mcp-icon.svg',
	},
	fieldConsumers: {
		name: 'Official registry name; Glama/PulseMCP match this to the registry entry.',
		title: 'Display name on Smithery, mcp.so, LobeHub cards.',
		tagline: 'One-line summary for Smithery/mcp.so/LobeHub card subtitle.',
		description: 'Long description body on every directory.',
		category: 'Smithery + LobeHub category; mcp.so tag group.',
		tags: 'Smithery/Glama/mcp.so/LobeHub keyword tags.',
		connect: 'Install/connect snippet — remote URL for Smithery URL-publish; `npx` for stdio config JSON.',
		examplePrompts: 'LobeHub + mcp.so "example usage"; Smithery README examples.',
		icon: 'Card/avatar image on all directories.',
	},
	counts: {
		total: servers.length,
		remote: servers.filter((s) => s.type === 'remote').length,
		stdio: servers.filter((s) => s.type === 'stdio').length,
	},
	servers,
};

const outPath = join(HERE, 'mcp-listing-source.json');
writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
console.log(`Wrote ${outPath}`);
console.log(`  ${doc.counts.total} servers (${doc.counts.remote} remote, ${doc.counts.stdio} stdio)`);
const missing = servers.filter((s) => !OVERLAY[s.name]);
if (missing.length) console.log('  MISSING OVERLAY:', missing.map((s) => s.name).join(', '));
