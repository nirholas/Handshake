// Type definitions for @three-ws/concierge

export const VERSION: string;

export interface VoiceProfile {
	lang?: string;
	pitch?: number;
	rate?: number;
	match?: string[];
}

export interface ConciergeAvatar {
	id: string;
	name: string;
	tagline: string;
	file?: string;
	url?: string;
	lipsync: 'viseme' | 'jaw' | 'animation';
	framing: 'bust' | 'upper' | 'full';
	voice: VoiceProfile;
	accent: string;
}

export const AVATARS: ConciergeAvatar[];
export const DEFAULT_AVATAR_ID: string;
export const DEFAULT_ASSET_BASE: string;
export function getAvatar(id?: string): ConciergeAvatar;
export function avatarUrl(entry: ConciergeAvatar, assetBase?: string): string | null;
export function customAvatarEntry(urlOrEntry: string | Partial<ConciergeAvatar>): ConciergeAvatar;

export interface SitePayload {
	url: string;
	name: string;
	title: string;
	description: string;
	headings: string[];
	nav: string[];
	knowledge: string;
	content: string;
}

export const MAX_CONTENT_CHARS: number;
export const MAX_KNOWLEDGE_CHARS: number;
export function harvestSiteContext(
	doc: Document,
	opts?: { knowledge?: string; siteName?: string },
): Omit<SitePayload, 'knowledge'>;
export function buildSitePayload(
	doc: Document,
	opts?: { knowledge?: string; siteName?: string },
): SitePayload;

export interface ChatTurn {
	role: 'user' | 'assistant';
	content: string;
}

export const DEFAULT_ENDPOINT: string;
export const MAX_HISTORY_TURNS: number;
export function parseSseEvent(raw: string): Record<string, unknown> | null;
export function createSseBuffer(onEvent: (evt: Record<string, unknown>) => void): {
	push(text: string): void;
};
export function askConcierge(opts: {
	endpoint?: string;
	message: string;
	history?: ChatTurn[];
	site?: Partial<SitePayload>;
	persona?: string;
	lang?: string;
	signal?: AbortSignal;
	onChunk?: (text: string) => void;
}): Promise<{ text: string; provider?: string; model?: string }>;

// ── Shopping mode (Shopify) ─────────────────────────────────────────────────

export interface ShopProduct {
	id: number | string;
	handle: string;
	title: string;
	url: string;
	type: string;
	vendor: string;
	tags: string[];
	priceMin: number;
	priceMax: number;
	currency: string;
	available: boolean;
	onSale: boolean;
	image: string;
	variantId: number | string | null;
	summary: string;
}

export interface ShopCollection {
	title: string;
	handle: string;
	url: string;
}

export interface ShopCatalog {
	store: string;
	origin: string;
	currency: string;
	products: ShopProduct[];
	collections: ShopCollection[];
}

export interface ShopPolicies {
	shipping?: string;
	returns?: string;
	privacy?: string;
	terms?: string;
}

export interface ShoppingIntent {
	maxPrice: number | null;
	sort: 'price-asc' | 'price-desc' | null;
	onSale: boolean;
}

export interface ShoppingPayload {
	store: string;
	currency: string;
	summary: string;
	collections: string[];
	policies: string;
	products: string;
}

export const MAX_RECOMMENDATIONS: number;
export function normalizeShopDomain(input: unknown): string;
export function shopOrigin(domain: unknown): string;
export function detectShop(win?: unknown): { shop: string; currency: string } | null;
export function money(amount: number, currency?: string): string;
export function normalizeProduct(
	raw: Record<string, unknown>,
	origin: string,
	currency?: string,
): ShopProduct | null;
export function fetchCatalog(opts?: {
	shop?: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	currency?: string;
	limit?: number;
	maxProducts?: number;
}): Promise<ShopCatalog>;
export function fetchPolicies(opts?: {
	shop?: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}): Promise<ShopPolicies>;
