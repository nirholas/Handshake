/**
 * @three-ws/sdk — TypeScript definitions
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ServiceEntry {
	name: string;
	endpoint: string;
	version?: string;
}

export interface SkillDefinition {
	id: string;
	name: string;
	description: string;
	tags?: string[];
	examples?: string[];
}

export interface RegistrationRecord {
	agentId: number;
	agentRegistry: string;
}

export interface RegistrationResult {
	agentId: number;
	registrationCID: string;
	txHash: string;
}

export type StatusCallback = (message: string) => void;
export type MessageHandler = (text: string) => string | Promise<string>;

// ---------------------------------------------------------------------------
// AgentPanel
// ---------------------------------------------------------------------------

export interface AgentPanelOptions {
	title?: string;
	welcome?: string;
	placeholder?: string;
	onMessage?: MessageHandler;
	voice?: boolean;
}

export class AgentPanel {
	constructor(options?: AgentPanelOptions);
	mount(container: HTMLElement): this;
	open(): void;
	close(): void;
	addMessage(role: 'ak-agent' | 'ak-user' | string, text: string): void;
	dispose(): void;
}

// ---------------------------------------------------------------------------
// Avatar embed
// ---------------------------------------------------------------------------

export interface LoadAvatarOptions {
	/** three.ws agent id (e.g. "agt_abc123") */
	agentId: string;
	/** Element to mount the avatar into */
	container: HTMLElement;
	/** 'orbit' (default) or 'none' */
	controls?: 'orbit' | 'none';
	/** Override the agent-3d CDN URL */
	cdnUrl?: string;
	/** Optional SRI integrity hash for the script tag */
	integrity?: string;
	/** CSS width (default: '100%') */
	width?: string;
	/** CSS height (default: '100%') */
	height?: string;
	/** Extra attributes to forward to the <agent-3d> element */
	attrs?: Record<string, string>;
}

export interface AvatarHandle {
	element: HTMLElement;
	playAnimation(hint: string): unknown;
	dispose(): void;
}

export function loadAvatar(options: LoadAvatarOptions): Promise<AvatarHandle>;

// ---------------------------------------------------------------------------
// AgentKit — the primary API
// ---------------------------------------------------------------------------

export interface AgentKitOptions {
	/** Agent display name (required) */
	name: string;
	/** Agent public URL (required) */
	endpoint: string;
	/** What the agent does */
	description?: string;
	/** Public URL to logo/avatar */
	image?: string;
	/** Semver version string */
	version?: string;
	/** Organization name for agent-card.json */
	org?: string;
	/** A2A skill definitions */
	skills?: SkillDefinition[];
	/** Extra service entries */
	services?: ServiceEntry[];
	/** async response handler */
	onMessage?: MessageHandler;
	/** Panel welcome message */
	welcome?: string;
	/** Enable text-to-speech on replies */
	voice?: boolean;
}

export interface RegisterOptions {
	imageFile?: File;
	services?: ServiceEntry[];
	ipfsToken?: string;
	onStatus?: StatusCallback;
}

export interface ManifestsOptions {
	openapiUrl?: string;
	registrations?: RegistrationRecord[];
}

export interface ManifestsResult {
	agentRegistration: AgentRegistrationDocument;
	agentCard: AgentCardDocument;
	aiPlugin: AiPluginDocument;
}

export class AgentKit {
	constructor(options: AgentKitOptions);
	mount(container?: HTMLElement): this;
	open(): this;
	close(): this;
	addMessage(role: string, text: string): this;
	register(options?: RegisterOptions): Promise<RegistrationResult>;
	manifests(options?: ManifestsOptions): ManifestsResult;
	dispose(): void;
}

// ---------------------------------------------------------------------------
// Manifest document shapes
// ---------------------------------------------------------------------------

export interface AgentRegistrationDocument {
	type: string;
	name: string;
	description?: string;
	image?: string;
	active: boolean;
	services: ServiceEntry[];
	registrations: RegistrationRecord[];
	supportedTrust: string[];
}

