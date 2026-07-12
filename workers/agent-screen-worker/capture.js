
let lastScreenshotAt = 0;

/**
 * Push a frame (screenshot + activity text) to /api/agent-screen-push.
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {import('playwright').Page|null} opts.page  — null for text-only pushes
 * @param {string} opts.activity                      — human-readable narration
 * @param {string} [opts.type]                        — screenshot | activity | trade | analysis
 * @param {string} opts.pushUrl
 * @param {string} opts.agentJwt
 * @param {number} [opts.screenshotIntervalMs]        — min ms between full screenshots
 */
export async function pushFrame({
	agentId,
	page,
	activity,
	type = 'screenshot',
	pushUrl,
	agentJwt,
	screenshotIntervalMs = 5_000,
}) {
	let data = null;
	const now = Date.now();
	const wantScreenshot = type !== 'activity' && page !== null;
	const screenshotDue = now - lastScreenshotAt >= screenshotIntervalMs;

	if (wantScreenshot && screenshotDue) {
		try {
			const buf = await page.screenshot({ type: 'png', fullPage: false });
			data = 'data:image/png;base64,' + buf.toString('base64');
			lastScreenshotAt = now;
		} catch (err) {
			console.warn('[capture] screenshot failed:', err.message);
			type = 'activity';
		}
	} else if (wantScreenshot && !screenshotDue) {
		// Throttled — send as activity-only so the log still updates
		type = 'activity';
	}

	const body = { agentId, frame: { data, activity, type } };

	try {
		const res = await fetch(pushUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${agentJwt}`,
			},
			body: JSON.stringify(body),
			// 10 s timeout — worker should not stall on a slow push
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			console.warn(`[capture] push failed ${res.status}: ${text.slice(0, 120)}`);
		}
	} catch (err) {
		console.warn('[capture] push error:', err.message);
	}
}
