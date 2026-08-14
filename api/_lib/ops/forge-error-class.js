// @ts-check
// Forge failure classifier. Turns the free-text `forge_creations.error` column
// into a stable class you can count.
//
// The outcome ledger stores whatever the lane said, verbatim (markFailed clamps
// it to 500 chars and nothing else). That is the right thing to store: the raw
// message is the only forensic record of what a vendor or worker actually
// returned. It is the wrong thing to GROUP BY. Every message carries the
// specifics of its own failure (a prediction id, a task uuid, a signed URL, a
// byte count, a minute count), so 40 instances of one recurring failure count as
// 40 distinct "classes" and the ranking that should say "the self-host lane is
// losing its tasks" says nothing at all.
//
// The pre-aggregation the health sensor does in SQL (`split_part(error, ':', 1)`)
// is the cheap version of this and holds only while messages happen to lead with
// a stable prefix: `generation timed out after 41 minutes` and
// `generation timed out after 63 minutes` are already two reasons under it, and
// a bare vendor sentence with no colon becomes its own class every time.
//
// So: normalize first (strip the varying parts), then match a known class, and
// fall back to the normalized text rather than force-fitting. Same principle as
// forge-classify.js: high precision, honest 'other', no invented buckets.

/**
 * Lowercase and strip the unbounded identifiers (URLs, uuids, long hex/base58
 * ids) while KEEPING numbers. This is what the class patterns match against,
 * because the numbers are half the signal: `502`, `429`, `404` are the class.
 * @param {unknown} raw
 * @returns {string}
 */
function cleanForgeError(raw) {
	const text = String(raw ?? '').trim();
	if (!text) return '';
	return text
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, ' <url> ')
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
		.replace(/\b[0-9a-f]{16,}\b/g, '<id>')
		.replace(/\b[a-z0-9]{20,}\b/g, '<id>')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Strip the parts of a failure message that vary per occurrence, numbers
 * included, so two instances of the same failure normalize to one string. This
 * is the GROUPING key for messages no class recognizes: without it,
 * `generation timed out after 41 minutes` and the same failure 63 minutes later
 * are two rows in a frequency ranking that exists to collapse them.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeForgeError(raw) {
	const cleaned = cleanForgeError(raw);
	if (!cleaned) return '';
	return cleaned
		.replace(/\b\d+(\.\d+)?\s*(ms|s|sec|secs|seconds|m|min|mins|minutes|h|hours|mb|gb|kb|bytes)\b/g, '<n> $2')
		.replace(/\b\d+\b/g, '<n>')
		.replace(/\s+/g, ' ')
		.trim();
}

// Ordered most-specific first: the first pattern that matches wins, so
// "task not found" reads as a lost self-host task rather than a generic 404.
/** @type {Array<{ id: string, label: string, test: RegExp }>} */
const CLASSES = [
	{ id: 'timeout', label: 'timed out before the lane returned', test: /\btimed out\b|\btimeout\b|deadline exceeded|etimedout/ },
	// The two dominant real shapes both mean "the lane lost the job", and both
	// used to land elsewhere: the self-host workers' own orphan reaper wording
	// (workers/model-*/main.py) fell through to `other`, and NVIDIA's
	// "NVCF request not found or expired" read as a generic 404. Measured on
	// 2026-08-14 they were 19 of the prior week's 23 failures.
	{ id: 'lost_task', label: 'lane lost the task (poll found nothing)', test: /task not found|prediction not found|job not found|request not found|unknown task|no such task|missing task|orphaned/ },
	{ id: 'aborted', label: 'request aborted mid-flight', test: /\baborted\b|abortsignal|operation was canceled|canceled by (the )?client/ },
	{ id: 'out_of_memory', label: 'worker ran out of memory', test: /out of memory|\boom\b|cuda out of memory|killed \(signal 9\)|exit 144/ },
	{ id: 'rate_limited', label: 'lane rate limited or over quota', test: /rate limit|too many requests|\b429\b|quota exceeded|over quota/ },
	{ id: 'payment_required', label: 'lane refused on billing or credits', test: /\b402\b|payment required|insufficient (credit|funds)|billing/ },
	{ id: 'unauthorized', label: 'lane rejected our credentials', test: /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication failed/ },
	{ id: 'upstream_5xx', label: 'lane returned a server error', test: /\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/ },
	{ id: 'not_found_4xx', label: 'lane returned not found', test: /\b404\b|\b410\b|not found|gone/ },
	{ id: 'network', label: 'network failure reaching the lane', test: /econnreset|econnrefused|enotfound|socket hang up|network error|fetch failed|dns/ },
	{ id: 'bad_input_image', label: 'reference image rejected', test: /image (is )?(too large|invalid|unusable|not usable)|invalid image|unsupported image|no face|cannot decode image/ },
	{ id: 'bad_output_mesh', label: 'produced mesh was unusable', test: /invalid glb|empty mesh|no mesh|mesh (is )?(invalid|empty)|glb (is )?(invalid|empty|too large)|zero bytes/ },
	{ id: 'content_filtered', label: 'prompt or image blocked by a content filter', test: /content (policy|filter)|nsfw|safety (system|filter)|flagged/ },
	{ id: 'storage', label: 'could not persist the artifact', test: /\bs3\b|object storage|upload failed|bucket|access ?denied .*key/ },
	{ id: 'generic_failure', label: 'lane failed without saying why', test: /^generation failed$|^failed$|^error$|^unknown error$/ },
];

/**
 * Classify one `forge_creations.error` value into a stable class.
 *
 * Returns `{ id: 'other', label: <normalized message> }` when nothing matches,
 * so an unrecognized failure still groups with its own kind (identical messages
 * share a normalized form) instead of being force-fit into a named class.
 * An empty/absent message classifies as `none`.
 * @param {unknown} raw
 * @returns {{ id: string, label: string, normalized: string }}
 */
export function classifyForgeError(raw) {
	const cleaned = cleanForgeError(raw);
	if (!cleaned) return { id: 'none', label: 'no error recorded', normalized: '' };
	const normalized = normalizeForgeError(raw);
	for (const c of CLASSES) {
		if (c.test.test(cleaned)) return { id: c.id, label: c.label, normalized };
	}
	return { id: 'other', label: normalized.slice(0, 80), normalized };
}

/** Every named class id, in match order. Consumers use it to render a full table. */
export const FORGE_ERROR_CLASS_IDS = CLASSES.map((c) => c.id);
