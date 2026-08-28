export interface ModelAnimation {
	name: string;
	duration: number;
	channels: unknown[];
}

export interface Model {
	nodes: unknown[];
	primitives: unknown[];
	animations: ModelAnimation[];
	bounds: { min: number[]; max: number[] };
	triangleCount: number;
	skinned: boolean;
	poseStamp: number;
}

export type ColorModeValue = 'truecolor' | 'ansi256' | 'mono';

export interface RendererOptions {
	/** Character columns. Default 96. */
	width?: number;
	/** Character rows. One row is two vertical pixels. Default 48. */
	height?: number;
	/** Clip name, index, or false to hold the rest pose. Default: the first clip. */
	animation?: string | number | boolean | null;
	mode?: ColorModeValue;
	/** Background rgb in 0..1, painted where nothing was drawn. */
	background?: [number, number, number];
	/** Leave uncovered cells as plain spaces instead of painting the background. */
	transparent?: boolean;
	/** Turntable speed, radians per second. Default 1. */
	spin?: number;
	pitch?: number;
	zoom?: number;
	tint?: [number, number, number];
}

export interface Orbit {
	yaw: number;
	pitch: number;
	zoom: number;
}

export interface Renderer {
	model: Model;
	animation: ModelAnimation | null;
	framing: { halfHeight: number; halfWidth: number };
	width: number;
	height: number;
	readonly orbit: Orbit;
	setOrbit(next: Partial<Orbit>): Orbit;
	/** Terminal-ready text for the frame at `time` seconds. No trailing newline. */
	frame(time?: number): string;
}

export interface LoadOptions {
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

/** Load from a file path, an http(s) URL, or raw GLB bytes. */
export function loadModel(source: string | Uint8Array | ArrayBuffer, options?: LoadOptions): Promise<Model>;
export function loadModelFromFile(path: string): Promise<Model>;
export function loadModelFromBytes(bytes: Uint8Array | ArrayBuffer): Promise<Model>;

export function createRenderer(model: Model, options?: RendererOptions): Renderer;
export function renderOnce(source: string | Uint8Array | ArrayBuffer, options?: RendererOptions & LoadOptions & { time?: number }): Promise<string>;

export function selectAnimation(model: Model, wanted?: string | number | boolean | null): ModelAnimation | null;
export function describeModel(model: Model): {
	triangles: number;
	primitives: number;
	nodes: number;
	skinned: boolean;
	animations: Array<{ name: string; duration: number }>;
};

export function detectColorMode(env?: NodeJS.ProcessEnv, stream?: NodeJS.WriteStream): ColorModeValue;
export function detectTerminalColor(env?: NodeJS.ProcessEnv, stream?: NodeJS.WriteStream): ColorModeValue;
export function toAnsi256(r: number, g: number, b: number): number;

export const ColorMode: { TRUECOLOR: 'truecolor'; ANSI256: 'ansi256'; MONO: 'mono' };
export const ansi: {
	hideCursor: string;
	showCursor: string;
	clearScreen: string;
	home: string;
	up(n: number): string;
};
