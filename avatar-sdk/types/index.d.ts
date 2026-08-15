// Type declarations for @three-ws/avatar. The runtime is implemented in
// JavaScript and ships as a self-contained ES module that side-effectfully
// registers the <agent-3d> custom element on import.

export {};

declare global {
	interface HTMLElementTagNameMap {
		'agent-3d': Agent3DElement;
		'agent-stage': AgentStageElement;
	}
}

/** A choreography step: one clip held for `hold` seconds at `speed`. */
export interface RoutineStep {
	clip: string;
	hold?: number;
	speed?: number;
}

/** A named, replayable sequence of clips. */
export interface Routine {
	name: string;
	steps: RoutineStep[];
	loop?: boolean;
}

/**
 * The `<agent-3d>` web component renders a 3D avatar with a built-in chat /
 * voice loop, emotion morphs, and lipsync. Most apps will use it declaratively
 * in HTML; instances can also be created via `document.createElement`.
 *
 * The element is configured through ATTRIBUTES, not properties: `avatar-id`,
 * `src`, `body`, `manifest`, `ios-src`, `kiosk`, `brain`, `instructions`,
 * `memory`, `voice`, `mode`, `position`, `width`, `height`, `background`,
 * `name-plate`, `avatar-chat`, `avatar-walk`. Use `setAttribute` (or plain
 * HTML) to set them; the methods below are the imperative API.
 */
export class Agent3DElement extends HTMLElement {
	/** Send a message through the agent's brain and speak the reply. */
	say(text: string, opts?: Record<string, unknown>): void;
	/** Like `say`, but resolves once the reply has been produced. */
	ask(text: string, opts?: Record<string, unknown>): Promise<unknown>;
	/** Play a talking animation sized to `text` without calling the brain. */
	speak(text: string, opts?: Record<string, unknown>): void;
	/** Drop the in-memory conversation history. */
	clearConversation(): void;

	/** Play a clip by name with the polished embed defaults. */
	playClip(name: string, opts?: { fade_ms?: number; userInitiated?: boolean }): void;
	/** Play a raw clip by name on the scene. Resolves false when unavailable. */
	play(name: string, opts?: Record<string, unknown>): Promise<boolean | undefined>;
	/** Play a named emote ('cheer' | 'flinch' | 'celebrate'), with fallbacks. */
	playEmote(name: string, intensity?: number): boolean | undefined;
	/** Play the wave animation. */
	wave(opts?: Record<string, unknown>): Promise<boolean | undefined>;
	/** Aim the avatar's gaze at a target ('user', 'camera', or a position). */
	lookAt(target: unknown): Promise<unknown>;

	/** Fire an emotion stimulus: 'celebration' | 'concern' | 'curiosity' | 'empathy' | 'patience'. */
	expressEmotion(trigger: string, weight?: number): boolean;
	/** Set the sustained mood driving resting expression and posture. */
	setMood(valence: number, arousal: number, opts?: { reducedMotion?: boolean }): boolean;

	/** Play a named routine, or an inline routine object. */
	playRoutine(nameOrRoutine: string | Routine, opts?: Record<string, unknown>): boolean;
	/** Stop the running routine and settle back into idle. */
	stopRoutine(): void;
	/** Every routine available on this avatar (presets plus manifest routines). */
	getRoutines(): Routine[];

	/** Slide into frame, speak a message, then retreat. Queued. */
	notify(message: string, opts?: { priority?: 'low' | 'normal' | 'high'; duration?: number }): void;

	/** Install a skill from a manifest URI. */
	installSkill(uri: string): Promise<unknown>;
	/** Remove an installed skill by name. */
	uninstallSkill(name: string): unknown;

	/** Switch layout mode ('inline' | 'corner' | 'fullscreen' | 'pill'). */
	setMode(mode: string): void;
	/** Move a positioned agent ('bottom-right', etc.) with an optional offset. */
	setPosition(pos: string, offset?: string): void;
	/** Resize the element. */
	setSize(width: string | number, height: string | number): void;

	/** Enable the inline avatar-in-chat layout (the default). */
	enableAvatarChat(): void;
	/** Restore the bottom-bar chat layout. */
	disableAvatarChat(): void;
	/** Enable the walk animation during streaming and scrolling (the default). */
	enableAvatarWalk(): void;
	/** Keep the avatar in idle instead of walking while streaming. */
	disableAvatarWalk(): void;

	/** Pause the runtime. */
	pause(): void;
	/** Resume the runtime (the viewer also resumes on its own when visible). */
	resume(): void;
	/** Tear the agent down and release GPU resources. */
	destroy(): void;

	/** Installed skills. */
	readonly skills: unknown[];
	/** The agent's memory store, once booted. */
	readonly memory: Memory | undefined;
	/** The resolved avatar manifest, once loaded. */
	readonly manifest: unknown;
	/** The agent runtime, once booted. */
	readonly runtime: Runtime | undefined;
}

export class AgentStageElement extends HTMLElement {}

export class Viewer {}
export class Runtime {}
export class SceneController {}
export class Memory {}
export class Skill {}
export class SkillRegistry {}

/** Load a manifest from an `agent://`, `ipfs://`, or HTTP source. */
export function loadManifest(
	source: string,
	opts?: { rpcURL?: string; registry?: string },
): Promise<unknown>;
/** Normalize a raw manifest object into the canonical shape. */
export function normalize(json: unknown, opts?: { baseURI?: string }): unknown;
/** Fetch a path relative to a loaded manifest's base URI. */
export function fetchRelative(manifest: unknown, relPath: string): Promise<Response>;
/** Resolve an `ipfs://` or `ar://` URI to an HTTP gateway URL. */
export function resolveURI(uri: string, gatewayIndex?: number): string;
/** Fetch an `ipfs://` URI, trying each configured gateway in turn. */
export function fetchWithFallback(ipfsURI: string): Promise<Response>;

/** Register the element under a custom tag name (defaults to 'agent-3d'). */
export function defineElement(tag?: string): void;
