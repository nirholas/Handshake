// Type definitions for @three-ws/pose

export declare class ThreeWsError extends Error {
	name: string;
	code: string;
	status: number | null;
	detail?: unknown;
	retryAfter?: number;
	body: unknown;
}

export declare class PaymentRequiredError extends ThreeWsError {
	accepts: unknown | null;
}

/** Typed error for every @three-ws/pose failure. */
export declare class PoseError extends ThreeWsError {}

export declare const DEFAULT_BASE_URL: string;

/** A single Euler rotation (radians) or, for `rootPosition`, a translation. */
export interface JointVector {
	x: number;
	y: number;
	z: number;
}

/** Joint name → rotation (radians). May include `rootPosition` (a translation). */
export type PoseParameters = Record<string, JointVector>;

export interface PoseMatch {
	/** Token-overlap score; 0 on the deterministic fallback. */
	score: number;
	/** `'token-match'` or `'no-match-deterministic-pick'`. */
	reason: 'token-match' | 'no-match-deterministic-pick' | string;
}

export interface PoseResult {
	/** 16-hex stable id, `sha256(prompt|presetId).slice(0,16)`. */
	seed: string | null;
	/** The picked preset's id, e.g. `'wave'`, `'warrior2'`, `'crouch'`. */
	presetId: string | null;
	/** Human label, e.g. `'Wave hello'`, `'Warrior II (yoga)'`. */
	presetLabel: string | null;
	/** One of `'Standing'`, `'Action'`, `'Sitting & Floor'`, `'Expressive'`. */
	group: string | null;
	/** Joint → Euler rotation (radians). May include `rootPosition`. */
	parameters: PoseParameters;
	/** Open the result on three.ws/pose with `seed` + `preset` params. */
	previewUrl: string | null;
	/** Why this preset was chosen (token match vs deterministic fallback). */
	match: PoseMatch | null;
	/** All four preset groups, for building a picker. */
	groups: string[];
	/** The raw structuredContent from the tool (escape hatch). */
	raw: unknown;
}

export interface PoseRequestOptions {
	/** Override the returned previewUrl base (per-call clients use this). */
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

/**
 * With no transport option (`baseUrl`, `apiKey`, `fetch`) the client resolves
 * poses locally: no network, no key, no payment. Passing any of the three
 * switches it to the hosted pose_model tool on /api/mcp-3d.
 */
export interface PoseClientOptions {
	/** API origin (default https://three.ws). Selects the hosted lane. */
	baseUrl?: string;
	/** fetch implementation (e.g. a payment-aware x402 fetch). Selects the hosted lane. */
	fetch?: typeof fetch;
	/** OAuth bearer, runs hosted calls operator-funded. Selects the hosted lane. */
	apiKey?: string;
	/** Base URL for the returned previewUrl (default https://three.ws/pose). */
	previewBase?: string;
	/** Extra headers on every hosted-lane request. */
	headers?: Record<string, string>;
}

/** A preset entry from the in-repo pose-studio library. */
export interface PosePreset {
	id: string;
	label: string;
	group: string;
	pose: PoseParameters;
}

export interface PoseClient {
	poseSeed(prompt: string, opts?: PoseRequestOptions): Promise<PoseResult>;
	presetPose(presetId: string, opts?: PoseRequestOptions): Promise<PoseResult>;
	listPresetGroups(): string[];
}

export declare const PRESETS: PosePreset[];
export declare const PRESET_GROUPS: string[];

export declare function createPose(options?: PoseClientOptions): PoseClient;
export declare function poseSeed(prompt: string, opts?: PoseRequestOptions): Promise<PoseResult>;
export declare function presetPose(presetId: string, opts?: PoseRequestOptions): Promise<PoseResult>;
export declare function listPresetGroups(): string[];