export interface AgentCardDocument {
	name: string;
	description?: string;
	url: string;
	provider: { organization: string; url: string };
	version: string;
	capabilities: {
		streaming: boolean;
		pushNotifications: boolean;
		stateTransitionHistory: boolean;
	};
	authentication: { schemes: string[]; credentials: null };
	defaultInputModes: string[];
	defaultOutputModes: string[];
	skills: SkillDefinition[];
}

export interface AiPluginDocument {
	schema_version: 'v1';
	name_for_human: string;
	name_for_model: string;
	description_for_human: string;
	description_for_model: string;
	auth: { type: 'none' };
	api: { type: 'openapi'; url: string };
	logo_url: string;
	contact_email: string;
	legal_info_url: string;
}

// ---------------------------------------------------------------------------
// Manifest generators (low-level)
// ---------------------------------------------------------------------------

export function agentRegistration(opts: {
	name: string;
	description?: string;
	endpoint: string;
	image?: string;
	services?: ServiceEntry[];
	registrations?: RegistrationRecord[];
}): AgentRegistrationDocument;

export function agentCard(opts: {
	name: string;
	description?: string;
	url: string;
	version?: string;
	org?: string;
	skills?: SkillDefinition[];
}): AgentCardDocument;

export function aiPlugin(opts: {
	name: string;
	description?: string;
	openapiUrl: string;
	logoUrl?: string;
	contactEmail?: string;
	legalUrl?: string;
}): AiPluginDocument;

// ---------------------------------------------------------------------------
// ERC-8004 low-level
// ---------------------------------------------------------------------------

export interface ConnectWalletResult {
	provider: unknown;
	signer: unknown;
	address: string;
	chainId: number;
}

export function connectWallet(): Promise<ConnectWalletResult>;

export function pinToIPFS(blob: Blob | File, apiToken?: string): Promise<string>;

export function buildRegistrationJSON(opts: {
	name: string;
	description?: string;
	imageCID?: string | null;
	agentId: number;
	chainId: number;
	registryAddr: string;
	services?: ServiceEntry[];
}): AgentRegistrationDocument;

export function getIdentityRegistry(chainId: number, signer: unknown): unknown;

export function registerAgent(opts: {
	name: string;
	description?: string;
	endpoint: string;
	imageFile?: File;
	services?: ServiceEntry[];
	apiToken?: string;
	onStatus?: StatusCallback;
}): Promise<RegistrationResult>;

export const IDENTITY_REGISTRY_ABI: readonly string[];
export const REPUTATION_REGISTRY_ABI: readonly string[];
export const VALIDATION_REGISTRY_ABI: readonly string[];

export interface RegistryDeployment {
	identityRegistry: string;
	reputationRegistry?: string;
	validationRegistry?: string;
}

export const REGISTRY_DEPLOYMENTS: Record<number, RegistryDeployment>;

export function agentRegistryId(chainId: number, registryAddress: string): string;

export function getSigner(): unknown | null;

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface DelegationPublic {
	id: string;
	delegationHash: string;
	agentId: string;
	delegator: string;
	delegate: string;
	status: string;
	chainId: number;
	[key: string]: unknown;
}

export interface ScopePreset {
	token: string;
	maxAmount: string;
	period: string;
	targets: string[];
	expiryDays: number;
}

export interface PermissionsClientOptions {
	baseUrl?: string;
	bearer?: string;
}

export declare class PermissionError extends Error {
	code: string;
	name: 'PermissionError';
	constructor(code: string, message: string);
}

