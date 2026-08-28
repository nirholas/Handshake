// Notification herald: your agent delivers the important ones in person.
// ============================================================================
// The bell inbox (src/notifications.js) is a passive surface. It waits for you
// to notice a badge and open a panel. Some notifications deserve more than
// that: money landed, the generation you were waiting on finished, something
// happened to your account. For those, the corner companion (the avatar that
// already walks your pages, src/walk-companion.js) turns to you, waves, and
// says it out loud, with a link straight to the thing that happened.
//
// The rules, in order:
//   1. The visitor owns it. Announcements are a real delivery channel in the
//      preference center (/dashboard/settings), gated per category exactly like
//      push and email are (api/_lib/notify-prefs.js, channel "avatar"). The
//      defaults announce sales, creations, and account events only.
//   2. Only fresh (under 15 minutes old), unread notifications are announced,
//      and each id exactly once per browser. The ids already delivered live in
//      localStorage, so a page navigation, a re-poll, or a second tab never
//      repeats a line.
//   3. At most two lines per batch. Anything past that collapses into one
//      "N more waiting" line that links to the inbox, so a backlog never turns
//      into a monologue.
//   4. Nothing is announced into a background tab. The whole point is to tell
//      someone who is actually here.
//   5. "Turn off" in the bubble silences this browser instantly, without
//      touching the account-wide preference (which the settings page owns).
//
// The body comes from @three-ws/walk (walk-sdk/): `announce()` mounts the
// companion when it is off, delivers, and walks it back off. When it cannot
// render at all (no WebGL, an iframe, a route that already owns the corner) the
// message degrades to the normal toast, so a notification is never lost to a
// missing GPU.
//
// Fed by src/notifications.js on every poll. Everything heavy here (the
// companion module, the inbox helpers, TTS, toasts) is imported on demand, so
// a visitor with nothing to announce pays for a few hundred bytes and no more.

const ANNOUNCED_KEY = '3dagent:herald-announced';
const DEVICE_OFF_KEY = '3dagent:herald-off';
const PREFS_CACHE_KEY = '3dagent:herald-prefs';

// A notification older than this is history, not news: it belongs in the inbox,
// not in the avatar's mouth.
const FRESH_WINDOW_MS = 15 * 60_000;
// Preferences change rarely and cost a request; re-read them a few times an
// hour rather than on every poll.
const PREFS_TTL_MS = 10 * 60_000;
const MAX_PER_BATCH = 2;
// Remembered ids are only used to answer "did we already say this", so a small
// rolling window is enough. Old ids age out of the freshness window anyway.
const ANNOUNCED_CAP = 200;

// Bubble dwell: long enough to read a full line, scaled by length, capped so a
// verbose payload can never park the avatar on screen.
const BASE_HOLD_MS = 5200;
const HOLD_MS_PER_CHAR = 55;
const MAX_HOLD_MS = 12_000;
// Breathing room between two announcements so they read as two visits rather
// than one bubble mutating.
const GAP_MS = 900;

// ── Pure rules (unit-tested in tests/notification-herald.test.js) ────────────

/** How long a line stays up, scaled to its length. */
export function holdMsFor(text) {
	const chars = String(text || '').length;
	return Math.min(MAX_HOLD_MS, BASE_HOLD_MS + chars * HOLD_MS_PER_CHAR);
}

/** Is this notification recent enough to be worth interrupting for? */
export function isFresh(createdAt, now = Date.now()) {
	const t = Date.parse(createdAt);
	return Number.isFinite(t) && now - t < FRESH_WINDOW_MS && t - now < FRESH_WINDOW_MS;
}

/**
 * Category for a notification type, using the map the server sends with the
 * preferences (api/_lib/notify-prefs.js owns it). Unmapped types fall back to
 * 'account' exactly as they do server-side, so a brand new type is never
 * silently unannounceable.
 */
export function categoryFor(type, typeCategories) {
	return (typeCategories && typeCategories[type]) || 'account';
}

/** Has the visitor left the avatar channel on for this category? */
export function announcesCategory(prefs, category) {
	return prefs?.categories?.[category]?.avatar === true;
}

/**
 * Choose what the avatar says out of everything the inbox is holding.
 * @param {Array} notifications rows as returned by GET /api/notifications
 * @param {{prefs:object, typeCategories:object, announced:Set<string>, now?:number, max?:number}} ctx
 * @returns {{deliver: Array, overflow: number}} `deliver` newest first,
 *   `overflow` how many eligible ones did not fit in this batch.
 */
export function pickAnnouncements(
	notifications,
	{ prefs, typeCategories, announced, now = Date.now(), max = MAX_PER_BATCH },
) {
	const eligible = (Array.isArray(notifications) ? notifications : []).filter(
		(n) =>
			n &&
			n.id &&
			!n.read_at &&
			!announced.has(n.id) &&
			isFresh(n.created_at, now) &&
			announcesCategory(prefs, categoryFor(n.type, typeCategories)),
	);
	eligible.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
	return {
		deliver: eligible.slice(0, max),
		overflow: Math.max(0, eligible.length - max),
	};
}

