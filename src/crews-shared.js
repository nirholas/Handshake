// Pure crew helpers shared by the Crew HQ page and its tests.
//
// Split out of crews-page.js because that module boots itself on import (it is
// a page entry point, not a library). Everything here is deterministic and
// DOM-free, so the rules that decide what a visitor reads can be pinned by a
// test instead of by looking at the page.

// Tag grammar, mirroring normalizeTag() in api/_lib/crews-store.js.
export const TAG_RE = /^[A-Z0-9]{2,6}$/;

// Kept in sync with RESERVED_TAGS in api/_lib/crews-store.js. Duplicated rather
// than fetched so the founding form can say "reserved" as you type instead of
// after a round trip; the server remains the authority and rejects it anyway.
// tests/crews-store.test.js asserts the two lists never drift.
export const RESERVED_TAGS = new Set(['SEARCH', 'INDEX', 'API', 'ADMIN', 'NEW', 'ME', 'ALL', 'NULL']);

// What the tag input accepts as you type: uppercase, letters and digits only.
export function sanitizeTag(raw) {
	return String(raw || '')
		.trim()
		.toUpperCase()
		.replace(/[^A-Z0-9]/g, '');
}

// The founding form's verdict on a tag. Returns the sentence the user reads and
// the tone it reads in, so the message and the submit-enabled state can never
// disagree: `ok` is the single source for both.
export function validateTag(raw) {
	const tag = sanitizeTag(raw);
	if (!tag) {
		return {
			tag,
			ok: false,
			tone: '',
			message: '2 to 6 letters or digits. This is the badge worn over your avatar in world.',
		};
	}
	if (tag.length < 2) return { tag, ok: false, tone: 'bad', message: 'A tag needs at least 2 characters.' };
	if (!TAG_RE.test(tag)) return { tag, ok: false, tone: 'bad', message: 'A tag is at most 6 characters.' };
	if (RESERVED_TAGS.has(tag)) return { tag, ok: false, tone: 'bad', message: `${tag} is reserved by the site.` };
	return { tag, ok: true, tone: 'good', message: `${tag} looks good.` };
}

// A crew's colour is derived from its tag (FNV-1a), so it is stable everywhere
// the crew appears (room, directory, share card) without anyone picking or
// storing one. The second hue is a fixed rotation away, which keeps every crest
// gradient legible rather than letting two random hues collide.
export function crestHues(tag) {
	let h = 2166136261;
	for (const ch of String(tag || '')) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 16777619) >>> 0;
	}
	const hue = h % 360;
	return { hue, hue2: (hue + 58) % 360 };
}

// Presence wording, matching src/game/friends-panel.js so the same person reads
// the same in the drawer and in the HQ.
export function realmLabel(realm, server) {
	if (!realm) return '';
	const r = String(realm)
		.replace(/[_-]+/g, ' ')
		.replace(/\b\w/g, (c) => c.toUpperCase());
	return server ? `${r} · Server ${server}` : r;
}

export function presenceLine(member) {
	if (!member?.online) return 'Offline';
	const where = realmLabel(member.realm, member.server);
	return where ? `In ${where}` : 'Online';
}

// The tag in /crews/<TAG>, or '' for the personal HQ at /crews.
export function tagFromPath(pathname) {
	const m = String(pathname || '').match(/^\/crews\/([A-Za-z0-9]{2,6})\/?$/);
	return m ? m[1].toUpperCase() : '';
}
