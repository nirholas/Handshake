// dashboard-next — Competitive Landscape page.
//
// Investor-demo-quality market intelligence dashboard. Real competitor data from
// primary research (May 2026). Interactive positioning map, feature matrix,
// market growth chart, and detailed competitor profiles. All Canvas 2D charts —
// no chart libraries.

import { mountShell } from '../shell.js';
import { requireUser, esc } from '../api.js';

// ── Competitive data (real research, May 2026) ─────────────────────────────

const MARKET = {
	tam2025: 7.84,
	tam2030: 52.62,
	cagr: 46.3,
};

const CATEGORIES = [
	{ key: 'all', label: 'All' },
	{ key: 'crypto-ai', label: 'Crypto-Native AI' },
	{ key: 'frameworks', label: 'Agent Frameworks' },
	{ key: 'monetization', label: 'API Monetization' },
	{ key: 'payments', label: 'Payment Protocols' },
	{ key: 'first-party', label: 'First-Party AI' },
];

const COMPETITORS = [
	{
		name: 'Virtuals Protocol',
		category: 'crypto-ai',
		threat: 'high',
		funding: '$29.5M ecosystem',
		traction: '18K+ agents, $13.2B monthly vol',
		description: 'Leading AI agent tokenization platform on Base. Agents are tradable, co-owned, revenue-generating tokenized entities.',
		strengths: ['Massive token-driven network effects', 'Multi-chain (Base + BNB)', 'Strong speculative interest driving acquisition'],
		weaknesses: ['Primarily speculative/trading-driven', 'No 3D visualization', 'Variable agent quality'],
		pos: { x: 75, y: 30 },
	},
	{
		name: 'Fetch.ai / ASI Alliance',
		category: 'crypto-ai',
		threat: 'high',
		funding: 'Major crypto project',
		traction: '2.7M agents, Google Cloud partner',
		description: 'Merged entity of Fetch.ai + Ocean Protocol + SingularityNET. Agentverse hosts 2.7M+ registered AI agents.',
		strengths: ['Massive agent count', 'Google Cloud partnership', 'Vertically integrated stack'],
		weaknesses: ['Fragmented across merged projects', 'Questionable agent quality at scale', 'Complex token economics'],
		pos: { x: 60, y: 25 },
	},
	{
		name: 'Autonolas / Olas',
		category: 'crypto-ai',
		threat: 'medium',
		funding: '$13.8M (1kx led)',
		traction: '700K+ tx/month, 30% MoM growth',
		description: 'Decentralized autonomous agent protocol since 2021. Pearl agent app store desktop app for owning agents.',
		strengths: ['Longest track record (since 2021)', 'Developer reward system', 'Genuine on-chain execution'],
		weaknesses: ['Smaller scale', 'Desktop-centric', 'Limited to crypto use cases'],
		pos: { x: 45, y: 40 },
	},
	{
		name: 'elizaOS (ai16z)',
		category: 'crypto-ai',
		threat: 'medium',
		funding: 'Open-source + ELIZAOS token',
		traction: '47.8K GitHub stars, 13K+ Discord',
		description: 'Open-source Web3-friendly AI Agent Operating System with plugin ecosystem and Generative Treasury System.',
		strengths: ['Strong open-source community', 'Solana-native', 'Generative treasury concept'],
		weaknesses: ['Framework-only, no marketplace', 'No hosted deployment', 'Heavily DeFi-focused'],
		pos: { x: 35, y: 55 },
	},
	{
		name: 'CrewAI',
		category: 'frameworks',
		threat: 'medium',
		funding: '$24.5M–$44.5M, $76M valuation',
		traction: '63% of Fortune 500, 2B executions',
		description: 'Enterprise Multi-Agent AI Orchestration Platform with Visual Studio Editor and 100+ built-in tools.',
		strengths: ['Dominant enterprise adoption', 'No-code builder', 'Deep enterprise integrations'],
		weaknesses: ['No crypto/payment layer', 'No external monetization', 'Closed platform'],
		pos: { x: 20, y: 20 },
	},
	{
		name: 'LangChain / LangGraph',
		category: 'frameworks',
		threat: 'low',
		funding: '$160M+ VC',
		traction: '57% have agents in production',
		description: 'Low-level agent orchestration framework with LangSmith observability platform.',
		strengths: ['Massive developer mindshare', 'Best-in-class observability', 'Framework flexibility'],
		weaknesses: ['No marketplace or payment layer', 'Developers build own distribution', 'No crypto integration'],
		pos: { x: 15, y: 35 },
	},
	{
		name: 'MindStudio',
		category: 'monetization',
		threat: 'high',
		funding: 'Growing startup',
		traction: 'Active creator marketplace',
		description: 'No-code AI agent builder with built-in marketplace. Creators keep 100% of revenue.',
		strengths: ['100% revenue share', 'No-code builder', 'Dual-sided marketplace'],
		weaknesses: ['No crypto payments', 'No agent-to-agent commerce', 'Web2 only'],
		pos: { x: 55, y: 65 },
	},
	{
		name: 'RapidAPI',
		category: 'monetization',
		threat: 'low',
		funding: 'Acquired by Nokia ($106M)',
		traction: '4M+ devs, 90% valuation decline',
		description: 'World\'s largest API marketplace. Acquired by Nokia, strategic direction shifted to telco APIs.',
		strengths: ['Massive developer network', 'Established marketplace economics'],
		weaknesses: ['90% valuation decline', 'Not AI-agent-specific', 'Shifted to telco focus'],
		pos: { x: 30, y: 80 },
	},
	{
		name: 'Cloudflare',
		category: 'monetization',
		threat: 'high',
		funding: 'Public company ($30B+)',
		traction: 'Massive developer platform',
		description: 'Full agent infrastructure: Agents SDK, Dynamic Workers, AI Gateway. Co-creator of x402 with Coinbase.',
		strengths: ['Co-creator of x402', 'Global edge network', 'Deep developer trust', 'Acquired Replicate'],
		weaknesses: ['Infrastructure, not marketplace', 'No agent listing/discovery', 'No 3D visualization'],
		pos: { x: 40, y: 15 },
	},
	{
		name: 'ACP (Stripe + OpenAI)',
		category: 'payments',
		threat: 'critical',
		funding: 'Stripe + OpenAI backed',
		traction: 'Live in ChatGPT, 1M+ Shopify merchants',
		description: 'Open standard for AI agents to complete purchases. Live Instant Checkout in ChatGPT with Stripe processing.',
		strengths: ['Stripe + OpenAI backing', 'Fiat-native (credit cards)', 'Massive merchant adoption'],
		weaknesses: ['Consumer e-commerce focused', 'No API micropayments', 'Centralized'],
		pos: { x: 85, y: 15 },
	},
	{
		name: 'x402 (Coinbase)',
		category: 'payments',
		threat: 'opportunity',
		funding: 'Coinbase + Cloudflare',
		traction: '119M cumulative tx, $600M vol',
		description: 'Open protocol using HTTP 402 for stablecoin micropayments. three.ws implements x402 directly.',
		strengths: ['HTTP-native', 'Zero fees', 'Open-source'],
		weaknesses: ['Daily volume collapsed to ~$28K', '~50% artificial transactions', 'Demand lagging hype'],
		pos: { x: 70, y: 45 },
	},
	{
		name: 'MPP (Stripe + Tempo)',
		category: 'payments',
		threat: 'medium',
		funding: 'Stripe backed',
		traction: 'Launched March 2026',
		description: 'Sessions-based protocol. Agents pre-authorize spending and stream micropayments. Hybrid fiat+crypto.',
		strengths: ['Hybrid fiat+crypto', 'Sessions model', 'Stripe integration'],
		weaknesses: ['Very new (March 2026)', 'Unproven adoption', 'Competing with x402'],
		pos: { x: 80, y: 55 },
	},
	{
		name: 'OpenAI GPT Store',
		category: 'first-party',
		threat: 'medium',
		funding: 'OpenAI ($157B valuation)',
		traction: '3M+ custom GPTs',
		description: 'Largest collection of conversational agents inside ChatGPT. Revenue sharing based on engagement metrics.',
		strengths: ['Massive distribution', 'Largest agent collection', 'ChatGPT captive audience'],
		weaknesses: ['Walled garden', 'No crypto, no external API', 'No agent-to-agent commerce', 'Opaque revenue sharing'],
		pos: { x: 90, y: 70 },
	},
	{
		name: 'Bittensor',
		category: 'crypto-ai',
		threat: 'low',
		funding: '$1.5B ecosystem value',
		traction: '$43M Q1 2026 revenue, 128 subnets',
		description: 'Decentralized AI network with 128 active subnets. Real revenue ($43M/quarter) from compute.',
		strengths: ['Real revenue', 'Decentralized compute', 'Institutional interest'],
		weaknesses: ['Compute network, not marketplace', 'Complex staking', 'No agent commerce'],
		pos: { x: 25, y: 50 },
	},
];

