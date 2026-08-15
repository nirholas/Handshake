// Type definitions for @three-ws/x402-server

export declare class ThreeWsError extends Error {
	name: string;
	code: string;
	status: number | null;
	detail?: string;
	retryAfter?: number;
	body: unknown;
}

export declare class PaymentRequiredError extends ThreeWsError {
	accepts: unknown | null;
}

export declare const DEFAULT_BASE_URL: string;
export declare const DEFAULT_FACILITATOR_URL: string;
export declare const X402_VERSION: 2;
export declare const MAX_FEE_BPS: 1000;
export declare const NETWORK_SOLANA_MAINNET: string;
export declare const NETWORK_BASE_MAINNET: string;
export declare const NETWORK_BASE_SEPOLIA: string;

export type Lane = 'solana' | 'base' | 'base-sepolia';

/** A canonical v2 x402 accept entry. */
export interface Accept {
	scheme: 'exact';
	network: string;
	amount: string;
	asset: string;
	payTo: string;
	maxTimeoutSeconds: number;
	resource?: string;
	extra: {
		name: string;
		decimals: number;
		version?: string;
		/** Required on Solana — the facilitator sponsor account that co-signs. */
		feePayer?: string;
		[key: string]: unknown;
	};
}

/** The split of a platform fee carved OUT of the listed price. */
export interface FeeSplit {
	price: string;
	net: string;
	fee: string;
	bps: number;
	recipient: string;
}

/** A pay-to address per lane. At least one lane is required. */
export interface PayTo {
	solana?: string;
	base?: string;
	'base-sepolia'?: string;
}

/**
 * Settlement asset. `'usdc'` resolves canonical USDC per lane; `'three'` resolves
 * the $THREE platform token (Solana-only); or pin explicit addresses per lane.
 */
export type Asset = 'usdc' | 'three' | { solana?: string; base?: string };

export interface BuildChallengeOptions {
	/** Amount in atomic units of the asset (`'10000'` = $0.01 of 6-decimal USDC). */
	price?: string | number;
	asset?: Asset;
	payTo?: PayTo;
	/** Which lanes to advertise. Defaults to every lane present in `payTo`. */
	network?: Lane | Lane[];
	/**
	 * The Solana facilitator sponsor account (required for a Solana accept).
	 * Falls back to the X402_FEE_PAYER_SOLANA env var when omitted.
	 */
	feePayer?: string;
	/**
	 * Advertise $THREE alongside USDC on the Solana lane (a second accept, pushed
	 * after USDC). The platform's two main x402 assets in one challenge.
	 */
	acceptThree?: boolean;
	/**
	 * Atomic $THREE amount (6 decimals) for the `acceptThree` entry. Omit to reuse
	 * the USDC `price` value.
	 */
	threeAmount?: string | number;
	/** Platform fee in basis points, split OUT of price (≤ 1000 / 10%). */
	feeBps?: number;
	/** Fee recipient. Required when feeBps > 0. */
	feeTo?: string;
	maxTimeoutSeconds?: number;
	resourceUrl?: string;
	description?: string;
	mimeType?: string;
	serviceName?: string;
	tags?: string[];
	iconUrl?: string;
	error?: string;
	/** Pre-built accepts[] (raw path) — overrides price/asset/payTo. */
	accepts?: Accept[];
	extensions?: Record<string, unknown>;
}

export interface Challenge {
	x402Version: 2;
	error: string;
	resource: { url: string | null; mimeType: string; description?: string; serviceName?: string; tags?: string[]; iconUrl?: string };
	accepts: Accept[];
	extensions: Record<string, unknown>;
	/** Present only when feeBps > 0 and feeTo is set; null when no fee applies. */
	fee?: FeeSplit | null;
}

/** A verified payment, returned by verifyPayment on success. */
export interface Verified {
	ok: true;
	payer: string | null;
	network: string;
	amount: string;
	accept: Accept;
	paymentPayload: unknown;
	requirement: Accept;
	raw: unknown;
}

