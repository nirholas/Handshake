/** Public types for @three-ws/motion. */

export type Side = 'Left' | 'Right';
export type SideKey = 'left' | 'right';
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

export type EaseName = 'linear' | 'smooth' | 'in' | 'out' | 'snap' | 'overshoot' | 'settle';
export type PlantName = 'flat' | 'toe' | 'heel' | 'lift';
export type DirectionName = 'forward' | 'back' | 'up' | 'down' | 'in' | 'out' | 'left' | 'right';

export interface Effort {
	/** 0 light and floating, 1 heavy and committed. */
	weight: number;
	/** 0 sustained and unhurried, 1 sudden and urgent. */
	time: number;
	/** 0 bound and controlled, 1 free and released. */
	flow: number;
}

export interface ArmSpec {
	at?: string | Vec3;
	out?: number;
	up?: number;
	forward?: number;
	palm?: DirectionName;
	point?: DirectionName;
	elbow?: string;
	hand?: string | { shape?: string; curl?: number; thumb?: number; spread?: number };
}

export interface FootSpec {
	out?: number;
	forward?: number;
	lift?: number;
	heading?: number;
	plant?: PlantName;
}

export interface Beat {
	label?: string;
	at?: number;
	in?: number;
	hold?: number;
	ease?: EaseName;
	effort?: string | Partial<Effort> & { preset?: string };
	posture?: string;
	root?: { height?: number; forward?: number; side?: number; rise?: number; turn?: number };
	torso?: { lean?: number; twist?: number; sideBend?: number };
	gaze?: string | { preset?: string; yaw?: number; pitch?: number; roll?: number };
	arms?: { left?: ArmSpec | string; right?: ArmSpec | string };
	legs?: string | { stance?: string; left?: FootSpec; right?: FootSpec };
	face?: string | Record<string, number>;
}

export interface MotionScore {
	version?: number;
	name?: string;
	seed?: string;
	loop?: boolean;
	effort?: string;
	beats: Beat[];
}

/** A normalized score: every field resolved, every beat carrying an absolute time. */
export interface NormalizedScore extends Required<Pick<MotionScore, 'version' | 'name' | 'seed' | 'loop'>> {
	effort: Effort;
	beats: Array<Required<Pick<Beat, 'at' | 'in' | 'hold' | 'ease'>> & Beat & { effort: Effort }>;
	duration: number;
}

/** A three.js AnimationClip.toJSON() document. */
export interface ClipDocument {
	name: string;
	duration: number;
	uuid: string;
	blendMode: number;
	tracks: Array<{ type: string; name: string; times: number[]; values: number[] }>;
}

export interface CompileOptions {
	name?: string;
	/** Layer breathing and micro-sway on top. Default true. */
	idle?: boolean;
	/** Emit the hip translation track. Default true. */
	rootMotion?: boolean;
	/** Emit the finger bones. Default true. */
	fingers?: boolean;
}

export interface CompileResult {
	clip: ClipDocument;
	score: NormalizedScore;
	warnings: string[];
}

export const MOTION_SCORE_VERSION: number;
export const MOTION_BONES: readonly string[];
export const ACTION_NAMES: readonly string[];
export const LIMITS: Readonly<Record<string, number>>;

export function compileScore(score: MotionScore, opts?: CompileOptions): CompileResult;
export function motionFromText(
	prompt: string,
	opts?: CompileOptions & { loop?: boolean; effort?: string },
): CompileResult & { matched: string };
export function motionCapabilities(): { version: number; schema: object; limits: object; actions: string[] };

export function normalizeScore(input: unknown): NormalizedScore;
export function validateScore(input: unknown): { ok: boolean; score: NormalizedScore | null; error: { path: string; message: string } | null };
export function scoreSchema(): object;
export function describeScore(score: NormalizedScore): string;
export function composeScore(
	prompt: string,
	opts?: { name?: string; loop?: boolean; effort?: string },
): { score: MotionScore | null; matched: string | null; reason: string | null };

export declare class Pose {
	constructor(from?: Pose | null);
	local: Map<string, Quat>;
	face: Map<string, number>;
	rootOffset: Vec3;
	readonly isRest: boolean;
	clone(): Pose;
	getLocal(bone: string): Quat;
	setLocal(bone: string, q: Quat): this;
	rotateLocal(bone: string, axis: Vec3, deg: number): this;
	setRootOffset(offset: Vec3): this;
	worldQuat(bone: string): Quat;
	worldPos(bone: string): Vec3;
	worldDir(bone: string): Vec3;
	setWorldQuat(bone: string, q: Quat): this;
	aim(bone: string, dirWorld: Vec3, refWorld?: Vec3 | null, refLocal?: Vec3 | null): this;
	setFace(weights: Record<string, number>): this;
	getFace(shape: string): number;
	locals(): Record<string, Quat>;
}

