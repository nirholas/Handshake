// Unattended-completion notifications for forge generations.
//
// Called ONLY from the server-side finalizer (api/cron/forge-finalize.js) -
// i.e. exactly when a generation finished while the creator was away from the
// page. The attended browser-poll path never notifies: the result is already
// on screen, and a push/email about it would be noise.
//
// Channels ride the standard preference-gated fan-out: insertNotification
// handles the bell inbox + Web Push; email goes out here when the user's
// 'creations' category has email enabled (the default: an unattended finish
// is precisely the moment email earns its keep). All best-effort: a delivery
// failure never touches the creation row.
//
// Developer webhooks are the one channel that does NOT follow the attended /
// unattended split. `forge.completed` fires from materializeCreation, the
// universal completion writer, so an API integrator learns every outcome
// whether or not a browser was watching; only `forge.failed` lives here,
// because this is the sole place that distinguishes a terminal failure from a
// failover that is still running. See docs/api-reference.md.

import { sql } from './db.js';
import { insertNotification, emailAllowedForType } from './notify.js';
import { sendForgeCompleteEmail } from './email.js';
import { dispatchWebhooks } from './webhook-dispatch.js';

// Real, sendable email for a user. Skips missing addresses and the synthetic
// `…@privy.local` placeholders minted for wallet-only Privy accounts.
async function deliverableEmail(userId) {
	if (!userId) return null;
	try {
		const [row] = await sql`select email from users where id = ${userId} and deleted_at is null`;
		const email = row?.email;
		if (!email || /@privy\.local$/i.test(email)) return null;
		return email;
	} catch {
		return null;
	}
}

export function notifyForgeComplete({ userId, creationId, prompt, previewImageUrl }) {
	return deliverComplete({ userId, creationId, prompt, previewImageUrl }).catch((err) => {
		console.error('[forge-notify] complete delivery failed:', err?.message);
	});
}

async function deliverComplete({ userId, creationId, prompt, previewImageUrl }) {
	if (!userId || !creationId) return;
	const link = `/forge?share=${encodeURIComponent(creationId)}`;
	await insertNotification(userId, 'forge_complete', {
		prompt: prompt || null,
		creation_id: creationId,
		preview_image_url: previewImageUrl || null,
		link,
	});
	if (await emailAllowedForType(userId, 'forge_complete')) {
		const to = await deliverableEmail(userId);
		if (to) {
			sendForgeCompleteEmail({ to, prompt, creationPath: link, previewImageUrl }).catch(() => {});
		}
	}
}

export function notifyForgeFailed({ userId, creationId = null, prompt, error, backend = null, tier = null }) {
	if (!userId) return Promise.resolve();
	// The `forge.failed` webhook fires from here rather than from markFailed,
	// because markFailed also runs on the failover path: a row that failed on one
	// lane and was redispatched to another is marked failed and immediately
	// superseded, and telling an integrator that job died while it is still
	// running would be a lie. The finalizer calls this function only when nothing
	// is left to try, which is exactly the terminal signal a subscriber wants.
	dispatchWebhooks({
		userId,
		eventType: 'forge.failed',
		data: {
			id: creationId,
			status: 'failed',
			prompt: prompt || null,
			error: error ? String(error).slice(0, 200) : null,
			backend,
			tier,
		},
	}).catch(() => {});
	// Bell + push only: a failure email for a free generation would be noise.
	return insertNotification(userId, 'forge_failed', {
		prompt: prompt || null,
		error: error ? String(error).slice(0, 200) : null,
		link: '/forge',
	});
}
