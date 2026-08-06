// @ts-check
// GET /api/cron/forge-off-crown: crown the weekly Forge-Off winner.
//
// The Forge-Off board (the "Top this week" ordering of the forge showcase) ranks
// public creations by community vote_count over the current Monday→Monday UTC
// week. When a week completes, its top-voted creation is permanent: this cron
// writes one forge_board_winners row for the just-finished week so the hall of
// fame is stable even after later votes reshuffle the live board.
//
// It is also the writer the Sketchfab showcase cron (api/cron/sketchfab-showcase)
// has been waiting on: that job's strongest candidate tier reads
// forge_board_winners, so until this cron runs the tier is empty and the
// distribution pipeline falls back to raw vote/accepted signals. Crowning
// un-starves it.
//
// Winner definition mirrors the live board exactly (listShowcase sort='top'
// window='week'): highest vote_count among creations CREATED in the week, with
// at least one real vote. A week with zero votes crowns nobody (no filler).
//
// Idempotent and permanent: the first crowning for a week_start wins and is
// never overwritten (ON CONFLICT DO NOTHING), so a re-run or a late vote can't
// rewrite history. `?week=YYYY-MM-DD` crowns a specific past week (owner
// backfill); `?dry_run=1` previews the pick without writing.
//
// Runs Monday 00:07 UTC (just after the week rolls over). Auth: CRON_SECRET.

import { json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { forgeOffWeekStart, forgeStoreEnabled } from '../_lib/forge-store.js';
import { requireCron } from '../_lib/cron-auth.js';

// The Monday that starts the week we are crowning. Default: the week that just
// completed (the previous Monday relative to now). `weekParam` (YYYY-MM-DD)
// overrides for backfills — it is snapped to its own week's Monday so a mid-week
// date still resolves to a valid week boundary.
function resolveWeekStart(weekParam) {
	if (weekParam) {
		const t = Date.parse(`${weekParam}T00:00:00Z`);
		if (Number.isFinite(t)) return forgeOffWeekStart(new Date(t));
	}
	const thisWeek = forgeOffWeekStart();
	const prev = new Date(thisWeek);
	prev.setUTCDate(prev.getUTCDate() - 7);
	return prev;
}

// YYYY-MM-DD (UTC) — the DATE primary key for forge_board_winners.
function toDateKey(d) {
	return d.toISOString().slice(0, 10);
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET'])) return;
	if (!requireCron(req, res)) return;

	if (!forgeStoreEnabled()) {
		return json(res, 200, { ok: false, reason: 'persistence_unconfigured' });
	}

	const url = new URL(req.url || '/', 'https://three.ws');
	const dryRun = url.searchParams.get('dry_run') === '1';
	const weekStart = resolveWeekStart(url.searchParams.get('week'));
	const weekKey = toDateKey(weekStart);
	const weekEnd = new Date(weekStart);
	weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

	// Top-voted public creation made during the week, at least one vote.
	const rows = await sql`
		select id, prompt, glb_url, preview_image_url, model_category, vote_count
		from forge_creations
		where status = 'done' and glb_url is not null
			and (outcome is null or outcome != 'rejected')
			and created_at >= ${weekStart.toISOString()}::timestamptz
			and created_at < ${weekEnd.toISOString()}::timestamptz
			and vote_count >= 1
		order by vote_count desc, created_at desc
		limit 1
	`;
	const winner = rows[0] || null;

	if (!winner) {
		return json(res, 200, {
			ok: true,
			week_start: weekKey,
			crowned: false,
			reason: 'no_votes_this_week',
		});
	}

	if (dryRun) {
		return json(res, 200, {
			ok: true,
			dry_run: true,
			week_start: weekKey,
			winner: {
				creation_id: winner.id,
				votes: Number(winner.vote_count) || 0,
				prompt: winner.prompt,
			},
		});
	}

	// First crowning for the week wins and is permanent — a re-run or a later
	// vote shuffle never rewrites it.
	const inserted = await sql`
		insert into forge_board_winners
			(week_start, creation_id, votes, prompt, glb_url, preview_image_url, model_category)
		values (
			${weekKey}, ${winner.id}, ${Number(winner.vote_count) || 0}, ${winner.prompt},
			${winner.glb_url}, ${winner.preview_image_url}, ${winner.model_category || 'other'}
		)
		on conflict (week_start) do nothing
		returning week_start
	`;

	return json(res, 200, {
		ok: true,
		week_start: weekKey,
		crowned: inserted.length > 0,
		already_crowned: inserted.length === 0,
		winner: {
			creation_id: winner.id,
			votes: Number(winner.vote_count) || 0,
			prompt: winner.prompt,
		},
	});
});
