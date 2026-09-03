// The disclosure copy, re-exported for the server.
//
// The strings themselves live in src/shared/home-disclosure.js, because the two
// places they have to appear are a browser screen (the connect form, the voice
// opt-in) and a server response (GET /api/home/privacy, which serves them so a
// surface can render them without a second copy). A module under api/_lib is
// unreachable from a Vite bundle, so the canonical file has to sit in src/shared
// with the rest of the code both halves read.
//
// This file exists so every existing server-side importer keeps working and so
// `grep -rn disclosure api/_lib/home` still finds the lane's copy. It adds
// nothing and must never diverge: it is a re-export, not a second version.

export {
	CONNECT_DISCLOSURE,
	DISCLOSURES,
	VOICE_DISCLOSURE,
	disclosureById,
} from '../../../src/shared/home-disclosure.js';
