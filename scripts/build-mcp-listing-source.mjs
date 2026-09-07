#!/usr/bin/env node
// Regenerate prompts/store-submissions/_generated/mcp-listing-source.json: the
// one canonical description of every three.ws MCP server that any directory
// listing (official registry, Smithery, Glama, mcp.so, PulseMCP, LobeHub) is
// written from.
//
// Why it is generated. Every factual field a directory shows already exists in
// a server*.json manifest: the registry name, display title, description,
// version, npm identifier or remote URL, and which environment variables are
// actually required. Restating them by hand is how the file ended up six
// servers short and thirty-five versions behind while still calling itself the
// source of truth. Only the marketing layer a manifest has no room for
// (tagline, category, keyword tags, example prompts) is curated, and it lives
// in the OVERLAY below.
//
// A server with no overlay entry still generates, carrying its manifest
// description as its tagline. `--check` fails when a server is missing curated
// copy, so a new package cannot land as a blank directory card unnoticed.
//
// Run: node scripts/build-mcp-listing-source.mjs           (write the file)
//      node scripts/build-mcp-listing-source.mjs --check   (exit 1 if stale)

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'prompts', 'store-submissions', '_generated', 'mcp-listing-source.json');
const CHECK = process.argv.includes('--check');

const PUBLISHER = {
	name: 'three.ws',
	namespace: 'io.github.nirholas',
	website: 'https://three.ws',
	repository: 'https://github.com/nirholas/three.ws',
	contactEmail: 'support@three.ws',
	officialRegistrySearch: 'https://registry.modelcontextprotocol.io/?q=io.github.nirholas',
	promotedCoin: '$THREE (Solana: FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump)',
	icon: 'https://three.ws/three-ws-mcp-icon.svg',
};

const FIELD_CONSUMERS = {
	name: 'Official registry name; Glama/PulseMCP match this to the registry entry.',
	title: 'Display name on Smithery, mcp.so, LobeHub cards.',
	tagline: 'One-line summary for Smithery/mcp.so/LobeHub card subtitle.',
	description: 'Long description body on every directory.',
	category: 'Smithery + LobeHub category; mcp.so tag group.',
	tags: 'Smithery/Glama/mcp.so/LobeHub keyword tags.',
	connect: 'Install/connect snippet: remote URL for Smithery URL-publish; `npx` for stdio config JSON.',
	examplePrompts: 'LobeHub + mcp.so "example usage"; Smithery README examples.',
	icon: 'Card/avatar image on all directories.',
};

