// Type definitions for @three-ws/agent-ui
// Project: https://three.ws

import type {
	AnimationClip,
	AnimationAction,
	Object3D,
	OrthographicCamera,
	Scene,
	WebGLRenderer,
	Bone,
} from 'three';

export interface SubclipSpec {
	/** Start frame (inclusive) */
	start: number;
	/** End frame (inclusive) */
	end: number;
	/** Frame rate the source clip was authored at. Default 30. */
	fps?: number;
}

export interface AgentUIOptions {
	/** Path to a .glb avatar. Default '/avatars/cz.glb'. */
	avatar?: string;
	/** Base URL for clip JSONs (joined with `${name}.json`). Default '/animations/clips/'. */
	clipsBase?: string;
	/** Names of clips to load eagerly. */
	clips?: string[];
	/** Per-clip subclip windows (e.g. trim the tail of a long Mixamo clip). */
	subclips?: Record<string, SubclipSpec>;
	/** Element to mount the overlay canvas into. Default document.body. */
	container?: HTMLElement;
	/** Pre-existing canvas to render into; else one is created. */
	canvas?: HTMLCanvasElement;
	/** z-index for the auto-created overlay canvas. Default 999. */
	zIndex?: number;
	/** How many screen pixels equal one Three.js world unit. Default 120. */
	pixelsPerUnit?: number;
	/** Enable mouse-driven camera parallax. Default true. */
	parallax?: boolean;
	/** Crossfade duration in seconds for animation transitions. Default 0.3. */
	crossfade?: number;
	/** Add default 3-point lighting rig. Default true. */
	lights?: boolean;
}

export interface PlayOptions {
	/** Loop the clip. Default true. */
	loop?: boolean;
	/** Hold the final frame after a non-looping clip ends. Default false. */
	hold?: boolean;
	/** Callback fired when a non-looping clip's last frame is reached. */
	onComplete?: () => void;
}

export interface MoveOptions {
	duration?: number;
	ease?: (t: number) => number;
}

export interface AnchorOptions {
	/** Where on the element the avatar should stand. Default 'top-center'. */
	anchor?:
		| 'top-left'
		| 'top-right'
		| 'top-center'
		| 'center'
		| 'bottom-center'
		| 'left-of'
		| 'right-of';
	offsetX?: number;
	offsetY?: number;
}

export interface WalkOptions extends AnchorOptions {
	walkClip?: string;
	duration?: number;
}

export interface StandOptions extends AnchorOptions {
	idleClip?: string;
}

export interface FallOptions extends AnchorOptions {
	fallClip?: string;
	/** Seconds. */
	duration?: number;
	/** Multiple of viewport height above the target to start. Default 0.6. */
	startOffsetVh?: number;
	/** Pixels above the element top to land on. Default 90. */
	landingOffsetPx?: number;
	/** Tumble amplitude during the fall. Default 0.25 radians. */
	tumble?: number;
	/** Called once the impact frame is reached. */
	onLand?: () => void;
}

export interface RunOffOptions {
	walkClip?: string;
	rotationDuration?: number;
	minDuration?: number;
	/** Travel speed for distance-based timing. Default 0.45 px/ms. */
	pxPerMs?: number;
}

export interface InterceptNavigationOptions {
	direction?: 'left' | 'right';
	/** Time in ms to wait after firing runOff before navigating. Default 1100. */
	delay?: number;
	/** Custom callback instead of following linkEl.href. */
	onAfter?: () => void;
}

export interface DustOptions {
	count?: number;
	gravity?: number;
	minSpeed?: number;
	maxSpeed?: number;
	minSize?: number;
	maxSize?: number;
	maxLifeMs?: number;
	yWithin?: number;
	zIndex?: number;
	color?: string;
}

export interface ImpactPulseOptions {
	dropPx?: number;
	elasticMs?: number;
}

export interface ProximityShadowOptions {
	maxDistancePx?: number;
	maxAlpha?: number;
	cssVar?: string;
}

export interface LookAtOptions {
	duration?: number;
	maxYaw?: number;
	sensitivity?: number;
}

export interface WorldPoint { x: number; y: number; }

