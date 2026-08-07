// Event leaderboard — the pure ranking math behind the live event quest line.
//
// The event jobs (quests.js, `event: true`) pay in ordinary in-world gold; this is
// the standing that says who ran the most of them inside the window. Like
// war-standings.js it is dependency-free and side-effect-free: a record in, a
// ranked table out. The durable store (api/_lib/event-leaderboard-store.js) and the
// read endpoint (api/play/event-leaderboard.js) both fold their rows through THESE
// functions, so the panel a player sees in-world and the JSON the web reads can
// never rank the same data two different ways.
//
// Ranking, in order:
//   1. runs   — event quests completed inside the window (the headline)
//   2. cash   — total event gold earned (the tiebreak: harder jobs pay more)
//   3. lastAt — earliest to reach that score wins (a tie broken by the clock is
//               fairer than one broken by an id, and it rewards finishing early)
//   4. account — a stable last resort so the order is total and reproducible
//
// Prizes are NOT paid here or anywhere in code. The board ranks; the owner settles
// after the event.

// How many rows the in-world panel and the public read endpoint show by default.
export const TOP_LIMIT = 10;

// A zeroed record for one player. `name` is the display name at the time of their
// most recent run, so a rename during the event shows the newest one.
export function emptyEventRecord(account, name = '') {
	return {
		account: String(account || ''),
		name: String(name || '').slice(0, 24),
		runs: 0,
		cash: 0,
		lastAt: 0,
		missions: {},
	};
}

// Fold one finished event quest into a record, mutating and returning it. Every
// value is clamped here rather than at the call sites, so a malformed report can
// dirty a row but never poison the ranking with NaN or a negative score.
export function applyEventRun(rec, { missionId = '', gold = 0, at = 0, name = '' } = {}) {
	rec.runs = Math.max(0, (rec.runs | 0) + 1);
	rec.cash = Math.max(0, (rec.cash | 0) + Math.max(0, Math.round(Number(gold) || 0)));
	const ts = Math.max(0, Math.round(Number(at) || 0));
	if (ts > rec.lastAt) rec.lastAt = ts;
	if (name) rec.name = String(name).slice(0, 24);
	const id = String(missionId || '').slice(0, 64);
	if (id) rec.missions[id] = (rec.missions[id] | 0) + 1;
	return rec;
}

// Normalize a persisted/transported row back into a full record. Tolerant of
// partial and legacy blobs — a corrupt row degrades to a zeroed one rather than
// throwing inside a read that the whole panel depends on.
export function normalizeEventRecord(row, account = '') {
	const rec = emptyEventRecord(row?.account || account, row?.name || '');
	rec.runs = Math.max(0, Number(row?.runs) | 0);
	rec.cash = Math.max(0, Number(row?.cash) | 0);
	rec.lastAt = Math.max(0, Number(row?.lastAt) | 0);
	if (row?.missions && typeof row.missions === 'object') {
		for (const [id, n] of Object.entries(row.missions)) {
			const count = Number(n) | 0;
			if (count > 0) rec.missions[String(id).slice(0, 64)] = count;
		}
	}
	return rec;
}

// Sort records into the ranked, rank-stamped array both surfaces render. Records
// with zero runs are dropped: the board is "who ran the event", not "who logged in".
export function rankEventBoard(records = []) {
	const rows = records
		.map((r) => normalizeEventRecord(r))
		.filter((r) => r.account && r.runs > 0);
	rows.sort((a, b) =>
		b.runs - a.runs
		|| b.cash - a.cash
		|| a.lastAt - b.lastAt
		|| a.account.localeCompare(b.account));
	rows.forEach((row, i) => { row.rank = i + 1; });
	return rows;
}

// One row shaped for the wire: the account id itself never leaves the server (it is
// a wallet address or a guest key), only its rank, display name and score.
function publicRow(row) {
	return {
		rank: row.rank,
		name: row.name || 'Anonymous',
		runs: row.runs,
		cash: row.cash,
		lastAt: row.lastAt,
	};
}

// The payload the in-world panel and the read endpoint both serve: the top N, the
// requesting player's own row (pinned, whatever their rank), and the totals that let
// a UI say "12 of 41 runners" without a second call. `account` may be omitted for an
// anonymous read (the web page) — `you` is then null.
export function eventBoardView(records = [], { account = '', limit = TOP_LIMIT } = {}) {
	const ranked = rankEventBoard(records);
	const cap = Math.max(1, Math.min(100, limit | 0 || TOP_LIMIT));
	const mine = account ? ranked.find((r) => r.account === account) : null;
	return {
		top: ranked.slice(0, cap).map(publicRow),
		you: mine ? { ...publicRow(mine), inTop: mine.rank <= cap } : null,
		players: ranked.length,
		totalRuns: ranked.reduce((sum, r) => sum + r.runs, 0),
	};
}
