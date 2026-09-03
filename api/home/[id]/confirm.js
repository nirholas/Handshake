/**
 * POST /api/home/:id/confirm: a human says yes to a physical action.
 *
 * This is the other half of the confirmation protocol in
 * api/_lib/home/tools.js, and it is deliberately the narrowest endpoint on the
 * platform. A model asked to unlock a door gets a `pending_confirmation` back
 * from its tool call; a person redeems it here. Between those two moments the
 * door does not move.
 *
 * What makes that true, and what a reviewer should check first:
 *
 *   1. **No bearer, ever.** An OAuth or API-key principal is refused before
 *      anything else runs, even one carrying `home:act`. `home:act` authorises
 *      asking; it never authorises answering. An MCP client, a chat model, and a
 *      background agent all reach this platform as bearer principals, so this
 *      single check is what keeps every one of them out of the confirm path.
 *   2. **Session plus CSRF.** A browser cookie alone is not intent; a cookie
 *      that a third-party page can make the browser send is exactly the shape of
 *      "a website unlocked my front door".
 *   3. **The id is the whole request.** No domain, no service, no entity, no
 *      `confirmed`. The action was frozen server-side when the confirmation was
 *      minted, and it is read back from that row. There is nothing here for a
 *      caller to steer.
 *
 * GET on the same path lists what is currently waiting, so a chat card or a
 * voice prompt that lost its state can recover it without minting anything new.
 */

import { getSessionUser, extractBearer } from '../../_lib/auth.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { claimConfirmation, expireStaleConfirmations, finalizeConfirmation, listPendingConfirmations } from '../../_lib/home/confirm.js';
import { listMembers, requireMembership } from '../../_lib/home/members.js';
import { withHome } from '../../_lib/home/runtime.js';
import { logHomeActionNow } from '../../_lib/home/store.js';
import { cors, error, json, method, readJson, rateLimited, wrap } from '../../_lib/http.js';
import { limits } from '../../_lib/rate-limit.js';
import { isUuid } from '../../_lib/validate.js';

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// (1) Bearer principals are refused before authentication, not after, so the
	// refusal cannot depend on a scope check somewhere else being right.
	if (extractBearer(req)) {
		return error(
			res,
			403,
			'confirmation_requires_session',
			'A confirmation can only be approved by a signed-in person in a browser session. A bearer token, including one holding home:act, can ask for a confirmation and can never satisfy one.',
		);
	}

	const session = await getSessionUser(req, res);
	if (!session) {
		return error(res, 401, 'unauthorized', 'Sign in to approve a home action.');
	}

	const homeId = homeIdFrom(req);
	if (!isUuid(homeId)) return error(res, 404, 'not_found', 'home not found');

	const capability = req.method === 'GET' ? 'read' : 'confirm';
	const access = await requireMembership(homeId, session.id, capability);
	if (!access.ok) {
		// 404 for a non-member: a stranger must not learn that a home id is real.
		// 403 for a member whose role cannot confirm, because a guest refused an
		// unlock deserves to be told it is their role and not a broken door.
		return access.status === 404
			? error(res, 404, 'not_found', 'home not found')
			: error(res, 403, 'role_forbidden', `The ${access.role} role in this home cannot approve a guarded action.`);
	}

	if (req.method === 'GET') {
		await expireStaleConfirmations({ homeId }).catch(() => 0);
		const pending = await listPendingConfirmations({ homeId, userId: session.id });
		return json(res, 200, { home_id: homeId, pending });
	}

	// (2) A cookie is not intent. CSRF is required and is not waivable here: the
	// bearer exemption inside requireCsrf is unreachable because a bearer request
	// was already refused above.
	if (!(await requireCsrf(req, res, session.id))) return;

	const rl = await limits.homeConfirm(session.id);
	if (!rl.success) return rateLimited(res, rl, 'too many confirmations, slow down');

	// (3) The id is the whole request. Anything else in the body is ignored on
	// purpose rather than validated away, because there is no field a caller
	// could send that should influence what runs.
	const body = await readJson(req).catch(() => ({}));
	const confirmationId = String(body?.confirmation_id || '').trim();
	if (!isUuid(confirmationId)) {
		return error(res, 400, 'bad_request', 'confirmation_id must be the id of a pending confirmation.');
	}

	const claim = await claimConfirmation({ id: confirmationId, homeId, userId: session.id });
	if (!claim.ok) {
		const status = claim.reason === 'not_found' ? 404 : 410;
		return error(res, status, `confirmation_${claim.reason}`, claim.message, {
			confirmation_id: confirmationId,
			...(claim.confirmation ? { summary: claim.confirmation.summary } : {}),
		});
	}

	const action = claim.confirmation;
	const ownerId = await ownerOf(homeId);
	if (!ownerId) return error(res, 404, 'not_found', 'home not found');

	try {
		// `confirmed: true` is set exactly here, on a server holding a redeemed
		// row, one statement after a human's session cleared CSRF. It is set
		// nowhere else in the platform and it is never derived from model output.
		await withHome(homeId, ownerId, (bridge) =>
			bridge.call(action.domain, action.service, action.service_data, { confirmed: true }),
		);
	} catch (err) {
		await finalizeConfirmation(action.id, 'failed');
		await logHomeActionNow({
			homeId,
			userId: session.id,
			actor: 'user',
			channel: 'websocket',
			action: `${action.domain}.${action.service}`,
			entityIds: action.entity_ids,
			guarded: true,
			confirmedBy: session.id,
			risk: action.risk,
			outcome: 'failed',
			detail: { reason: String(err?.message || err).slice(0, 300), code: err?.code || null, confirmation_id: action.id },
		});
		return error(
			res,
			err?.code === 'unreachable' || err?.code === 'not_connected' ? 503 : 502,
			err?.code || 'call_failed',
			`You approved it, but the home did not carry it out: ${String(err?.message || err).slice(0, 300)}`,
			{ confirmation_id: action.id },
		);
	}

	await finalizeConfirmation(action.id, 'ok');
	await logHomeActionNow({
		homeId,
		userId: session.id,
		actor: 'user',
		channel: 'websocket',
		action: `${action.domain}.${action.service}`,
		entityIds: action.entity_ids,
		guarded: true,
		confirmedBy: session.id,
		risk: action.risk,
		outcome: 'ok',
		detail: { confirmation_id: action.id, source: action.source },
	});

	// Sweep on the way out: an expiry earns a log row, and this is the one place
	// the feature is guaranteed to be in use.
	expireStaleConfirmations({ homeId }).catch(() => 0);

	return json(res, 200, {
		ok: true,
		home_id: homeId,
		confirmation: { id: action.id, summary: action.summary, risk: action.risk },
		ran: `${action.domain}.${action.service}`,
		entity_ids: action.entity_ids,
	});
});

/** Who holds this home's credential. Membership grants the capability; the token belongs to the owner. */
async function ownerOf(homeId) {
	const members = await listMembers(homeId);
	return members.find((m) => m.role === 'owner')?.userId || null;
}

function homeIdFrom(req) {
	if (req.query?.id) return String(req.query.id);
	const parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean);
	return parts[2] || '';
}