const FEATURES = [
	{ name: '3D Agent Visualization', threews: true, virtuals: false, fetchai: false, crewai: false, mindstudio: false, cloudflare: false },
	{ name: 'Agent Marketplace', threews: true, virtuals: true, fetchai: true, crewai: false, mindstudio: true, cloudflare: false },
	{ name: 'x402 Micropayments', threews: true, virtuals: false, fetchai: false, crewai: false, mindstudio: false, cloudflare: true },
	{ name: 'On-Chain Identity (ERC-8004)', threews: true, virtuals: false, fetchai: false, crewai: false, mindstudio: false, cloudflare: false },
	{ name: 'Agent-to-Agent Payments', threews: true, virtuals: true, fetchai: true, crewai: false, mindstudio: false, cloudflare: false },
	{ name: 'Crypto-Native Payments', threews: true, virtuals: true, fetchai: true, crewai: false, mindstudio: false, cloudflare: true },
	{ name: 'Developer SDK', threews: true, virtuals: true, fetchai: true, crewai: true, mindstudio: false, cloudflare: true },
	{ name: 'No-Code Builder', threews: true, virtuals: true, fetchai: false, crewai: true, mindstudio: true, cloudflare: false },
	{ name: 'Skill Monetization', threews: true, virtuals: true, fetchai: true, crewai: false, mindstudio: true, cloudflare: false },
	{ name: 'Multi-Chain Support', threews: true, virtuals: true, fetchai: true, crewai: false, mindstudio: false, cloudflare: false },
	{ name: 'Voice Cloning', threews: true, virtuals: false, fetchai: false, crewai: false, mindstudio: false, cloudflare: false },
	{ name: 'Embeddable Web Components', threews: true, virtuals: false, fetchai: false, crewai: false, mindstudio: false, cloudflare: true },
	{ name: 'Memory System', threews: true, virtuals: false, fetchai: false, crewai: true, mindstudio: false, cloudflare: false },
	{ name: 'Reputation On-Chain', threews: true, virtuals: false, fetchai: false, crewai: false, mindstudio: false, cloudflare: false },
	{ name: 'Selfie-to-Avatar Pipeline', threews: true, virtuals: false, fetchai: false, crewai: false, mindstudio: false, cloudflare: false },
];

const DIFFERENTIATORS = [
	{ icon: 'cube', title: '3D Visualization', description: 'Browser-native WebGL rendering with morph-target emotion blending. No competitor offers embodied 3D agents.' },
	{ icon: 'link', title: 'x402 + On-Chain Identity', description: 'HTTP 402 micropayments combined with ERC-8004 identity across 15+ chains. Permanent, verifiable, transferable agent identities.' },
	{ icon: 'stack', title: 'Full-Stack Platform', description: 'Build, deploy, list, monetize — one platform. Competitors offer fragments: a framework OR a marketplace OR payments. Never all three.' },
	{ icon: 'zap', title: 'Agent Protocol Event Bus', description: 'Zero-dependency observable agent cognition. Every SPEAK, THINK, GESTURE, EMOTE action is visible and debuggable in real-time.' },
	{ icon: 'shield', title: 'Skill Sandboxing', description: 'Untrusted skills run in Web Workers. Trusted skills get main-thread access. Payment-gated execution with x402 proof injection.' },
	{ icon: 'selfie', title: 'Selfie-to-Agent Pipeline', description: 'Photo capture to 3D avatar to deployed agent in under 60 seconds. No competitor offers this end-to-end flow.' },
];

