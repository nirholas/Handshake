/**
 * @three-ws/oracle-model
 *
 * The three.ws Oracle conviction model, scoring locally from published weights.
 */

/** A tier rung on the 0-100 score line. */
export interface Tier {
	min: number;
	tier: 'prime' | 'strong' | 'lean' | 'watch' | 'avoid';
	label: 'Prime' | 'Strong' | 'Lean' | 'Watch' | 'Avoid';
}

export declare const TIERS: readonly Tier[];

/**
 * Launch-time signals. Every field is optional: a missing one lands in the
 * model's fitted `null` bucket, which carries real information rather than
 * being treated as zero.
 */
export interface LaunchSignals {
	organic_score?: number | null;
	bundle_score?: number | null;
	snipe_ratio?: number | null;
	coordination_score?: number | null;
	timing_entropy?: number | null;
	concentration_top1?: number | null;
	concentration_top5?: number | null;
	concentration_top10?: number | null;
	fresh_wallet_ratio?: number | null;
	bubblemap_connectivity?: number | null;
	unique_buyers?: number | null;
	unique_sellers?: number | null;
	buy_sell_ratio?: number | null;
	buy_volume_sol?: number | null;
	sell_volume_sol?: number | null;
	net_volume_sol?: number | null;
	trade_count?: number | null;
	largest_buy_sol?: number | null;
	avg_buy_sol?: number | null;
	median_buy_sol?: number | null;
	dev_buy_sol?: number | null;
	dev_sell_sol?: number | null;
	dev_sold?: boolean | number | null;
	mc_sol_first_seen?: number | null;
	smart_money_count?: number | null;
	/** Creator history, either pre-bucketed or as raw counts. */
	creator_record?: 'has_wins' | 'serial_no_wins' | 'repeat_no_wins' | 'first_launch' | 'unknown';
	creator_launches?: number | null;
	creator_wins?: number | null;
	category?: string | null;
	[key: string]: unknown;
}

/** Observed outcome rates for one bucket, per head. */
export interface BucketRates {
	win?: number;
	rug?: number;
	moon?: number;
}

/** One term in the log-odds sum, with the evidence behind it. */
export interface Why {
	feature: string;
	label: string;
	pillar: 'pedigree' | 'structure' | 'narrative' | 'momentum';
	bucket: string;
	value: number | string | null;
	/** Log-odds contribution on the scoring head. */
	weight: number;
	/** How many labeled launches sat in this bucket. */
	samples: number;
	observed: BucketRates | null;
}

export interface Verdict {
	/** 0-100, anchored on P(runs and holds). Not a percentage. */
	score: number;
	tier: Tier['tier'];
	tierLabel: Tier['label'];
	/** Raw probability per head: win, rug, moon. */
	probabilities: Record<string, number>;
	/** P(a first-sight holder ends down more than half), 0-100. */
	rugRisk: number | null;
	/** P(graduates or peaks at 3x or more), 0-100. */
	upside: number | null;
	/** P(hands the run straight back, given it runs), 0-100. */
	giveBackRisk: number | null;
	/** Share of the model's signals that were actually supplied, 0-100. */
	confidence: number;
	/** Every bucket that moved the score, biggest mover first. */
	why: Why[];
	model: { version: number; fitted_at: string | null; training_rows: number; score_head: string };
}

export interface Explained extends Verdict {
	math: {
		head: string;
		intercept: number;
		terms: Array<{ term: string; log_odds: number; samples: number; observed_rate: number | null }>;
		total_log_odds: number;
		probability: number;
		formula: string;
	};
}

export interface ReliabilityBand {
	lo: number;
	hi: number;
	n: number;
	observed: number | null;
	predicted: number | null;
}

export interface Performance {
	head: string;
	holdout_n: number;
	auc: number;
	brier: number;
	base_rate: number;
	precision: Record<string, { n: number; rate: number; lift: number }>;
	reliability: ReliabilityBand[];
}

export interface VerifyResult {
	head: string;
	n: number;
	base_rate: number;
	auc: number;
	brier: number;
	reliability: ReliabilityBand[];
}

export interface DiffMove {
	key: string;
	kind: 'new' | 'moved' | 'gone';
	from: number | null;
	to: number | null;
	delta: number;
	samples: number;
}

export interface DiffResult {
	head: string;
	from: { fitted_at: string | null; training_rows: number };
	to: { fitted_at: string | null; training_rows: number };
	auc: { from: number | null; to: number | null };
	moves: DiffMove[];
}

export interface FetchOptions {
	endpoint?: string;
	network?: 'mainnet' | 'devnet';
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}

export declare function bucketLabel(feature: { categorical?: boolean; edges?: number[] | null }, value: number | string | null): string;

export declare class OracleModel {
	constructor(doc: object);

	readonly document: Record<string, unknown>;
	readonly version: number;
	readonly fittedAt: string | null;
	readonly trainingRows: number;
	readonly scoreHead: string;
	readonly anchors: Record<string, number>;
	readonly holdout: Record<string, unknown> | null;
	readonly droppedFeatures: Array<{ key: string; bucket: string; share: number }>;

	/** Download the live model. One request, then everything is local. */
	static fetch(opts?: FetchOptions): Promise<OracleModel>;

	score(signals?: LaunchSignals): Verdict;
	/** The same score with the arithmetic shown, term by term. */
	explain(signals?: LaunchSignals): Explained;
	/** What this model earned on launches it had never seen. */
	performance(head?: string): Performance | null;
	/** Re-measure the model against outcomes you collected yourself. */
	verify(samples: Array<{ signals: LaunchSignals; outcome: boolean | number }>, head?: string): VerifyResult;
	/** Every bucket weight that moved between two model versions. */
	diff(other: OracleModel | object, threshold?: number): DiffResult;
	rank<T>(launches: T[], opts?: { key?: string; limit?: number }): Array<T & { verdict: Verdict }>;

	scoreFromProbability(p: number): number;
	probabilityFromScore(score: number): number;
	tierFor(score: number): Tier;
}

/** Score one launch against the live model, fetching it on first use. */
export declare function score(signals: LaunchSignals, opts?: FetchOptions): Promise<Verdict>;

export default OracleModel;
