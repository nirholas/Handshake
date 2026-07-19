// Type definitions for @three-ws/assistant

export const VERSION: string;
export const CHANNEL: 'three-assistant';
export const PARAM_KEYS: readonly string[];

/** Interaction mode. 'both' shows a Chat / Speak toggle in the widget. */
export type AssistantMode = 'chat' | 'speak' | 'both';

/** Launcher / panel corner. */
export type AssistantPosition = 'right' | 'left';

export interface AssistantConfig {
	/** Avatar id, an `/avatars/*.glb` path, or a GLB URL. */
	avatar?: string;
	/** A three.ws agent id (alternative to `avatar`). */
	agent?: string;
	/**
	 * Background: `transparent` (default, avatar floats over the page), a `#hex`
	 * color, a preset (`ember` | `ocean` | `violet` | `forest` | `dusk` | `slate`),
	 * or `gradient:#aabbcc,#112233,160`.
	 */
	bg?: string;
	mode?: AssistantMode;
	/** Accent color (`#hex`) for the launcher, send button, and focus rings. */
	accent?: string;
	/** Assistant/header name and chatbot persona name. */
	name?: string;
	/** First speech bubble shown when the widget opens. */
	greeting?: string;
	/** What the chatbot should know about your site; injected into the prompt. */
	context?: string;
	/** Start with voice muted. */
	voice?: boolean;
	/** Hide the three.ws attribution badge. */
	badge?: boolean;
	position?: AssistantPosition;
	/** Start with the panel open. */
	open?: boolean;
	/** Override the frame origin (self-hosting). Defaults to https://three.ws. */
	origin?: string;
	/** Pin the frame's outbound postMessage target. Defaults to the page origin. */
	targetOrigin?: string;
}

export type AssistantEventType =
	| 'ready'
	| 'open'
	| 'close'
	| 'message'
	| 'speak:start'
	| 'speak:end'
	| 'error';

export class Assistant {
	constructor(config: AssistantConfig, ctx: { origin: string; onDestroy?: (a: Assistant) => void });
	readonly isOpen: boolean;
	readonly config: AssistantConfig;
	readonly launcher: HTMLButtonElement;
	readonly panel: HTMLDivElement;
	readonly iframe: HTMLIFrameElement;
	open(): void;
	close(): void;
	toggle(): void;
	say(text: string): void;
	setMode(mode: 'chat' | 'speak'): void;
	destroy(): void;
}

export interface AssistantApi {
	readonly version: string;
	readonly origin: string;
	readonly instance: Assistant | null;
	init(config?: AssistantConfig): Assistant;
	open(): void;
	close(): void;
	toggle(): void;
	say(text: string): void;
	setMode(mode: 'chat' | 'speak'): void;
	destroy(): void;
}

/** Create an API bound to a frame `origin` (defaults to https://three.ws). */
export function createAssistant(opts?: { origin?: string }): AssistantApi;

/** Build the `/assistant-frame` URL for a config. */
export function frameUrl(config: AssistantConfig, origin: string, hostOrigin?: string): string;

/** True for a `#rgb` / `#rrggbb` / `#rrggbbaa` hex color. */
export function isHex(value: unknown): boolean;

/** Read a `<script data-*>` tag's assistant config into an object. */
export function configFromScript(script: Element | null): AssistantConfig;

/** Auto-mount from a `<script data-*>` tag. Idempotent; skipped on `data-manual`. */
export function autoInit(script?: Element | null): void;

export const init: AssistantApi['init'];
export const open: AssistantApi['open'];
export const close: AssistantApi['close'];
export const toggle: AssistantApi['toggle'];
export const say: AssistantApi['say'];
export const setMode: AssistantApi['setMode'];
export const destroy: AssistantApi['destroy'];
export function mount(config?: AssistantConfig): Assistant;

declare const ThreeAssistant: AssistantApi;
export default ThreeAssistant;

declare global {
	interface Window {
		ThreeAssistant?: AssistantApi;
	}
}