const TAM_PROJECTION = [
	{ year: 2024, value: 5.29 },
	{ year: 2025, value: 7.84 },
	{ year: 2026, value: 11.47 },
	{ year: 2027, value: 16.78 },
	{ year: 2028, value: 24.54 },
	{ year: 2029, value: 35.91 },
	{ year: 2030, value: 52.62 },
];

const THREAT_COLORS = {
	critical: '#ef4444',
	high: '#f97316',
	medium: '#eab308',
	low: '#22c55e',
	opportunity: '#3b82f6',
};

const THREAT_LABELS = {
	critical: 'Critical',
	high: 'High',
	medium: 'Medium',
	low: 'Low',
	opportunity: 'Opportunity',
};

// ── Boot ────────────────────────────────────────────────────────────────────

let activeCategory = 'all';
let expandedCards = new Set();

(async function boot() {
	const main = await mountShell();
	await requireUser();
	injectStyles();

	main.innerHTML = `
		<div class="ls-header">
			<div>
				<h1 class="dn-h1">Competitive Landscape</h1>
				<p class="dn-h1-sub">Market intelligence and competitive positioning for three.ws</p>
			</div>
			<div class="ls-header-badge">
				<div class="ls-badge-label">Total Addressable Market</div>
				<div class="ls-badge-value">$52.62B</div>
				<div class="ls-badge-sub">by 2030 &middot; ${MARKET.cagr}% CAGR</div>
			</div>
		</div>
		<div class="ls-root" data-slot="root"></div>
	`;

	const root = main.querySelector('[data-slot="root"]');
	renderAll(root);
})().catch(err => {
	if (err?.message === 'redirecting') return;
	const main = document.querySelector('.dn-main-inner') || document.body;
	main.innerHTML = `<h1 class="dn-h1">Competitive Landscape</h1><div class="dn-panel" style="padding:32px;text-align:center"><p style="color:var(--nxt-danger);margin-bottom:12px">Failed to load</p><p style="color:var(--nxt-ink-dim);font-size:13px">${esc(err?.message || 'Unknown error')}</p><button class="dn-btn" onclick="location.reload()" style="margin-top:16px">Reload</button></div>`;
});

function renderAll(root) {
	root.innerHTML = '';
	root.appendChild(renderKpis());
	root.appendChild(renderPositionMap());
	root.appendChild(renderDifferentiators());
	root.appendChild(renderCategoryFilter());
	root.appendChild(renderCompetitorGrid());
	root.appendChild(renderFeatureMatrix());
	root.appendChild(renderMarketGrowth());
}

// ── KPI Row ─────────────────────────────────────────────────────────────────

function renderKpis() {
	const el = document.createElement('div');
	el.className = 'ls-kpi-row';

	const uniqueFeatures = FEATURES.filter(f => f.threews && !f.virtuals && !f.fetchai && !f.crewai && !f.mindstudio && !f.cloudflare).length;
	const threewsFeatures = FEATURES.filter(f => f.threews).length;
	const bestCompetitor = Math.max(
		FEATURES.filter(f => f.virtuals).length,
		FEATURES.filter(f => f.fetchai).length,
		FEATURES.filter(f => f.crewai).length,
		FEATURES.filter(f => f.mindstudio).length,
		FEATURES.filter(f => f.cloudflare).length,
	);

	el.innerHTML = `
		<div class="dn-panel ls-kpi">
			<div class="ls-kpi-label">Market Size 2025</div>
			<div class="ls-kpi-value" style="color:var(--nxt-success)">$${MARKET.tam2025}B</div>
			<div class="ls-kpi-sub">${MARKET.cagr}% CAGR to 2030</div>
		</div>
		<div class="dn-panel ls-kpi">
			<div class="ls-kpi-label">Competitors Tracked</div>
			<div class="ls-kpi-value">${COMPETITORS.length}</div>
			<div class="ls-kpi-sub">across ${CATEGORIES.length - 1} categories</div>
		</div>
		<div class="dn-panel ls-kpi">
			<div class="ls-kpi-label">Feature Coverage</div>
			<div class="ls-kpi-value" style="color:var(--nxt-success)">${threewsFeatures}/${FEATURES.length}</div>
			<div class="ls-kpi-sub">next best: ${bestCompetitor}/${FEATURES.length}</div>
		</div>
		<div class="dn-panel ls-kpi">
			<div class="ls-kpi-label">Unique to three.ws</div>
			<div class="ls-kpi-value" style="color:#a78bfa">${uniqueFeatures}</div>
			<div class="ls-kpi-sub">features no competitor has</div>
		</div>
	`;
	return el;
}

// ── Market Position Map (Canvas 2D) ─────────────────────────────────────────

function renderPositionMap() {
	const panel = document.createElement('section');
	panel.className = 'dn-panel ls-map-panel';
	panel.setAttribute('aria-label', 'Market positioning map');
	panel.innerHTML = `
		<div class="ls-map-header">
			<div>
				<div class="dn-panel-title">Market Position</div>
				<div class="dn-panel-sub">Competitive positioning by platform capability vs. crypto integration depth</div>
			</div>
			<div class="ls-map-legend" role="list" aria-label="Threat level legend">
				${Object.entries(THREAT_COLORS).map(([k, c]) => `<span class="ls-legend-item" role="listitem"><span class="ls-legend-dot" style="background:${c}"></span>${THREAT_LABELS[k]}</span>`).join('')}
			</div>
		</div>
		<div class="ls-map-wrap" data-slot="map" style="position:relative;width:100%;height:420px" role="img" aria-label="Scatter plot: three.ws in upper-right quadrant combining full platform capability with deep crypto integration"></div>
	`;

	const mapHost = panel.querySelector('[data-slot="map"]');
	requestAnimationFrame(() => paintPositionMap(mapHost));
	return panel;
}

