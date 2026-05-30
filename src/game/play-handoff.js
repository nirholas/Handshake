// Avatar handoff between the creation surfaces and the live worlds (/play, /game).
//
// One localStorage key — `cc-avatar` — is the contract that ties the platform's
// avatar tools to its multiplayer scenes. The lobby avatar bar, the boot loader,
// the social walkaround (coincommunities.js) and the isometric RPG (iso-game.js)
// all read it. This module is the single writer used by every "use this avatar"
// affordance, so the value stored is always something the scenes can resolve:
//
//   • a three.ws avatar id        — canonical identity, resolved via /api/avatars/:id
//   • a public GLB/VRM URL or path
//   • GUEST_SENTINEL              — a just-created avatar not yet uploaded, staged
//                                   in IndexedDB by guest-avatar.js
//
// Scenes resolve all three through resolveAvatarUrl() in avatar-rig.js. A guest
// avatar shows to its creator instantly from the local blob; the scene then
// uploads it in the background (uploadPendingGuestAvatar) and swaps in the public
// URL so peers see it too — no upload round-trip before the world appears.

import { stage, load, peek } from '../guest-avatar.js';

export const CC_AVATAR_KEY = 'cc-avatar';
export const CC_NAME_KEY = 'cc-name';
export const GUEST_SENTINEL = 'guest:pending';

// One object URL per staged blob, cached so repeated resolves (local rig + boot
// loader + thumbnail) share it and we only revoke when the staged avatar changes.
let _guest = { id: null, url: null };

export function getPlayAvatar() {
	try { return localStorage.getItem(CC_AVATAR_KEY) || ''; } catch { return ''; }
}

// Persist the avatar every world reads. Prefer a canonical id; fall back to a
// loadable URL/path or the guest sentinel. Returns the stored value.
export function setPlayAvatar(value) {
	const v = (value || '').trim();
	try { localStorage.setItem(CC_AVATAR_KEY, v); } catch { /* storage disabled */ }
	return v;
}

export function setPlayName(name) {
	const v = (name || '').trim().slice(0, 24);
	if (!v) return '';
	try { localStorage.setItem(CC_NAME_KEY, v); } catch { /* ignore */ }
	return v;
}

/**
 * Adopt an avatar and (optionally) jump into a world. The single entry point for
 * every "Play as this" / "Use in /play" button across the creation surfaces.
 *
 * @param {object} opts
 * @param {string} [opts.id]    three.ws avatar id (preferred — stable identity)
 * @param {string} [opts.url]   public GLB/VRM URL (used when no id is available)
 * @param {Blob}   [opts.blob]  a freshly-created GLB not yet uploaded
 * @param {string} [opts.name]  player display name to carry in
 * @param {string} [opts.source] provenance label when staging a blob
 * @param {'/play'|'/game'|null} [opts.dest='/play'] where to navigate; null = stay
 * @param {object} [opts.coin]  optional { mint, name, symbol, image } deep-link
 * @returns {Promise<string>} the value stored in cc-avatar
 */
export async function playAs(opts = {}) {
	const { id, url, blob, name, dest = '/play', coin } = opts;
	let value;
	if (blob instanceof Blob) {
		await stage(blob, { source: opts.source || 'three-ws-studio', name: name || 'My avatar' });
		value = GUEST_SENTINEL;
	} else {
		value = (id || url || '').trim();
	}
	if (!value) throw new Error('playAs requires an id, url, or blob');
	setPlayAvatar(value);
	if (name) setPlayName(name);

	if (dest) {
		const q = new URLSearchParams();
		if (coin?.mint) {
			q.set('coin', coin.mint);
			if (coin.name) q.set('name', coin.name);
			if (coin.symbol) q.set('symbol', coin.symbol);
			if (coin.image) q.set('image', coin.image);
		}
		const qs = q.toString();
		location.href = dest + (qs ? '?' + qs : '');
	}
	return value;
}

// Resolve the guest sentinel to a local object URL for instant self-preview.
// Returns null when nothing is staged. Cached per staged blob; the previous URL
// is revoked only when the staged avatar actually changes, so a loader mid-fetch
// is never pulled out from under.
export async function resolveGuestAvatar() {
	const ptr = peek();
	if (!ptr) return null;
	if (_guest.id === ptr.id && _guest.url) return _guest.url;
	const rec = await load();
	if (!rec?.blob) return null;
	if (_guest.url) { try { URL.revokeObjectURL(_guest.url); } catch { /* ignore */ } }
	_guest = { id: rec.id, url: URL.createObjectURL(rec.blob) };
	return _guest.url;
}

export function hasPendingGuestAvatar() {
	return getPlayAvatar() === GUEST_SENTINEL && !!peek();
}

/**
 * Upload a staged guest avatar so every peer can fetch it, then promote
 * cc-avatar from the local sentinel to the real public URL. Safe to call when
 * nothing is staged (returns null). The local staging is intentionally kept so a
 * refresh still self-previews instantly; the public URL now in cc-avatar wins for
 * the network.
 *
 * @param {(publicUrl: string) => void} [onPublished] called once the URL is live
 * @returns {Promise<string|null>} the public URL, or null if there was nothing to upload
 */
export async function uploadPendingGuestAvatar(onPublished) {
	if (getPlayAvatar() !== GUEST_SENTINEL) return null;
	const rec = await load();
	if (!rec?.blob) return null;
	try {
		const { uploadGlb } = await import('./avatar-upload.js');
		const file = new File([rec.blob], `${(rec.name || 'avatar').replace(/[^\w.-]+/g, '-')}.glb`, {
			type: 'model/gltf-binary',
		});
		const publicUrl = await uploadGlb(file);
		setPlayAvatar(publicUrl);
		onPublished?.(publicUrl);
		return publicUrl;
	} catch (err) {
		console.warn('[play-handoff] guest avatar upload failed; staying local-only:', err?.message);
		return null;
	}
}
