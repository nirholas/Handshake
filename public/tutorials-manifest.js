/*
 * Tutorial manifest — single source of truth for the tutorial library.
 *
 * Loaded as a classic script by /tutorials (the 3-tier index) and
 * /tutorials/<slug> (the viewer template) — exposes window.TUTORIALS.
 *
 * Each entry maps to a long-form markdown file at /docs/tutorials/<slug>.md
 * which is fetched and rendered by the viewer.
 */
(function () {
	const TUTORIALS = [
		/* ─────────────────────────── EASY ─────────────────────────── */
		{
			slug: 'getting-started',
			tier: 'easy',
			title: 'Getting started (hosted)',
			blurb: 'A five-minute, no-code tour: create an agent, pick a body, give it a personality, share the URL.',
			builds: 'Your first hosted agent with a shareable URL',
			time: '5 min',
			previewModel: '/animations/robotexpressive.glb',
			ctaPrimary: { label: 'Open the editor', href: '/create' },
		},
		{
			slug: 'embed-in-30-seconds',
			tier: 'easy',
			title: 'Embed in 30 seconds',
			blurb: 'Drop one script tag into any HTML page. Your agent loads, auto-sizes, and starts animating.',
			builds: 'A live agent on any web page with one line of HTML',
			time: '2 min',
			previewModel: '/animations/robotexpressive.glb',
			ctaPrimary: { label: 'Open Widget Studio', href: '/studio' },
		},
		{
			slug: 'customize-appearance',
			tier: 'easy',
			title: 'Customize size, position & background',
			blurb: 'Tune every visible knob — bubble size, corner placement, background, rotation speed — entirely through data-* attributes.',
			builds: 'A pixel-perfect floating agent that matches your site',
			time: '8 min',
			previewModel: '/animations/soldier.glb',
			ctaPrimary: { label: 'Open Widget Studio', href: '/studio' },
		},
		{
			slug: 'swap-avatar-in-studio',
			tier: 'easy',
			title: 'Pick & swap an avatar in Studio',
			blurb: 'Visually browse the avatar gallery, switch bodies with one click, and have the change ripple to every embed without redeploying.',
			builds: 'A library of swappable avatar bodies for the same agent',
			time: '6 min',
			previewModel: '/avatars/cz.glb',
			ctaPrimary: { label: 'Open Widget Studio', href: '/studio' },
		},
		{
			slug: 'greeting-and-first-speech',
			tier: 'easy',
			title: 'Add a greeting & first speech line',
			blurb: 'Make your agent say hello the moment it loads — and have its mouth move with the words.',
			builds: 'An agent that greets every visitor by voice',
			time: '7 min',
			previewModel: '/animations/robotexpressive.glb',
			ctaPrimary: { label: 'Open Widget Studio', href: '/studio' },
		},
		{
			slug: 'share-your-agent',
			tier: 'easy',
			title: 'Share your agent (link, QR, social preview)',
			blurb: 'Get a permanent link to your agent, generate a QR for print, and set the Open Graph preview so it looks good in tweets.',
			builds: 'A shareable agent URL with rich previews on every platform',
			time: '6 min',
			previewModel: '/animations/robotexpressive.glb',
			ctaPrimary: { label: 'Open My Agents', href: '/my-agents' },
		},

		/* ────────────────────────── MIDDLE ────────────────────────── */
		{
			slug: 'first-agent',
			tier: 'middle',
			title: 'Build your first agent (from scratch)',
			blurb: 'A complete walkthrough from a blank HTML file to a live, talking 3D character you wrote yourself — no framework, no build tools.',
			builds: 'A self-hosted index.html with a working talking agent',
			time: '40 min',
			previewModel: '/animations/robotexpressive.glb',
			ctaPrimary: { label: 'Read the source', href: '/docs/tutorials/first-agent' },
		},
		{
			slug: 'embed-on-website',
			tier: 'middle',
			title: 'Embed on a website (HTML, React, Next.js)',
			blurb: 'Five different ways to add an agent to your site — pick the one that matches how you build today.',
			builds: 'A production-ready embed in your existing stack',
			time: '30 min',
			previewModel: '/animations/soldier.glb',
			ctaPrimary: { label: 'Embed docs', href: '/docs#embedding' },
		},
		{
			slug: 'personal-ai-site',
			tier: 'middle',
			title: 'Build a personal AI website',
			blurb: 'A 3D version of you, on your domain, ready to answer any question about your work — with a portfolio, contact form, and resume.',
			builds: 'A complete personal site at yourname.com powered by an agent',
			time: '60 min',
			previewModel: '/avatars/cz.glb',
			ctaPrimary: { label: 'Create your agent', href: '/create' },
		},
		{
			slug: 'js-api-events',
			tier: 'middle',
			title: 'Drive the agent with the JavaScript API',
			blurb: 'Listen for the ready event, play animations on demand, make the agent speak from anywhere in your app code.',
			builds: 'An agent driven by your app — clicks, scrolls, form submits',
			time: '25 min',
			previewModel: '/animations/robotexpressive.glb',
			ctaPrimary: { label: 'JS API reference', href: '/docs#js-api' },
		},
		{
			slug: 'web-component-end-to-end',
			tier: 'middle',
			title: 'Use the <agent-3d> web component end-to-end',
			blurb: 'Skip the script tag — drop a real custom element into your DOM, bind attributes, and use the full event lifecycle.',
			builds: 'A reusable <agent-3d> tag wired into your component system',
			time: '30 min',
			previewModel: '/animations/soldier.glb',
			ctaPrimary: { label: 'Web component docs', href: '/docs#web-component' },
		},
		{
			slug: 'trigger-from-page-events',
			tier: 'middle',
			title: 'Trigger the agent from page events',
			blurb: 'Make your agent react to clicks, scrolls, form submits, and route changes — turn it into a real co-pilot, not a chat widget.',
			builds: 'An agent that reacts to the user journey on your site',
			time: '25 min',
			previewModel: '/animations/robotexpressive.glb',
			ctaPrimary: { label: 'JS API reference', href: '/docs#js-api' },
		},
		{
			slug: 'upload-custom-glb',
			tier: 'middle',
			title: 'Upload a custom GLB avatar',
			blurb: 'Bring your own model — any glTF 2.0 .glb from Blender, three.ws Studio, or any other source. Get it validated, fixed, and live.',
			builds: 'A fully custom avatar body running in production',
			time: '35 min',
			previewModel: '/animations/soldier.glb',
			ctaPrimary: { label: 'Open Validator', href: '/validation' },
		},
		{
			slug: 'agent-personality',
			tier: 'middle',
			title: 'Give your agent a personality',
			blurb: 'System prompt design, voice & tone, memory of past conversations, refusal patterns — make your agent feel like a real character.',
			builds: 'A distinct, on-brand persona that holds across thousands of chats',
			time: '40 min',
			previewModel: '/avatars/cz.glb',
			ctaPrimary: { label: 'Agent system docs', href: '/docs#agent-system' },
		},
		{
			slug: 'connect-ai-brain',
			tier: 'middle',
			title: 'Connect Anthropic or OpenAI as the brain',
			blurb: 'Plug your own model provider into the agent loop. Bring your API key, choose your model, control cost and latency.',
			builds: 'An agent powered by the model you choose, billed to your account',
			time: '30 min',
			previewModel: '/animations/robotexpressive.glb',
			ctaPrimary: { label: 'Open My Agents', href: '/my-agents' },
		},

		/* ───────────────────────── ADVANCED ───────────────────────── */
		{
			slug: 'custom-skill',
			tier: 'advanced',
			title: 'Build a custom skill',
			blurb: 'A complete walkthrough of building a weather skill an agent can invoke — bundle format, LLM tool calling, context API.',
			builds: 'A live weather skill bundled, deployed, and callable by the agent',
			time: '60 min',
			previewModel: '/animations/robotexpressive.glb',
			ctaPrimary: { label: 'Skills docs', href: '/docs#skills' },
		},
		{
			slug: 'register-onchain',
			tier: 'advanced',
			title: 'Register your agent on-chain (ERC-8004)',
			blurb: 'Give your agent a permanent, verifiable identity. Publish an ERC-8004 attestation anyone can read from any chain.',
			builds: 'A registered agent identity discoverable from any wallet',
			time: '45 min',
			previewModel: '/animations/robotexpressive.glb',
			ctaPrimary: { label: 'ERC-8004 docs', href: '/docs#erc8004' },
		},
		{
			slug: 'mint-pumpfun-token',
			tier: 'advanced',
			title: 'Mint an agent token on Pump.fun',
			blurb: 'Launch a Solana token for your agent, bond it to its on-chain identity, and let people speculate on (or hold) a piece of it.',
			builds: 'A live Pump.fun token bonded to your agent identity',
			time: '50 min',
			previewModel: '/animations/soldier.glb',
			ctaPrimary: { label: 'Pump.fun stream', href: '/pumpfun' },
		},
		{
			slug: 'paid-x402-endpoint',
			tier: 'advanced',
			title: 'Build a paid x402 endpoint your agent calls',
			blurb: 'Stand up an API that other agents pay USDC to call — using the x402 protocol on Base mainnet. Real money, real flow.',
			builds: 'A revenue-generating paid API, callable agent-to-agent',
			time: '75 min',
			previewModel: '/avatars/cz.glb',
			ctaPrimary: { label: 'See paid calls', href: '/pay/calls' },
		},
		{
			slug: 'self-host-agent-backend',
			tier: 'advanced',
			title: 'Self-host the agent backend',
			blurb: 'Run the full three.ws backend on your own infrastructure — workers, function endpoints, model proxies. No three.ws dependency in production.',
			builds: 'A fully independent agent stack running on your own servers',
			time: '90 min',
			previewModel: '/animations/robotexpressive.glb',
			ctaPrimary: { label: 'Architecture docs', href: '/docs#architecture' },
		},
		{
			slug: 'multi-agent-coordination',
			tier: 'advanced',
			title: 'Multi-agent coordination',
			blurb: 'Two or more agents on the same page that talk to each other — turn-taking, shared memory, delegating subtasks.',
			builds: 'A team of agents that collaborate to solve a single task',
			time: '60 min',
			previewModel: '/animations/soldier.glb',
			ctaPrimary: { label: 'Multi-agent docs', href: '/docs#multi-agent' },
		},
		{
			slug: 'mcp-server-for-your-agent',
			tier: 'advanced',
			title: 'Expose your agent as an MCP server',
			blurb: 'Wrap your agent in the Model Context Protocol so any MCP-compatible client (Claude Desktop, Cursor, etc.) can drive it.',
			builds: 'Your agent reachable as a tool from any MCP-aware app',
			time: '45 min',
			previewModel: '/animations/robotexpressive.glb',
			ctaPrimary: { label: 'MCP docs', href: '/docs#mcp' },
		},
		{
			slug: 'skill-with-database-auth',
			tier: 'advanced',
			title: 'Custom skill with database + auth',
			blurb: 'A real production skill — Postgres-backed CRM lookup, signed requests, per-user permissions, rate limits. Not a toy weather demo.',
			builds: 'A production CRM-lookup skill with auth and rate limits',
			time: '90 min',
			previewModel: '/avatars/cz.glb',
			ctaPrimary: { label: 'Skills docs', href: '/docs#skills' },
		},
		{
			slug: 'deploy-to-vercel-custom-domain',
			tier: 'advanced',
			title: 'Deploy to Vercel with a custom domain',
			blurb: 'Take a forked three.ws and ship it as agent.yourcompany.com — CI, environment variables, custom domain, SSL, the lot.',
			builds: 'A live agent on agent.yourcompany.com with CI and SSL',
			time: '45 min',
			previewModel: '/animations/robotexpressive.glb',
			ctaPrimary: { label: 'Deployment docs', href: '/docs#deployment' },
		},
	];

	const TIER_META = {
		easy: {
			label: 'Easy',
			eyebrow: 'No-code · 5–10 min',
			blurb: 'Copy-paste and click. Zero code. If you can edit an HTML file (or use a CMS), you can do these.',
			accent: '#ffffff',
			accentSoft: 'rgba(255, 255, 255, 0.16)',
			accentBorder: 'rgba(255, 255, 255, 0.32)',
		},
		middle: {
			label: 'Middle',
			eyebrow: 'HTML & JS · 15–40 min',
			blurb: 'You write some code. Comfortable with HTML and a bit of JavaScript? Start here.',
			accent: '#cccccc',
			accentSoft: 'rgba(255, 255, 255, 0.16)',
			accentBorder: 'rgba(255, 255, 255, 0.32)',
		},
		advanced: {
			label: 'Advanced',
			eyebrow: 'Real engineering · 45+ min',
			blurb: 'Backend, on-chain, and real production concerns. Bring a Node toolchain and a server.',
			accent: '#fbbf24',
			accentSoft: 'rgba(251, 191, 36, 0.16)',
			accentBorder: 'rgba(251, 191, 36, 0.32)',
		},
	};

	function tutorialBySlug(slug) {
		return TUTORIALS.find((t) => t.slug === slug) || null;
	}

	function tutorialIndex(slug) {
		return TUTORIALS.findIndex((t) => t.slug === slug);
	}

	function tutorialsByTier(tier) {
		return TUTORIALS.filter((t) => t.tier === tier);
	}

	window.TUTORIALS = TUTORIALS;
	window.TUTORIAL_TIERS = TIER_META;
	window.tutorialBySlug = tutorialBySlug;
	window.tutorialIndex = tutorialIndex;
	window.tutorialsByTier = tutorialsByTier;
})();