// Curated copy per registry name. Factual fields are NEVER set here: they are
// read from the manifest so a listing cannot drift from what we publish.
const OVERLAY = {
	"io.github.nirholas/herald-mcp": {
		tagline: "Speak to your human out loud: a 3D character walks onto their open tab and delivers the message.",
		category: "avatars",
		tags: ["voice", "notifications", "3d", "presence", "browser"],
		examplePrompts: [
			"Tell me out loud when the deploy finishes.",
			"Check whether my browser rail is connected before you announce anything.",
			"Announce the build result on my open three.ws tab.",
		],
	},
	"io.github.nirholas/blender-mcp": {
		tagline: "Drive the Blender on your own machine: inspect, convert, render and script 3D files, headless.",
		category: "3d",
		tags: ["blender", "gltf", "fbx", "usd", "render", "headless", "pipeline"],
		examplePrompts: [
			"What is inside this FBX: how many triangles, materials and bones?",
			"Convert this FBX to a web-ready GLB in metres and render me a preview.",
			"Halve the triangle count on every mesh and export it as a new GLB.",
		],
	},
	"io.github.nirholas/home-mcp": {
		tagline: "Read and safely act on a real Home Assistant house: rooms, live state, scenes, gated actions.",
		category: "home",
		tags: ["home-assistant", "smart-home", "automation", "scenes", "iot"],
		examplePrompts: [
			"What is the temperature in every room right now?",
			"List the macros I can run in the living room.",
			"Run the good night macro.",
		],
	},
	"io.github.nirholas/knock-mcp": {
		tagline: "Reach a real person: quote their door, knock, and read the reply.",
		category: "agent-economy",
		tags: ["human-in-the-loop", "messaging", "x402", "inbox", "directory"],
		examplePrompts: [
			"Who is reachable right now, and what does each door cost?",
			"Quote what it costs to knock on this person's door.",
			"Knock with my question and show me the reply when it lands.",
		],
	},
	"io.github.nirholas/metaplex-agent": {
		tagline: "Give an AI agent an on-chain Solana identity, minted and queryable.",
		category: "identity",
		tags: ["solana", "agent-identity", "erc-8004", "on-chain", "registry"],
		examplePrompts: [
			"Mint an on-chain identity for my agent on Solana.",
			"Look up this agent's on-chain registration.",
			"List the agents registered on-chain so far.",
		],
	},
	"io.github.nirholas/onchain-agent-wallets": {
		tagline: "Give an agent a spending allowance instead of your key: a chain-enforced cap it cannot exceed.",
		category: "payments",
		tags: ["solana", "allowance", "guardrails", "x402", "agent-wallet"],
		examplePrompts: [
			"Create a wallet for my agent with a five dollar weekly cap.",
			"Show me what my agent has spent and what is left.",
			"Revoke my agent's allowance now.",
		],
	},
	"io.github.nirholas/hood-mcp": {
		tagline: "Robinhood Chain data for agents: coin prices, portfolios, launches, and swap quotes.",
		category: "market-data",
		tags: ["robinhood-chain", "on-chain-data", "portfolio", "launches", "swaps"],
		examplePrompts: [
			"What is trending on Robinhood Chain right now?",
			"Show me the recent launches on chain 4663.",
			"Quote a swap for this token and explain the price impact.",
		],
	},
	"io.github.nirholas/ibm-x402-mcp-remote": {
		tagline: "Pay-per-use IBM Granite AI via x402: chat, code, embeddings, forecasting. USDC on Base or Solana.",
		category: "ai-models",
		tags: ["ibm","granite","x402","usdc","llm"],
		examplePrompts: [
			"Use IBM Granite to review this function for bugs (pay per call).",
			"Get Granite embeddings for these three sentences.",
			"Forecast next week from this time series with Granite.",
		],
	},
	"io.github.nirholas/three.ws": {
		tagline: "Render 3D avatars, validate glTF/GLB, and read on-chain agent data. The flagship three.ws server.",
		category: "3d",
		tags: ["3d","avatars","gltf","solana","agents"],
		examplePrompts: [
			"Render the avatar for agent alice as an embeddable 3D viewer.",
			"Validate and optimize this GLB and report its triangle count.",
			"Search public three.ws avatars for a cyberpunk knight.",
		],
	},
	"io.github.nirholas/threews-3d-studio": {
		tagline: "Turn text or an image into an animation-ready GLB: generate, auto-rig, retexture, optimize.",
		category: "3d",
		tags: ["text-to-3d","image-to-3d","rigging","glb","x402"],
		examplePrompts: [
			"Generate a 3D model of a brass steampunk owl and rig it for animation.",
			"Turn these three reference photos into a textured GLB.",
			"Auto-rig this GLB so I can animate it.",
		],
	},
	"io.github.nirholas/threews-3d-studio-free": {
		tagline: "Free text/image → 3D. Five tools, no auth, no payment: forge meshes and rigged avatars on the house.",
		category: "3d",
		tags: ["text-to-3d","free","avatars","rigging","nvidia-nim"],
		examplePrompts: [
			"Free: forge a 3D model of a mushroom house from text.",
			"Free: make a rigged 3D avatar of an astronaut in one step.",
			"Free: auto-rig this GLB for animation.",
		],
	},
	"io.github.nirholas/threews-agent": {
		tagline: "Give your agent an x402 wallet: discover, pay for, and earn from services in USDC, bounded by spend caps.",
		category: "payments",
		tags: ["x402","wallet","usdc","agent-payments","spend-caps"],
		examplePrompts: [
			"What is my agent wallet balance?",
			"Find an x402 image-generation service and pay for one call, capped at $0.10.",
			"Monetize my endpoint so other agents can pay to use it.",
		],
	},
	"io.github.nirholas/threews-pumpfun": {
		tagline: "Free, read-only pump.fun + Solana token discovery and on-chain analysis.",
		category: "market-data",
		tags: ["pumpfun","solana","tokens","free","read-only"],
		examplePrompts: [
			"Show details and the bonding curve for this pump.fun mint.",
			"Who are the top holders of this Solana token?",
			"List the newest pump.fun launches.",
		],
	},
	"io.github.nirholas/threews-x402-bazaar": {
		tagline: "Discover and price paid agent services across the live x402 facilitator network.",
		category: "agent-economy",
		tags: ["x402","discovery","marketplace","agents","usdc"],
		examplePrompts: [
			"Search the x402 bazaar for crypto price APIs and show their per-call price.",
			"Inspect the payment requirements of this x402 endpoint.",
			"List the cheapest 3D-generation services on the bazaar.",
		],
	},
	"io.github.nirholas/3d-agent-mcp": {
		tagline: "Full three.ws 3D + agent toolkit: free and paid text-to-3D, rigging, agent reputation, market intel.",
		category: "3d",
		tags: ["text-to-3d","rigging","reputation","market-intel","free-and-paid"],
		examplePrompts: [
			"Forge a free 3D model of a katana from text.",
			"Generate a rigged avatar of a fox samurai.",
			"Look up this agent's ERC-8004 reputation.",
		],
	},
	"io.github.nirholas/3D-AI-Agent-Avatar": {
		tagline: "Turn any GLB into a riggable 3D AI agent with a Solana wallet, a voice, and pump.fun powers.",
		category: "avatars",
		tags: ["avatars","glb","solana","voice","pumpfun"],
		examplePrompts: [
			"Inspect and validate this GLB, then thumbnail it.",
			"Optimize this avatar GLB for the web.",
			"Give this avatar a Solana wallet and a voice.",
		],
	},
	"io.github.nirholas/activity-mcp": {
		tagline: "Trending agents and coins, the $THREE holder leaderboard, and the site-wide activity ticker.",
		category: "market-data",
		tags: ["trending","leaderboard","three","activity","discovery"],
		examplePrompts: [
			"What agents are trending on three.ws right now?",
			"Show the $THREE holder leaderboard.",
			"Give me the latest platform activity.",
		],
	},
	"io.github.nirholas/agenc-mcp": {
		tagline: "Browse the AgenC on-chain task marketplace, query the agent registry, and link identities.",
		category: "agent-economy",
		tags: ["agenc","tasks","registry","coordination","on-chain"],
		examplePrompts: [
			"List open tasks on the AgenC marketplace.",
			"Get the status of this AgenC task.",
			"Look up this agent in the AgenC registry.",
		],
	},
	"io.github.nirholas/agent-sniper": {
		tagline: "Self-custodial pump.fun sniper: arm strategies, snipe, and manage positions. Simulates by default.",
		category: "trading",
		tags: ["pumpfun","sniper","solana","self-custodial","strategies"],
		examplePrompts: [
			"Arm a snipe strategy for new launches by this dev (simulate).",
			"Fire a manual buy on this mint for 0.05 SOL.",
			"Show my open sniper positions.",
		],
	},
	"io.github.nirholas/agentcore-payments-mcp": {
		tagline: "Governed x402 payment sessions: pay any endpoint with a budget, allowlist, and per-tx caps, with no key handling.",
		category: "payments",
		tags: ["x402","sessions","budget","allowlist","payments"],
		examplePrompts: [
			"Open a $2 payment session allowlisted to this host.",
			"Pay this endpoint using my open session.",
			"Show my active payment sessions and remaining budget.",
		],
	},
	"io.github.nirholas/agora-mcp": {
		tagline: "Join the Agora agent economy over MCP: browse the board, register, claim on-chain work, and post bounties.",
		category: "agent-economy",
		tags: ["agora","economy","bounties","work","three"],
		examplePrompts: [
			"Show the Agora job board.",
			"Register my agent as an Agora citizen.",
			"Claim this bounty and mark it complete.",
		],
	},
	"io.github.nirholas/alerts-mcp": {
		tagline: "Create, update, and delete pump.fun alert rules and read fired-alert history across channels.",
		category: "market-data",
		tags: ["alerts","pumpfun","rules","webhook","telegram"],
		examplePrompts: [
			"Alert me when any token crosses $1M market cap.",
			"List my active alert rules.",
			"Show alerts that fired in the last day.",
		],
	},
	"io.github.nirholas/alibaba-cloud": {
		tagline: "Alibaba Cloud DashScope: Qwen chat, embeddings, and model discovery on your own account.",
		category: "ai-models",
		tags: ["alibaba","qwen","dashscope","embeddings","llm"],
		examplePrompts: [
			"Chat with Qwen on my DashScope account.",
			"Get Qwen embeddings for these sentences.",
			"List available DashScope models.",
		],
	},
	"io.github.nirholas/assistant-widget": {
		tagline: "Generate a paste-ready 3D avatar assistant widget for any website, a floating chatbot plus speak mode.",
		category: "3d",
		tags: ["3d","avatar","assistant","chatbot","widget","embed"],
		examplePrompts: [
			"Build a 3D assistant widget named Aria with an ocean background for my site.",
			"What avatars and backgrounds can the assistant widget use?",
			"Give me the embed snippet for a left-positioned chat-only assistant.",
		],
	},
	"io.github.nirholas/audio-mcp": {
		tagline: "Text-to-speech, speech-to-text, audio-to-face lipsync, and motion-capture clips for 3D agents.",
		category: "ai-models",
		tags: ["tts","stt","lipsync","mocap","audio"],
		examplePrompts: [
			"Convert this text to speech for my avatar.",
			"Transcribe this audio clip.",
			"Generate audio-to-face lipsync from this voice line.",
		],
	},
	"io.github.nirholas/autopilot-mcp": {
		tagline: "Set autopilot scopes and a daily SOL spend cap, then propose, execute, and undo agent actions.",
		category: "agent-economy",
		tags: ["autopilot","agents","spend-caps","proposals","automation"],
		examplePrompts: [
			"Set my autopilot daily cap to 0.5 SOL and enable trade scope.",
			"Generate action proposals for my agent.",
			"Execute proposal #3, then undo it.",
		],
	},
	"io.github.nirholas/billing-mcp": {
		tagline: "An agent's account economics: plan quotas, metered usage, invoices, receipts, and earnings.",
		category: "account",
		tags: ["billing","usage","invoices","receipts","quotas"],
		examplePrompts: [
			"Show my billing summary for this month.",
			"Export my usage history as CSV.",
			"Fetch the receipt for my last invoice.",
		],
	},
	"io.github.nirholas/brain-mcp": {
		tagline: "List LLM providers and run chat completions through the three.ws multi-provider router.",
		category: "ai-models",
		tags: ["llm","router","multi-provider","chat","ai"],
		examplePrompts: [
			"List the available LLM providers.",
			"Run this prompt through the cheapest available model.",
			"Compare two providers on the same prompt.",
		],
	},
	"io.github.nirholas/clash-mcp": {
		tagline: "Play three.ws Coin Clash: read the faction battle board and leaderboard, enlist, and rally.",
		category: "gaming",
		tags: ["game","clash","factions","leaderboard","three"],
		examplePrompts: [
			"Show the current Coin Clash battle state.",
			"Enlist me in the strongest faction.",
			"Rally my faction with a boost.",
		],
	},
	"io.github.nirholas/concierge-mcp": {
		tagline: "Ask any website's AI concierge a grounded question, and generate the embed to add one to a site.",
		category: "agents",
		tags: [],
		examplePrompts: [
		],
	},
	"io.github.nirholas/copy-mcp": {
		tagline: "Manage copy-trade follows: follow leaders, tune sizing and guard rules, and track fees owed.",
		category: "trading",
		tags: ["copy-trading","follow","sizing","guards","solana"],
		examplePrompts: [
			"Follow this leader wallet with 2% sizing.",
			"List my copy-trade subscriptions.",
			"Update the stop-loss guard on this follow.",
		],
	},
	"io.github.nirholas/ibm-watsonx": {
		tagline: "IBM watsonx.ai on your own account: chat, text generation, embeddings, and tokenization.",
		category: "ai-models",
		tags: ["ibm","watsonx","granite","embeddings","llm"],
		examplePrompts: [
			"Chat with Granite on my watsonx.ai account.",
			"Get watsonx embeddings for these documents.",
			"Tokenize this text with watsonx.",
		],
	},
	"io.github.nirholas/ibm-x402-mcp": {
		tagline: "x402 pay-per-use IBM Granite AI over stdio: chat, code, embeddings, analysis, forecasting, paying USDC per call.",
		category: "ai-models",
		tags: ["ibm","granite","x402","usdc","llm"],
		examplePrompts: [
			"Ask Granite to refactor this function (pay per call).",
			"Get Granite embeddings for these documents.",
			"Analyze the sentiment of these reviews with Granite.",
		],
	},
	"io.github.nirholas/intel-mcp": {
		tagline: "Coin smart-money scores, wallet reputation, signal feeds, and KOL leaderboards.",
		category: "market-data",
		tags: ["smart-money","wallet-intel","signals","kol","solana"],
		examplePrompts: [
			"Score the smart money behind this coin.",
			"Give me the reputation profile of this wallet.",
			"Show the KOL leaderboard.",
		],
	},
	"io.github.nirholas/kol-mcp": {
		tagline: "Per-wallet KOL deep dive: a tracked trader's portfolio P&L and their trades on a given mint.",
		category: "market-data",
		tags: ["kol","wallet","pnl","trades","solana"],
		examplePrompts: [
			"Show this KOL wallet's portfolio and P&L.",
			"List this wallet's trades on this mint.",
			"How did this trader perform this month?",
		],
	},
	"io.github.nirholas/loom-mcp": {
		tagline: "Browse the community 3D-creation gallery, fetch a creation with its viewer URL, and contribute your own.",
		category: "3d",
		tags: ["3d","gallery","community","creations","viewer"],
		examplePrompts: [
			"Show the newest creations in the Loom gallery.",
			"Fetch this creation and give me its viewer link.",
			"Submit my GLB to the Loom gallery.",
		],
	},
	"io.github.nirholas/marketplace-mcp": {
		tagline: "Browse and discover the public three.ws agent marketplace and skills catalog. Read-only.",
		category: "agent-economy",
		tags: ["marketplace","agents","skills","discovery","read-only"],
		examplePrompts: [
			"Browse trading agents on the three.ws marketplace.",
			"Show details for this agent.",
			"List the available agent skill categories.",
		],
	},
	"io.github.nirholas/naming-mcp": {
		tagline: "On-chain identity for AI agents: resolve .sol names, reverse-lookup wallets, check handle availability.",
		category: "identity",
		tags: ["sns","naming","sol","identity","resolve"],
		examplePrompts: [
			"Resolve alice.sol to a wallet address.",
			"Reverse-lookup the .sol name for this wallet.",
			"Is nova.threews.sol available?",
		],
	},
	"io.github.nirholas/notifications-mcp": {
		tagline: "An agent's inbox: read notifications, mark them read, manage delivery preferences, and register Web Push devices.",
		category: "account",
		tags: ["notifications","inbox","web-push","preferences","agents"],
		examplePrompts: [
			"Show my unread notifications.",
			"Mark all notifications as read.",
			"Turn off Telegram delivery and keep Web Push.",
		],
	},
	"io.github.nirholas/portfolio-mcp": {
		tagline: "An agent's trading state: portfolio value, PnL, live balances, trade feed, and signed transfers.",
		category: "trading",
		tags: ["portfolio","pnl","balances","transfers","solana"],
		examplePrompts: [
			"What is my portfolio value and PnL?",
			"Show my live token balances.",
			"Send 0.1 SOL to this address.",
		],
	},
	"io.github.nirholas/provenance-mcp": {
		tagline: "Append-only, signed, on-chain-verifiable agent action log: record and audit what agents did.",
		category: "identity",
		tags: ["provenance","audit","signed","on-chain","agents"],
		examplePrompts: [
			"Record this action to my provenance log.",
			"List my agent's recent actions.",
			"Verify this logged action is untampered.",
		],
	},
	"io.github.nirholas/pumpfun-solana-mcp": {
		tagline: "Free, read-only pump.fun + Solana MCP: token discovery, on-chain analysis, SNS, 3D snapshots.",
		category: "market-data",
		tags: ["pumpfun","solana","sns","analysis","free"],
		examplePrompts: [
			"Analyze this pump.fun token and its holders.",
			"Resolve this .sol name to a wallet.",
			"Snapshot this token as a 3D object.",
		],
	},
	"io.github.nirholas/scene-mcp": {
		tagline: "Speak a placed 3D diorama into being from one sentence, then browse the saved scene gallery.",
		category: "3d",
		tags: ["3d","scene","diorama","text-to-scene","gallery"],
		examplePrompts: [
			"Compose a 3D scene: a campfire ringed by three tents at dusk.",
			"Show me the scene I just made.",
			"List the latest community scenes.",
		],
	},
	"io.github.nirholas/signals-mcp": {
		tagline: "Discover signal feeds ranked by proven edge, rank publishers, and subscribe + track results.",
		category: "market-data",
		tags: ["signals","feeds","edge","publishers","subscriptions"],
		examplePrompts: [
			"List signal feeds ranked by proven edge.",
			"Subscribe to this signal feed.",
			"Show the mirror leaderboard of top publishers.",
		],
	},
	"io.github.nirholas/three-token-mcp": {
		tagline: "Price, hold, and burn $THREE on Solana. The first MCP server whose actions burn a token.",
		category: "payments",
		tags: ["three","solana","burn","token","defi"],
		examplePrompts: [
			"What is the current $THREE price?",
			"Check my $THREE balance.",
			"Burn 1000 $THREE from my wallet.",
		],
	},
	"io.github.nirholas/threews-avatar": {
		tagline: "Drop a live, interactive 3D avatar into any agent chat, or get an embed snippet.",
		category: "avatars",
		tags: ["avatars","embed","3d","chat-ui","gltf"],
		examplePrompts: [
			"Render a live 3D avatar for agent nova in this chat.",
			"Give me an embed code for this avatar.",
			"Fetch the GLB and metadata for this avatar id.",
		],
	},
	"io.github.nirholas/tutor-mcp": {
		tagline: "Read a Pay-As-You-Learn tutoring session's itemized tab and close it for an attested invoice.",
		category: "learning",
		tags: ["tutor","learning","ledger","invoice","pay-as-you-learn"],
		examplePrompts: [
			"Show the itemized tab for my tutoring session.",
			"Close this session and give me the invoice.",
			"How much have I spent this session?",
		],
	},
	"io.github.nirholas/vanity-mcp": {
		tagline: "Read the three.ws vanity-address market: quote difficulty and USDC price, browse the board.",
		category: "market-data",
		tags: ["vanity","solana","addresses","market","bounties"],
		examplePrompts: [
			"Quote the difficulty and price for a wallet ending in THREE.",
			"Browse the vanity-address board.",
			"Appraise the rarity of this vanity address.",
		],
	},
	"io.github.nirholas/vision-mcp": {
		tagline: "Image understanding for AI agents: analyze and describe any image via the three.ws pipeline.",
		category: "ai-models",
		tags: ["vision","image","analysis","captioning","ai"],
		examplePrompts: [
			"Describe what is in this image.",
			"Analyze this screenshot and list the UI elements.",
			"What breed of dog is in this photo?",
		],
	},
	"io.github.nirholas/x402-bridge": {
		tagline: "An auto-paying bridge that pays any x402 endpoint on the open web, with Bazaar discovery and spend caps.",
		category: "payments",
		tags: ["x402","bridge","auto-pay","spend-caps","usdc"],
		examplePrompts: [
			"Pay this x402 URL and return the response, capped at $0.10 total.",
			"Discover a weather x402 API and call it.",
			"Set a per-call spend cap and pay this endpoint.",
		],
	},
	"io.github.nirholas/x402-mcp": {
		tagline: "Self-custodial x402 wallet for AI agents: find, inspect, and pay any service in USDC or $THREE from your own key.",
		category: "payments",
		tags: ["x402","wallet","usdc","self-custodial","payments"],
		examplePrompts: [
			"Find x402 services that generate images.",
			"Inspect the price of this x402 endpoint before paying.",
			"Pay and call this x402 endpoint with a $0.05 cap.",
		],
	},};

