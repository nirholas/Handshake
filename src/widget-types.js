// Widget type registry + brand defaults + per-type config validators.
// Both the Studio UI and the public widget runtime import from here.
//
// Every shipped widget has a working runtime (`status: 'ready'`). The
// `status`/`isReady()` machinery stays so a newly-scaffolded type can be added
// as `'pending'` — saving its config while the runtime renders a "coming soon"
// banner — and flipped to `'ready'` the moment its runtime lands.

import { z } from 'zod';

export const WIDGET_TYPES = {
	turntable: {
		label: 'Turntable Showcase',
		desc: 'Hero banner — auto-rotate, no UI, just the avatar.',
		status: 'ready',
		icon: '◎',
	},
	'animation-gallery': {
		label: 'Animation Gallery',
		desc: 'Click through every clip on a rigged avatar.',
		status: 'ready',
		icon: '▶',
	},
	'talking-agent': {
		label: 'Talking Agent',
		desc: 'Embodied chat — your agent on your site.',
		status: 'ready',
		icon: '◐',
	},
	passport: {
		label: 'ERC-8004 Passport',
		desc: 'On-chain identity card for any agent.',
		status: 'ready',
		icon: '◊',
	},
	'hotspot-tour': {
		label: 'Hotspot Tour',
		desc: 'Annotated 3D scene with clickable points of interest.',
		status: 'ready',
		icon: '⌖',
	},
	'pumpfun-feed': {
		label: 'Pump.fun Live Feed',
		desc: 'Solana agent narrates live pump.fun claims and graduations.',
		status: 'ready',
		icon: '✦',
	},
	'kol-trades': {
		label: 'Smart Money Feed',
		desc: 'Live buy/sell activity from KOL and whale wallets for a single token.',
		status: 'ready',
		icon: '◈',
	},
	'live-trades-canvas': {
		label: 'Live Trades Canvas',
		desc: 'Particle visualization of live pump.fun buy/sell trades for a token.',
		status: 'ready',
		icon: '⬡',
	},
	'bonding-curve': {
		label: 'Bonding Curve',
		desc: 'Live graduation progress and bonding-curve climb for a pump.fun token.',
		status: 'ready',
		icon: '◭',
	},
	'walking-avatar': {
		label: 'Walking Avatar',
		desc: 'A roaming 3D avatar visitors can walk around your page — joystick or keyboard.',
		status: 'ready',
		icon: '🚶',
	},
};

// Size presets for the walking-avatar embed frame. Shared by the Studio editor
// and the widget client so the published snippet matches the preview. Walking
// needs horizontal room, so presets lean landscape.
export const WALK_SIZE_PRESETS = Object.freeze({
	S: { width: 360, height: 320 },
	M: { width: 480, height: 420 },
	L: { width: 720, height: 560 },
});

// The environments the walk-embed runtime can actually render (mirrors ENV_IDS
// in src/walk-embed-events.js). Kept here so the Studio picker only offers
// environments the embed understands.
export const WALK_ENVIRONMENTS = Object.freeze([
	['studio', 'Studio'],
	['void', 'Void'],
	['beach', 'Beach'],
	['sunset', 'Sunset'],
	['night', 'Night'],
	['grid', 'Grid'],
]);

export const WIDGET_TYPE_KEYS = Object.keys(WIDGET_TYPES);

export const BRAND_DEFAULTS = Object.freeze({
	background: '#0a0a0a',
	accent: '#ffffff',
	caption: '',
	showControls: true,
	autoRotate: true,
	envPreset: 'neutral',
	cameraPosition: null,
});