function paintPositionMap(host) {
	host.innerHTML = '';
	const canvas = document.createElement('canvas');
	canvas.style.cssText = 'width:100%;height:100%;display:block;cursor:crosshair';
	host.appendChild(canvas);

	const tooltip = document.createElement('div');
	tooltip.className = 'ls-map-tooltip';
	tooltip.setAttribute('role', 'tooltip');
	tooltip.style.display = 'none';
	host.appendChild(tooltip);

	const dpr = window.devicePixelRatio || 1;
	const rect = host.getBoundingClientRect();
	canvas.width = Math.round(rect.width * dpr);
	canvas.height = Math.round(rect.height * dpr);
	const ctx = canvas.getContext('2d');
	ctx.scale(dpr, dpr);

	const W = rect.width;
	const H = rect.height;
	const PAD = { top: 28, right: 28, bottom: 48, left: 56 };
	const innerW = W - PAD.left - PAD.right;
	const innerH = H - PAD.top - PAD.bottom;

	const allPoints = [
		...COMPETITORS.map(c => ({
			x: PAD.left + (c.pos.x / 100) * innerW,
			y: PAD.top + (1 - c.pos.y / 100) * innerH,
			name: c.name,
			color: THREAT_COLORS[c.threat],
			radius: 7,
			isThreews: false,
		})),
		{
			x: PAD.left + (65 / 100) * innerW,
			y: PAD.top + (1 - 75 / 100) * innerH,
			name: 'three.ws',
			color: '#ffffff',
			radius: 11,
			isThreews: true,
		},
	];

	let progress = 0;
	const duration = 800;
	const startTime = performance.now();

	function draw(now) {
		progress = Math.min(1, (now - startTime) / duration);
		const eased = 1 - Math.pow(1 - progress, 3);

		ctx.clearRect(0, 0, W, H);

		// Grid
		ctx.strokeStyle = 'rgba(255,255,255,0.04)';
		ctx.lineWidth = 0.5;
		for (let i = 0; i <= 10; i++) {
			const x = PAD.left + (i / 10) * innerW;
			ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, H - PAD.bottom); ctx.stroke();
			const y = PAD.top + (i / 10) * innerH;
			ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
		}

		// Quadrant labels
		ctx.font = '11px Inter, system-ui, sans-serif';
		ctx.fillStyle = 'rgba(255,255,255,0.08)';
		ctx.textAlign = 'center';
		ctx.fillText('ENTERPRISE TOOLS', PAD.left + innerW * 0.25, PAD.top + innerH * 0.12);
		ctx.fillText('CRYPTO INFRASTRUCTURE', PAD.left + innerW * 0.75, PAD.top + innerH * 0.12);
		ctx.fillText('LEGACY APIS', PAD.left + innerW * 0.25, PAD.top + innerH * 0.88);
		ctx.fillText('EMERGING PROTOCOLS', PAD.left + innerW * 0.75, PAD.top + innerH * 0.88);

		// Axis labels
		ctx.fillStyle = 'rgba(255,255,255,0.3)';
		ctx.font = '10px Inter, system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('Crypto Integration Depth →', PAD.left + innerW / 2, H - 8);
		ctx.save();
		ctx.translate(14, PAD.top + innerH / 2);
		ctx.rotate(-Math.PI / 2);
		ctx.fillText('Platform Capability →', 0, 0);
		ctx.restore();

		// three.ws highlight zone
		const twx = PAD.left + (65 / 100) * innerW;
		const twy = PAD.top + (1 - 75 / 100) * innerH;
		const grad = ctx.createRadialGradient(twx, twy, 0, twx, twy, 100 * eased);
		grad.addColorStop(0, 'rgba(167,139,250,0.08)');
		grad.addColorStop(1, 'rgba(167,139,250,0)');
		ctx.fillStyle = grad;
		ctx.beginPath();
		ctx.arc(twx, twy, 100 * eased, 0, Math.PI * 2);
		ctx.fill();

		// Points
		allPoints.forEach(p => {
			const scale = eased;
			const r = p.radius * scale;
			if (r < 0.5) return;

			if (p.isThreews) {
				const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
				glow.addColorStop(0, 'rgba(167,139,250,0.2)');
				glow.addColorStop(1, 'rgba(167,139,250,0)');
				ctx.fillStyle = glow;
				ctx.beginPath();
				ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
				ctx.fill();

				ctx.strokeStyle = 'rgba(167,139,250,0.5)';
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
				ctx.stroke();
			}

			ctx.beginPath();
			ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
			ctx.fillStyle = p.isThreews ? '#a78bfa' : p.color;
			ctx.fill();

			if (scale > 0.6) {
				ctx.fillStyle = p.isThreews ? '#a78bfa' : 'rgba(255,255,255,0.5)';
				ctx.font = p.isThreews ? 'bold 13px Inter, system-ui, sans-serif' : '10px Inter, system-ui, sans-serif';
				ctx.textAlign = 'center';
				ctx.fillText(p.name, p.x, p.y - r - (p.isThreews ? 10 : 8));
			}
		});

		if (progress < 1) requestAnimationFrame(draw);
	}

	requestAnimationFrame(draw);

	canvas.addEventListener('mousemove', e => {
		const br = canvas.getBoundingClientRect();
		const mx = e.clientX - br.left;
		const my = e.clientY - br.top;
		let hit = null;
		let closestDist = 20;
		allPoints.forEach(p => {
			const d = Math.sqrt((p.x - mx) ** 2 + (p.y - my) ** 2);
			if (d < closestDist) { closestDist = d; hit = p; }
		});
		if (hit) {
			const comp = hit.isThreews ? null : COMPETITORS.find(c => c.name === hit.name);
			tooltip.innerHTML = `<strong>${esc(hit.name)}</strong>${comp ? `<br><span style="color:${THREAT_COLORS[comp.threat]}">${THREAT_LABELS[comp.threat]} threat</span><br>${esc(comp.traction)}` : '<br>Full-stack AI agent platform'}`;
			tooltip.style.display = 'block';
			const left = Math.min(mx + 12, W - 220);
			tooltip.style.left = left + 'px';
			tooltip.style.top = (my - 10) + 'px';
		} else {
			tooltip.style.display = 'none';
		}
	});
	canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

