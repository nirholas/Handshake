// The connection cards on /companion.
//
// Four lanes, each of which the user owns end to end:
//   • the phone and desktop bridge (a token, and anything that can POST),
//   • Telegram (a bot the user creates with @BotFather),
//   • a calendar (the private ICS URL every calendar app publishes),
//   • email (IMAP with an app password).
//
// A card is either a connected state (what it is, when it last ran, what the
// provider last said) or the form that connects it. Both are rendered from the
// same data so a connection that starts erroring explains itself in place.

const KINDS = {
	telegram: {
		icon: '✈️',
		title: 'Telegram',
		sub: 'A bot you own relays the chats you add it to. Nothing else in your account is readable.',
	},
	calendar: {
		icon: '📅',
		title: 'Calendar',
		sub: 'The private iCal link from Google, Apple, Outlook, or any CalDAV server. Read only, revocable by you.',
	},
	email: {
		icon: '✉️',
		title: 'Email',
		sub: 'IMAP with an app password. Headers and a short preview only, and your unread state is never touched.',
	},
};

export function esc(value) {
	return String(value == null ? '' : value)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function relTime(iso) {
	if (!iso) return 'never';
	const delta = Date.now() - Date.parse(iso);
	if (!Number.isFinite(delta)) return 'never';
	const mins = Math.round(delta / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function statusChip(source) {
	if (!source.enabled) return '<span class="chip">paused</span>';
	if (source.status === 'error') return '<span class="chip err">needs attention</span>';
	if (source.status === 'ok') return '<span class="chip ok">live</span>';
	return '<span class="chip warn">not checked yet</span>';
}

function connectedBody(source) {
	const config = source.config || {};
	const detail = source.kind === 'telegram'
		? (config.bot_username ? `@${config.bot_username}` : 'bot connected')
		: source.kind === 'calendar'
			? `${config.ics_host || 'calendar feed'} · looks ${config.lookahead_minutes || 30} min ahead`
			: `${config.user || ''} · ${config.host || ''}${config.folder && config.folder !== 'INBOX' ? ` · ${config.folder}` : ''}`;

	const hintByKind = {
		telegram: config.bot_username
			? `Message <strong>@${esc(config.bot_username)}</strong> from your phone, or add it to a group, and it reaches your companion.`
			: '',
		calendar: 'Events are announced as they approach, once each.',
		email: 'New mail only. The first check starts from now, so your archive stays quiet.',
	};

	return `
		<div class="connected">
			<div>
				<div>${esc(source.label)} ${statusChip(source)}</div>
				<div class="connected-meta">${esc(detail)} · checked ${relTime(source.last_polled_at)}</div>
			</div>
			<div class="hero-actions">
				<button type="button" class="btn btn-sm" data-action="poll" data-id="${esc(source.id)}">Check now</button>
				<button type="button" class="btn btn-sm" data-action="toggle" data-id="${esc(source.id)}" data-enabled="${source.enabled ? '1' : '0'}">${source.enabled ? 'Pause' : 'Resume'}</button>
				<button type="button" class="btn btn-sm btn-danger" data-action="disconnect" data-id="${esc(source.id)}">Disconnect</button>
			</div>
		</div>
		${source.status === 'error' && source.last_error ? `<div class="error" style="margin:0">${esc(source.last_error)}</div>` : ''}
		${hintByKind[source.kind] ? `<div class="hint">${hintByKind[source.kind]}</div>` : ''}
	`;
}

function formBody(kind) {
	if (kind === 'telegram') {
		return `
			<form class="src-body" data-connect="telegram">
				<label class="field">
					Bot token
					<input type="password" name="bot_token" placeholder="123456789:AA..." autocomplete="off" required minlength="20" />
				</label>
				<div class="hint">
					Open <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">@BotFather</a> in Telegram,
					send <code>/newbot</code>, and paste the token it gives you. Then message your new bot, or add it to the
					group you want relayed.
				</div>
				<button type="submit" class="btn btn-primary">Connect Telegram</button>
			</form>
		`;
	}
	if (kind === 'calendar') {
		return `
			<form class="src-body" data-connect="calendar">
				<label class="field">
					Private iCal URL
					<input type="text" name="ics_url" placeholder="https://calendar.google.com/calendar/ical/.../basic.ics" required />
				</label>
				<label class="field">
					Tell me this far ahead
					<select name="lookahead_minutes">
						<option value="10">10 minutes</option>
						<option value="30" selected>30 minutes</option>
						<option value="60">1 hour</option>
						<option value="120">2 hours</option>
					</select>
				</label>
				<div class="hint">
					Google Calendar: Settings for my calendars, then "Secret address in iCal format".
					Apple: share the calendar and copy its link. Outlook: Publish a calendar, ICS.
				</div>
				<button type="submit" class="btn btn-primary">Connect calendar</button>
			</form>
		`;
	}
	return `
		<form class="src-body" data-connect="email">
			<div class="row">
				<label class="field">
					IMAP server
					<input type="text" name="host" placeholder="imap.gmail.com" required />
				</label>
				<label class="field">
					Port
					<input type="number" name="port" value="993" min="1" max="65535" />
				</label>
			</div>
			<div class="row">
				<label class="field">
					Address
					<input type="text" name="user" placeholder="you@example.com" autocomplete="username" required />
				</label>
				<label class="field">
					App password
					<input type="password" name="pass" autocomplete="off" required />
				</label>
			</div>
			<label class="field">
				Folder
				<input type="text" name="folder" value="INBOX" />
			</label>
			<div class="hint">
				Use an app password, never your account password: Gmail and iCloud both issue one per app, and
				revoking it here cuts the connection instantly. It is encrypted before it is stored.
			</div>
			<button type="submit" class="btn btn-primary">Connect inbox</button>
		</form>
	`;
}

function bridgeCard(bridge) {
	const curl = `curl -X POST ${bridge.url} \\
  -H "Authorization: Bearer ${bridge.token}" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Sarah is at the door","sender":"Sarah","app":"Messages","priority":"high"}'`;
	return `
		<article class="card src">
			<div class="src-head">
				<div class="src-icon">📱</div>
				<div>
					<div class="src-title">Phone and Mac</div>
					<div class="src-sub">Forward anything that can make an HTTP request: an iOS Shortcuts automation, an Android profile, a Mail rule, a script.</div>
				</div>
			</div>
			<div class="src-body">
				<label class="field">
					Your bridge token
					<code class="token" id="bridge-token">${esc(bridge.token)}</code>
				</label>
				<div class="hero-actions">
					<button type="button" class="btn btn-sm" data-action="copy-token">Copy token</button>
					<button type="button" class="btn btn-sm" data-action="copy-curl">Copy example</button>
					<button type="button" class="btn btn-sm" data-action="send-test">Send a test</button>
					<button type="button" class="btn btn-sm btn-danger" data-action="rotate-token">Rotate</button>
				</div>
				<pre class="snippet">${esc(curl)}</pre>
				<div class="hint">
					Step by step recipes for iOS Shortcuts, Android, macOS, and Gmail are in
					<a href="/docs/companion">the companion docs</a>. Rotating revokes every device at once.
				</div>
			</div>
		</article>
	`;
}

/**
 * Render every connection card.
 * @param {HTMLElement} host
 * @param {{ sources: Array, bridge: {token:string,url:string} }} state
 */
export function renderSources(host, { sources, bridge }) {
	const byKind = new Map();
	for (const source of sources) {
		if (!byKind.has(source.kind)) byKind.set(source.kind, []);
		byKind.get(source.kind).push(source);
	}

	const cards = Object.entries(KINDS).map(([kind, meta]) => {
		const connected = byKind.get(kind) || [];
		return `
			<article class="card src" data-kind="${kind}">
				<div class="src-head">
					<div class="src-icon">${meta.icon}</div>
					<div>
						<div class="src-title">${esc(meta.title)}</div>
						<div class="src-sub">${esc(meta.sub)}</div>
					</div>
				</div>
				<div class="src-body">
					${connected.map(connectedBody).join('')}
					${connected.length
						? `<details class="src-body"><summary class="btn btn-sm" style="width:fit-content;list-style:none">Connect another</summary><div style="margin-top:12px">${formBody(kind)}</div></details>`
						: formBody(kind)}
				</div>
			</article>
		`;
	});

	host.innerHTML = bridgeCard(bridge) + cards.join('');
}