const TYPE_DEFAULTS = {
	turntable: { rotationSpeed: 0.5 },
	'animation-gallery': { defaultClip: '', loopAll: false, showClipPicker: true },
	'talking-agent': {
		agentName: '',
		agentTitle: 'AI Agent',
		avatar: 'embedded',
		brainProvider: 'anthropic',
		proxyURL: '',
		systemPrompt: '',
		greeting: 'Hi! Ask me anything.',
		temperature: 0.7,
		maxTurns: 20,
		skills: { speak: true, wave: true, lookAt: true, playClip: true, remember: false },
		showChatHistory: true,
		voiceInput: true,
		voiceOutput: true,
		chatPosition: 'right',
		poweredByBadge: true,
		visitorRateLimit: { msgsPerMinute: 8, msgsPerSession: 50 },
	},
	passport: {
		chain: 'base-sepolia',
		agentId: null,
		wallet: null,
		showReputation: true,
		showRecentFeedback: true,
		showValidation: false,
		showRegistrationJSON: true,
		layout: 'portrait',
		badgeSize: 'medium',
		rotationSpeed: 0.6,
		rpcURL: '',
		refreshIntervalSec: 60,
		showPoweredBy: true,
	},
	'hotspot-tour': { hotspots: [] },
	'pumpfun-feed': {
		kind: 'all',
		minTier: '',
		autoNarrate: true,
		maxCards: 8,
	},
	'kol-trades': {
		mint: '',
		limit: 20,
		refreshMs: 30_000,
	},
	'live-trades-canvas': {
		mint: '',
		chain: 'solana',
		bg: '#0a0a0a',
		minUsd: 0,
	},
	'bonding-curve': {
		mint: '',
		network: 'mainnet',
		refreshMs: 15_000,
		showUsd: true,
	},
	'walking-avatar': {
		controls: 'joystick',
		environment: 'studio',
		autoplay: false,
		walkSpeed: 1.0,
		bg: 'transparent',
		size: 'M',
		width: 480,
		height: 420,
		position: 'inline',
		enableNarration: false,
	},
};