export declare class PermissionsClient {
	constructor(opts?: PermissionsClientOptions);
	listDelegations(params?: { agentId?: string; delegator?: string; status?: string }): Promise<DelegationPublic[]>;
	getMetadata(agentId: string): Promise<{ spec: string; delegations: DelegationPublic[] }>;
	grant(params: { agentId: string; chainId: number; preset: ScopePreset; delegate: string; signer: unknown }): Promise<{ id: string; delegationHash: string }>;
	redeem(params: { id: string; calls: Array<{ to: string; value?: string; data: string }> }): Promise<{ txHash: string }>;
	revoke(params: { id: string; delegationHash: string; signer: unknown }): Promise<{ status: 'revoked'; txHash: string }>;
	verify(hash: string, chainId: number): Promise<{ valid: boolean; reason?: string }>;
}

// ---------------------------------------------------------------------------
// Solana
// ---------------------------------------------------------------------------

export declare function detectSolanaProvider(preferred?: string | null): unknown | null;

export declare function signInWithSolana(opts?: {
	preferred?: string | null;
	nonceUrl?: string;
	verifyUrl?: string;
	chainId?: string;
}): Promise<{ user: object; wallet: object }>;

export declare function registerSolanaAgent(opts?: {
	name: string;
	description?: string;
	avatarId?: string;
	network?: 'mainnet' | 'devnet';
	preferred?: string | null;
	onStatus?: (msg: string) => void;
}): Promise<{ agent: object; sol_mint_address: string; tx_signature: string }>;

export declare function startSolanaCheckout(opts?: {
	plan: 'pro' | 'team' | 'enterprise';
	network?: 'mainnet' | 'devnet';
}): Promise<{ solana_pay_url: string; intent_id: string; amount_usdc: number; nonce: string }>;

export declare function confirmSolanaPayment(opts?: {
	intentId: string;
	txSignature: string;
	network?: 'mainnet' | 'devnet';
}): Promise<{ ok: boolean; plan: string; active_until: string }>;

// ---------------------------------------------------------------------------
// Solana attestations
// ---------------------------------------------------------------------------

export interface AttestationResult {
	signature: string;
	memo: object;
}

export declare function attestFeedback(opts?: {
	agentAsset: string;
	score: number;
	taskId?: string;
	uri?: string;
	network?: 'mainnet' | 'devnet';
	preferred?: string | null;
}): Promise<AttestationResult>;

export declare function attestValidation(opts?: {
	agentAsset: string;
	taskHash: string;
	passed: boolean;
	uri?: string;
	network?: 'mainnet' | 'devnet';
	preferred?: string | null;
}): Promise<AttestationResult>;

export declare function createTask(opts?: {
	agentAsset: string;
	taskId: string;
	scopeHash: string;
	uri?: string;
	network?: 'mainnet' | 'devnet';
	preferred?: string | null;
}): Promise<AttestationResult>;

export declare function acceptTask(opts?: {
	agentAsset: string;
	taskId: string;
	network?: 'mainnet' | 'devnet';
	preferred?: string | null;
}): Promise<AttestationResult>;

export declare function attestRevoke(opts?: {
	agentAsset: string;
	targetSignature: string;
	reason?: string;
	network?: 'mainnet' | 'devnet';
	preferred?: string | null;
}): Promise<AttestationResult>;

export declare function attestDispute(opts?: {
	agentAsset: string;
	targetSignature: string;
	reason?: string;
	uri?: string;
	network?: 'mainnet' | 'devnet';
	preferred?: string | null;
}): Promise<AttestationResult>;

export declare function listAttestations(opts?: {
	agentAsset: string;
	kind?: 'feedback' | 'validation' | 'all';
	limit?: number;
	network?: 'mainnet' | 'devnet';
}): Promise<Array<{ signature: string; slot: number; attester: string; memo: object }>>;

export declare function fetchAttestations(opts?: {
	agentAsset: string;
	kind?: string;
	network?: 'mainnet' | 'devnet';
	apiOrigin?: string;
}): Promise<unknown>;

export declare function fetchReputation(opts?: {
	agentAsset: string;
	network?: 'mainnet' | 'devnet';
	apiOrigin?: string;
}): Promise<unknown>;
