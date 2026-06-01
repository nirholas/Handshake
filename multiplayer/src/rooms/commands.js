// Chat slash-command registry + router (Task 13).
//
// Single source of truth for the documented player commands. GameRoom._handleChat
// forwards any chat line that begins with '/' to runCommand(), which parses the
// command + args, resolves the name (or an alias), validates it exists, and
// dispatches to its handler — returning a result the caller sees as a system
// message. Unknown commands return a helpful error with a "did you mean" hint.
//
// /help is GENERATED from this registry, so it can never drift from the real
// command set. /who reads the live realm roster (state.players). The stateful
// actions (pickup/lock/unlock/dismount) live on the GameRoom because they mutate
// synced state; the registry invokes them through ctx.room so the room stays the
// single authority over mutation.
//
//   ctx = { room, client, player }
//   handler(ctx, args) -> { text, kind } | string | null
//     null  → the handler already sent its own reply (e.g. /dismount's notice);
//             the router sends nothing further.
//   kind   → styles the client bubble: 'info' (default) | 'error' | 'help' | 'who'.

export const COMMANDS = [
	{
		name: 'help',
		aliases: ['commands', 'h', '?'],
		args: '',
		desc: 'List the commands you can use',
		run: () => ({ text: formatHelp(), kind: 'help' }),
	},
	{
		name: 'who',
		aliases: ['players', 'online'],
		args: '',
		desc: 'List the players in your realm',
		run: (ctx) => ({ text: formatWho(ctx), kind: 'who' }),
	},
	{
		name: 'pickup',
		aliases: ['take'],
		args: '',
		desc: 'Pick up your firepit or shack you are standing beside',
		run: (ctx) => ctx.room.pickupStructure(ctx.player),
	},
	{
		name: 'lock',
		aliases: [],
		args: '',
		desc: 'Lock the structure beside you against stray clicks',
		run: (ctx) => ctx.room.setStructureLock(ctx.player, true),
	},
	{
		name: 'unlock',
		aliases: [],
		args: '',
		desc: 'Unlock the structure beside you',
		run: (ctx) => ctx.room.setStructureLock(ctx.player, false),
	},
	{
		name: 'dismount',
		aliases: ['unmount'],
		args: '',
		desc: 'Climb down from your mount',
		// Reuse the room's dismount action (shared with the dismount button); it
		// sends its own notice, so the router adds no second reply.
		run: (ctx) => { ctx.room._handleDismount(ctx.client); return null; },
	},
];

// Client-facing manifest of the registry: just the data the chat autocomplete
// needs (signature + aliases + description), never the server-side `run`
// handlers. Sent once on join so the client hint list is the SAME source of
// truth as /help — it can never drift from the real command set.
export function commandManifest() {
	return COMMANDS.map((c) => ({
		name: c.name,
		args: c.args || '',
		aliases: c.aliases.slice(),
		desc: c.desc,
	}));
}

// Resolve a name or alias (case-insensitive) to its command, or null.
function resolve(name) {
	const n = String(name || '').toLowerCase();
	return COMMANDS.find((c) => c.name === n || c.aliases.includes(n)) || null;
}

// Nearest command for a "did you mean" hint on a typo. Small registry, so a plain
// Levenshtein over the names is more than fast enough.
function suggest(name) {
	const n = String(name || '').toLowerCase();
	let best = null, bestD = Infinity;
	for (const c of COMMANDS) {
		const d = editDistance(n, c.name);
		if (d < bestD) { bestD = d; best = c.name; }
	}
	return best && bestD <= Math.max(2, Math.ceil(best.length / 2)) ? best : null;
}

function editDistance(a, b) {
	const m = a.length, n = b.length;
	const row = Array.from({ length: n + 1 }, (_, i) => i);
	for (let i = 1; i <= m; i++) {
		let prev = row[0];
		row[0] = i;
		for (let j = 1; j <= n; j++) {
			const tmp = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = tmp;
		}
	}
	return row[n];
}

// Build /help from the registry so it always matches the real command set. Names
// are padded to a common width so the descriptions line up as a scannable column.
function formatHelp() {
	const width = COMMANDS.reduce((w, c) => Math.max(w, c.name.length + (c.args ? c.args.length + 1 : 0)), 0);
	const lines = COMMANDS.map((c) => {
		const sig = '/' + c.name + (c.args ? ' ' + c.args : '');
		return '  ' + sig.padEnd(width + 1) + '  ' + c.desc;
	});
	return 'Commands\n' + lines.join('\n');
}

// /who — real realm occupancy. Each GameRoom is a single realm, so state.players
// IS the realm roster. The caller is marked and the list is sorted for stability.
function formatWho(ctx) {
	const realm = cap(ctx.room.state.realm || 'realm');
	const rows = [];
	for (const [id, p] of ctx.room.state.players) {
		rows.push({ name: p.name || 'guest', me: id === ctx.client.sessionId });
	}
	rows.sort((a, b) => (a.me === b.me ? a.name.localeCompare(b.name) : a.me ? -1 : 1));
	const n = rows.length;
	const head = `${n} ${n === 1 ? 'player' : 'players'} in ${realm}`;
	const list = rows.map((r) => '  • ' + r.name + (r.me ? ' (you)' : '')).join('\n');
	return head + (list ? '\n' + list : '');
}

function cap(s) {
	return String(s || '').replace(/^\w/, (m) => m.toUpperCase());
}

// Parse + dispatch a raw chat line beginning with '/'. The room has already
// rate-limited and looked up the player. Returns { text, kind } for the caller to
// ship as a system message, or null when the handler already replied itself.
export function runCommand(ctx, raw) {
	const without = String(raw || '').trim().replace(/^\//, '');
	const parts = without.split(/\s+/).filter(Boolean);
	const name = (parts.shift() || '').toLowerCase();

	if (!name) return { text: 'Type a command after the slash — try /help.', kind: 'error' };

	const cmd = resolve(name);
	if (!cmd) {
		const hint = suggest(name);
		return {
			text: `Unknown command /${name}.` + (hint ? ` Did you mean /${hint}?` : '') + ' Type /help for the list.',
			kind: 'error',
		};
	}

	let result;
	try {
		result = cmd.run(ctx, parts);
	} catch (err) {
		console.error(`[commands] /${cmd.name} threw:`, err);
		return { text: `Something went wrong running /${cmd.name}.`, kind: 'error' };
	}
	if (result == null) return null; // handler replied itself
	if (typeof result === 'string') return { text: result, kind: 'info' };
	return { text: String(result.text ?? ''), kind: result.kind || 'info' };
}