// Types worth dancing about. Everything else arrives with a wave.
const CELEBRATED = new Set([
	'skill_purchased',
	'asset_purchased',
	'sale',
	'payment-earned',
	'referral_earned',
	'royalty_paid',
	'pump_launch_filled',
	'quest_complete',
	'forge_complete',
]);

/**
 * The gesture the avatar arrives with. Money and finished work get the
 * celebration; everything else gets the wave every rig can perform.
 */
export function emoteFor(type) {
	return CELEBRATED.has(type) ? 'dance' : 'wave';
}

// ── Local state (per browser) ────────────────────────────────────────────────

/** Ids claimed by this page, so a claim survives storage being unavailable. */
const _session = new Set();
/** Device-level mute, read once per page and flipped by the bubble's control. */
let _muted = null;

function readAnnounced() {
	try {
		const raw = localStorage.getItem(ANNOUNCED_KEY);
		const list = raw ? JSON.parse(raw) : [];
		return new Set(Array.isArray(list) ? list : []);
	} catch {
		// Storage disabled: nothing is remembered, so the freshness window and
		// the in-memory set below are what stop a repeat within this page.
		return new Set();
	}
}

function markAnnounced(ids) {
	for (const id of ids) _session.add(id);
	try {
		const raw = localStorage.getItem(ANNOUNCED_KEY);
		const list = raw ? JSON.parse(raw) : [];
		const next = (Array.isArray(list) ? list : []).concat(ids).slice(-ANNOUNCED_CAP);
		localStorage.setItem(ANNOUNCED_KEY, JSON.stringify(next));
	} catch {
		/* storage disabled: the in-memory set still covers this page */
	}
}

export function deviceMuted() {
	try {
		return localStorage.getItem(DEVICE_OFF_KEY) === '1';
	} catch {
		return false;
	}
}

function muteDevice() {
	try {
		localStorage.setItem(DEVICE_OFF_KEY, '1');
	} catch {
		/* storage disabled: the mute lasts for this page only */
	}
	_muted = true;
}

// ── Preferences ──────────────────────────────────────────────────────────────

let _prefsPromise = null;

function readCachedPrefs() {
	try {
		const raw = sessionStorage.getItem(PREFS_CACHE_KEY);
		if (!raw) return null;
		const cached = JSON.parse(raw);
		if (!cached || Date.now() - cached.ts > PREFS_TTL_MS) return null;
		return { prefs: cached.prefs, typeCategories: cached.typeCategories };
	} catch {
		return null;
	}
}

/**
 * The visitor's channel matrix plus the server's type to category map. Returns
 * null when it cannot be read, and a null result announces nothing: silence is
 * the safe failure for a channel that interrupts.
 */
async function loadPrefs() {
	const cached = readCachedPrefs();
	if (cached) return cached;
	if (_prefsPromise) return _prefsPromise;
	_prefsPromise = (async () => {
		try {
			const res = await fetch('/api/notifications/preferences', { credentials: 'include' });
			if (!res.ok) return null;
			const body = await res.json();
			const bundle = {
				prefs: body?.prefs || null,
				typeCategories: body?.type_categories || {},
			};
			if (!bundle.prefs) return null;
			try {
				sessionStorage.setItem(
					PREFS_CACHE_KEY,
					JSON.stringify({ ts: Date.now(), ...bundle }),
				);
			} catch {
				/* storage disabled: re-fetch next batch */
			}
			return bundle;
		} catch {
			return null;
		} finally {
			_prefsPromise = null;
		}
	})();
	return _prefsPromise;
}

// ── The companion body ───────────────────────────────────────────────────────

// public/nav.js injects this module only when the companion is switched on, so
// on a page where it is off we inject it ourselves and let `announce()` decide
// whether to summon and retreat. Same stable URL in dev and production
// (vite.config.js maps both).
const COMPANION_SRC = '/walk-companion.js';
const COMPANION_WAIT_MS = 8000;
const COMPANION_POLL_MS = 120;

function ensureCompanion() {
	if (window.__walkCompanion) return Promise.resolve(window.__walkCompanion);
	if (!document.querySelector(`script[src="${COMPANION_SRC}"]`)) {
		const s = document.createElement('script');
		s.type = 'module';
		s.src = COMPANION_SRC;
		document.head.appendChild(s);
	}
	return new Promise((resolve) => {
		const deadline = Date.now() + COMPANION_WAIT_MS;
		const poll = () => {
			if (window.__walkCompanion) return resolve(window.__walkCompanion);
			if (Date.now() > deadline) return resolve(null);
			setTimeout(poll, COMPANION_POLL_MS);
		};
		poll();
	});
}

