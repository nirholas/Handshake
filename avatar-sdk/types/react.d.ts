// Type declarations for @three-ws/avatar/react.
//
// React peer dependency: >=18. The module is client-only ('use client') —
// every component touches the DOM. React 19 Server Components are not
// supported in this subpath.

import type {
	CSSProperties,
	ForwardRefExoticComponent,
	RefAttributes,
} from 'react';

export interface AvatarProps {
	/** GLB URL to render. */
	src: string;
	/** Accessibility label / caption shown beneath the model. */
	alt?: string;
	/** CSS color string, or 'transparent'. Defaults to transparent. */
	background?: string;
	style?: CSSProperties;
	className?: string;
	/** Fired once the GLB finishes loading. */
	onLoad?: (detail: { url: string }) => void;
	/** Fired if the GLB fails to load. */
	onError?: (detail: { url: string; error: Error }) => void;
}

/**
 * Lightweight 3D avatar viewer. Wraps the `<three-ws-viewer>` web component
 * registered by `@three-ws/avatar/viewer`. Does not load the heavy
 * chat/voice/skill runtime.
 */
export const Avatar: ForwardRefExoticComponent<
	AvatarProps & RefAttributes<HTMLElement>
>;

export interface AgentAvatarProps {
	/** three.ws avatar UUID. The element resolves it to a GLB on mount. */
	avatarId?: string;
	/** Direct GLB URL. Use this OR `avatarId`, not both. */
	src?: string;
	/** Optional iOS Quick Look USDZ URL for AR. */
	iosSrc?: string;
	/** Hide the dev/debug GUI. */
	kiosk?: boolean;
	style?: CSSProperties;
	className?: string;
}

/**
 * Wraps the heavy `<agent-3d>` element (chat loop, voice, lipsync, skills).
 * The monolith bundle is lazy-loaded the first time this component mounts.
 */
export const AgentAvatar: ForwardRefExoticComponent<
	AgentAvatarProps & RefAttributes<HTMLElement>
>;

export interface AvatarCreatorProps {
	/** Controls whether the creator modal is open. */
	open: boolean;
	/** Called with the GLB Blob when the user exports an avatar. */
	onExport?: (blob: Blob) => void | Promise<void>;
	/** Called when the user dismisses the modal without exporting. */
	onClose?: () => void;
	/** Override the studio iframe URL. Defaults to https://three.ws/avatar-studio/. */
	studioUrl?: string;
	/** Edit-mode session URL for an existing avatar (resolved server-side). */
	sessionUrl?: string;
}

/**
 * Declarative wrapper around the imperative AvatarCreator class. Renders
 * `null` — the modal is appended to `document.body` while `open` is true.
 */
export function AvatarCreator(props: AvatarCreatorProps): null;

export interface UseAvatarOptions {
	/** Override the API origin used to fetch `/api/avatars/:id`. */
	apiOrigin?: string;
}

export interface UseAvatarResult<T = any> {
	avatar: T | null;
	loading: boolean;
	error: Error | null;
}

/**
 * Fetches a three.ws avatar record by id. Re-fetches on `id` change,
 * aborts in-flight requests on unmount.
 */
export function useAvatar<T = any>(
	id: string | null | undefined,
	opts?: UseAvatarOptions,
): UseAvatarResult<T>;
