// GET /api/play/event-leaderboard
//
// The live standing for the platform event's in-world quest line: who has completed
// the most event jobs inside the window, tiebroken by the event gold they earned.
// One read, two consumers, the in-world panel (the multiplayer room proxies this
// call for its clients) and the web event page, so the ranking a player sees at the
// jobs board is byte-for-byte the ranking the site shows.
//
// Query:
//   account   optional, a player's account key; pins their own row in `you`, even
//                        when they are outside the top N. Omitted for an anonymous
//                        web read.
//   limit     optional, how many rows to return (default 10, max 100).
//
// Scores are written only by the authoritative game server through
// api/internal/event-score.js; this endpoint is read-only and never grants anything.
// Prizes are NOT settled here: the board ranks, and the owner pays the winners
// manually after the event. Nothing in this path touches a wallet or a chain.
//
// Shape (always 200 when an event is configured, an event nobody has played yet is
// an empty board, not an error):
//   {
//     event: { id, name, startsAt, endsAt, live },
//     top: [{ rank, name, runs, cash, lastAt }],
//     you: { rank, name, runs, cash, lastAt, inTop } | null,
//     players, totalRuns, prizes: { settlement: 'manual', … }
//   }

import { cors, json, method, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { eventConfig } from '../_lib/event-config.js';
import { readEventRecords, isValidAccount } from '../_lib/event-leaderboard-store.js';
import { isEventLive } from '../../multiplayer/src/event-window.js';
import { eventBoardView, TOP_LIMIT } from '../../multiplayer/src/event-leaderboard.js';

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const now = Date.now();
	const event = eventConfig(now);
	if (!event) return error(res, 404, 'no_event', 'no event is configured');

	const url = new URL(req.url, 'http://localhost');
	const rawAccount = (url.searchParams.get('account') || '').trim();
	// An unparseable account is treated as an anonymous read rather than a 400: the
	// board itself is public, and refusing the whole page over one bad query param
	// would be a worse answer than serving the ranking without a pinned row.
	const account = isValidAccount(rawAccount) ? rawAccount : '';
	const limit = Number.parseInt(url.searchParams.get('limit') || '', 10) || TOP_LIMIT;

	const { records } = await readEventRecords(event.id);
	const view = eventBoardView(records, { account, limit });

	return json(res, 200, {
		event: {
			id: event.id,
			name: event.name,
			startsAt: new Date(event.startsAt).toISOString(),
			endsAt: new Date(event.endsAt).toISOString(),
			live: isEventLive(event, now),
		},
		...view,
		prizes: {
			settlement: 'manual',
			summary: 'Winners are announced from this board and settled by the three.ws team after the event. No prize is paid automatically.',
		},
	}, {
		// Live standings during an event: short edge cache so a refresh feels current
		// without every viewer hitting the store.
		'cache-control': 'public, max-age=5, s-maxage=10, stale-while-revalidate=60',
	});
});