// ── Differentiators ─────────────────────────────────────────────────────────

function renderDifferentiators() {
	const section = document.createElement('section');
	section.className = 'ls-diff-section';
	section.setAttribute('aria-label', 'Unique differentiators');

	const DIFF_ICONS = {
		cube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 5v10l-9 5-9-5V7l9-5z"/><path d="M12 22V12"/><path d="M21 7l-9 5-9-5"/></svg>',
		link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>',
		stack: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l10 5-10 5L2 7l10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
		zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
		shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
		selfie: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="10" r="3"/><path d="M6 21v-1a6 6 0 0112 0v1"/></svg>',
	};

	section.innerHTML = `
		<div class="ls-diff-title">
			<h2 class="dn-panel-title" style="font-size:18px">What Only three.ws Has</h2>
			<p class="dn-panel-sub">Capabilities no competitor offers today</p>
		</div>
		<div class="ls-diff-grid" role="list">
			${DIFFERENTIATORS.map(d => `
				<div class="dn-panel ls-diff-card" role="listitem" tabindex="0">
					<div class="ls-diff-icon" aria-hidden="true">${DIFF_ICONS[d.icon]}</div>
					<h3 class="ls-diff-card-title">${esc(d.title)}</h3>
					<p class="ls-diff-card-desc">${esc(d.description)}</p>
					<span class="ls-diff-badge" aria-label="Exclusive to three.ws">Exclusive</span>
				</div>
			`).join('')}
		</div>
	`;
	return section;
}

// ── Category Filter ─────────────────────────────────────────────────────────

function renderCategoryFilter() {
	const bar = document.createElement('nav');
	bar.className = 'ls-cat-bar';
	bar.setAttribute('role', 'tablist');
	bar.setAttribute('aria-label', 'Competitor categories');
	bar.innerHTML = CATEGORIES.map(c =>
		`<button class="ls-cat-btn${c.key === activeCategory ? ' is-active' : ''}" role="tab" aria-selected="${c.key === activeCategory}" data-cat="${c.key}">${esc(c.label)}${c.key !== 'all' ? ` <span class="ls-cat-count">${COMPETITORS.filter(comp => comp.category === c.key).length}</span>` : ''}</button>`
	).join('');

	bar.addEventListener('click', e => {
		const btn = e.target.closest('.ls-cat-btn');
		if (!btn) return;
		activeCategory = btn.dataset.cat;
		const root = document.querySelector('[data-slot="root"]');
		if (root) renderAll(root);
	});
	return bar;
}

// ── Competitor Cards ────────────────────────────────────────────────────────

function renderCompetitorGrid() {
	const grid = document.createElement('div');
	grid.className = 'ls-comp-grid';
	grid.setAttribute('role', 'list');

	const filtered = activeCategory === 'all'
		? COMPETITORS
		: COMPETITORS.filter(c => c.category === activeCategory);

	if (!filtered.length) {
		grid.innerHTML = `<div class="dn-panel" style="grid-column:1/-1;padding:48px;text-align:center"><p style="color:var(--nxt-ink-dim)">No competitors in this category.</p></div>`;
		return grid;
	}

	filtered.forEach(comp => {
		const card = document.createElement('article');
		card.className = 'dn-panel ls-comp-card';
		card.setAttribute('role', 'listitem');

		const isExpanded = expandedCards.has(comp.name);
		const catLabel = CATEGORIES.find(c => c.key === comp.category)?.label || comp.category;

		card.innerHTML = `
			<div class="ls-comp-top">
				<div class="ls-comp-info">
					<div class="ls-comp-name">${esc(comp.name)}</div>
					<div class="ls-comp-cat">${esc(catLabel)}</div>
				</div>
				<span class="ls-threat-badge" style="background:${THREAT_COLORS[comp.threat]}20;color:${THREAT_COLORS[comp.threat]};border:1px solid ${THREAT_COLORS[comp.threat]}30">${THREAT_LABELS[comp.threat]}</span>
			</div>
			<p class="ls-comp-desc">${esc(comp.description)}</p>
			<div class="ls-comp-metrics">
				<div class="ls-comp-metric"><span class="ls-comp-metric-label">Funding</span><span class="ls-comp-metric-value">${esc(comp.funding)}</span></div>
				<div class="ls-comp-metric"><span class="ls-comp-metric-label">Traction</span><span class="ls-comp-metric-value">${esc(comp.traction)}</span></div>
			</div>
			<div class="ls-comp-expand ${isExpanded ? 'is-open' : ''}">
				<div class="ls-comp-expand-inner">
					<div class="ls-comp-sw">
						<div class="ls-comp-sw-col">
							<div class="ls-comp-sw-title ls-sw-strength">Strengths</div>
							<ul class="ls-comp-sw-list">${comp.strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul>
						</div>
						<div class="ls-comp-sw-col">
							<div class="ls-comp-sw-title ls-sw-weakness">Weaknesses</div>
							<ul class="ls-comp-sw-list">${comp.weaknesses.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
						</div>
					</div>
				</div>
			</div>
			<button class="ls-comp-toggle" aria-expanded="${isExpanded}" aria-label="${isExpanded ? 'Collapse' : 'Expand'} details for ${esc(comp.name)}">
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="ls-comp-chevron ${isExpanded ? 'is-open' : ''}"><path d="M4 6l4 4 4-4"/></svg>
			</button>
		`;

		const toggleBtn = card.querySelector('.ls-comp-toggle');
		const expandDiv = card.querySelector('.ls-comp-expand');
		const chevron = card.querySelector('.ls-comp-chevron');

		toggleBtn.addEventListener('click', () => {
			const opening = !expandedCards.has(comp.name);
			if (opening) expandedCards.add(comp.name); else expandedCards.delete(comp.name);
			expandDiv.classList.toggle('is-open', opening);
			chevron.classList.toggle('is-open', opening);
			toggleBtn.setAttribute('aria-expanded', String(opening));
			toggleBtn.setAttribute('aria-label', `${opening ? 'Collapse' : 'Expand'} details for ${comp.name}`);
		});

		grid.appendChild(card);
	});

	return grid;
}