// ── Voice ────────────────────────────────────────────────────────────────────

let _speaker = null;

/**
 * Speak the line aloud, but only when the visitor already chose voice for the
 * companion's narration ("walk:companion:narrate" = voice, set from the
 * companion's own toggle). An announcement never introduces audio on its own.
 */
async function speakAloud(text) {
	try {
		const mod = await import('./walk-companion-narrator.js');
		if (mod.narrationMode() !== 'voice') return;
		// Page-section narration and an announcement share one voice; the
		// announcement wins.
		window.__walkNarrator?.api?.silence?.();
		if (!_speaker) _speaker = mod.createSpeaker();
		_speaker.speak(text);
	} catch {
		/* no TTS available: the bubble already carries the message */
	}
}

// ── Delivery ─────────────────────────────────────────────────────────────────

const queue = [];
let running = false;

/**
 * Offer the inbox's current contents to the avatar. Safe to call on every poll:
 * it is idempotent per notification id, cheap when nothing qualifies, and
 * silent in a background tab.
 * @param {Array} notifications rows from GET /api/notifications
 */
export async function consider(notifications) {
	if (!Array.isArray(notifications) || notifications.length === 0) return;
	if (_muted === null) _muted = deviceMuted();
	if (_muted) return;
	if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;

	const bundle = await loadPrefs();
	if (!bundle) return;

	const announced = readAnnounced();
	for (const id of _session) announced.add(id);
	const { deliver, overflow } = pickAnnouncements(notifications, {
		prefs: bundle.prefs,
		typeCategories: bundle.typeCategories,
		announced,
	});
	if (deliver.length === 0) return;

	// Claim before delivering: a sibling tab polling the same second must not
	// say the same line, and a failed delivery must not queue up a retry loop.
	markAnnounced(deliver.map((n) => n.id));

	queue.push(...deliver.map((n) => ({ notification: n })));
	if (overflow > 0) queue.push({ overflow });
	if (!running) run();
}

async function run() {
	running = true;
	try {
		while (queue.length) {
			const item = queue.shift();
			// The visitor may have muted mid-queue, or walked away from the tab.
			if (_muted || document.visibilityState !== 'visible') break;
			await deliver(item);
			if (queue.length) await wait(GAP_MS);
		}
	} finally {
		running = false;
	}
}

async function deliver(item) {
	const [{ TYPE_ICON, notifLabel, notifLink, trackInApp }, walk] = await Promise.all([
		import('./notifications.js'),
		ensureCompanion(),
	]);

	const n = item.notification;
	const line = n
		? notifLabel(n)
		: `${item.overflow} more notification${item.overflow === 1 ? '' : 's'} waiting for you`;
	const href = n ? notifLink(n) : '/notifications';
	const icon = n ? TYPE_ICON[n.type] || '📣' : '🔔';
	const hold = holdMsFor(line);

	const actions = [];
	if (href) {
		actions.push({
			label: 'Open',
			href,
			title: `Open: ${line}`,
			onClick: () => {
				if (n?.id) trackAvatarOpen(n.id, trackInApp);
			},
		});
	}
	actions.push({
		label: 'Turn off',
		title: 'Stop the avatar announcing notifications in this browser',
		onClick: () => turnOff(),
	});

	if (!walk?.announce) return fallbackToast(line);

	speakAloud(line);
	const shown = await walk.announce(`${icon} ${line}`, {
		hold,
		tone: 'alert',
		emote: n ? emoteFor(n.type) : 'wave',
		actions,
	});
	if (!shown) fallbackToast(line);
}

/**
 * Record the click-through on the avatar channel so the delivery is measured
 * like push and the inbox are (api/notifications/track).
 */
function trackAvatarOpen(id, trackInApp) {
	fetch('/api/notifications/track', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ notification_id: id, channel: 'avatar', event: 'opened' }),
	})
		.then((res) => {
			// The avatar channel is new; a browser talking to an older deploy
			// gets a 400 back, and the open still deserves to be counted.
			if (!res.ok) trackInApp(id, 'opened');
		})
		.catch(() => {
			/* offline: the click still navigates, only the beacon is lost */
		});
}

async function turnOff() {
	muteDevice();
	queue.length = 0;
	try {
		window.__walkCompanion?.instance?.hideBubble?.();
	} catch {
		/* companion already gone */
	}
	const { toast } = await import('./shared/toast.js');
	toast('Your agent will stop announcing notifications in this browser. Per-category control lives in Settings.', {
		variant: 'info',
		duration: 6000,
	});
}

async function fallbackToast(line) {
	const { toast } = await import('./shared/toast.js');
	toast(line, { variant: 'info', duration: 6000 });
}

function wait(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
