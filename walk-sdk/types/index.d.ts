// Type definitions for @three-ws/walk
import type { Object3D } from 'three';

export declare const VERSION: string;

/** How a roster avatar is animated. */
export type WalkRig = 'embedded' | 'shared';

/** Logical animation states the controller understands. */
export type WalkState = 'idle' | 'walk' | 'run' | 'jump';

/** On-command performances the controller can play (when the rig has the clip). */
export type WalkEmote = 'dance' | 'punch' | 'backflip' | 'wave' | (string & {});

/** Mapping of logical states to clip names (shared rig) or candidate name lists (embedded rig). */
export interface WalkClipMap {
	idle?: string | string[];
	walk?: string | string[];
	run?: string | string[];
	wave?: string | string[];
	jump?: string | string[];
}

/** A single avatar in the roster. */
export interface WalkAvatar {
	id: string;
	name: string;
	emoji?: string;
	blurb?: string;
	category: string;
	/** GLB path resolved against `assetBase`; null for API-served avatars. */
	asset: string | null;
	source: 'static' | 'api';
	rig: WalkRig;
	clips?: WalkClipMap;
	/** Shared-rig emote overrides: emote name to manifest clip name. */
	emotes?: Record<string, string>;
	thumb?: string;
	accent?: string;
	tags?: string[];
}

export declare const WALK_AVATARS: WalkAvatar[];
export declare const DEFAULT_AVATAR_ID: string;
export declare const DEFAULT_SHARED_CLIPS: Record<string, string>;
export declare const DEFAULT_EMOTES: Record<string, string>;

/** Resolve an emote map against the clips that exist, dropping unsupported emotes. */
export declare function resolveEmotes(
	availableClipNames: Iterable<string>,
	emotes?: Record<string, string>,
): Record<string, string>;

export declare function getAvatar(id: string): WalkAvatar | null;
export declare function defaultAvatar(): WalkAvatar;
export declare function listCategories(): string[];
export declare function makeApiAvatarEntry(
	id: string,
	opts?: { name?: string; accent?: string },
): WalkAvatar;
export declare function resolveAvatarUrl(
	entry: WalkAvatar,
	opts?: { assetBase?: string; apiBase?: string },
): string | null;

/** Options accepted by `createWalkCompanion`. */
export interface WalkCompanionOptions {
	/** Roster shown in the picker and resolvable by id. Defaults to WALK_AVATARS. */
	avatars?: WalkAvatar[];
	/** Avatar to load when none is chosen/stored. Defaults to 'robot'. */
	defaultAvatarId?: string;
	/** Base prepended to static GLB paths (e.g. a CDN origin). */
	assetBase?: string;
	/** Base prepended to the `/api/avatars/<id>/glb` proxy. */
	apiBase?: string;
	/** URL of the shared animation manifest. Defaults to '/animations/manifest.json'. */
	manifestUrl?: string;
	/** Route prefixes where the companion never mounts. */
	excludedRoutes?: string[];
	/** Show the avatar picker button. Defaults to true. */
	enablePicker?: boolean;
	/** Companion's chest/neck/head follow the visitor's cursor. Defaults to true. */
	lookAt?: boolean;
	/** Override the page-context greeting; return null to fall back to the default. */
	greeting?: (path: string) => string | null;
	/** Optional "make your own" link shown in the picker footer. */
	docsUrl?: string;
	/** Storage key prefix. Defaults to 'walk'. */
	storagePrefix?: string;
}

/** The controller returned by `createWalkCompanion`. */
export interface WalkCompanionControl {
	readonly instance: unknown;
	/** The resolved options this control was built with (storage keys included). */
	readonly config: WalkConfig;
	isEnabled(): boolean;
	enable(): void;
	disable(): void;
	toggle(): void;
	/** Persist and (if mounted) hot-swap the live avatar. */
	setAvatar(idOrEntry: string | WalkAvatar): void;
	openPicker(): void;
	/** Run the app-style auto-mount + deep-link logic (reads ?walk= and saved state). */
	bootstrap(): void;
}

export declare function createWalkCompanion(opts?: WalkCompanionOptions): WalkCompanionControl;

/** A controller exposing setState/playWave/emotes for a loaded avatar. */
export interface WalkController {
	setState(state: WalkState): void;
	playWave(): void;
	/** Emote names this rig can actually perform; render only these as buttons. */
	emotes(): WalkEmote[];
	/** Play an emote once, then settle back to the base state. False = unsupported. */
	playEmote(name: WalkEmote): boolean;
	/** Scale playback rate (1 = authored cadence) so walk cycles match travel speed. */
	setSpeed(scale: number): void;
	update(dt: number): void;
	dispose(): void;
}

export declare function loadWalkAvatar(
	entry: WalkAvatar,
	opts?: {
		assetBase?: string;
		apiBase?: string;
		manifestUrl?: string;
		fallbackEntry?: WalkAvatar | null;
		waveMs?: number;
	},
): Promise<{ model: Object3D; controller: WalkController; gltf: unknown; entry: WalkAvatar }>;

export type PlaygroundMode = 'stroll' | 'platformer';

export declare function launchPlayground(opts?: {
	avatarId?: string | null;
	startScreen?: { x: number; y: number } | null;
	dropIn?: boolean;
	mode?: PlaygroundMode;
	config?: unknown;
	/** Checkpoint quest: elements the visitor must reach, in order. Works in both movement modes. */
	checkpoints?: Array<{ el: Element }>;
	/** Called when the active checkpoint is reached; call resume() to unfreeze and advance. */
	onReach?: (index: number, resume: () => void) => void;
	onComplete?: () => void;
	/** Start the quest at this checkpoint index (used to carry progress across a mode switch). */
	startCheckpoint?: number;
}): unknown;
export declare function exitPlayground(): void;
export declare function switchPlaygroundMode(forceMode?: PlaygroundMode | null): unknown;
export declare function getPlaygroundMode(): PlaygroundMode;
export declare function shouldDropIn(config?: unknown): boolean;
export declare function consumeDropIn(config?: unknown): boolean;
export declare function playgroundState(): Record<string, unknown> | null;

/** Avatar picker popover. */
export interface AvatarPicker {
	el: HTMLElement;
	show(): void;
	close(): void;
	toggle(): void;
	isOpen(): boolean;
	setCurrent(id: string): void;
	destroy(): void;
}

export declare function createAvatarPicker(opts: {
	avatars: WalkAvatar[];
	currentId?: string | null;
	onSelect: (entry: WalkAvatar) => void;
	anchor?: { right: number; bottom: number };
	assetBase?: string;
	docsUrl?: string;
}): AvatarPicker;

export interface WalkConfig {
	avatars: WalkAvatar[];
	defaultAvatarId: string;
	assetBase: string;
	apiBase: string;
	manifestUrl: string;
	excludedRoutes: string[];
	enablePicker: boolean;
	lookAt: boolean;
	greeting: ((path: string) => string | null) | null;
	docsUrl: string | null;
	keys: Record<string, string>;
}

export declare function resolveConfig(opts?: WalkCompanionOptions): WalkConfig;
export declare function resolveAvatarEntry(id: string | null, config: WalkConfig): WalkAvatar;
export declare const DEFAULT_EXCLUDED_PREFIXES: string[];