// ── Feature Matrix ──────────────────────────────────────────────────────────

function renderFeatureMatrix() {
	const panel = document.createElement('section');
	panel.className = 'dn-panel ls-matrix-panel';
	panel.setAttribute('aria-label', 'Feature comparison matrix');

	const cols = [
		{ key: 'threews', label: 'three.ws' },
		{ key: 'virtuals', label: 'Virtuals' },
		{ key: 'fetchai', label: 'Fetch.ai' },
		{ key: 'crewai', label: 'CrewAI' },
		{ key: 'mindstudio', label: 'MindStudio' },
		{ key: 'cloudflare', label: 'Cloudflare' },
	];

	panel.innerHTML = `
		<div class="dn-panel-title">Feature Comparison</div>
		<div class="dn-panel-sub" style="margin-bottom:16px">How three.ws stacks up against key competitors across ${FEATURES.length} capabilities</div>
		<div class="ls-matrix-wrap">
			<table class="ls-matrix" role="grid">
				<thead>
					<tr>
						<th class="ls-matrix-feature-col" scope="col">Feature</th>
						${cols.map(c => `<th scope="col" class="${c.key === 'threews' ? 'ls-matrix-hl' : ''}">${esc(c.label)}</th>`).join('')}
					</tr>
				</thead>
				<tbody>
					${FEATURES.map(f => `
						<tr>
							<td class="ls-matrix-feature">${esc(f.name)}</td>
							${cols.map(c => {
								const has = f[c.key];
								const cls = c.key === 'threews' ? 'ls-matrix-hl' : '';
								return `<td class="${cls}" aria-label="${has ? 'Yes' : 'No'}"><span class="ls-matrix-check ${has ? 'is-yes' : 'is-no'}">${has ? '✓' : '—'}</span></td>`;
							}).join('')}
						</tr>
					`).join('')}
					<tr class="ls-matrix-total">
						<td><strong>Total</strong></td>
						${cols.map(c => {
							const count = FEATURES.filter(f => f[c.key]).length;
							const cls = c.key === 'threews' ? 'ls-matrix-hl' : '';
							return `<td class="${cls}"><strong style="${c.key === 'threews' ? 'color:#a78bfa' : ''}">${count}</strong></td>`;
						}).join('')}
					</tr>
				</tbody>
			</table>
		</div>
	`;
	return panel;
}

// ── Market Growth Chart (Canvas 2D) ─────────────────────────────────────────

function renderMarketGrowth() {
	const panel = document.createElement('section');
	panel.className = 'dn-panel ls-growth-panel';
	panel.setAttribute('aria-label', 'Market growth projection chart');
	panel.innerHTML = `
		<div class="ls-growth-header">
			<div>
				<div class="dn-panel-title">AI Agent Market Growth</div>
				<div class="dn-panel-sub">Total addressable market projection ($B), 2024–2030</div>
			</div>
			<div class="ls-growth-stat">
				<span class="ls-growth-stat-value">$${MARKET.tam2030}B</span>
				<span class="ls-growth-stat-label">by 2030</span>
			</div>
		</div>
		<div data-slot="growth-chart" style="position:relative;width:100%;height:280px;margin-top:16px" role="img" aria-label="Bar chart: AI agent market growing from $5.29B in 2024 to $52.62B in 2030"></div>
	`;

	const chartHost = panel.querySelector('[data-slot="growth-chart"]');
	requestAnimationFrame(() => paintGrowthChart(chartHost));
	return panel;
}

