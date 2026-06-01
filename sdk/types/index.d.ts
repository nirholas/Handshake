export { AgentPanel } from './panel.js';
export type { AgentPanelOptions } from './panel.js';

export { agentRegistration, agentCard, aiPlugin } from './manifests.js';
export type {
	AgentRegistrationOptions,
	AgentCardOptions,
	AiPluginOptions,
} from './manifests.js';

export {
	connectWallet,
	getSigner,
	registerAgent,
	pinToIPFS,
	buildRegistrationJSON,
	getIdentityRegistry,
} from './erc8004/registry.js';
export type {
	WalletConnection,
	RegisterAgentOptions,
	BuildRegistrationJSONOptions,
} from './erc8004/registry.js';

export {
	IDENTITY_REGISTRY_ABI,
	REPUTATION_REGISTRY_ABI,
	VALIDATION_REGISTRY_ABI,
	REGISTRY_DEPLOYMENTS,
	agentRegistryId,
} from './erc8004/abi.js';
export type { RegistryAddresses } from './erc8004/abi.js';

export { PermissionsClient, PermissionError } from './permissions.js';
export type {
	PermissionsClientOptions,
	DelegationPublic,
	ScopePreset,
} from './permissions.js';

export {
	detectSolanaProvider,
	signInWithSolana,
	registerSolanaAgent,
	startSolanaCheckout,
	confirmSolanaPayment,
} from './solana.js';
export type {
	SignInWithSolanaOptions,
	RegisterSolanaAgentOptions,
	StartSolanaCheckoutOptions,
	ConfirmSolanaPaymentOptions,
} from './solana.js';

export {
	attestFeedback,
	attestValidation,
	createTask,
	acceptTask,
	attestRevoke,
	attestDispute,
	listAttestations,
	fetchAttestations,
	fetchReputation,
} from './solana-attestations.js';
export type {
	AttestationResult,
	AttestFeedbackOptions,
	AttestValidationOptions,
	CreateTaskOptions,
	AcceptTaskOptions,
	AttestRevokeOptions,
	AttestDisputeOptions,
	ListAttestationsOptions,
	FetchAttestationsOptions,
	FetchReputationOptions,
} from './solana-attestations.js';

// ── AgentKit ──────────────────────────────────────────────────────────────────

export interface AgentKitOptions {
	name: string;
	description?: string;
	endpoint: string;
	image?: string;
	version?: string;
	org?: string;
	skills?: unknown[];
	services?: unknown[];
	onMessage?: (text: string) => string | Promise<string>;
	welcome?: string;
	voice?: boolean;
}

export interface AgentKitRegisterOptions {
	imageFile?: File;
	services?: unknown[];
	ipfsToken?: string;
	onStatus?: (message: string) => void;
}

export interface AgentKitManifestsOptions {
	openapiUrl?: string;
	registrations?: unknown[];
}

export declare class AgentKit {
	constructor(opts: AgentKitOptions);
	mount(container?: HTMLElement): this;
	open(): this;
	close(): this;
	addMessage(role: string, text: string): this;
	dispose(): void;
	register(opts?: AgentKitRegisterOptions): Promise<{
		agentId: number;
		registrationCID: string;
		txHash: string;
	}>;
	manifests(opts?: AgentKitManifestsOptions): {
		agentRegistration: object;
		agentCard: object;
		aiPlugin: object;
	};
}

// ─── x402 paid-skill client ──────────────────────────────────────────────────

export interface SkillPrice {
	skill: string;
	amount: string;
	currency_mint?: string;
	currency?: string;
	chain?: string;
	is_active?: boolean;
}

export interface X402Manifest {
	version: string | number;
	kind: 'agent-skill';
	agent_id: string;
	skill: string;
	amount: string;
	currency: string;
	recipient: string;
	recipient_name?: string;
	valid_until: number;
	intent_url: string;
	verify_url: string;
	retry_with_header: string;
}

export declare class PaymentRequiredError extends Error {
	constructor(manifest: X402Manifest);
	manifest: X402Manifest;
}

/** Settles a 402 payment manifest on-chain and resolves to the paid intent id. */
export type PayIntentFn = (manifest: X402Manifest) => Promise<{ intentId: string } | string>;

export interface PaymentSigner {
	payIntent: PayIntentFn;
}

export interface AgentClientOptions {
	baseUrl?: string;
	apiKey?: string;
	fetch?: typeof fetch;
}

export interface InvokeSkillOptions {
	signer?: PaymentSigner;
	payIntent?: PayIntentFn;
}

export declare class AgentClient {
	constructor(opts?: AgentClientOptions);
	baseUrl: string;
	apiKey: string;
	getSkillPrices(agentId: string): Promise<SkillPrice[]>;
	getManifest(agentId: string, skill: string): Promise<X402Manifest | null>;
	invokeSkill(
		agentId: string,
		skill: string,
		args?: Record<string, unknown>,
		options?: InvokeSkillOptions,
	): Promise<unknown>;
}
