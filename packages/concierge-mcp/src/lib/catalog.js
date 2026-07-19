// The concierge avatar catalog, mirrored from @three-ws/concierge (the SDK's
// src/catalog.js). Kept as a small static list so concierge_avatars answers
// offline with zero dependencies; the GLBs themselves are served from the
// three.ws origin. Keep this in sync with the SDK catalog when it changes.

export const AVATARS = [
	{ id: 'sol', name: 'Sol', tagline: 'Calm, clear product guide', style: 'realistic', framing: 'bust' },
	{ id: 'nova', name: 'Nova', tagline: 'Upbeat, friendly host', style: 'stylized', framing: 'upper' },
	{ id: 'vera', name: 'Vera', tagline: 'Composed, professional', style: 'realistic', framing: 'bust' },
	{ id: 'atlas', name: 'Atlas', tagline: 'Confident, grounded', style: 'realistic', framing: 'bust' },
	{ id: 'echo', name: 'Echo', tagline: 'Neutral, even-keeled', style: 'stylized', framing: 'upper' },
];

export const DEFAULT_AVATAR_ID = 'sol';

export function isKnownAvatar(id) {
	return AVATARS.some((a) => a.id === id);
}
