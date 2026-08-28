/**
 * @three-ws/agent-vitals
 * Capability attestation for autonomous agents: not "is it up" but "can it act".
 */

/** Where a single precondition stands. */
export type VitalStatus =
	/** Probed and satisfied. */
	| 'up'
	/** Probed and definitively not satisfied. */
	| 'down'
	/** Not probed at all: a dependency was already not `up`. */
	| 'blocked'
	/** Probed but undecidable (threw, timed out, or returned no verdict). Never treated as `down`. */
	| 'unknown';

/** Whether the agent can perform a declared action. */
export type CapabilityStatus =
	/** Every precondition in the closure is `up`. */
	| 'ready'
	/** At least one precondition is `down`, or blocked by something that is `down`. */
	| 'unable'
	/** Nothing is definitively broken, but at least one precondition is unreadable. */
	| 'unknown';

/**
 * What a probe may return. A bare boolean is shorthand for `{ ok }`.
 * A missing or null `ok` means "could not decide", which becomes `unknown`.
 */
export type ProbeResult =
	| boolean
	| {
		ok?: boolean | null;
		/** One short clause explaining the reading, shown in reports and explanations. */
		detail?: string;
		/** Arbitrary payload passed through to a remedy function and kept on the report. */
		data?: unknown;
	};

export interface RemedyContext {
	detail: string | null;
	data: unknown;
}

export interface VitalSpec {
	/** Human sentence describing what being `up` means. */
	describe?: string;
	/** Ids of vitals that must be `up` before this one is worth probing. */
	needs?: string[];
	probe: () => ProbeResult | Promise<ProbeResult>;
	/** The fix. A function receives the probe's own detail and data so it can name real values. */
	remedy?: string | ((ctx: RemedyContext) => string);
	/** Per-probe deadline in ms. Overrides the chart default. */
	timeoutMs?: number;
}

export interface CapabilitySpec {
	describe?: string;
	/** Vitals that must all be `up`. Their transitive `needs` are included automatically. */
	needs: string[];
}

export interface VitalReport {
	id: string;
	status: VitalStatus;
	describe: string | null;
	detail: string | null;
	data: unknown;
	/** Populated only when the vital is not `up`. */
	remedy: string | null;
	needs: string[];
	/** Direct dependencies that were not `up`. Non-empty only when `status` is `blocked`. */
	blockedBy: string[];
	/**
	 * For a `blocked` vital: whether the block traces back to a definite failure
	 * (`down`) or merely to an unreadable one (`unknown`). Null when not blocked.
	 * A block behind an unreadable probe leaves a capability `unknown`, never `unable`.
	 */
	blockedSeverity: 'down' | 'unknown' | null;
	/** Probe duration in ms; null when the vital was never probed. */
	ms: number | null;
}

export interface CapabilityReport {
	id: string;
	describe: string | null;
	status: CapabilityStatus;
	needs: string[];
	/** Failing vitals with no failing dependency of their own: causes, not symptoms. */
	rootCauses: VitalReport[];
	remedies: string[];
	/** One sentence reading from the capability down to its root cause. */
	explain: string;
}

export interface VerdictJSON {
	agent: string | null;
	at: string;
	ms: number;
	healthy: boolean;
	can: Record<string, boolean | null>;
	capabilities: CapabilityReport[];
	vitals: VitalReport[];
	root_causes: string[];
	remedies: string[];
}

export declare class Verdict {
	readonly agent: string | null;
	readonly at: Date;
	/** Wall-clock duration of the whole attestation. */
	readonly ms: number;
	readonly vitals: VitalReport[];
	readonly capabilities: CapabilityReport[];
	/** Per capability: true = ready, false = unable, null = cannot say. */
	readonly can: Record<string, boolean | null>;
	/** Every capability is ready. */
	readonly healthy: boolean;
	/** Distinct root causes across all failing capabilities, most severe first. */
	readonly rootCauses: VitalReport[];
	/** Distinct remedies for those root causes, in the same order. */
	readonly remedies: string[];
	vital(id: string): VitalReport | null;
	/** The whole verdict as a human paragraph, written to be pasted into an incident channel. */
	explain(): string;
	toJSON(): VerdictJSON;
}

export declare class VitalsChart {
	constructor(opts?: { agent?: string; timeoutMs?: number });
	readonly agent: string | null;
	readonly timeoutMs: number;
	vital(id: string, spec: VitalSpec): this;
	capability(id: string, spec: CapabilitySpec): this;
	/** Probe the graph layer by layer and return the verdict. */
	attest(opts?: { signal?: AbortSignal }): Promise<Verdict>;
}

export declare function vitals(opts?: { agent?: string; timeoutMs?: number }): VitalsChart;

export declare const DEFAULT_TIMEOUT_MS: number;
