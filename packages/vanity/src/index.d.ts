// Type definitions for @three-ws/vanity

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

/** Bitcoin/Solana Base58 alphabet (excludes the confusable 0 O I l). */
export declare const BASE58_ALPHABET: string;

/** Hard ceiling per prefix/suffix pattern. */
export declare const MAX_PATTERN_LENGTH: number;

export interface Pattern {
	/** Base58 prefix the address must start with. */
	prefix?: string;
	/** Base58 suffix the address must end with. */
	suffix?: string;
	/** Case-insensitive match (folds upper+lower Base58 chars). */
	ignoreCase?: boolean;
}

export interface GrindProgress {
	/** Running total of keypairs tried. */
	attempts: number;
	/** Keypairs/sec. */
	rate: number;
	/** Expected time to a hit at the current rate, e.g. "~12 seconds", "unknown". Memoryless: does not count down. */
	eta: string;
}

export interface GrindOptions extends Pattern {
	/** Alias for `ignoreCase`. */
	caseInsensitive?: boolean;
	/** Cancel the grind; rejects with AbortError. */
	signal?: AbortSignal;
	/** Called ~every 250ms with running attempts / rate / ETA. */
	onProgress?: (progress: GrindProgress) => void;
}

export interface GrindResult {
	/** Base58 address matching your pattern. */
	publicKey: string;
	/** 64-byte Ed25519 secret key — `Keypair.fromSecretKey()`-compatible. */
	secretKey: Uint8Array;
	/** Total keypairs tried. */
	attempts: number;
	/** Wall-clock duration in milliseconds. */
	durationMs: number;
	/** Workers used (always 1 on the local path). */
	workers: number;
}

/** Grind for a vanity Solana address entirely on the local machine. */
export declare function grind(opts?: GrindOptions): Promise<GrindResult>;

/** Mean expected attempts (`58^n`, adjusted for case-insensitivity). */
export declare function expectedAttempts(pattern?: Pattern): number;

/** Validate a single prefix or suffix against Base58 + the length ceiling. */
export declare function validatePattern(pattern: string): { valid: boolean; errors: string[] };

/** Encode a byte array as a Base58 (Solana address) string. */
export declare function base58Encode(bytes: Uint8Array | number[]): string;

export type VanityFormat = 'keypair' | 'mnemonic';

export interface VanityClientOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface GrindViaApiOptions extends Pattern {
	/** Alias for `ignoreCase`. */
	caseInsensitive?: boolean;
	/** `keypair` (default) or an importable BIP-39 `mnemonic`. */
	format?: VanityFormat;
	/** Mnemonic only: 128 → 12 words, 256 → 24 words. */
	strength?: 128 | 256;
	/** Optional X25519 public key — the secret is ECIES-sealed to you. */
	sealTo?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

/**
 * Options for the standalone `grindViaApi()`: the per-call params plus the
 * client knobs (`fetch`, `baseUrl`, `apiKey`). Supplying any of them binds a
 * client to this call instead of using the shared zero-config one. A client
 * built with `createVanity()` takes the client knobs at construction time.
 */
export interface GrindViaApiStandaloneOptions extends GrindViaApiOptions, VanityClientOptions {}

export interface ApiResult {
	address: string | null;
	prefix: string | null;
	suffix: string | null;
	ignoreCase: boolean;
	format: string | null;
	secretKeyBase58: string | null;
	secretKey: Uint8Array | null;
	mnemonic: string | null;
	wordCount: number | null;
	derivationPath: string | null;
	sealed: boolean;
	sealedSecret: unknown | null;
	attempts: number | null;
	durationMs: number | null;
	expectedAttempts: number | null;
	network: string | null;
	explorerUrl: string | null;
	raw: unknown;
}

export interface VanityClient {
	grindViaApi(params: GrindViaApiOptions): Promise<ApiResult>;
}

export declare function createVanity(options?: VanityClientOptions): VanityClient;
export declare function grindViaApi(params: GrindViaApiStandaloneOptions): Promise<ApiResult>;