export function restPose(): Pose;
export function blendPose(a: Pose, b: Pose, t: number): Pose;

export function solveBeat(beat: Beat): { pose: Pose; warnings: string[] };
export function solveScorePoses(score: NormalizedScore): {
	keys: Array<{ time: number; pose: Pose; beat: object }>;
	warnings: string[];
};

export function solveArm(pose: Pose, side: Side, spec: {
	wrist: Vec3; fingers?: Vec3; palm?: Vec3; pole?: Vec3; reach?: number; clavicle?: boolean;
}): Pose;
export function solveLeg(pose: Pose, side: Side, spec: {
	ankle: Vec3; heading?: number; plant?: PlantName; toe?: Vec3; sole?: Vec3; pole?: Vec3; reach?: number;
}): Pose;
export function solveSpine(pose: Pose, spec: { lean?: number; twist?: number; sideBend?: number }): Pose;
export function solveGaze(pose: Pose, spec: { yaw?: number; pitch?: number; roll?: number }): Pose;
export function solveTurn(pose: Pose, degrees: number): Pose;
export function shapeHand(pose: Pose, side: Side, spec: {
	curl?: number; thumb?: number; spread?: number; only?: string[];
}): Pose;

export function centreOfMass(pose: Pose): Vec3;
export function supportCentre(pose: Pose, weights?: { Left?: number; Right?: number }): Vec3;
export function balanceError(pose: Pose, weights?: { Left?: number; Right?: number }): number;
export function balanceOffset(pose: Pose, weights?: { Left?: number; Right?: number }): Vec3;

export function anchorPoint(pose: Pose, anchor: string | Vec3, offset?: {
	out?: number; up?: number; forward?: number; side?: Side;
}): Vec3;
export function restAnchor(anchor: string | Vec3, offset?: {
	out?: number; up?: number; forward?: number; side?: Side;
}): Vec3;
export function bodyDirection(pose: Pose, name: DirectionName, side?: Side): Vec3;

export function buildClip(
	keys: Array<{ time: number; pose: Pose; beat?: object }>,
	opts: { name: string; seed?: string; loop?: boolean; idle?: boolean; rootMotion?: boolean; fingers?: boolean },
): ClipDocument;
export function restClip(name: string): ClipDocument;
export function stableUuid(seed: string): string;
export function expressionWeights(spec: Record<string, number>): Record<string, number>;

export const POSTURES: Readonly<Record<string, object>>;
export const POSTURE_NAMES: readonly string[];
export const STANCES: Readonly<Record<string, object>>;
export const STANCE_NAMES: readonly string[];
export const HAND_SHAPES: Readonly<Record<string, object>>;
export const HAND_SHAPE_NAMES: readonly string[];
export const ELBOW_POLES: Readonly<Record<string, object>>;
export const ELBOW_NAMES: readonly string[];
export const GAZES: Readonly<Record<string, object>>;
export const GAZE_NAMES: readonly string[];
export const EXPRESSIONS: Readonly<Record<string, Record<string, number>>>;
export const EXPRESSION_NAMES: readonly string[];
export const EXPRESSION_SHAPES: readonly string[];
export const EFFORTS: Readonly<Record<string, Effort>>;
export const EFFORT_NAMES: readonly string[];
export const EASE_NAMES: readonly string[];
export const ANCHORS: Readonly<Record<string, unknown>>;
export const ANCHOR_NAMES: readonly string[];
export const DIRECTIONS: Readonly<Record<string, Vec3>>;
export const UNITS: Readonly<Record<string, number>>;
export const PLANT_TILT: Readonly<Record<PlantName, number>>;

export const BODY_FORWARD: Readonly<Vec3>;
export const BODY_LEFT: Readonly<Vec3>;
export const BODY_UP: Readonly<Vec3>;
export const CANONICAL_BONES: readonly string[];
export const ARM_REACH: number;
export const LEG_LENGTH: number;
export const SHOULDER_SPAN: number;
export const STANDING_HIP_HEIGHT: number;
export const GROUND_Y: number;
export function boneLength(bone: string): number;
export function hasBone(bone: string): boolean;
export function restPos(bone: string): Vec3;