/** A rejected / under-paid payment — re-challenge the buyer with `body`. */
export interface Rejected {
	ok: false;
	code: string;
	status: number;
	reason: string;
	body: { x402Version: 2; error: string; accepts: Accept[] };
}

export type VerifyResult = Verified | Rejected;

export interface VerifyArgs {
	paymentHeader?: string;
	xPaymentHeader?: string;
	requirements?: Accept[] | Accept | Challenge;
	signal?: AbortSignal;
}

/** The on-chain settlement receipt (base64 it into X-PAYMENT-RESPONSE). */
export interface Receipt {
	network: string;
	payer: string | null;
	transaction: string | null;
	raw: unknown;
}

/** The verified payer context passed to a paid() handler on a paid call. */
export interface Payment {
	payer: string | null;
	network: string;
	amount: string;
	accept: Accept;
}

/** Adapter that lets paid() serve different runtimes (node req/res vs fetch). */
export interface PaidAdapter {
	read(...args: any[]): any;
	challenge(ctx: any, body: unknown, args: any[], status?: number): any;
	dispatch(ctx: any, handler: Function, payment: Payment, args: any[]): Promise<{ __handled: boolean; value?: unknown }>;
	respond(ctx: any, dispatched: unknown, receipt: Receipt, args: any[]): any;
	/** Settle-then-stream entry point for `streaming: true` (node only). */
	stream?(ctx: any, handler: Function, payment: Payment, receipt: Receipt, args: any[]): any;
	/** Handle a handler throw AFTER a valid payment but before settlement. */
	fail(ctx: any, err: unknown, args: any[]): any;
}

export interface PaidOptions extends BuildChallengeOptions {
	/** Override the facilitator base URL for /verify + /settle. */
	facilitator?: string;
	/** Fired after a successful settlement — record the call, fire a webhook. */
	onSettled?: (receipt: Receipt) => void;
	/**
	 * Response ordering. Default (false) is deliver-then-settle: run the work,
	 * settle, then flush the response with the X-PAYMENT-RESPONSE receipt header.
	 * The buyer never receives the good before settlement. Set `true` for
	 * self-flushing handlers (binary download, SSE, res.pipe): settlement runs
	 * first and the receipt header is emitted up-front. Node adapter only.
	 */
	streaming?: boolean;
	/** Runtime adapter. Defaults to node (req,res); use `fetchAdapter` for fetch. */
	adapter?: PaidAdapter;
}

export declare const fetchAdapter: PaidAdapter;

export interface X402ServerClientOptions {
	/** Facilitator base URL for /verify + /settle. */
	facilitator?: string;
	baseUrl?: string;
	fetch?: typeof fetch;
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface X402ServerClient {
	buildChallenge(opts: BuildChallengeOptions): Challenge;
	verifyPayment(args: VerifyArgs | string, expected?: Accept[] | Accept | Challenge): Promise<VerifyResult>;
	settlePayment(args: { verified: Verified } | Verified): Promise<Receipt>;
	paid(opts: PaidOptions, handler: Function): (...args: any[]) => Promise<unknown>;
}

export declare function createX402Server(options?: X402ServerClientOptions): X402ServerClient;

export declare function buildChallenge(opts: BuildChallengeOptions): Challenge;
export declare function verifyPayment(args: VerifyArgs | string, expected?: Accept[] | Accept | Challenge): Promise<VerifyResult>;
export declare function settlePayment(args: { verified: Verified } | Verified): Promise<Receipt>;
export declare function paid(opts: PaidOptions, handler: Function): (...args: any[]) => Promise<unknown>;

/**
 * Split a platform fee OUT of the listed price. Returns null when no fee applies
 * (rate 0, no recipient, or a sub-atomic fee). `bps` is clamped to [0, 1000].
 */
export declare function feeSplit(priceAtomics: bigint | number | string, bps: number, recipient: string): FeeSplit | null;

/**
 * Resolve the Solana sponsor account: the explicit value, else the
 * X402_FEE_PAYER_SOLANA env var, else null.
 */
export declare function resolveFeePayer(feePayer?: string | null): string | null;
