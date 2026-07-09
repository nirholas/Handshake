// Type definitions for @three-ws/irl

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

export type InteractionType = 'view' | 'tap' | 'message' | 'pay';
export type PlacementKind = 'precise' | 'approximate';
export type AnchorSource = 'webxr' | 'gyro-gps' | 'gyro-gps:rel' | 'map' | 'marker';

/** An explicit GPS fix passed to `checkIn()` in non-browser environments. */
export interface FixInput {
	lat: number;
	lng: number;
	/** Reported accuracy in metres, if known. */
	accuracy?: number;
}

/** The proof-of-presence returned by `checkIn()`. */
export interface Presence {
	/** The fix used to mint the token. */
	lat: number;
	lng: number;
	/** Reported GPS accuracy in metres, or null. */
	accuracy: number | null;
	/** HMAC-signed presence token — sent as the `x-irl-fix` header on reads. */
	token: string;
	/** Token lifetime in seconds (180). Re-`checkIn()` when it lapses. */
	expiresIn: number;
	/** The precision-7 geohash (~153 m) the fix fell in — the re-mint trigger. */
	cell: string;
	/** Raw `POST /api/irl/fix-token` response. */
	raw: unknown;
}

export interface NearbyOptions {
	/** Metres. Clamped server-side to 10–60 m. Default 40. */
	radius?: number;
	/** Anonymous device token (header-only) to flag `isMine` on the caller's pins. */
	deviceToken?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

/** A pin from the public nearby feed (allow-list projection — never owner ids). */
export interface Pin {
	id: string;
	agentId: string | null;
	/** Coarsened to ~1.1 m (5 dp). */
	lat: number;
	lng: number;
	/** Facing, 0–359°. */
	heading: number;
	/** Great-circle metres from your fix. */
	distanceM: number | null;
	avatarUrl: string | null;
	avatarName: string | null;
	caption: string | null;
	/** First-party pay target for the agent, if any. */
	x402Endpoint: string | null;
	viewCount: number;
	/** Bumps on a remote outfit re-skin — diff to swap the GLB. */
	avatarVersion: number;
	placedAt: string | null;
	anchorHeightM: number | null;
	anchorYawDeg: number | null;
	anchorQuat: number[] | string | null;
	anchorSource: AnchorSource | null;
	gpsAccuracyM: number | null;
	altitudeM: number | null;
	/** Room frame for shared-anchor clusters (null on standalone pins). */
	roomId: string | null;
	relEastM: number | null;
	relNorthM: number | null;
	originLat: number | null;
	originLng: number | null;
	originYawDeg: number | null;
	/** True for the caller's own pins. */
	isMine: boolean;
	raw: unknown;
}

/** Optional reproducible pose for AR replay. */
export interface AnchorPose {
	heightM?: number;
	yawDeg?: number;
	quat?: number[];
	gpsAccuracyM?: number;
	altitudeM?: number;
	source?: AnchorSource;
}

/** Optional shared-room frame to place into a colocalized cluster. */
export interface RoomFrame {
	id: string;
	originLat: number;
	originLng: number;
	relEast: number;
	relNorth: number;
	originYawDeg?: number;
}

export interface PlacePinInput {
	/** Required. Range-checked. */
	lat: number;
	lng: number;
	/** Initial facing in degrees (default 0). */
	heading?: number;
	/** GLB URL — relative same-origin or https (no private hosts). */
	avatarUrl?: string;
	/** ≤ 40 chars. */
	avatarName?: string;
	/** ≤ 140 chars. Content-gated; may reference only $THREE. */
	caption?: string;
	/** Link the pin to a registered agent. */
	agentId?: string;
	/** Pay target — must be a first-party three.ws host. */
	x402Endpoint?: string;
	anchor?: AnchorPose;
	room?: RoomFrame;
	vps?: { provider?: string; id?: string };
	/** `approximate` blurs the spot by `fuzzRadiusM` (10–500 m). */
	placementKind?: PlacementKind;
	fuzzRadiusM?: number;
}

/** A pin the caller owns (from `placePin` / `myPins`). */
export interface OwnPin {
	id: string;
	agentId: string | null;
	lat: number;
	lng: number;
	heading: number;
	avatarUrl: string | null;
	avatarName: string | null;
	caption: string | null;
	x402Endpoint: string | null;
	viewCount: number;
	avatarVersion: number;
	placedAt: string | null;
	expiresAt: string | null;
	/** True for signed-in owners; false (7-day expiry) for anonymous device pins. */
	permanent: boolean;
	raw: unknown;
}

export interface InteractInput {
	/** Required. The agent you met. */
	pinId: string;
	/** `view` repeats from one device collapse within 5 min. Default `view`. */
	type?: InteractionType;
	/** ≤ 280 chars (for `message`). */
	message?: string;
	/** Interaction id this message replies to. */
	replyTo?: string;
	payload?: Record<string, unknown>;
	/** `pay` — on-chain settlement signature (required for `pay`). */
	signature?: string;
	/** `pay` — $THREE or USDC mint. */
	currencyMint?: string;
	/** `pay` — settled amount. */
	amount?: number;
	/** `pay` — settlement network, e.g. `solana`. */
	network?: string;
	deviceType?: string;
	/** Anonymous viewer attribution (header-only). */
	deviceToken?: string;
}

export interface Interaction {
	ok: boolean;
	id: string | null;
	type: InteractionType | null;
	createdAt: string | null;
	/** True when a repeat view/pay was collapsed onto an existing record. */
	deduped: boolean;
	/** True when the caller is the pin owner (a self-view is not counted). */
	self: boolean;
	/** True when the owner was notified (a `pay` / visitor `message`). */
	notified: boolean;
	raw: unknown;
}

export interface CheckInOptions {
	signal?: AbortSignal;
}

export interface WriteOptions {
	/** Anonymous device token (header-only) for ownership/attribution. */
	deviceToken?: string;
	signal?: AbortSignal;
}

export interface IrlClientOptions {
	baseUrl?: string;
	fetch?: typeof fetch;
	/** Bearer session token for signed-in ownership. */
	apiKey?: string;
	/** Default anonymous device token, sent header-only on every write. */
	deviceToken?: string;
	headers?: Record<string, string>;
}

// ── Money Drops (real value escrowed at real-world spots) ────────────────────

export type DropKind = 'drop' | 'bounty';
export type DropAsset = 'SOL' | 'USDC' | 'THREE';
export type ClaimRule = 'first' | 'each-once' | 'quiz';
export type BountyCondition = 'presence' | 'quiz' | 'chat';
export type DropStatus = 'pending_funding' | 'active' | 'exhausted' | 'expired' | 'refunding' | 'refunded' | 'cancelled';

/** A drop from the public projection. */
export interface Drop {
	id: string;
	kind: DropKind;
	asset: DropAsset;
	/** Human-readable per-claim amount (e.g. "5" USDC). */
	amount: string | number;
	amountAtomics: string | null;
	maxClaims: number;
	claimsCount: number;
	claimsLeft: number;
	claimRule: ClaimRule | null;
	bountyCondition: BountyCondition | null;
	quizQuestion: string | null;
	title: string | null;
	note: string | null;
	lat: number;
	lng: number;
	radiusM: number | null;
	/** Metres from your fix (nearby read only). */
	distanceM: number | null;
	/** True when the location was coarsened to ~110 m for a non-owner id read. */
	coarse: boolean;
	network: string | null;
	status: DropStatus | null;
	escrowAddress: string | null;
	fundingTx: string | null;
	refundTx: string | null;
	expiresAt: string | null;
	createdAt: string | null;
	isMine: boolean;
	raw: unknown;
}

/** A claim receipt from `myDrops().claims`. */
export interface DropClaim {
	id: string;
	dropId: string;
	title: string | null;
	kind: DropKind | null;
	asset: DropAsset | null;
	amount: string | number | null;
	/** The on-chain release transaction signature. */
	signature: string | null;
	status: string | null;
	network: string | null;
	createdAt: string | null;
	confirmedAt: string | null;
	raw: unknown;
}

export interface CreateDropInput {
	/** Required. Where the value is placed. */
	lat: number;
	lng: number;
	/** Required. Per-claim amount in the asset's human units. */
	amount: number;
	/** Default `USDC`. Case-insensitive. */
	asset?: DropAsset | Lowercase<DropAsset>;
	/** Default `drop`. A `bounty` adds a completion condition. */
	kind?: DropKind;
	/** How many claims the pot covers (1–1000, default 1). */
	maxClaims?: number;
	claimRule?: ClaimRule;
	/** Bounty completion condition (default `presence`). */
	bountyCondition?: BountyCondition;
	quizQuestion?: string;
	quizAnswer?: string;
	title?: string;
	note?: string;
	/** Claim radius in metres (5–250, default 30). */
	radiusM?: number;
	expiresInMs?: number;
	/** Where a cancel/expiry refund sweeps back to. */
	refundAddress?: string;
	/** Fund server-side from this agent's custodial wallet (signed-in owner only). */
	agentId?: string;
}

export interface CreateDropResult {
	drop: Drop;
	/** Send the funds here, then call `fundDrop()` — unless `funded` is true. */
	escrowAddress: string | null;
	fundAtomics: string | null;
	fundAmount: string | number | null;
	/** True when an agent bounty was funded server-side (already active). */
	funded: boolean;
	fundingTx: string | null;
	agent: { id: string; name: string | null } | null;
	raw: unknown;
}

export interface FundDropInput {
	dropId: string;
	/** The creator-signed funding transfer signature. */
	signature: string;
	refundAddress?: string;
}

export interface ClaimDropInput {
	dropId: string;
	/** Presence from `checkIn()` at the drop's spot — always verified. */
	presence: Presence | (FixInput & { token?: string });
	/** The Solana wallet that receives the on-chain release. */
	wallet: string;
	/** Quiz bounty answer. */
	answer?: string;
}

export interface ClaimDropResult {
	ok: boolean;
	asset: DropAsset | null;
	amount: string | number | null;
	/** The on-chain release transaction signature. */
	signature: string | null;
	explorerUrl: string | null;
	wallet: string;
	raw: unknown;
}

// ── World Lines (agent-signed proof-of-presence AR quests) ───────────────────

export type ChallengeKind = 'tap' | 'quiz' | 'phrase';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type RewardKind = 'collectible' | 'three_pool';

export interface ChallengeSpec {
	kind: ChallengeKind;
	prompt?: string | null;
	/** Quiz only. */
	question?: string;
	choices?: string[];
	/** Quiz only — index of the correct choice. Redacted unless co-located/owner. */
	answer?: number;
	/** Phrase only — never echoed to remote callers. */
	phrase?: string;
}

export interface WorldLine {
	id: string;
	agentId: string | null;
	/** The agent wallet that signs every proof this quest mints. */
	signerPubkey: string | null;
	pinId: string | null;
	/** ~1.1 km precision-6 cell — the only location a quest ever carries. */
	coarseCell: string | null;
	regionCell: string | null;
	title: string;
	prompt: string | null;
	/** Redacted unless you are the owner or proven co-located. */
	challenge: ChallengeSpec | null;
	rewardKind: RewardKind | null;
	rewardRef: string | null;
	difficulty: Difficulty | null;
	maxCompletions: number | null;
	completionCount: number;
	createdAt: string | null;
	expiresAt: string | null;
	/** Nearby-read extras (coarsened to 10 m). */
	distanceM: number | null;
	completedByMe: boolean;
	capacityReached: boolean;
	/** Creator-dashboard extras. */
	expired: boolean;
	hidden: boolean;
	raw: unknown;
}

export interface CreateWorldLineInput {
	/** Required. The anchor pin you own (it carries the precise spot). */
	pinId: string;
	/** Required. Content-gated; may reference only $THREE. */
	title: string;
	prompt?: string;
	/** The signing agent — defaults to the pin's agent. Must be yours. */
	agentId?: string;
	challenge?: ChallengeSpec;
	rewardKind?: RewardKind;
	/** Collectible display name (≤ 80 chars). */
	rewardRef?: string;
	difficulty?: Difficulty;
	maxCompletions?: number;
	/** 1–90 (default 30). */
	lifetimeDays?: number;
}

/** An agent-signed proof of presence. */
export interface PresenceProof {
	id: string;
	worldLineId: string | null;
	worldLineTitle: string | null;
	agentId: string | null;
	signerPubkey: string | null;
	/** ~1.1 km — the only location the proof carries. */
	coarseCell: string | null;
	signature: string | null;
	signedMessage: string | null;
	signatureScheme: string;
	collectibleMint: string | null;
	collectibleName: string | null;
	completedAt: string | null;
	verifyUrl: string | null;
	raw: unknown;
}

/** An earned proof as an ownable collectible. */
export interface Collectible {
	mint: string | null;
	name: string | null;
	kind: string;
	rewardKind: RewardKind | null;
	signerPubkey: string | null;
	signature: string | null;
	proofId: string | null;
	worldLineId: string | null;
	worldLineTitle: string | null;
	difficulty: Difficulty | null;
	coarseCell: string | null;
	earnedAt: string | null;
	verifyUrl: string | null;
	raw: unknown;
}

export interface ChallengeWorldLineInput {
	worldLineId: string;
	/** Presence from `checkIn()` at the quest — co-location is server-derived. */
	presence: Presence | (FixInput & { token?: string });
}

export interface ChallengeWorldLineResult {
	alreadyCompleted: boolean;
	/** Single-use completion nonce (absent when already completed). */
	nonce: string | null;
	expiresIn: number | null;
	/** Full challenge spec — you are proven co-located. */
	challenge: ChallengeSpec | null;
	agentId: string | null;
	worldLine: unknown | null;
	proofId?: string | null;
	collectibleMint?: string | null;
	raw: unknown;
}

export interface CompleteWorldLineInput {
	worldLineId: string;
	/** The nonce from `challengeWorldLine()`. */
	nonce: string;
	presence: Presence | (FixInput & { token?: string });
	/** Quiz — index of the chosen answer. */
	answer?: number;
	/** Phrase — the passphrase the agent asked for. */
	phrase?: string;
}

export interface CompleteWorldLineResult {
	ok: boolean;
	alreadyCompleted: boolean;
	proof: PresenceProof | null;
	collectible: Collectible | null;
	raw: unknown;
}

export interface BrowseWorldLinesOptions {
	/** A precision-5 geohash cell (from the region roll-up). */
	region?: string;
	difficulty?: Difficulty;
	signal?: AbortSignal;
}

export interface RegionRollup {
	regionCell: string;
	quests: number;
	hard: number;
	completions: number;
	raw: unknown;
}

export interface RegionQuest {
	id: string;
	title: string;
	rewardKind: RewardKind | null;
	difficulty: Difficulty | null;
	completionCount: number;
	capacityReached: boolean;
	raw: unknown;
}

export type BrowseWorldLinesResult =
	| { regions: RegionRollup[]; raw: unknown }
	| { region: string; quests: RegionQuest[]; raw: unknown };

export interface WorldLinesHeatCell {
	worldLineId: string;
	coarseCell: string;
	completions: number;
}

export interface GetWorldLineOptions extends WriteOptions {
	/** Pass your presence to prove co-location and receive the full challenge. */
	presence?: Presence | (FixInput & { token?: string });
}

export interface IrlClient {
	checkIn(input?: FixInput, opts?: CheckInOptions): Promise<Presence>;
	nearby(presence: Presence | FixInput, opts?: NearbyOptions): Promise<Pin[]>;
	placePin(input: PlacePinInput, opts?: WriteOptions): Promise<{ pin: OwnPin; raw: unknown }>;
	myPins(opts?: WriteOptions): Promise<OwnPin[]>;
	interact(input: InteractInput, opts?: WriteOptions): Promise<Interaction>;
	removePin(id: string, opts?: WriteOptions): Promise<{ ok: boolean; raw: unknown }>;
	purgePins(opts?: WriteOptions): Promise<{ ok: boolean; deleted: number; raw: unknown }>;
	// Money Drops
	nearbyDrops(presence: Presence | FixInput, opts?: NearbyOptions): Promise<Drop[]>;
	getDrop(id: string, opts?: WriteOptions): Promise<Drop>;
	myDrops(opts?: WriteOptions): Promise<{ drops: Drop[]; claims: DropClaim[]; raw: unknown }>;
	createDrop(input: CreateDropInput, opts?: WriteOptions): Promise<CreateDropResult>;
	fundDrop(input: FundDropInput, opts?: WriteOptions): Promise<{ pending: boolean; status: string | null; drop: Drop | null; fundingTx: string | null; raw: unknown }>;
	claimDrop(input: ClaimDropInput, opts?: WriteOptions): Promise<ClaimDropResult>;
	cancelDrop(id: string, opts?: WriteOptions): Promise<{ ok: boolean; cancelled: boolean; refunded: boolean; refundTx: string | null; explorerUrl: string | null; raw: unknown }>;
	// World Lines
	nearbyWorldLines(presence: Presence | FixInput, opts?: NearbyOptions): Promise<WorldLine[]>;
	browseWorldLines(opts?: BrowseWorldLinesOptions): Promise<BrowseWorldLinesResult>;
	getWorldLine(id: string, opts?: GetWorldLineOptions): Promise<{ worldLine: WorldLine; colocated: boolean; raw: unknown }>;
	createWorldLine(input: CreateWorldLineInput, opts?: { signal?: AbortSignal }): Promise<{ worldLine: WorldLine; raw: unknown }>;
	myWorldLines(opts?: { signal?: AbortSignal }): Promise<{ worldLines: WorldLine[]; heatmap: WorldLinesHeatCell[]; raw: unknown }>;
	myCollectibles(opts?: WriteOptions): Promise<Collectible[]>;
	challengeWorldLine(input: ChallengeWorldLineInput, opts?: WriteOptions): Promise<ChallengeWorldLineResult>;
	completeWorldLine(input: CompleteWorldLineInput, opts?: WriteOptions): Promise<CompleteWorldLineResult>;
	verifyProof(proofId: string, opts?: { signal?: AbortSignal }): Promise<{ verified: boolean; proof: PresenceProof | null; raw: unknown }>;
}

export declare function createIrl(options?: IrlClientOptions): IrlClient;
export declare function configure(opts?: IrlClientOptions): IrlClientOptions;

export declare function checkIn(input?: FixInput, opts?: CheckInOptions): Promise<Presence>;
export declare function nearby(presence: Presence | FixInput, opts?: NearbyOptions): Promise<Pin[]>;
export declare function placePin(input: PlacePinInput, opts?: WriteOptions): Promise<{ pin: OwnPin; raw: unknown }>;
export declare function myPins(opts?: WriteOptions): Promise<OwnPin[]>;
export declare function interact(input: InteractInput, opts?: WriteOptions): Promise<Interaction>;
export declare function removePin(id: string, opts?: WriteOptions): Promise<{ ok: boolean; raw: unknown }>;
export declare function purgePins(opts?: WriteOptions): Promise<{ ok: boolean; deleted: number; raw: unknown }>;

export declare function nearbyDrops(presence: Presence | FixInput, opts?: NearbyOptions): Promise<Drop[]>;
export declare function getDrop(id: string, opts?: WriteOptions): Promise<Drop>;
export declare function myDrops(opts?: WriteOptions): Promise<{ drops: Drop[]; claims: DropClaim[]; raw: unknown }>;
export declare function createDrop(input: CreateDropInput, opts?: WriteOptions): Promise<CreateDropResult>;
export declare function fundDrop(input: FundDropInput, opts?: WriteOptions): Promise<{ pending: boolean; status: string | null; drop: Drop | null; fundingTx: string | null; raw: unknown }>;
export declare function claimDrop(input: ClaimDropInput, opts?: WriteOptions): Promise<ClaimDropResult>;
export declare function cancelDrop(id: string, opts?: WriteOptions): Promise<{ ok: boolean; cancelled: boolean; refunded: boolean; refundTx: string | null; explorerUrl: string | null; raw: unknown }>;

export declare function nearbyWorldLines(presence: Presence | FixInput, opts?: NearbyOptions): Promise<WorldLine[]>;
export declare function browseWorldLines(opts?: BrowseWorldLinesOptions): Promise<BrowseWorldLinesResult>;
export declare function getWorldLine(id: string, opts?: GetWorldLineOptions): Promise<{ worldLine: WorldLine; colocated: boolean; raw: unknown }>;
export declare function createWorldLine(input: CreateWorldLineInput, opts?: { signal?: AbortSignal }): Promise<{ worldLine: WorldLine; raw: unknown }>;
export declare function myWorldLines(opts?: { signal?: AbortSignal }): Promise<{ worldLines: WorldLine[]; heatmap: WorldLinesHeatCell[]; raw: unknown }>;
export declare function myCollectibles(opts?: WriteOptions): Promise<Collectible[]>;
export declare function challengeWorldLine(input: ChallengeWorldLineInput, opts?: WriteOptions): Promise<ChallengeWorldLineResult>;
export declare function completeWorldLine(input: CompleteWorldLineInput, opts?: WriteOptions): Promise<CompleteWorldLineResult>;
export declare function verifyProof(proofId: string, opts?: { signal?: AbortSignal }): Promise<{ verified: boolean; proof: PresenceProof | null; raw: unknown }>;

/** Encode a lat/lng to a geohash (default precision 7, the IRL cell key). */
export declare function encodeGeohash(lat: number, lng: number, precision?: number): string;
