// Pure draft helpers for the create-agent wizard.
//
// Kept separate from create-agent.js (which is DOM-bound and boots on import) so
// the two bits of real logic — "is there anything worth saving?" and "is this
// draft still fresh?" — can be unit-tested without a browser. The localStorage
// read/write wrappers stay in create-agent.js and lean on these.

// A draft older than this is stale: don't resurrect a build the visitor
// abandoned a week ago; start them fresh instead.
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// True once the wizard holds anything worth preserving. Guards autosave so an
// untouched form never writes an empty draft that would then "resume". Mirrors
// the wizard's default model mode ('starter' with no pick = untouched).
export function draftHasContent(state) {
	if (!state) return false;
	const s = (v) => (typeof v === 'string' ? v.trim() : '');
	return Boolean(
		s(state.name) ||
			s(state.description) ||
			(Array.isArray(state.tags) && state.tags.length) ||
			s(state.greeting) ||
			s(state.persona) ||
			state.category ||
			(state.model && state.model.mode !== 'starter') ||
			(state.model && state.model.starterId),
	);
}

// A draft with no timestamp (older format) is treated as fresh; one past the TTL
// is stale. `now` is injectable so tests never depend on the wall clock.
export function isDraftFresh(draft, now = Date.now()) {
	if (!draft || typeof draft.savedAt !== 'number') return true;
	return now - draft.savedAt <= DRAFT_TTL_MS;
}
