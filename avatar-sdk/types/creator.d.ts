export interface AvatarCreatorOptions {
	/** DOM node to mount the modal in. Defaults to document.body. */
	container?: HTMLElement;
	/** URL of the Avatar Studio iframe. Defaults to https://three.ws/avatar-studio/. */
	studioUrl?: string;
	/** Avaturn session URL for edit mode (created via /api/avatars/:id/session). */
	avaturnSessionUrl?: string;
	/** Called with the GLB Blob when the user exports. */
	onExport?: (blob: Blob) => void | Promise<void>;
	/** Called when the user closes the modal without exporting. */
	onClose?: () => void;
}

export class AvatarCreator {
	constructor(opts?: AvatarCreatorOptions);
	open(): Promise<void>;
	close(): void;
	dispose(): void;
}

export interface SaveBlobOptions {
	bearerToken: string;
	apiOrigin?: string;
	name?: string;
	description?: string;
	tags?: string[];
	visibility?: 'public' | 'unlisted' | 'private';
	source?: string;
}

export function saveBlob(
	blob: Blob,
	opts: SaveBlobOptions,
): Promise<{ id: string; url: string; slug: string }>;