function paintGrowthChart(host) {
	host.innerHTML = '';
	const canvas = document.createElement('canvas');
	canvas.style.cssText = 'width:100%;height:100%;display:block';
	host.appendChild(canvas);

	const dpr = window.devicePixelRatio || 1;
	const rect = host.getBoundingClientRect();
	canvas.width = Math.round(rect.width * dpr);
	canvas.height = Math.round(rect.height * dpr);
	const ctx = canvas.getContext('2d');
	ctx.scale(dpr, dpr);

	const W = rect.width;
	const H = rect.height;
	const PAD = { top: 24, right: 16, bottom: 40, left: 52 };
	const innerW = W - PAD.left - PAD.right;
	const innerH = H - PAD.top - PAD.bottom;

	const max = Math.max(...TAM_PROJECTION.map(p => p.value)) * 1.15;
	const barGap = 12;
	const totalSlots = TAM_PROJECTION.length;
	const slotW = innerW / totalSlots;
	const barW = Math.min(60, slotW - barGap);

	let progress = 0;
	const duration = 900;
	const startTime = performance.now();

	function draw(now) {
		progress = Math.min(1, (now - startTime) / duration);
		const eased = 1 - Math.pow(1 - progress, 3);

		ctx.clearRect(0, 0, W, H);

		// Grid
		ctx.strokeStyle = 'rgba(255,255,255,0.04)';
		ctx.lineWidth = 0.5;
		for (let i = 0; i <= 5; i++) {
			const y = PAD.top + (i / 5) * innerH;
			ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
			const val = ((5 - i) / 5) * max;
			ctx.fillStyle = 'rgba(255,255,255,0.3)';
			ctx.font = '10px Inter, system-ui, sans-serif';
			ctx.textAlign = 'right';
			ctx.fillText('$' + val.toFixed(0) + 'B', PAD.left - 8, y + 4);
		}

		TAM_PROJECTION.forEach((p, i) => {
			const cx = PAD.left + slotW * i + slotW / 2;
			const x = cx - barW / 2;
			const barH = (p.value / max) * innerH * eased;
			const y = PAD.top + innerH - barH;

			const grad = ctx.createLinearGradient(0, y, 0, PAD.top + innerH);
			if (p.year >= 2026) {
				grad.addColorStop(0, 'rgba(167,139,250,0.9)');
				grad.addColorStop(1, 'rgba(167,139,250,0.3)');
			} else {
				grad.addColorStop(0, 'rgba(255,255,255,0.5)');
				grad.addColorStop(1, 'rgba(255,255,255,0.15)');
			}

			ctx.fillStyle = grad;
			ctx.beginPath();
			const r = Math.min(4, barW / 4);
			ctx.moveTo(x + r, y);
			ctx.lineTo(x + barW - r, y);
			ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
			ctx.lineTo(x + barW, PAD.top + innerH);
			ctx.lineTo(x, PAD.top + innerH);
			ctx.lineTo(x, y + r);
			ctx.quadraticCurveTo(x, y, x + r, y);
			ctx.closePath();
			ctx.fill();

			if (eased > 0.5) {
				ctx.fillStyle = p.year >= 2026 ? '#a78bfa' : 'rgba(255,255,255,0.6)';
				ctx.font = 'bold 12px Inter, system-ui, sans-serif';
				ctx.textAlign = 'center';
				ctx.fillText('$' + p.value.toFixed(1) + 'B', cx, y - 8);
			}

			ctx.fillStyle = 'rgba(255,255,255,0.4)';
			ctx.font = '11px Inter, system-ui, sans-serif';
			ctx.textAlign = 'center';
			ctx.fillText(String(p.year), cx, H - 12);
		});

		if (eased > 0.7) {
			const opacity = Math.min(1, (eased - 0.7) / 0.3);
			ctx.fillStyle = `rgba(167,139,250,${opacity * 0.8})`;
			ctx.font = 'bold 14px Inter, system-ui, sans-serif';
			ctx.textAlign = 'right';
			ctx.fillText(MARKET.cagr + '% CAGR', W - PAD.right, PAD.top + 16);
		}

		if (progress < 1) requestAnimationFrame(draw);
	}

	requestAnimationFrame(draw);

	canvas.addEventListener('mousemove', e => {
		const br = canvas.getBoundingClientRect();
		const mx = e.clientX - br.left;
		let closest = null;
		let closestDist = slotW;
		TAM_PROJECTION.forEach((p, i) => {
			const cx = PAD.left + slotW * i + slotW / 2;
			const d = Math.abs(cx - mx);
			if (d < closestDist) { closestDist = d; closest = p; }
		});
		canvas.title = closest ? `${closest.year}: $${closest.value}B TAM` : '';
	});
}

// ── Styles ───────────────────────────────────────────────────────────────────

