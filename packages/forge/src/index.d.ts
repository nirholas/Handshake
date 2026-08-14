// Type definitions for @three-ws/forge

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

export type ForgePath = 'image' | 'geometry' | 'sketch';
export type ForgeTier = 'draft' | 'standard' | 'high';
export type ForgeStatus = 'queued' | 'running' | 'done' | 'failed';

export interface ForgeInput {
	/** Text description. Required for the text and sketch paths. */
	prompt?: string;
	/** One or more image URLs / data URIs. Switches to image→3D. */
	images?: string[];
	/** Reference-image aspect for the `image` path, e.g. "1:1". */
	aspectRatio?: string;
}

export interface ForgeOptions {
	path?: ForgePath;
	tier?: ForgeTier;
	/** Force a generation backend. See the live `catalog()` for the current ids. */
	backend?: string;
	/**
	 * Billing lane. Default: the account/credits lane on `/api/forge`.
	 * `'x402'` routes to the pay-per-call twin `/api/x402/forge`, which rejects
	 * `path`, `backend`, and `providerKey` because it picks its own lane.
	 */
	payWith?: 'credits' | 'x402';
	/** BYOK provider key for this call. Overrides the client-level key. */
	providerKey?: string;
	/** Called on each poll tick with the latest job state. */
	onProgress?: (job: ForgeResult) => void;
	pollIntervalMs?: number;
	timeoutMs?: number;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface JobOptions {
	/** BYOK provider key. Required to poll a job that was submitted with one. */
	providerKey?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface ForgeResult {
	jobId: string | null;
	creationId: string | null;
	status: ForgeStatus;
	glbUrl: string | null;
	viewerUrl: string | null;
	path: string | null;
	tier: string | null;
	backend: string | null;
	etaSeconds: number | null;
	estimatedCredits: number | null;
	durable: boolean;
	raw: unknown;
}

export interface Catalog {
	tiers: unknown[];
	backends: unknown[];
	paths: unknown[];
	[key: string]: unknown;
}

export interface ForgeClientOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	apiKey?: string;
	/** BYOK Meshy/Tripo key for the geometry path. */
	providerKey?: string;
	headers?: Record<string, string>;
}

export interface ForgeClient {
	forge(promptOrInput: string | ForgeInput, opts?: ForgeOptions): Promise<ForgeResult>;
	rig(glbUrl: string, opts?: ForgeOptions): Promise<ForgeResult>;
	catalog(opts?: { signal?: AbortSignal }): Promise<Catalog>;
	getJob(jobId: string, opts?: JobOptions): Promise<ForgeResult>;
}

export declare function createForge(options?: ForgeClientOptions): ForgeClient;
export declare function forge(promptOrInput: string | ForgeInput, opts?: ForgeOptions): Promise<ForgeResult>;
export declare function rig(glbUrl: string, opts?: ForgeOptions): Promise<ForgeResult>;
export declare function catalog(opts?: { signal?: AbortSignal }): Promise<Catalog>;
export declare function getJob(jobId: string, opts?: JobOptions): Promise<ForgeResult>;
