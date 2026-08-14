// Type definitions for @three-ws/reputation

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

export interface SupportedChain {
	id: number;
	name: string;
	testnet: boolean;
	explorer: string;
}

/** Chains where the ERC-8004 Identity Registry is deployed (mainnets + testnets). */
export declare const SUPPORTED_CHAINS: readonly SupportedChain[];

export type ChainSelector = string | number;
export type SolanaNetwork = 'mainnet' | 'devnet';
export type AttestKind = 'feedback' | 'validation' | 'task';

export interface ReputationOptions {
	/** Solana network for asset-address reads. Default `'mainnet'`. */
	network?: SolanaNetwork;
	signal?: AbortSignal;
}

/** Wallet-trust reputation (three.ws agent UUID). */
export interface WalletReputation {
	kind: 'wallet';
	agentId: string | null;
	name: string | null;
	score: number | null;
	max: number | null;
	tier: string | null;
	tierLabel: string | null;
	accent: string | null;
	isNew: boolean;
	totals: unknown | null;
	evidence: unknown | null;
	isOwner: boolean;
	computedAt: string | null;
	partial: boolean;
	raw: unknown;
}

export interface SolanaFeedback {
	total: number;
	verified: number;
	credentialed: number;
	eventAttested: number;
	disputed: number;
	uniqueAttesters: number;
	uniqueVerifiedAttesters: number;
	scoreAvg: number | null;
	scoreAvgVerified: number | null;
	scoreAvgWeighted: number | null;
}

export interface StakeSummary {
	totalLamports: string;
	count: number;
	uniqueStakers: number;
	topStakers: Array<{ attester: string | null; lamports: string; score: number | null }>;
}

/** On-chain attestation reputation (Solana asset address). */
export interface SolanaReputation {
	kind: 'solana';
	agent: string | null;
	network: string | null;
	feedback: SolanaFeedback;
	validation: unknown | null;
	tasks: unknown | null;
	stake: StakeSummary;
	disputesFiled: number;
	revokedCount: number;
	tokenActivity: unknown | null;
	pumpPayments: unknown | null;
	lastIndexedAt: string | null;
	raw: unknown;
}

export type ReputationResult = WalletReputation | SolanaReputation;

export interface LeaderboardOptions {
	/** 1-50, default 20. */
	limit?: number;
	signal?: AbortSignal;
}

export interface LeaderboardAgent {
	rank: number | null;
	id: string | null;
	name: string | null;
	avatarThumbnailUrl: string | null;
	solanaAddress: string | null;
	score: number | null;
	tier: string | null;
	tierLabel: string | null;
	totals: unknown | null;
	agentUrl: string | null;
	breakdownUrl: string | null;
	raw: unknown;
}

export interface Leaderboard {
	generatedAt: string | null;
	count: number;
	scored: number;
	agents: LeaderboardAgent[];
	raw: unknown;
}

export interface ValidationOptions {
	/** Chain name or numeric id; overrides the positional chainId. */
	chain?: ChainSelector;
	signal?: AbortSignal;
}

export interface ValidationRead {
	chain: string;
	chainId: number;
	agentId?: string | null;
	kind?: string | null;
	registry?: string | null;
	available: boolean;
	exists: boolean;
	passed: boolean | null;
	proofHash?: string | null;
	proofURI?: string | null;
	proofUrlResolved?: string | null;
	validator?: string | null;
	validatorExplorer?: string | null;
	validatedAt?: string | null;
	reason?: string | null;
	raw: unknown;
}

export interface AttestInput {
	/** Target agent: a Solana asset (base58) or a uint ERC-8004 agentId. */
	agent: string;
	kind?: AttestKind;
	/** Required for an EVM (uint agentId) target. */
	chain?: ChainSelector;
	/** Solana network for an asset target. Default `'mainnet'`. */
	network?: SolanaNetwork;
	/** Explicit GLB url to validate; resolved from the agent when omitted. */
	glbUrl?: string;
	signal?: AbortSignal;
}

export interface AttestReceipt {
	lane: 'evm' | 'solana';
	status: 'minted' | 'deduped';
	ok: boolean;
	passed: boolean | null;
	kind: string | null;
	signature: string | null;
	txExplorer: string | null;
	proofHash: string | null;
	proofURI: string | null;
	validator: string | null;
	chainId?: number | null;
	agentId?: string | null;
	network?: string | null;
	asset?: string | null;
	deduped?: boolean;
	validatedAt?: string | null;
	raw: unknown;
}

export interface ReputationClientOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	/** Bearer token (needs `avatars:write` scope) for `attest()`. */
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface ReputationClient {
	reputation(agent: string | number, opts?: ReputationOptions): Promise<ReputationResult>;
	leaderboard(opts?: LeaderboardOptions): Promise<Leaderboard>;
	validation(chainId: ChainSelector, agentId: string | number, opts?: ValidationOptions): Promise<ValidationRead>;
	attest(input: AttestInput): Promise<AttestReceipt>;
}

export declare function createReputation(options?: ReputationClientOptions): ReputationClient;
export declare function reputation(agent: string | number, opts?: ReputationOptions): Promise<ReputationResult>;
export declare function leaderboard(opts?: LeaderboardOptions): Promise<Leaderboard>;
export declare function validation(chainId: ChainSelector, agentId: string | number, opts?: ValidationOptions): Promise<ValidationRead>;
export declare function attest(input: AttestInput): Promise<AttestReceipt>;
