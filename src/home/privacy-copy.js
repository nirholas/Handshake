// The wording and the gates behind /smart-home/privacy, with no DOM in sight.
//
// Four small functions, separated from the screen for one reason each:
//
//   * statRows decides what a person sees FIRST on a page about their own data.
//     That is a product decision, not a rendering detail.
//   * describeWindow turns 90 into "Kept for 90 days" and 7 into "Kept for a
//     week". Wording that drifts is how a privacy screen starts lying quietly.
//   * phraseMatches is the only thing standing between a mis-click and a
//     permanent deletion. It belongs where it can be tested exhaustively.
//   * deletedSentence is the receipt. "Done" is not a receipt; the number of
//     rows that actually went is.
//
// Keeping them here also keeps src/home/privacy.js importable by a test without
// dragging a browser in, which is the difference between these being covered and
// being checked by eye.

/** The exact words somebody types to delete everything. Short, and not a yes. */
export const DELETE_ALL_PHRASE = 'delete everything';

/** Windows offered as one tap each. Any integer in range is accepted by the API. */
export const RETENTION_PRESETS = Object.freeze([
	{ days: 1, label: 'A day' },
	{ days: 7, label: 'A week' },
	{ days: 30, label: 'A month' },
	{ days: 90, label: '90 days' },
	{ days: 365, label: 'A year' },
]);

/**
 * The numbers worth putting at the top of the page.
 *
 * The last two rows are conditional on purpose: a column of zeroes teaches
 * somebody to stop reading, and most accounts have no satellite and no open
 * invitation. A stat that is always shown and always zero is noise.
 *
 * @param {{ homes?: Array<{revoked_at?: string|null}>, counts?: Record<string, number> }} data
 * @returns {Array<[string, number]>}
 */
export function statRows(data = {}) {
	const c = data.counts || {};
	const homes = (data.homes || []).filter((h) => !h.revoked_at).length;
	const rows = [
		['Homes connected', homes],
		['Actions logged', c.home_action_log_actor ?? 0],
		['Standing permissions', c.home_entity_grants ?? 0],
		['People with access', c.home_members ?? 0],
	];
	if (c.home_satellites) rows.push(['Voice satellites', c.home_satellites]);
	if (c.home_invites_sent) rows.push(['Invitations open', c.home_invites_sent]);
	return rows;
}

/**
 * A day count as a person would say it.
 * @param {number} days
 * @returns {string}
 */
export function describeWindow(days) {
	const n = Number(days);
	if (!Number.isFinite(n)) return 'Unknown';
	if (n === 1) return 'Kept for a day';
	if (n === 7) return 'Kept for a week';
	if (n === 30) return 'Kept for a month';
	if (n === 365) return 'Kept for a year';
	if (n >= 3650) return 'Kept for ten years';
	return `Kept for ${n} days`;
}

/**
 * Whether what somebody typed unlocks the irreversible button.
 *
 * Trimmed and case-folded, because a trailing space or a capital is a typo and
 * not a change of mind. Everything else fails, including "yes", "delete" and
 * "delete all": the point of a typed phrase is that it is a different gesture
 * from the click that opened the dialog.
 *
 * @param {string} typed
 * @returns {boolean}
 */
export function phraseMatches(typed) {
	return String(typed ?? '').trim().toLowerCase() === DELETE_ALL_PHRASE;
}

/**
 * What actually went, from the counts the API returned before it deleted them.
 * @param {Record<string, number>} [before]
 * @returns {string}
 */
export function deletedSentence(before = {}) {
	const parts = [];
	const say = (n, one, many) => {
		if (!n) return;
		parts.push(`${n} ${n === 1 ? one : many}`);
	};
	say(before.home_connections, 'home', 'homes');
	say(before.home_action_log ?? before.home_action_log_actor, 'logged action', 'logged actions');
	say(before.home_entity_grants, 'standing permission', 'standing permissions');
	say(before.home_members, 'household membership', 'household memberships');
	say(before.home_invites ?? before.home_invites_sent, 'invitation', 'invitations');
	say(before.home_confirmations, 'confirmation record', 'confirmation records');
	say(before.home_satellites, 'voice satellite', 'voice satellites');
	if (!parts.length) return 'There was nothing left to delete.';
	const last = parts.pop();
	return `${parts.length ? `${parts.join(', ')} and ${last}` : last} deleted.`;
}
