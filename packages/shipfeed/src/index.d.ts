// Type definitions for @three-ws/shipfeed.

export type Audience = 'holder' | 'developer' | 'internal';

export interface ParsedMessage {
	subject: string;
	type: string | null;
	scope: string | null;
	breaking: boolean;
	description: string;
	body: string;
	trailers: Record<string, string>;
	coAuthors: string[];
	issues: string[];
	merge: boolean;
	revert: boolean;
	revertedSubject: string | null;
	conventional: boolean;
}

export interface ParsedCommit extends ParsedMessage {
	sha: string;
	shortSha: string;
	url: string;
	author: { login: string | null; name: string };
	authoredAt: string;
	committedAt: string;
	parents: number;
	files: string[] | null;
}

export interface ClassifyOptions {
	productScopes?: string[];
	noiseScopes?: string[];
}

export interface Classification {
	audience: Audience;
	signal: number;
	noise: boolean;
	reasons: { rule: string; delta: number; note: string }[];
}

export interface ChangelogEntry {
	date: string;
	title: string;
	summary?: string;
	tags?: string[];
	link?: string | null;
}

export interface LinkOptions {
	windowDays?: number;
	leadDays?: number;
	threshold?: number;
	maxPerEntry?: number;
}

export interface LinkResult {
	byEntry: Map<string, { entry: ChangelogEntry; commits: ParsedCommit[] }>;
	byCommit: Map<string, { entryKey: string; score: number; reasons: string[] }>;
	orphans: ParsedCommit[];
}

export interface FeedCommit {
	sha: string;
	shortSha: string;
	url: string;
	date: string;
	author: string;
	type: string | null;
	scope: string | null;
	breaking: boolean;
	headline: string;
	summary: string;
	audience: Audience;
	signal: number;
	issues: string[];
	confidence?: number;
	why?: string[];
}

export interface FeedRelease {
	key: string;
	slug: string;
	date: string;
	title: string;
	summary: string;
	tags: string[];
	link: string | null;
	url: string | null;
	commits: FeedCommit[];
	stats: { commits: number; authors: number; range: string | null };
}

export interface FeedShip {
	id: string;
	start: string;
	end: string;
	title: string;
	summary: string;
	authors: string[];
	signal: number;
	commits: FeedCommit[];
}

export interface ShipFeed {
	version: number;
	generatedAt: string;
	repo: string;
	siteUrl: string | null;
	releases: FeedRelease[];
	ships: FeedShip[];
	stats: {
		commits: number;
		hidden: number;
		releases: number;
		linked: number;
		orphans: number;
		coverage: number;
		byType: Record<string, number>;
		byAudience: Record<Audience, number>;
		topAuthors: { name: string; count: number }[];
		velocity: { date: string; count: number }[];
	};
}

export declare const KNOWN_TYPES: Set<string>;
export declare const TYPE_LABELS: Record<string, string>;
export declare const AUDIENCE_RANK: Record<Audience, number>;
export declare const FEED_VERSION: number;
export declare const GIT_LOG_FORMAT: string;

export declare function parseCommitMessage(message: string): ParsedMessage;
export declare function parseCommit(input: unknown): ParsedCommit;
export declare function parseTrailers(body: string): {
	trailers: Record<string, string>;
	coAuthors: string[];
};
export declare function splitMessage(message: string): { subject: string; body: string };
export declare function headline(
	commit: ParsedCommit | ParsedMessage | string,
	options?: { separator?: string },
): string;
export declare function summaryLine(commit: ParsedCommit | ParsedMessage | string): string;

export declare function classify(commit: unknown, options?: ClassifyOptions): Classification;
export declare function filterByAudience<T>(
	commits: T[],
	minAudience?: Audience,
	options?: ClassifyOptions,
): T[];

export declare function linkCommits(
	entries: ChangelogEntry[],
	commits: unknown[],
	options?: LinkOptions,
): LinkResult;
export declare function tokenize(text: string): string[];
export declare function buildIdf(documents: string[][]): Map<string, number>;
export declare function entryKey(entry: ChangelogEntry): string;
export declare function entrySlug(entry: ChangelogEntry): string;

export declare function groupIntoShips(
	commits: unknown[],
	options?: { gapMinutes?: number; options?: ClassifyOptions },
): Omit<FeedShip, 'commits'> & { commits: ParsedCommit[] }[];

export declare function buildShipFeed(input: {
	commits: unknown[];
	entries?: ChangelogEntry[];
	repo?: string;
	siteUrl?: string;
	now?: number;
	minAudience?: Audience;
	link?: LinkOptions;
	classify?: ClassifyOptions;
	velocityDays?: number;
}): ShipFeed;

export declare function renderCommitTelegram(
	commit: FeedCommit,
	options?: { repo?: string; linkText?: string },
): string;
export declare function renderReleaseTelegram(
	release: FeedRelease,
	options?: { repo?: string; siteUrl?: string },
): string;
export declare function renderMarkdown(feed: ShipFeed, options?: { includeShips?: boolean }): string;
export declare function renderRss(
	feed: ShipFeed,
	options?: { title?: string; siteUrl?: string; description?: string },
): string;
export declare function renderTerminal(
	feed: ShipFeed,
	options?: { color?: boolean; maxCommits?: number },
): string;

export declare function fetchGitHubCommits(options: {
	repo: string;
	branch?: string;
	limit?: number;
	token?: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	userAgent?: string;
}): Promise<unknown[]>;
export declare function fetchChangelog(
	url: string,
	options?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<ChangelogEntry[]>;
export declare function commitsFromGitLog(text: string, options?: { repo?: string }): unknown[];
export declare function normalizeChangelog(input: unknown): ChangelogEntry[];

export declare function shipfeed(options: {
	repo: string;
	branch?: string;
	limit?: number;
	token?: string;
	changelogUrl?: string;
	changelog?: unknown;
	siteUrl?: string;
	minAudience?: Audience;
	productScopes?: string[];
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	now?: number;
}): Promise<ShipFeed>;