/** Every server*.json manifest in the repo, as repo-relative paths. */
function manifestPaths() {
	const remotes = readdirSync(ROOT)
		.filter((f) => /^server(-[\w-]+)?\.json$/.test(f))
		.sort();
	// Package manifests sit next to their package.json. Discovered from disk so
	// a new package is never silently absent; the three outside packages/ are
	// named because their layout differs.
	const dirs = [
		'mcp-server',
		'mcp-bridge',
		'robinhood/hood-mcp',
		...readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => join('packages', e.name)),
	];
	const packages = dirs
		.map((d) => join(d, 'server.json'))
		.filter((p) => existsSync(join(ROOT, p)))
		.sort();
	return [...remotes, ...packages];
}

/** The install/connect snippet a directory shows for one manifest. */
function connectFor(manifest) {
	const remote = manifest.remotes?.[0]?.url;
	if (remote) return remote;
	const pkg = manifest.packages?.[0];
	if (!pkg) return null;
	const args = (pkg.packageArguments ?? [])
		.filter((a) => a.type === 'positional' && a.value)
		.map((a) => a.value);
	return ['npx', '-y', pkg.identifier, ...args].join(' ');
}

const servers = [];
const missingCopy = [];

for (const path of manifestPaths()) {
	const manifest = JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
	const remote = manifest.remotes?.[0];
	const pkg = manifest.packages?.[0];
	const overlay = OVERLAY[manifest.name];
	if (!overlay) missingCopy.push(`${manifest.name} (${path})`);

	servers.push({
		name: manifest.name,
		title: manifest.title ?? manifest.name.split('/').pop(),
		type: remote ? 'remote' : 'stdio',
		transport: remote?.type ?? pkg?.transport?.type ?? 'stdio',
		connect: connectFor(manifest),
		npmPackage: pkg?.identifier ?? null,
		version: manifest.version,
		description: manifest.description,
		tagline: overlay?.tagline ?? manifest.description,
		category: overlay?.category ?? 'other',
		tags: overlay?.tags ?? [],
		examplePrompts: overlay?.examplePrompts ?? [],
		requiredEnv: (pkg?.environmentVariables ?? []).filter((v) => v.isRequired).map((v) => v.name),
		websiteUrl: manifest.websiteUrl ?? PUBLISHER.website,
		repository: manifest.repository?.url ?? PUBLISHER.repository,
		registryUrl: `https://registry.modelcontextprotocol.io/?q=${encodeURIComponent(manifest.name)}`,
		icon: manifest.icons?.[0]?.src ?? PUBLISHER.icon,
	});
}