function injectStyles() {
	if (document.getElementById('ls-styles')) return;
	const style = document.createElement('style');
	style.id = 'ls-styles';
	style.textContent = `
/* Root */
.ls-root { display: flex; flex-direction: column; gap: 20px; }

/* Header */
.ls-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; flex-wrap: wrap; }
.ls-header-badge { text-align: right; }
.ls-badge-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--nxt-ink-dim); font-weight: 500; }
.ls-badge-value { font-size: 36px; font-weight: 800; letter-spacing: -0.03em; background: linear-gradient(135deg, #a78bfa 0%, #818cf8 50%, #60a5fa 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; line-height: 1.1; }
.ls-badge-sub { font-size: 12px; color: var(--nxt-ink-fade); margin-top: 2px; }

/* KPIs */
.ls-kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.ls-kpi { padding: 20px; }
.ls-kpi-label { font-size: 11px; color: var(--nxt-ink-dim); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 500; margin-bottom: 6px; }
.ls-kpi-value { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.ls-kpi-sub { font-size: 12px; color: var(--nxt-ink-fade); margin-top: 4px; }

/* Position Map */
.ls-map-panel { padding: 24px; }
.ls-map-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
.ls-map-legend { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; }
.ls-legend-item { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--nxt-ink-dim); }
.ls-legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.ls-map-wrap { border-radius: var(--nxt-radius-sm); overflow: hidden; background: var(--nxt-bg-1); }
.ls-map-tooltip { position: absolute; pointer-events: none; background: var(--nxt-glass-strong); border: 1px solid var(--nxt-stroke-strong); border-radius: 8px; padding: 8px 12px; font-size: 12px; color: var(--nxt-ink); line-height: 1.5; z-index: 10; backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); max-width: 220px; }

/* Differentiators */
.ls-diff-title { margin-bottom: 16px; }
.ls-diff-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.ls-diff-card { padding: 24px; position: relative; transition: border-color 0.2s, transform 0.2s; }
.ls-diff-card:hover { border-color: var(--nxt-stroke-strong); transform: translateY(-2px); }
.ls-diff-card:focus-visible { outline: 2px solid #a78bfa; outline-offset: 2px; border-radius: var(--nxt-radius); }
.ls-diff-icon { width: 36px; height: 36px; color: #a78bfa; margin-bottom: 14px; }
.ls-diff-icon svg { width: 100%; height: 100%; }
.ls-diff-card-title { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
.ls-diff-card-desc { font-size: 13px; color: var(--nxt-ink-dim); line-height: 1.5; }
.ls-diff-badge { display: inline-block; margin-top: 12px; padding: 3px 10px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #a78bfa; background: rgba(167,139,250,0.12); border: 1px solid rgba(167,139,250,0.2); border-radius: var(--nxt-radius-pill); }

/* Category filter */
.ls-cat-bar { display: flex; gap: 6px; flex-wrap: wrap; }
.ls-cat-btn { padding: 7px 16px; border: 1px solid var(--nxt-stroke); border-radius: var(--nxt-radius-pill); background: none; color: var(--nxt-ink-dim); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; transition: background 0.15s, color 0.15s, border-color 0.15s; display: flex; align-items: center; gap: 6px; }
.ls-cat-btn:hover { background: rgba(255,255,255,0.04); color: var(--nxt-ink); }
.ls-cat-btn:focus-visible { outline: 2px solid #a78bfa; outline-offset: 2px; }
.ls-cat-btn.is-active { background: rgba(167,139,250,0.12); color: #a78bfa; border-color: rgba(167,139,250,0.3); }
.ls-cat-count { font-size: 10px; background: rgba(255,255,255,0.06); padding: 1px 6px; border-radius: 10px; }
.ls-cat-btn.is-active .ls-cat-count { background: rgba(167,139,250,0.2); }

/* Competitor cards */
.ls-comp-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
.ls-comp-card { padding: 20px; transition: border-color 0.2s; }
.ls-comp-card:hover { border-color: var(--nxt-stroke-strong); }
.ls-comp-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
.ls-comp-name { font-size: 16px; font-weight: 600; }
.ls-comp-cat { font-size: 11px; color: var(--nxt-ink-fade); margin-top: 2px; }
.ls-threat-badge { padding: 3px 10px; border-radius: var(--nxt-radius-pill); font-size: 11px; font-weight: 600; white-space: nowrap; }
.ls-comp-desc { font-size: 13px; color: var(--nxt-ink-dim); line-height: 1.5; margin-bottom: 14px; }
.ls-comp-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 8px; }
.ls-comp-metric-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--nxt-ink-fade); font-weight: 500; }
.ls-comp-metric-value { font-size: 12px; color: var(--nxt-ink); margin-top: 2px; font-weight: 500; }
.ls-comp-expand { max-height: 0; overflow: hidden; transition: max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1); }
.ls-comp-expand.is-open { max-height: 400px; }
.ls-comp-expand-inner { padding-top: 14px; border-top: 1px solid var(--nxt-stroke); margin-top: 8px; }
.ls-comp-sw { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.ls-comp-sw-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
.ls-sw-strength { color: var(--nxt-success); }
.ls-sw-weakness { color: var(--nxt-danger); }
.ls-comp-sw-list { list-style: none; padding: 0; margin: 0; font-size: 12px; color: var(--nxt-ink-dim); line-height: 1.7; }
.ls-comp-sw-list li::before { content: '•'; margin-right: 6px; }
.ls-comp-toggle { display: flex; align-items: center; justify-content: center; width: 100%; padding: 4px; background: none; border: none; color: var(--nxt-ink-fade); cursor: pointer; transition: color 0.15s; margin-top: 4px; }
.ls-comp-toggle:hover { color: var(--nxt-ink); }
.ls-comp-toggle:focus-visible { outline: 2px solid #a78bfa; outline-offset: 2px; border-radius: 4px; }
.ls-comp-chevron { width: 16px; height: 16px; transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1); }
.ls-comp-chevron.is-open { transform: rotate(180deg); }

/* Feature Matrix */
.ls-matrix-panel { padding: 24px; }
.ls-matrix-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.ls-matrix { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 640px; }
.ls-matrix th { text-align: center; font-weight: 600; font-size: 12px; padding: 10px 12px; border-bottom: 1px solid var(--nxt-stroke-strong); color: var(--nxt-ink-dim); text-transform: uppercase; letter-spacing: 0.03em; }
.ls-matrix-feature-col { text-align: left !important; min-width: 180px; }
.ls-matrix td { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.03); text-align: center; }
.ls-matrix-feature { text-align: left; font-weight: 500; color: var(--nxt-ink); }
.ls-matrix-hl { background: rgba(167,139,250,0.05); }
.ls-matrix thead .ls-matrix-hl { color: #a78bfa !important; background: rgba(167,139,250,0.08); }
.ls-matrix-check { font-size: 14px; font-weight: 700; }
.ls-matrix-check.is-yes { color: var(--nxt-success); }
.ls-matrix-check.is-no { color: rgba(255,255,255,0.12); }
.ls-matrix-total td { border-top: 1px solid var(--nxt-stroke-strong); border-bottom: none; padding-top: 12px; font-size: 14px; }
.ls-matrix tbody tr:hover { background: rgba(255,255,255,0.02); }

/* Market Growth */
.ls-growth-panel { padding: 24px; }
.ls-growth-header { display: flex; justify-content: space-between; align-items: flex-start; }
.ls-growth-stat { text-align: right; }
.ls-growth-stat-value { font-size: 28px; font-weight: 800; background: linear-gradient(135deg, #a78bfa, #60a5fa); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
.ls-growth-stat-label { display: block; font-size: 11px; color: var(--nxt-ink-fade); text-transform: uppercase; letter-spacing: 0.06em; }

/* Responsive */
@media (max-width: 1100px) {
	.ls-diff-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 900px) {
	.ls-kpi-row { grid-template-columns: repeat(2, 1fr); }
	.ls-comp-grid { grid-template-columns: 1fr; }
	.ls-diff-grid { grid-template-columns: 1fr; }
	.ls-comp-sw { grid-template-columns: 1fr; }
}
@media (max-width: 600px) {
	.ls-kpi-row { grid-template-columns: 1fr; }
	.ls-header { flex-direction: column; }
	.ls-header-badge { text-align: left; }
	.ls-badge-value { font-size: 28px; }
	.ls-map-wrap { height: 300px !important; }
	.ls-growth-header { flex-direction: column; gap: 8px; }
	.ls-growth-stat { text-align: left; }
	.ls-cat-bar { gap: 4px; }
	.ls-cat-btn { padding: 6px 12px; font-size: 11px; }
}
`;
	document.head.appendChild(style);
}