export interface AgentUI {
	readonly THREE: typeof import('three');
	readonly renderer: WebGLRenderer;
	readonly scene: Scene;
	readonly camera: OrthographicCamera;
	readonly canvas: HTMLCanvasElement;
	readonly pixelsPerUnit: number;
	readonly avatar: Object3D;
	readonly rootBone: Bone | null;
	readonly currentClip: string | null;
	readonly ready: boolean;

	domToWorld(screenX: number, screenY: number): WorldPoint;
	worldToScreen(worldX: number, worldY: number): { x: number; y: number };
	worldOfElement(el: Element, options?: AnchorOptions): WorldPoint;

	play(name: string, options?: PlayOptions): void;
	clip(name: string): number;

	moveTo(target: WorldPoint, options?: MoveOptions): Promise<void>;
	lookAt(screenX: number, options?: LookAtOptions): Promise<void>;
	faceFront(options?: { duration?: number }): Promise<void>;

	standOn(el: Element, options?: StandOptions): void;
	walkTo(el: Element, options?: WalkOptions): Promise<void>;
	fallOnto(el: Element, options?: FallOptions): Promise<void>;
	runOff(direction?: 'left' | 'right', options?: RunOffOptions): Promise<void>;
	interceptNavigation(linkEl: HTMLAnchorElement | HTMLElement, options?: InterceptNavigationOptions): () => void;

	fx: {
		dust(el: Element, options?: DustOptions): void;
		impactPulse(el: Element, options?: ImpactPulseOptions): () => void;
		/** Returns a disposer that stops the per-frame update + clears the CSS var. */
		proximityShadow(el: Element, options?: ProximityShadowOptions): () => void;
	};

	caretScreenX(input: HTMLInputElement): number;
	startCaretTracking(
		input: HTMLInputElement,
		onChange: (screenX: number) => void,
		getActive: () => HTMLInputElement | null,
	): () => void;

	pickFrom(pool: string[]): () => string | null;

	scan(root?: ParentNode): () => void;
	whenReady(fn: (agent: AgentUI) => void): void;
	destroy(): void;
}

export function createAgentUI(options?: AgentUIOptions): Promise<AgentUI>;

// Lower-level exports for power users assembling their own pipeline.
export function createRenderer(options?: {
	container?: HTMLElement;
	canvas?: HTMLCanvasElement;
	zIndex?: number;
	pixelsPerUnit?: number;
	lights?: boolean;
	parallax?: boolean;
}): {
	canvas: HTMLCanvasElement;
	renderer: WebGLRenderer;
	scene: Scene;
	camera: OrthographicCamera;
	pixelsPerUnit: number;
	domToWorld(x: number, y: number): WorldPoint;
	worldToScreen(x: number, y: number): { x: number; y: number };
	updateParallax(): void;
	destroy(): void;
};

export function loadAvatar(options: {
	avatar: string;
	clipsBase: string;
	clips: string[];
	subclips?: Record<string, SubclipSpec>;
}): Promise<{ object: Object3D; rootBone: Bone | null; clips: Record<string, AnimationClip>; }>;

export function createAnimator(options: {
	object: Object3D;
	clips: Record<string, AnimationClip>;
	crossfade?: number;
}): {
	play(name: string, options?: PlayOptions): void;
	update(dt: number): void;
	clipDuration(name: string): number;
	readonly currentName: string | null;
	actions: Record<string, AnimationAction>;
	clips: Record<string, AnimationClip>;
};

export function lockRootMotion(renderer: WebGLRenderer, rootBone: Bone | null): () => void;
export function createRandomPicker(pool: string[]): () => string | null;
export function caretScreenX(input: HTMLInputElement): number;
export function startCaretTracking(
	input: HTMLInputElement,
	onChange: (screenX: number) => void,
	getActive: () => HTMLInputElement | null,
): () => void;
export function dust(el: Element, options?: DustOptions): void;
export function impactPulse(el: Element, options?: ImpactPulseOptions): () => void;
export function proximityShadow(
	el: Element,
	agent: { avatar: Object3D | null; worldToScreen(x: number, y: number): { x: number; y: number } },
	options?: ProximityShadowOptions,
): { tick(): void; dispose(): void };
export function scan(root: ParentNode, agent: AgentUI): () => void;
