// GET /api/home/plan  what this account's plan covers, what it is using, when it resets
// POST /api/home/plan the two things a user does about it, and the one thing an admin does
//
// This is the surface behind commitment 3: a quota is SHOWN before it is hit.
// The GET returns every dimension whether or not it is anywhere near its
// ceiling, each with the measured cost that justifies metering it, so the page
// can explain a limit rather than merely enforce one.
//
// The POST carries commitment 2. When a plan change leaves an account with more
// connected homes than it covers, nothing is disconnected and nothing is
// deleted: the excess are PAUSED, and the user swaps which of their houses are
// live whenever they like. `pause` and `resume` are that swap. Both are
// reversible, neither touches a credential, and neither removes a row.
//
//   { action: 'preview'  }                     what a downgrade to the current limit would pause
//   { action: 'pause',  home_id }              pause one home
//   { action: 'resume', home_id }              bring one back, refused if it would exceed the limit
//   { action: 'override', user_id, limits, note }   admin only: the enterprise row
//
// A paused home still answers safety actions. Locking up, closing a garage or a
// valve and arming an alarm are never refused by a commercial limit, on any
// plan, in any state, and the response says so in words on the page.

import { requireAdmin } from '../_lib/admin.js';
import { requireCsrf } from '../_lib/csrf.js';
import { resolveCaller } from '../_lib/home/access.js';
import {
	applyDowngrade,
	clearAccountOverride,
	describeEntitlements,
	HomeQuotaError,
	planDowngrade,
	reactivateConnection,
	resolveHomeEntitlementsForUser,
	setAccountOverride,
} from '../_lib/home/entitlements.js';
import { readHomeUsage } from '../_lib/home/usage.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { limits as rateLimits } from '../_lib/rate-limit.js';
import { isUuid } from '../_lib/validate.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const caller = await resolveCaller(req, res);
	if (!caller) return error(res, 401, 'unauthorized', 'Sign in to see your home plan.');

	if (req.method === 'GET') return handleGet(req, res, caller);
	return handlePost(req, res, caller);
});

async function handleGet(req, res, caller) {
	const rl = await rateLimits.homeRead(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many plan reads, slow down');

	const [entitlements, usage] = await Promise.all([
		resolveHomeEntitlementsForUser(caller.userId),
		readHomeUsage(caller.userId),
	]);

	const homes = await listHomesForPlan(caller.userId);
	const view = describeEntitlements(entitlements, usage);

	return json(res, 200, {
		...view,
		homes,
		// What a downgrade to the CURRENT limit would pause. Zero on a healthy
		// account, and the whole explanation when a plan has just changed under
		// somebody, which is exactly when they open this page.
		downgrade: summarizeDowngrade(homes, entitlements.limits.homes),
	});
}

async function handlePost(req, res, caller) {
	if (!(await requireCsrf(req, res, caller.userId))) return;

	const rl = await rateLimits.homeAct(caller.userId);
	if (!rl.success) return rateLimited(res, rl, 'too many plan changes, slow down');

	const body = await readJson(req, 8_000).catch(() => null);
	const action = String(body?.action || '').toLowerCase();

	if (action === 'override') return handleOverride(req, res, body);

	if (action === 'preview') {
		const entitlements = await resolveHomeEntitlementsForUser(caller.userId);
		const homes = await listHomesForPlan(caller.userId);
		return json(res, 200, { downgrade: summarizeDowngrade(homes, entitlements.limits.homes), homes });
	}

	const homeId = String(body?.home_id || body?.homeId || '');
	if (!isUuid(homeId)) return error(res, 400, 'bad_request', 'home_id must be the id of one of your homes.');

	if (action === 'pause') {
		const paused = await applyDowngrade({
			userId: caller.userId,
			deactivateIds: [homeId],
			// Written in the user's own terms: they did this, and the page has to be
			// able to say so rather than blaming a plan for a choice they made.
			reason: 'You paused this home to make room for another one.',
		});
		if (!paused.length) return error(res, 404, 'not_found', 'No such home, or it is already paused.');
		return json(res, 200, { home: paused[0], homes: await listHomesForPlan(caller.userId) });
	}

	if (action === 'resume') {
		const entitlements = await resolveHomeEntitlementsForUser(caller.userId);
		try {
			const home = await reactivateConnection({ userId: caller.userId, homeId, entitlements });
			return json(res, 200, { home, homes: await listHomesForPlan(caller.userId) });
		} catch (err) {
			if (err instanceof HomeQuotaError) {
				return error(res, err.status, err.code, err.message, {
					code: err.code,
					quota: { dimension: err.dimension, label: err.dimensionLabel, limit: err.limit, used: err.used, upgrade: err.upgradePath },
				});
			}
			if (/no such home/.test(err?.message || '')) return error(res, 404, 'not_found', 'No such home.');
			throw err;
		}
	}

	return error(res, 400, 'bad_request', "action must be 'preview', 'pause', 'resume' or 'override'.");
}

/**
 * The enterprise row, set by an admin.
 *
 * Enterprise limits are configurable per account rather than hardcoded because
 * that is what the sales conversation is: a hotel buys 400 rooms and a year of
 * attribution, and the shape of that deal is known on the call and not at deploy
 * time. Sending `limits: {}` clears the override and returns the account to its
 * plan.
 */
async function handleOverride(req, res, body) {
	const admin = await requireAdmin(req, res);
	if (!admin) return;

	const userId = String(body?.user_id || body?.userId || '');
	if (!isUuid(userId)) return error(res, 400, 'bad_request', 'user_id is required.');

	const incoming = body?.limits && typeof body.limits === 'object' && !Array.isArray(body.limits) ? body.limits : null;
	if (!incoming) return error(res, 400, 'bad_request', 'limits must be an object of dimension to number or "unlimited".');

	if (Object.keys(incoming).length === 0) {
		await clearAccountOverride(userId);
		return json(res, 200, { cleared: true, entitlements: await resolveHomeEntitlementsForUser(userId) });
	}

	const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;
	const row = await setAccountOverride({ userId, limits: incoming, note, setBy: admin.id });
	const entitlements = await resolveHomeEntitlementsForUser(userId);
	return json(res, 200, { override: row, entitlements: { limits: entitlements.limits, sources: entitlements.sources } });
}

/**
 * The account's homes as the plan page needs them: label, when it was added, and
 * whether it is live or paused (and why). No credential, no capability dump.
 */
async function listHomesForPlan(userId) {
	return sql`
		select id, label, base_url, status, created_at, deactivated_at, deactivated_reason
		from home_connections
		where user_id = ${userId} and revoked_at is null
		order by created_at asc
	`;
}

function summarizeDowngrade(homes, limit) {
	const plan = planDowngrade(homes, limit);
	return {
		overBy: plan.overBy,
		limit: Number.isFinite(plan.limit) ? plan.limit : null,
		explanation: plan.explanation,
		wouldPause: plan.deactivate.map((h) => ({ id: h.id, label: h.label })),
	};
}
