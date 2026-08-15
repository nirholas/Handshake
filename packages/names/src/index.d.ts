// Type definitions for @three-ws/names

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

export type Network = 'solana' | 'ethereum';
export type PayMode = 'prep' | 'send';
export type PayeeSource = 'address' | 'sns' | 'username';

export interface NamesClientOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	/** Bearer token attached to every authenticated call. */
	apiKey?: string;
	/** Alias for `apiKey`. */
	token?: string;
	headers?: Record<string, string>;
}

export interface CallOptions {
	signal?: AbortSignal;
	headers?: Record<string, string>;
	/** Per-call bearer token; overrides the client default. */
	token?: string;
}

export interface ResolveOptions extends CallOptions {
	/**
	 * (SNS) also fetch every `.sol` the owner holds and their favorite domain.
	 * Off by default: it costs two extra lookups against the SNS index, which a
	 * plain address resolution does not need.
	 */
	domains?: boolean;
}

export interface ResolveResult {
	/** The resolved name, e.g. `alice.sol` or `vitalik.eth`. Null on a miss. */
	name: string | null;
	/** Owner wallet (base58 for SNS, 0x for ENS). Null when `resolved` is false. */
	address: string | null;
	/** Which registry answered. */
	network: Network;
	/** `false` is a routine "no such name", not an error (SNS only). */
	resolved: boolean;
	/** (SNS) every `.sol` the owner holds. Empty unless the call passed `domains: true`. */
	allDomains: string[];
	/** (SNS) the owner's primary `.sol`. Null unless the call passed `domains: true`. */
	favoriteDomain: string | null;
	/** (SNS) true when `allDomains` hit the 100-name cap and more exist. */
	domainsTruncated: boolean;
	/** (ENS) agents registered to the resolved address. */
	agents?: unknown[];
	raw: unknown;
}

export interface Availability {
	label: string | null;
	parent: string | null;
	fullName: string | null;
	available: boolean;
	owner: string | null;
	raw: unknown;
}

export interface MintInput {
	/** Required. The agent the subdomain attaches to. */
	agentId: string;
	/** Optional. Defaults to the agent's slugified name. 1–63 chars `[a-z0-9-]`. */
	label?: string;
	/** Optional base58 wallet to receive ownership. Must be linked to your account. */
	ownerAddress?: string;
	/** Optional, 1000–10000. Registry bytes reserved. Default 2000. */
	space?: number;
	/** Bearer token (or rely on a session cookie). */
	token?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface MintResult {
	ok: boolean;
	agentId: string | null;
	fullName: string | null;
	parent: string | null;
	owner: string | null;
	signature: string | null;
	explorer: string | null;
	urlRecord: string | null;
	agentUrl: string | null;
	raw: unknown;
}

export interface ClaimInput {
	/** Required. Must equal your account username. */
	label: string;
	/** Optional base58 wallet (linked to your account) to receive ownership. */
	ownerWallet?: string;
	token?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface ClaimResult {
	id: string | null;
	label: string | null;
	parent: string | null;
	ownerWallet: string | null;
	urlRecord: string | null;
	signature: string | null;
	fullName: string | null;
	showcaseUrl: string | null;
	explorer: string | null;
	createdAt: string | null;
	raw: unknown;
}

export interface PayeeClaim {
	user_id: string;
	username: string;
	display_name: string | null;
}

export interface Payee {
	name: string | null;
	address: string | null;
	source: PayeeSource | null;
	resolved: string | null;
	claim?: PayeeClaim | null;
	raw: unknown;
}

export interface PayOptions {
	/** `prep` returns an unsigned tx; `send` has the agent sign and broadcast. Default `prep`. */
	mode?: PayMode;
	/** Required for `prep`. Base58 fee-payer + source. */
	payerWallet?: string;
	/** Required for `send`. The agent that signs (must be yours). */
	agentId?: string;
	/** (`send`) the address you previewed; rejects with `recipient_changed` if the name re-points. */
	expectedAddress?: string;
	/** Optional memo. */
	message?: string;
	/** Bearer token for `send`. */
	token?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface PayPrepResult {
	mode: 'prep';
	recipient: Payee;
	amountUsdc: number | null;
	txBase64: string | null;
	blockhash: string | null;
	lastValidBlockHeight: number | null;
	mint: string | null;
	raw: unknown;
}

export interface PaySendResult {
	mode: 'send';
	recipient: Payee;
	payer: string | null;
	amountUsdc: number | null;
	signature: string | null;
	raw: unknown;
}

export type PayResult = PayPrepResult | PaySendResult;

export interface NamesClient {
	resolve(name: string, opts?: ResolveOptions): Promise<ResolveResult>;
	reverseLookup(address: string, opts?: ResolveOptions): Promise<ResolveResult>;
	checkSubdomain(label: string, opts?: CallOptions): Promise<Availability>;
	mintSubdomain(input: MintInput): Promise<MintResult>;
	claimSubdomain(input: ClaimInput): Promise<ClaimResult>;
	releaseSubdomain(label: string, opts?: CallOptions): Promise<unknown>;
	resolvePayee(name: string, opts?: CallOptions): Promise<Payee>;
	payByName(name: string, amountUsdc: string | number, opts?: PayOptions): Promise<PayResult>;
}

export declare function createNames(options?: NamesClientOptions): NamesClient;
export declare function resolve(name: string, opts?: ResolveOptions): Promise<ResolveResult>;
export declare function reverseLookup(address: string, opts?: ResolveOptions): Promise<ResolveResult>;
export declare function checkSubdomain(label: string, opts?: CallOptions): Promise<Availability>;
export declare function mintSubdomain(input: MintInput): Promise<MintResult>;
export declare function claimSubdomain(input: ClaimInput): Promise<ClaimResult>;
export declare function releaseSubdomain(label: string, opts?: CallOptions): Promise<unknown>;
export declare function resolvePayee(name: string, opts?: CallOptions): Promise<Payee>;
export declare function payByName(name: string, amountUsdc: string | number, opts?: PayOptions): Promise<PayResult>;