const hexColor = z.string().regex(/^#[0-9a-fA-F]{3,8}$/, 'must be a hex color');
const cameraVec = z.tuple([z.number(), z.number(), z.number()]).nullable();
const envPreset = z.enum(['none', 'neutral', 'venice-sunset', 'footprint-court']);

const brandSchema = z.object({
	background: hexColor.default(BRAND_DEFAULTS.background),
	accent: hexColor.default(BRAND_DEFAULTS.accent),
	caption: z.string().max(280).default(BRAND_DEFAULTS.caption),
	showControls: z.boolean().default(BRAND_DEFAULTS.showControls),
	autoRotate: z.boolean().default(BRAND_DEFAULTS.autoRotate),
	envPreset: envPreset.default(BRAND_DEFAULTS.envPreset),
	cameraPosition: cameraVec.default(BRAND_DEFAULTS.cameraPosition),
});

const TYPE_SCHEMAS = {
	turntable: brandSchema.extend({
		rotationSpeed: z.number().min(0).max(10).default(0.5),
	}),
	'animation-gallery': brandSchema.extend({
		defaultClip: z.string().max(120).default(''),
		loopAll: z.boolean().default(false),
		showClipPicker: z.boolean().default(true),
	}),
	'talking-agent': brandSchema
		.extend({
			agentName: z.string().max(80).default(''),
			agentTitle: z.string().max(80).default('AI Agent'),
			avatar: z.enum(['embedded', 'chat-only']).default('embedded'),
			brainProvider: z
				.enum(['none', 'auto', 'anthropic', 'openrouter', 'groq', 'openai', 'grok', 'watsonx', 'custom'])
				.default('anthropic'),
			proxyURL: z.string().url().startsWith('https://').or(z.literal('')).default(''),
			systemPrompt: z.string().max(4000).default(''),
			greeting: z.string().max(280).default('Hi! Ask me anything.'),
			temperature: z.number().min(0).max(1).default(0.7),
			maxTurns: z.number().int().min(1).max(100).default(20),
			skills: z
				.object({
					speak: z.boolean().default(true),
					wave: z.boolean().default(true),
					lookAt: z.boolean().default(true),
					playClip: z.boolean().default(true),
					remember: z.boolean().default(false),
				})
				.default({
					speak: true,
					wave: true,
					lookAt: true,
					playClip: true,
					remember: false,
				}),
			showChatHistory: z.boolean().default(true),
			voiceInput: z.boolean().default(true),
			voiceOutput: z.boolean().default(true),
			chatPosition: z.enum(['right', 'bottom', 'overlay']).default('right'),
			poweredByBadge: z.boolean().default(true),
			visitorRateLimit: z
				.object({
					msgsPerMinute: z.number().int().min(1).max(60).default(8),
					msgsPerSession: z.number().int().min(1).max(500).default(50),
				})
				.default({ msgsPerMinute: 8, msgsPerSession: 50 }),
		})
		.superRefine((cfg, ctx) => {
			if (cfg.brainProvider === 'custom' && !cfg.proxyURL) {
				ctx.addIssue({
					path: ['proxyURL'],
					code: z.ZodIssueCode.custom,
					message: 'proxyURL is required when brainProvider is "custom"',
				});
			}
		}),
	passport: brandSchema.extend({
		chain: z.string().min(1).default('base-sepolia'),
		agentId: z
			.string()
			.regex(/^\d+$/, 'agentId must be a uint256 string')
			.nullable()
			.default(null),
		wallet: z
			.string()
			.regex(/^0x[0-9a-fA-F]{40}$/)
			.nullable()
			.default(null),
		showReputation: z.boolean().default(true),
		showRecentFeedback: z.boolean().default(true),
		showValidation: z.boolean().default(false),
		showRegistrationJSON: z.boolean().default(true),
		layout: z.enum(['portrait', 'landscape', 'badge']).default('portrait'),
		badgeSize: z.enum(['small', 'medium', 'large']).default('medium'),
		rotationSpeed: z.number().min(0).max(10).default(0.6),
		rpcURL: z.string().url().startsWith('https://').or(z.literal('')).default(''),
		refreshIntervalSec: z.number().int().min(0).max(3600).default(60),
		showPoweredBy: z.boolean().default(true),
	}),
	'hotspot-tour': brandSchema.extend({
		hotspots: z
			.array(
				z.object({
					id: z.string().min(1).max(40),
					label: z.string().min(1).max(120),
					position: z.tuple([z.number(), z.number(), z.number()]),
					body: z.string().max(2000).optional(),
				}),
			)
			.max(40)
			.default([]),
	}),
	'pumpfun-feed': brandSchema.extend({
		kind: z.enum(['all', 'claims', 'graduations']).default('all'),
		minTier: z.enum(['', 'notable', 'influencer', 'mega']).default(''),
		autoNarrate: z.boolean().default(true),
		maxCards: z.number().int().min(1).max(50).default(8),
	}),
	'kol-trades': z.object({
		mint: z.string().default(''),
		limit: z.number().int().min(1).max(100).default(20),
		refreshMs: z.number().int().min(1000).max(300_000).default(30_000),
	}),
	'live-trades-canvas': brandSchema.extend({
		mint: z.string().min(1, 'mint is required'),
		chain: z.enum(['solana']).default('solana'),
		bg: hexColor.default('#0a0a0a'),
		minUsd: z.number().min(0).default(0),
	}),
	'bonding-curve': brandSchema.extend({
		mint: z.string().max(64).default(''),
		network: z.enum(['mainnet', 'devnet']).default('mainnet'),
		refreshMs: z.number().int().min(5_000).max(300_000).default(15_000),
		showUsd: z.boolean().default(true),
	}),
	// The walking avatar runs in its own chrome-less iframe (/walk-embed), not the
	// turntable viewer, so it does NOT inherit brandSchema — it has a self-contained
	// visual model (own background, environment, controls). Every field maps to a
	// /walk-embed query param or an embed-layout knob.
	'walking-avatar': z.object({
		controls: z.enum(['joystick', 'keyboard', 'none']).default('joystick'),
		environment: z.enum(['studio', 'void', 'beach', 'sunset', 'night', 'grid']).default('studio'),
		autoplay: z.boolean().default(false),
		walkSpeed: z.number().min(0.5).max(2).default(1),
		// 'transparent' lets the host page show through; a hex paints a solid color.
		bg: z
			.string()
			.regex(/^(transparent|#[0-9a-fA-F]{3,8})$/, 'must be "transparent" or a hex color')
			.default('transparent'),
		size: z.enum(['S', 'M', 'L', 'custom']).default('M'),
		width: z.number().int().min(100).max(3000).default(480),
		height: z.number().int().min(100).max(3000).default(420),
		position: z.enum(['tl', 'tr', 'bl', 'br', 'inline']).default('inline'),
		enableNarration: z.boolean().default(false),
	}),
};

export function defaultConfig(type) {
	if (!WIDGET_TYPES[type]) throw new Error(`unknown widget type: ${type}`);
	return { ...BRAND_DEFAULTS, ...(TYPE_DEFAULTS[type] || {}) };
}

export function validateConfig(type, config) {
	const schema = TYPE_SCHEMAS[type];
	if (!schema) throw new Error(`unknown widget type: ${type}`);
	const res = schema.safeParse(config || {});
	if (!res.success) {
		const err = new Error(
			res.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; '),
		);
		err.code = 'validation_error';
		throw err;
	}
	return res.data;
}

export function isReady(type) {
	return WIDGET_TYPES[type]?.status === 'ready';
}

// Server-side counterpart — the API can validate the same way.
export const widgetTypeEnum = z.enum(WIDGET_TYPE_KEYS);
export const widgetConfigSchemas = TYPE_SCHEMAS;

// ---------------------------------------------------------------------------
// Chain registry — used by the passport widget to resolve slugs to chainIds,
// pick a public RPC, and build explorer links.
// ---------------------------------------------------------------------------

export const CHAIN_SLUGS = {
	ethereum: 1,
	optimism: 10,
	bsc: 56,
	polygon: 137,
	base: 8453,
	arbitrum: 42161,
	sepolia: 11155111,
	'base-sepolia': 84532,
	'optimism-sepolia': 11155420,
	'arbitrum-sepolia': 421614,
	'polygon-amoy': 80002,
};

// Ordered keyless public RPC hosts per chain. Widgets run embedded on
// third-party origins, so they cannot reach the same-origin /api/evm-rpc proxy
// that three.ws pages use (src/shared/evm-rpc-fallback.js prepends it there);
// this public tail is the whole chain for an embed. Never eth.llamarpc.com,
// which bot-walls keyless POSTs.
export const PUBLIC_RPC_URLS = {
	1: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
	10: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io', 'https://optimism.drpc.org'],
	56: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.drpc.org'],
	137: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com', 'https://polygon.drpc.org'],
	8453: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'],
	42161: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://arbitrum.drpc.org'],
	11155111: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.sepolia.org', 'https://sepolia.drpc.org'],
	84532: ['https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org', 'https://base-sepolia.drpc.org'],
	11155420: ['https://optimism-sepolia-rpc.publicnode.com', 'https://sepolia.optimism.io', 'https://optimism-sepolia.drpc.org'],
	421614: ['https://arbitrum-sepolia-rpc.publicnode.com', 'https://sepolia-rollup.arbitrum.io/rpc', 'https://arbitrum-sepolia.drpc.org'],
	80002: ['https://polygon-amoy-bor-rpc.publicnode.com', 'https://rpc-amoy.polygon.technology', 'https://polygon-amoy.drpc.org'],
};

// First host of each list, for callers that still take a single URL.
export const PUBLIC_RPCS = Object.fromEntries(
	Object.entries(PUBLIC_RPC_URLS).map(([id, urls]) => [id, urls[0]]),
);

export const EXPLORERS = {
	1: 'https://etherscan.io',
	10: 'https://optimistic.etherscan.io',
	56: 'https://bscscan.com',
	137: 'https://polygonscan.com',
	8453: 'https://basescan.org',
	42161: 'https://arbiscan.io',
	11155111: 'https://sepolia.etherscan.io',
	84532: 'https://sepolia.basescan.org',
	11155420: 'https://sepolia-optimism.etherscan.io',
	421614: 'https://sepolia.arbiscan.io',
	80002: 'https://amoy.polygonscan.com',
};

/** Resolve a chain reference (slug or numeric id or numeric string) to chainId. */
export function resolveChainId(ref) {
	if (typeof ref === 'number') return ref;
	if (typeof ref !== 'string') return null;
	const slug = ref.toLowerCase();
	if (CHAIN_SLUGS[slug]) return CHAIN_SLUGS[slug];
	const n = Number(slug);
	return Number.isFinite(n) ? n : null;
}

/** Pretty display name for a chainId. */
export function chainLabel(chainId) {
	const entry = Object.entries(CHAIN_SLUGS).find(([, v]) => v === chainId);
	return entry ? entry[0] : `chain-${chainId}`;
}