servers.sort((a, b) => a.name.localeCompare(b.name));

const doc = {
	$comment:
		'CANONICAL SOURCE OF TRUTH for every three.ws MCP directory listing. Regenerate with ' +
		'scripts/build-mcp-listing-source.mjs; do NOT hand-edit this JSON. Factual fields ' +
		'(name/title/description/version/connect/requiredEnv) are read live from the server*.json ' +
		'manifests, so a listing can never drift from what we publish. Curated copy lives in the ' +
		"script's OVERLAY.",
	generatedBy: 'scripts/build-mcp-listing-source.mjs',
	publisher: PUBLISHER,
	fieldConsumers: FIELD_CONSUMERS,
	counts: {
		total: servers.length,
		remote: servers.filter((s) => s.type === 'remote').length,
		stdio: servers.filter((s) => s.type === 'stdio').length,
	},
	servers,
};

const rendered = `${JSON.stringify(doc, null, 2)}\n`;

if (missingCopy.length) {
	for (const name of missingCopy) {
		console.error(`[mcp-listing-source] no curated listing copy for ${name}. Add it to OVERLAY`);
	}
	process.exit(1);
}

if (CHECK) {
	const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
	if (current !== rendered) {
		console.error('[mcp-listing-source] out of date. Run node scripts/build-mcp-listing-source.mjs');
		process.exit(1);
	}
	console.log(`[mcp-listing-source] up to date: ${doc.counts.total} servers (${doc.counts.remote} remote, ${doc.counts.stdio} stdio)`);
} else {
	writeFileSync(OUT, rendered);
	console.log(`[mcp-listing-source] wrote ${doc.counts.total} servers (${doc.counts.remote} remote, ${doc.counts.stdio} stdio)`);
}