export function parseIntent(query: string): ShoppingIntent;
export function searchProducts(
	products: ShopProduct[],
	query: string,
	k?: number,
): ShopProduct[];
export function catalogSummary(catalog: ShopCatalog | null | undefined): string;
export function buildShoppingPayload(
	catalog: ShopCatalog | null | undefined,
	recommended: ShopProduct[],
	policies?: ShopPolicies,
	question?: string,
): ShoppingPayload | null;

export function renderMarkdown(text: string): string;
export function stripMarkdown(text: string): string;
export function escapeHtml(text: string): string;

export function micSupported(): boolean;
export function createMic(opts?: {
	lang?: string;
	onInterim?: (transcript: string) => void;
	onState?: (state: 'listening' | 'idle') => void;
	onError?: (err: Error) => void;
}): {
	supported: boolean;
	readonly listening: boolean;
	start(): Promise<string>;
	stop(): void;
	dispose(): void;
};

export interface ConciergeConfig {
	endpoint?: string;
	avatar?: string;
	avatars?: string[];
	customAvatar?: string | Partial<ConciergeAvatar>;
	assetBase?: string;
	name?: string;
	siteName?: string;
	greeting?: string;
	suggestions?: string[];
	knowledge?: string;
	shop?: string;
	shopping?: boolean;
	currency?: string;
	maxProducts?: number;
	persona?: string;
	accent?: string;
	position?: 'bottom-right' | 'bottom-left';
	theme?: 'auto' | 'dark' | 'light';
	open?: boolean;
	muted?: boolean;
	picker?: boolean;
	teaser?: boolean;
	zIndex?: number;
	lang?: string;
}

export type ConciergeEvent =
	| 'ready'
	| 'open'
	| 'close'
	| 'message'
	| 'agentchange'
	| 'catalog'
	| 'addtocart'
	| 'error';

export class Concierge {
	constructor(config?: ConciergeConfig);
	readonly open: boolean;
	readonly busy: boolean;
	readonly muted: boolean;
	avatar: ConciergeAvatar;
	messages: ChatTurn[];
	on(event: ConciergeEvent, fn: (detail: unknown) => void): () => void;
	setOpen(open: boolean): void;
	toggle(): void;
	ask(text: string): Promise<string>;
	setAvatar(id: string): Promise<void>;
	togglePicker(force?: boolean): void;
	setMuted(muted: boolean): void;
	reset(): void;
	dispose(): void;
}

export function drainSentences(buffer: string): { sentences: string[]; rest: string };

export class ThreeConciergeElement extends HTMLElement {
	ask(text: string): Promise<string> | undefined;
	open(): void;
	close(): void;
	reset(): void;
	setAvatar(id: string): Promise<void> | undefined;
	setMuted(muted: boolean): void;
	readonly controller: Concierge | null;
}
export function registerElement(tag?: string): string;

export function mount(config?: ConciergeConfig): Concierge;

export class AvatarStage {
	constructor(container: HTMLElement, opts?: { background?: string });
	load(url: string, opts?: { framing?: 'bust' | 'upper' | 'full' }): Promise<unknown>;
	setSpeaking(on: boolean): void;
	onFrame(fn: (dt: number, nowMs: number) => void): () => void;
	dispose(): void;
}

export class SpeechNarrator {
	constructor(
		stage: AvatarStage,
		opts?: {
			muted?: boolean;
			onState?: (s: 'idle' | 'speaking') => void;
			onCaption?: (text: string | null) => void;
			onError?: (e: Error) => void;
		},
	);
	setAgent(agent: { voice?: VoiceProfile } | null): void;
	setMuted(muted: boolean): void;
	speak(text: string, opts?: { interrupt?: boolean }): Promise<void>;
	cancel(): void;
	readonly speaking: boolean;
	dispose(): void;
}

export function buildMorphMap(root: unknown): { mode: 'arkit' | 'jaw'; map: Map<string, unknown[]> } | null;
export function createLipsync(
	text: string,
	morph: ReturnType<typeof buildMorphMap>,
	opts?: { rate?: number },
): { tick(nowMs: number): void; stop(): void; readonly done: boolean; readonly totalMs: number };
export function estimateDurationMs(text: string): number;

export const CSS: string;
export function ensureStyles(doc?: Document): void;

export default Concierge;
