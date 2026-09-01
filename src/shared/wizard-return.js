/**
 * Wizard return contract.
 *
 * The /start onboarding wizard sends people off-page to make an avatar
 * (/create, /create/selfie, /create/prompt, /create/studio) and expects them
 * back on /start with the finished avatar attached. The hop can span several
 * pages and a sign-in round trip, so the return address is not carried in the
 * URL from page to page: the first page in the chain captures `?next=` into
 * sessionStorage and whichever page finally saves the avatar reads it back.
 *
 * Contract:
 *   - The wizard links out with `?wizard=1&next=<same-origin path under /start>`.
 *   - An avatar-producing page calls captureWizardReturn() on boot.
 *   - On save it calls pendingWizardReturn(); when that is set, it hands the
 *     avatar back with returnToWizard({ avatarId, avatarName, avatarThumb })
 *     instead of its usual post-save destination. The wizard creates the
 *     agent itself, so the producing page must not attach the avatar to an
 *     agent on this path.
 *
 * Only a same-origin path that starts with /start is ever stored, so a
 * crafted link cannot bounce a visitor to another site with their avatar id.
 * Entries expire after two hours; a stale one from an abandoned session must
 * not hijack a later, unrelated avatar save.
 */

export const WIZARD_RETURN_KEY = 'wz:return';
export const WIZARD_RETURN_TTL_MS = 2 * 60 * 60 * 1000;

function storageOf(storage) {
	if (storage) return storage;
	try { return globalThis.sessionStorage || null; } catch { return null; }
}

/**
 * Normalize a candidate return target to a same-origin /start path, or null.
 * Accepts a bare path ("/start?from=selfie") or an absolute URL on `origin`.
 */
export function sanitizeWizardReturn(candidate, origin) {
	if (typeof candidate !== 'string' || !candidate) return null;
	const base = origin || (typeof location !== 'undefined' ? location.origin : 'https://three.ws');
	let url;
	try { url = new URL(candidate, base); } catch { return null; }
	if (url.origin !== base) return null;
	if (!/^\/start(\/|$)/.test(url.pathname)) return null;
	return url.pathname + url.search;
}

/**
 * Read `?next=` off the current URL, remember it when it is a valid wizard
 * return target, and strip `next` / `wizard` from the address bar so a reload
 * or a copied link does not re-arm the flow. Returns the stored path or null.
 */
export function captureWizardReturn({ url, storage, now = Date.now() } = {}) {
	const store = storageOf(storage);
	let current = url || null;
	if (!current) {
		// A page under test may stub location with a bare object; an unparsable
		// href means there is no query to capture, not a failure.
		try { current = typeof location !== 'undefined' ? new URL(location.href) : null; } catch { current = null; }
	}
	if (!current) return null;
	const next = sanitizeWizardReturn(current.searchParams.get('next'), current.origin);
	if (!next) return null;
	try { store?.setItem(WIZARD_RETURN_KEY, JSON.stringify({ next, at: now })); } catch {}
	if (!url && typeof history !== 'undefined') {
		const clean = new URL(current.href);
		clean.searchParams.delete('next');
		clean.searchParams.delete('wizard');
		history.replaceState(history.state, '', clean.pathname + clean.search + clean.hash);
	}
	return next;
}

/** The stored return path when one is present and fresh, otherwise null. */
export function pendingWizardReturn({ storage, now = Date.now() } = {}) {
	const store = storageOf(storage);
	let raw = null;
	try { raw = store?.getItem(WIZARD_RETURN_KEY) || null; } catch { return null; }
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed.next !== 'string') return null;
		if (typeof parsed.at === 'number' && now - parsed.at > WIZARD_RETURN_TTL_MS) {
			clearWizardReturn({ storage: store });
			return null;
		}
		return sanitizeWizardReturn(parsed.next);
	} catch {
		return null;
	}
}

export function clearWizardReturn({ storage } = {}) {
	try { storageOf(storage)?.removeItem(WIZARD_RETURN_KEY); } catch {}
}

/** Build the /start URL that hands a finished avatar back to the wizard. */
export function wizardReturnUrl(next, { avatarId, avatarName = '', avatarThumb = '' } = {}) {
	const origin = typeof location !== 'undefined' ? location.origin : 'https://three.ws';
	const url = new URL(next, origin);
	if (avatarId) url.searchParams.set('avatarId', String(avatarId));
	if (avatarName) url.searchParams.set('avatarName', String(avatarName).slice(0, 100));
	if (avatarThumb) url.searchParams.set('avatarThumb', String(avatarThumb));
	return url.pathname + url.search;
}

/**
 * Hand the avatar back to the wizard and forget the return address. Returns
 * false (and navigates nowhere) when no return is pending, so callers can fall
 * through to their normal post-save destination.
 */
export function returnToWizard(details, { storage } = {}) {
	const next = pendingWizardReturn({ storage });
	if (!next) return false;
	clearWizardReturn({ storage });
	location.href = wizardReturnUrl(next, details);
	return true;
}
