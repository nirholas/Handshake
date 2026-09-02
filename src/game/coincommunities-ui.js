// Coin Communities UI layer, lobby + in-world chrome.
//
// Two surfaces:
//   1. Lobby: live pump.fun coin grid (each coin = a community to enter) + a
//      zero-friction avatar picker (presets, or paste your own avatar / 3D
//      agent GLB URL or three.ws avatar id).
//   2. In-world HUD: coin banner + online count, chat, emote tray, leave.
//
// The 3D scene (coincommunities.js) owns WebGL + projected name labels; this
// module owns the 2D chrome and calls back through the handlers passed in.

import { renderAvatarThumb } from './avatar-thumb.js';
import { resolveAvatarUrl } from './avatar-rig.js';
import { validateGlb, uploadGlb } from './avatar-upload.js';
import { GUEST_SENTINEL, playAs } from './play-handoff.js';
import { COMPOSITE_PIECES } from './build-voxels.js';
import { PROP_CATALOG, GALLERY_PROP_PREFIX, registerGalleryProp } from './world-objects.js';
import { makeIntroReopener } from './play-intro.js';
import { getPowerSaver, setPowerSaver, onPowerSaverChange } from '../shared/frame-governor.js';
import { getMe } from '../account.js';
import { threeMarkSvg } from '../shared/brand-mark.js';
import { proxiedImageURL } from '../ipfs.js';
import { log } from '../shared/log.js';
import { t, onLocaleChange } from './i18n-play.js';
import { announce } from './a11y.js';
import { countUp } from '../ui-juice.js';

// localStorage throws in private mode and in third-party iframe contexts where
// storage is blocked (the `?bg=transparent` embed). Guard every access so a
// blocked store degrades to defaults instead of throwing while the HUD builds,
// same contract as play-onboard.js / play-intro.js / play-handoff.js.
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* storage disabled */ } }

// Degrees shown on the rotate button for each quarter-turn step (0, 3).
const ROT_DEG = ['0°', '90°', '180°', '270°'];

// ── Emote wheel (R09) ────────────────────────────────────────────────────────
// Category definitions: clip names → buckets. Angles are CSS/SVG standard
// (0 = right, CW), with the first category centred at the 12 o'clock position
// (−90°). Any manifest clip not matched here falls through to 'social'.
const _EW_CATS = [
	{
		id: 'social', label: 'Social', icon: '👋', angle: -90,
		names: new Set(['wave','celebrate','angry','kiss','pray','reaction','av-cheering',
			'av-joy','av-call-me','av-brag-claps','sitclap','sitlaugh','taunt',
			'xbot-agree','xbot-head-shake','facepalm','av-celebrating','av-chest-bump']),
	},
	{
		id: 'dances', label: 'Dances', icon: '💃', angle: -18,
		names: new Set(['dance','rumba','silly','thriller','capoeira','av-boxer-dance',
			'av-dance-shuffle','av-headbang','av-banging-tunes','av-conductor',
			'av-rap-dance','michelle-samba-dance','av-listening-music','av-vtubing']),
	},
	{
		id: 'flips', label: 'Flips', icon: '🤸', angle: 54,
		names: new Set(['av-back-flip','av-gymnastics-aerial','av-superhero-jump',
			'jump','falling','dying','defeated','standup','falltolanding']),
	},
	{
		id: 'combat', label: 'Combat', icon: '🥊', angle: 126,
		names: new Set(['av-muay-thai','av-arm-flex','av-flexing-arm','dodge','stepback',
			'shoved','header','coverstand','goalkeeper','av-push-block','av-stand-crouch-stand']),
	},
	{
		id: 'poses', label: 'Poses', icon: '🧍', angle: 198,
		names: new Set(['av-waiting','av-chilling','av-smoking','av-leaning-wall','av-spy',
			'downdog','xbot-sad-pose','xbot-sneak-pose','lookdown','covereyes',
			'av-idle-breath','idle','av-idle-anim','av-idle-male','av-idle-female']),
	},
];

// Distribute a flat emote-def array into the 5 category buckets.
function _ewCategorize(allDefs) {
	const buckets = _EW_CATS.map((c) => ({ ...c, clips: [] }));
	const fallback = buckets[0]; // 'social' is the catch-all
	for (const def of allDefs) {
		const b = buckets.find((c) => c.names.has(def.name)) || fallback;
		b.clips.push(def);
	}
	return buckets;
}

// Build an SVG donut-sector path centred at (cx,cy) with inner/outer radii,
// spanning from startDeg to endDeg (standard math angles, degrees).
function _ewSectorPath(cx, cy, ir, or_, s, e) {
	const r = (d) => (d * Math.PI) / 180;
	const px = (a, rad) => cx + rad * Math.cos(r(a));
	const py = (a, rad) => cy + rad * Math.sin(r(a));
	const lg = (e - s > 180) ? 1 : 0;
	return `M${px(s,ir)} ${py(s,ir)} L${px(s,or_)} ${py(s,or_)} A${or_} ${or_} 0 ${lg} 1 ${px(e,or_)} ${py(e,or_)} L${px(e,ir)} ${py(e,ir)} A${ir} ${ir} 0 ${lg} 0 ${px(s,ir)} ${py(s,ir)} Z`;
}
// ── end emote wheel helpers ──────────────────────────────────────────────────

// Wrap a URL for use inside a CSS `url(...)` value without letting it break out
// of the declaration. A coin's image is network-controlled (pump.fun metadata,
// or the ?image= deep-link param); proxiedImageURL only encodes http/ipfs/ar
// URLs, so any other value reaches us raw. A crafted string like
// `x");position:fixed;inset:0;background:url(//evil)` would otherwise escape the
// declaration and paint a full-screen overlay for everyone in the lobby. We
// refuse dangerous schemes and percent-encode the characters that could close
// the url() or the rule, so the worst a hostile value can do is fail to load.
function cssBgImage(url) {
	if (!url || typeof url !== 'string') return '';
	if (/^\s*(javascript|vbscript|data\s*:\s*text\/html)/i.test(url)) return '';
	const safe = url.replace(/["'()\\\s<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
	return `background-image:url("${safe}")`;
}

function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
	}
	for (const kid of [].concat(kids)) if (kid != null && kid !== false) n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	return n;
}

const fmtMc = (n) => {
	if (!n || !isFinite(n)) return null;
	if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
	if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
	if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
	return '$' + Math.round(n);
};

// Compact token-amount label ("1.5M", "12.3K", "950") for gate requirements.
const fmtCompact = (n) => {
	const v = Number(n) || 0;
	if (v >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
	if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
	if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
	return String(Math.round(v));
};

// Compact "3h ago" / "just now" relative time from an epoch-ms timestamp.
function timeAgo(ts) {
	const at = Number(ts);
	if (!at || !isFinite(at)) return '';
	const s = Math.max(0, (Date.now() - at) / 1000);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

const DEFAULT_AVATAR = '/avatars/default.glb';

// Crossed swords for the Adventure-mode button. Drawn rather than typed: the
// ⚔️ emoji has no color glyph on most Linux/headless font stacks and the button
// grayscaled it anyway, so it degraded to a bare monochrome ✕ that read as a
// close button sitting next to the search field. Two blades on the diagonals
// with a cross-guard low on each grip; the guards are what keep it from
// reading as an X.
const ADVENTURE_MARK =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
	'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
	'<path d="M21 3 4.5 19.5"/><path d="M7 13 11 17"/>' +
	'<path d="M3 3 19.5 19.5"/><path d="M13 17 17 13"/></svg>';

// Grid orderings. Each one reads a field we actually hold: `trending` is the
// feed's own rank (the order the API returned), `people` the live matchmaker
// headcount, `mcap` the pump.fun market cap, `new` the on-chain launch time that
// arrives with the enrichment pass. Nothing here invents a ranking signal.
const SORTS = [
	{ id: 'trending', label: 'Trending', hint: 'The live pump.fun trending order' },
	{ id: 'people', label: 'Most people', hint: 'Worlds with the most players inside right now' },
	{ id: 'mcap', label: 'Market cap', hint: 'Biggest market cap first' },
	{ id: 'new', label: 'Newest', hint: 'Most recently launched coins first' },
];

// Live headcount poll. 20s is slower than the 5s cache on the endpoint on
// purpose: the number moves on a human timescale and the lobby is a browse
// surface, not a dashboard.
const POPULATION_URL = '/api/play/population?by=coin';
const POPULATION_POLL_MS = 20_000;

// Second pass over the same trending feed, for the fields the thin projection
// drops: launch time, reply count, and whether the bonding curve has completed.
// The thin feed stays the one the grid is built from (it has a Birdeye fallback
// and therefore survives a pump.fun outage); this only ever adds texture on top,
// and a failure here leaves the cards exactly as they were.
const ENRICH_URL = '/api/pump/trending?limit=50&rich=1';

// A coin younger than this wears the NEW badge.
const NEW_COIN_MS = 24 * 60 * 60 * 1000;

// Compact age label for a launch timestamp: "3h old", "6d old".
function fmtAge(ts) {
	const at = Number(ts);
	if (!at || !isFinite(at) || at > Date.now()) return '';
	const s = (Date.now() - at) / 1000;
	// "min" spelled out: "24m old" next to "20mo old" reads as months at a glance.
	if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}min old`;
	if (s < 86400) return `${Math.floor(s / 3600)}h old`;
	if (s < 86400 * 30) return `${Math.floor(s / 86400)}d old`;
	return `${Math.floor(s / (86400 * 30))}mo old`;
}

export class CommunityUI {
	/**
	 * @param {object} h handlers: { onEnter(coin), onLeave(), onChat(text), onEmote(name) }
	 */
	constructor(h) {
		this.h = h;
		this.coins = [];
		this.featured = null;      // pinned official town (e.g. the $THREE flagship)
		this.searchResults = [];   // live pump.fun search hits beyond the trending grid
		this.searching = false;
		this._searchSeq = 0;       // guards against out-of-order async search responses
		this._searchTimer = null;
		this.popByCoin = null;     // mint → live headcount, null until a real read lands
		this.popTotal = null;      // people standing in any world, null until measured
		this.enriched = new Map(); // mint → { createdAt, replies, graduated } from the rich feed
		this.avatar = lsGet('cc-avatar') || DEFAULT_AVATAR;
		this._buildLobby();
		this._buildHud();
		this._buildStructures();
		this._buildPropPalette();
		this._hydrateAccountIdentity();
	}

	// Signed-in identity (W10): a logged-in player enters the world AS their
	// three.ws account, default the nameplate to their display name and show
	// the @handle peers will see (and can follow/DM) beside the name field.
	// Anonymous visitors keep the plain guest field; getMe() resolves null.
	async _hydrateAccountIdentity() {
		let me = null;
		try { me = await getMe(); } catch { return; }
		if (!me) return;
		this.me = me;
		if (!this.nameInput.value.trim()) {
			const n = String(me.display_name || me.username || '').trim().slice(0, 24);
			if (n) { this.nameInput.value = n; lsSet('cc-name', n); }
		}
		if (me.username && this.nameRow && !this._identityChip) {
			this._identityChip = el('a', {
				class: 'cc-identity-chip',
				href: `/u/${encodeURIComponent(me.username)}`,
				target: '_blank',
				rel: 'noopener',
				title: 'Signed in, players you meet can open your profile, follow you, and message you',
				text: `@${me.username}`,
			});
			this.nameRow.appendChild(this._identityChip);
		}
	}

	// ---------------------------------------------------------------- lobby
	_buildLobby() {
		this.sort = SORTS.some((s) => s.id === lsGet('cc-sort')) ? lsGet('cc-sort') : 'trending';
		this.searchInput = el('input', {
			type: 'text', class: 'cc-search-input', id: 'cc-search-input',
			placeholder: 'Search any pump.fun coin by name, symbol, or mint…',
			autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search pump.fun coins',
			oninput: () => this._onSearchInput(),
			onkeydown: (e) => {
				e.stopPropagation();
				if (e.key === 'Escape' && this.searchInput.value) { this._clearSearch(); }
			},
		});
		this.searchClear = el('button', {
			type: 'button', class: 'cc-search-clear', 'aria-label': 'Clear search', hidden: true,
			onclick: () => { this._clearSearch(); this.searchInput.focus(); },
			html: '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="3" y1="3" x2="11" y2="11"/><line x1="11" y1="3" x2="3" y2="11"/></svg>',
		});
		this.grid = el('div', { class: 'cc-grid' });

		// Your display name, the label peers see above your avatar and in chat.
		// Persisted so it sticks across sessions; broadcast live if changed in-world.
		this.nameInput = el('input', {
			type: 'text', maxlength: '24', class: 'cc-name-input', id: 'cc-name-input',
			placeholder: 'Pick a name', 'aria-label': 'Your display name',
			value: lsGet('cc-name') || '',
			onchange: () => this._commitName(),
			onkeydown: (e) => { if (e.key === 'Enter') { this._commitName(); this.nameInput.blur(); } e.stopPropagation(); },
		});

		this.presetRow = el('div', { class: 'cc-avatar-presets' });
		this.customInput = el('input', {
			type: 'text',
			placeholder: 'Paste avatar / 3D agent GLB URL or avatar id',
			value: /^https?:|^\//.test(this.avatar) && this.avatar !== DEFAULT_AVATAR ? this.avatar : '',
			onchange: () => { this._setAvatar(this.customInput.value.trim() || DEFAULT_AVATAR, true); },
		});

		// Bring-your-own avatar: drop a .glb on the bar or pick one. It's validated,
		// uploaded to storage, then broadcast by its public URL so peers see it too.
		this.uploadFile = el('input', {
			type: 'file', accept: '.glb,.vrm,model/gltf-binary', class: 'cc-upload-file',
			onchange: (e) => { const f = e.target.files?.[0]; if (f) this._handleGlbFile(f); e.target.value = ''; },
		});
		this.uploadBtn = el('label', { class: 'cc-upload-btn', title: 'Upload a .glb or .vrm avatar from your device' }, [
			el('span', { class: 'cc-upload-ico', text: '⬆' }),
			el('span', { class: 'cc-upload-text', text: 'Upload model' }),
			this.uploadFile,
		]);

		// Browse the full avatar library (your own + the public gallery) with live
		// 3D previews, instead of pasting a URL. Reuses the platform-wide
		// AvatarGalleryPicker, lazy-loaded so the lobby bundle stays lean.
		this.galleryBtn = el('button', {
			type: 'button', class: 'cc-gallery-btn',
			title: 'Browse your avatars and the public gallery',
			onclick: () => this._openGallery(),
		}, [
			el('span', { class: 'cc-gallery-ico', text: '🖼' }),
			el('span', { class: 'cc-gallery-text', text: 'Browse gallery' }),
		]);
		// Create a brand-new avatar without leaving the lobby, the headline action.
		// Opens the in-app creator (design from scratch or from a photo); the exported
		// GLB is staged locally and adopted instantly, then the world uploads it so
		// peers see it too. Lazy-loaded so the avatar SDK never bloats the lobby boot.
		this.createBtn = el('button', {
			type: 'button', class: 'cc-create-btn',
			title: 'Create a brand-new 3D avatar, design it or build it from a photo',
			onclick: () => this._openCreate(),
		}, [
			el('span', { class: 'cc-create-ico', 'aria-hidden': 'true', text: '✦' }),
			el('span', { class: 'cc-create-copy', html: 'Create your avatar<small>Design from scratch or from a photo, drop straight in</small>' }),
			el('span', { class: 'cc-create-arrow', 'aria-hidden': 'true', text: '→' }),
		]);

		this.uploadStatus = el('div', { class: 'cc-upload-status', role: 'status', 'aria-live': 'polite', hidden: true });

		this.lobby = el('div', { id: 'cc-lobby' }, [
			this._buildSiteNav(),
			el('div', { class: 'cc-lobby-inner' }, [
				this._buildHero(),
				this._buildSearchBar(),
				this._buildIdentityBar(),
				this._buildFeedHead(),
				this.grid,
			]),
			this._buildSiteFooter(),
		]);
		document.body.appendChild(this.lobby);

		this._wireNav();
		this._wireGlbDrop();
		this._wireLobbyKeys();
		this._renderPresets();
		this.setCoinsLoading();
		this._startPopulation();
	}

	// The hero states what this place is in one line and proves it is alive in
	// three real numbers: how many communities are on screen, how many people are
	// standing in the worlds right now, and what those communities are worth
	// together. Every figure is measured, never decorative: the population comes
	// from the multiplayer matchmaker and the rest from the live pump.fun feed,
	// and a figure we cannot measure is hidden rather than filled in.
	_buildHero() {
		this.statWorlds = el('dd', { class: 'cc-stat-v', text: '…' });
		this.statPeople = el('dd', { class: 'cc-stat-v', text: '…' });
		this.statCap = el('dd', { class: 'cc-stat-v', text: '…' });
		const stat = (label, valueEl, hint) => el('div', { class: 'cc-stat', title: hint }, [
			valueEl,
			el('dt', { class: 'cc-stat-k', text: label }),
		]);
		// Hidden until the first successful population read: a landing page must
		// never invent a headcount (see api/play/population.js).
		this.statPeopleWrap = stat('inside right now', this.statPeople, 'People standing in a three.ws world at this moment');
		this.statPeopleWrap.hidden = true;

		return el('section', { class: 'cc-hero' }, [
			el('div', { class: 'cc-hero-copy' }, [
				el('div', { class: 'cc-brand' }, [
					el('a', { class: 'cc-brand-logo', href: '/', 'aria-label': 'three.ws home', title: 'three.ws', html: threeMarkSvg() }),
					el('div', {}, [
						el('div', { class: 'cc-brand-title', text: 'Coin Communities' }),
						el('div', { class: 'cc-brand-sub', text: 'A live 3D world behind every ticker' }),
					]),
				]),
				el('h1', { class: 'cc-hero-title', html: 'Every coin is a <em>3D world</em>.' }),
				el('p', { class: 'cc-hero-sub', text: 'Walk into any pump.fun community as your own avatar. Talk, build, trade and play with the people holding the same coin, straight in the browser. No download, no wallet needed to look around.' }),
				el('div', { class: 'cc-hero-actions' }, [
					// A button into the home-town world, not a link: an <a href="/play">
					// here was a full page reload back to this same lobby.
					el('button', {
						type: 'button', class: 'cc-adventure', title: 'Drop into the home town: gather, fight, level up',
						onclick: () => this.h.onDropIn?.(),
					}, [
						el('span', { class: 'cc-adventure-ico', 'aria-hidden': 'true', html: ADVENTURE_MARK }),
						el('span', { html: 'Adventure mode<small>Gather · fight · level up</small>' }),
					]),
					// Cold-open reopener (see play-intro.js), the intro auto-shows once
					// per browser; this brings it back for anyone who skipped it.
					makeIntroReopener(() => this.h.onDropIn?.()),
				]),
			]),
			el('dl', { class: 'cc-stats' }, [
				stat('communities live', this.statWorlds, 'Coin worlds you can enter from this page right now'),
				this.statPeopleWrap,
				stat('combined market cap', this.statCap, 'Market cap of every community listed below, added up'),
			]),
		]);
	}

	// One command bar: the search field plus the shortcut hint that teaches it.
	// Sat in the header row before, competing with the brand for the eye; it is
	// the page's main verb, so it gets its own line at full width.
	_buildSearchBar() {
		return el('div', { class: 'cc-cmd' }, [
			el('label', { class: 'cc-search', for: 'cc-search-input' }, [
				el('span', { class: 'cc-search-ico', 'aria-hidden': 'true', html: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="9" cy="9" r="6"/><line x1="13.5" y1="13.5" x2="18" y2="18"/></svg>' }),
				this.searchInput,
				this.searchClear,
				el('kbd', { class: 'cc-search-kbd', 'aria-hidden': 'true', text: '/' }),
			]),
			el('p', { class: 'cc-cmd-hint', text: 'Any pump.fun coin works, even one that launched a minute ago. Paste a mint to jump straight to its world.' }),
		]);
	}

	// Your identity, one row: the avatar you will be seen as, the name above your
	// head, and a disclosure holding every way to change it. It used to be a tall
	// always-open panel that pushed the communities (the reason people come here)
	// below the fold; a returning player who already has both now sees a compact
	// summary, and a first-timer still lands on the picker wide open.
	_buildIdentityBar() {
		this.idPortrait = el('div', { class: 'cc-id-portrait', 'aria-hidden': 'true' }, [
			el('span', { class: 'cc-id-portrait-glyph', text: '🧍' }),
		]);
		this.idSummary = el('span', { class: 'cc-id-summary', text: 'Default avatar' });

		const startOpen = !(lsGet('cc-avatar') && lsGet('cc-name'));
		this.idBody = el('div', { class: 'cc-id-body', id: 'cc-id-body' }, [
			el('div', { class: 'cc-avatar-label', html: 'Your avatar<small>Create your own, pick a preset, browse the gallery, paste a URL, or drop your own .glb / .vrm</small>' }),
			this.createBtn,
			this.presetRow,
			el('div', { class: 'cc-avatar-custom' }, [this.customInput, this.galleryBtn, this.uploadBtn]),
			this.uploadStatus,
		]);
		this.idToggle = el('button', {
			type: 'button', class: 'cc-id-toggle', 'aria-expanded': String(startOpen), 'aria-controls': 'cc-id-body',
			onclick: () => this._toggleIdentity(),
		}, [
			el('span', { class: 'cc-id-toggle-text', text: startOpen ? 'Hide options' : 'Change avatar' }),
			el('span', { class: 'cc-id-toggle-caret', 'aria-hidden': 'true', text: '▾' }),
		]);

		this.avatarBar = el('div', { class: 'cc-avatar-bar' + (startOpen ? ' cc-id-open' : '') }, [
			el('div', { class: 'cc-id-head' }, [
				this.idPortrait,
				el('div', { class: 'cc-id-fields' }, [
					this.nameRow = el('div', { class: 'cc-name-row' }, [
						el('label', { class: 'cc-name-label', for: 'cc-name-input', text: 'Your name' }),
						this.nameInput,
					]),
					this.idSummary,
				]),
				this.idToggle,
			]),
			this.idBody,
			el('div', { class: 'cc-avatar-dropmsg', text: 'Drop a .glb or .vrm to use as your avatar' }),
		]);
		this.idBody.hidden = !startOpen;
		return this.avatarBar;
	}

	_toggleIdentity(force) {
		const open = force === undefined ? this.idBody.hidden : !!force;
		this.idBody.hidden = !open;
		this.avatarBar.classList.toggle('cc-id-open', open);
		this.idToggle.setAttribute('aria-expanded', String(open));
		this.idToggle.querySelector('.cc-id-toggle-text').textContent = open ? 'Hide options' : 'Change avatar';
	}

	// Section head over the grid: what you are looking at, how many there are, and
	// how to reorder them. The sort is a real reorder of real fields (feed rank,
	// live headcount, market cap, launch time), not a filter that hides coins.
	_buildFeedHead() {
		this.feedCount = el('span', { class: 'cc-feed-count', 'aria-live': 'polite' });
		this.sortRow = el('div', { class: 'cc-sorts', role: 'group', 'aria-label': 'Sort communities' }, SORTS.map((s) => el('button', {
			type: 'button', class: 'cc-sort' + (s.id === this.sort ? ' cc-on' : ''),
			'aria-pressed': String(s.id === this.sort), title: s.hint, 'data-sort': s.id,
			onclick: () => this._setSort(s.id),
			text: s.label,
		})));
		// Ranking by headcount needs headcounts. Until a per-coin read lands (the
		// multiplayer server is unreachable, or it predates the breakdown), the
		// control that promises that ordering cannot keep the promise, so it stays
		// disabled and says why rather than silently sorting by something else.
		this._setPeopleSortAvailable(false);
		return el('div', { class: 'cc-feed-head' }, [
			el('div', { class: 'cc-feed-title' }, [
				el('p', { class: 'cc-section-title', text: 'Live communities' }),
				this.feedCount,
			]),
			this.sortRow,
		]);
	}

	_setPeopleSortAvailable(on) {
		const chip = this.sortRow?.querySelector('[data-sort="people"]');
		if (!chip) return;
		chip.disabled = !on;
		chip.title = on
			? SORTS.find((s) => s.id === 'people').hint
			: 'Live headcounts are unavailable right now';
		if (!on && this.sort === 'people') this._setSort('trending');
	}

	_setSort(id) {
		if (!SORTS.some((s) => s.id === id) || id === this.sort) return;
		this.sort = id;
		lsSet('cc-sort', id);
		for (const b of this.sortRow.children) {
			const on = b.dataset.sort === id;
			b.classList.toggle('cc-on', on);
			b.setAttribute('aria-pressed', String(on));
		}
		this._renderGrid();
		announce(`Sorted by ${SORTS.find((s) => s.id === id).label}`);
	}

	// "/" focuses the search from anywhere in the lobby, the shortcut every
	// browse surface has trained people to expect. Bound on the document because
	// the field is rarely what has focus; ignored while typing somewhere else, and
	// ignored entirely once the player is in a world (the same keys drive movement).
	_wireLobbyKeys() {
		document.addEventListener('keydown', (e) => {
			if (this.lobby.hidden || e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
			const t = e.target;
			if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
			e.preventDefault();
			this.searchInput.focus();
			this.searchInput.select();
		});
	}

	// ---------------------------------------------------------- site chrome
	// The platform-wide top nav + footer, so the lobby sits inside three.ws
	// instead of feeling like an island. Mirrors the home page's navigation
	// (Build / Discover / Embed / Learn / Labs) so links and ordering stay
	// consistent across the site; styled with the lobby's own dark tokens.
	_buildSiteNav() {
		const THREE_MARK = threeMarkSvg();

		// [href, title, description, badge?] per menu item.
		const GROUPS = [
			['Build', [
				['/create', 'Create agent', 'Avatar + brain wizard'],
				['/create/selfie', 'Selfie to avatar', 'One photo → rigged 3D avatar', 'New'],
				['/worlds', 'Worlds', 'Every coin is a 3D world, drop in & hang out', 'New'],
				['/app', 'Viewer', 'Drag-and-drop GLB'],
				['/playground', 'Playground', 'Viewer + environment + embed code'],
				['/voice', 'Voice Lab', 'Clone your voice · TTS playground', 'New'],
			]],
			['Discover', [
				['/features', 'Features', 'Everything an agent gets, interactive tour'],
				['/discover', 'ERC-8004 Agents', 'On-chain agent directory'],
				['/marketplace', 'Marketplace', 'Buy, sell & remix agents'],
				['/gallery', 'Avatar Gallery', 'Every public 3D avatar'],
				['/skills', 'Skills', 'Browse agent tool packs & capabilities', 'New'],
				['/bazaar', 'x402 Bazaar', 'Browse paid APIs and MCP tools'],
				['/community', 'Community', 'X, GitHub, and ways to get involved'],
			]],
			['Embed', [
				['/widgets', 'Widgets', 'Browse + customize embeddable widgets'],
				['/studio', 'Widget Studio', 'Pick avatar → copy snippet'],
				['/embed.html', 'Embed editor', 'Tune mode, size, position'],
				['/avatar-sdk', 'Avatar SDK', 'npm · web component · React · GLB upload', 'New'],
				['/docs#embedding', 'Embed docs', 'iframe + oEmbed'],
			]],
			['Learn', [
				['/docs', 'Docs', 'SDKs + API reference'],
				['/tutorials', 'Tutorials', 'Step-by-step guides'],
				['/brain', 'Brain', 'Claude · GPT · DeepSeek · Qwen · Llama', 'New'],
				['/chat', 'Chat', 'Talk to your agent'],
				['/pay', 'Pay', 'Agent payments, x402 + USDC', 'New'],
			]],
			['Labs', [
				['/launchpad', 'Launchpad Studio', 'Build a 3D launchpad · token · concierge', 'New'],
				['/mocap-studio', 'Mocap Studio', 'Record face → save clip → replay', 'New'],
				['/pose', 'Pose Studio', 'Click-to-pose mannequin + export PNG'],
				['/temporary', 'Walk', 'Walk your avatar, multiplayer + AR', 'New'],
				['/xr', 'XR', 'Place your avatar in the real world', 'New'],
				['/three-live', '$THREE Live', 'Protocol pulse, live trades in 3D', 'New'],
				['/pump-visualizer', 'Pump Visualizer', '3D view of trending tokens'],
				['/club', 'Pole Club', 'x402 micro-tip demo, $0.001 / dance', 'New'],
				['/play/agent-wallet', 'Agent Wallet', 'Your avatar pays an endpoint, USDC on Solana', 'New'],
			], true],
		];

		const item = ([href, title, desc, badge]) => el('a', { class: 'cc-nav-mi', href, role: 'menuitem' }, [
			el('span', { class: 'cc-nav-mi-t' }, [title, badge ? el('span', { class: 'cc-nav-pill', text: badge }) : null]),
			el('span', { class: 'cc-nav-mi-d', text: desc }),
		]);

		const group = ([label, items, wide]) => el('div', { class: 'cc-nav-grp' }, [
			el('button', { type: 'button', class: 'cc-nav-trigger', 'aria-haspopup': 'true', 'aria-expanded': 'false' }, [
				label,
				el('span', { class: 'cc-nav-caret', 'aria-hidden': 'true', text: '▾' }),
			]),
			el('div', { class: 'cc-nav-pop' + (wide ? ' cc-nav-wide' : ''), role: 'menu', 'aria-label': label }, items.map(item)),
		]);

		// Mobile drawer mirrors the same destinations as a flat list.
		const drawerSections = GROUPS.map(([label, items]) => [
			el('div', { class: 'cc-dr-h', text: label }),
			...items.map(([href, title]) => el('a', { href, text: title })),
		]).flat();

		this.navDrawer = el('nav', { class: 'cc-nav-drawer', id: 'cc-nav-drawer', 'aria-label': 'Mobile', 'aria-hidden': 'true' }, [
			...drawerSections,
			el('div', { class: 'cc-dr-h', text: 'More' }),
			el('a', { href: '/pricing', text: 'Pricing' }),
			el('div', { class: 'cc-dr-sep' }),
			el('a', { href: '/login', text: 'Sign in' }),
			el('a', { class: 'cc-dr-console', href: '/dashboard', text: 'Console →' }),
		]);

		this.navToggle = el('button', { class: 'cc-nav-toggle', id: 'cc-nav-toggle', 'aria-label': 'Menu', 'aria-expanded': 'false' }, [
			el('span', { class: 'cc-nav-burger', 'aria-hidden': 'true', html: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/></svg>' }),
			el('span', { class: 'cc-nav-x', 'aria-hidden': 'true', html: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>' }),
		]);

		return el('header', { class: 'cc-nav' }, [
			el('div', { class: 'cc-nav-inner' }, [
				el('a', { class: 'cc-nav-brand', href: '/', 'aria-label': 'three.ws home', html: THREE_MARK + '<span>three.ws</span>' }),
				el('nav', { class: 'cc-nav-main', 'aria-label': 'Primary' }, [
					...GROUPS.map(group),
					el('a', { class: 'cc-nav-flat', href: '/pricing', text: 'Pricing' }),
				]),
				el('div', { class: 'cc-nav-end' }, [
					el('a', { class: 'cc-nav-signin', href: '/login', text: 'Sign in' }),
					el('a', { class: 'cc-nav-console', href: '/dashboard', text: 'Console →' }),
				]),
				this.navToggle,
			]),
			this.navDrawer,
		]);
	}

	_buildSiteFooter() {
		const link = (href, text) => el('a', { href, text, ...(href.startsWith('http') ? { target: '_blank', rel: 'noopener' } : {}) });
		return el('footer', { class: 'cc-foot' }, [
			el('div', { class: 'cc-foot-inner' }, [
				el('div', { class: 'cc-foot-copy', text: '© 2026 · three.ws · the 3D agent layer of the internet' }),
				el('div', { class: 'cc-foot-links' }, [
					link('/docs', 'Docs'),
					link('/pricing', 'Pricing'),
					link('/discover', 'Discover'),
					link('/dashboard/api', 'API'),
					link('https://github.com/nirholas/three.ws', 'GitHub'),
					link('mailto:support@three.ws', 'Contact'),
				]),
			]),
		]);
	}

	// Hover-to-open desktop dropdowns (click/keyboard for touch + a11y) plus the
	// mobile drawer toggle. Mirrors the home page's nav behavior.
	_wireNav() {
		const groups = [...this.lobby.querySelectorAll('.cc-nav-main .cc-nav-grp')];
		const hoverCapable = window.matchMedia('(hover: hover)').matches;
		const setOpen = (grp, on) => {
			grp.classList.toggle('cc-open', on);
			grp.querySelector('.cc-nav-trigger')?.setAttribute('aria-expanded', on ? 'true' : 'false');
		};
		const closeAll = (except) => groups.forEach((g) => { if (g !== except) setOpen(g, false); });

		groups.forEach((grp) => {
			const trigger = grp.querySelector('.cc-nav-trigger');
			if (!trigger) return;
			let closeTimer;
			trigger.addEventListener('click', (e) => {
				e.stopPropagation();
				if (hoverCapable) { closeAll(grp); setOpen(grp, true); return; }
				const willOpen = !grp.classList.contains('cc-open');
				closeAll(grp);
				setOpen(grp, willOpen);
			});
			if (hoverCapable) {
				grp.addEventListener('mouseenter', () => { clearTimeout(closeTimer); closeAll(grp); setOpen(grp, true); });
				grp.addEventListener('mouseleave', () => { closeTimer = setTimeout(() => setOpen(grp, false), 120); });
			}
			grp.querySelectorAll('.cc-nav-mi').forEach((a) => a.addEventListener('click', () => setOpen(grp, false)));
		});
		document.addEventListener('click', (e) => { if (!e.target.closest('.cc-nav-main .cc-nav-grp')) closeAll(); });
		document.addEventListener('keydown', (e) => {
			if (e.key !== 'Escape') return;
			const openGrp = this.lobby.querySelector('.cc-nav-main .cc-nav-grp.cc-open');
			if (openGrp) { setOpen(openGrp, false); openGrp.querySelector('.cc-nav-trigger')?.focus(); }
		});

		// Mobile drawer
		const toggle = this.navToggle, drawer = this.navDrawer;
		const isOpen = () => drawer.classList.contains('cc-open');
		const setDrawer = (open) => {
			toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
			drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
			drawer.classList.toggle('cc-open', open);
		};
		toggle.addEventListener('click', () => setDrawer(!isOpen()));
		drawer.addEventListener('click', (e) => { if (e.target.closest('a')) setDrawer(false); });
		document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { setDrawer(false); toggle.focus(); } });
		window.addEventListener('resize', () => { if (window.innerWidth > 880 && isOpen()) setDrawer(false); });
	}

	// Make the avatar bar a drop target for a local .glb. Only reacts to file
	// drags so a stray text/element drag never lights it up.
	_wireGlbDrop() {
		const bar = this.avatarBar;
		const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
		const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
		bar.addEventListener('dragenter', (e) => { stop(e); if (hasFiles(e)) bar.classList.add('cc-drag'); });
		bar.addEventListener('dragover', (e) => { stop(e); if (hasFiles(e)) { e.dataTransfer.dropEffect = 'copy'; bar.classList.add('cc-drag'); } });
		bar.addEventListener('dragleave', (e) => { stop(e); if (!bar.contains(e.relatedTarget)) bar.classList.remove('cc-drag'); });
		bar.addEventListener('drop', (e) => {
			stop(e);
			bar.classList.remove('cc-drag');
			const files = [...(e.dataTransfer?.files || [])];
			const glb = files.find((f) => /\.(glb|vrm)$/i.test(f.name)) || files[0];
			if (glb) this._handleGlbFile(glb);
		});
	}

	// Validate → upload → adopt a dropped/selected .glb as the player's avatar.
	async _handleGlbFile(file) {
		if (this._uploading) return;
		this._uploading = true;
		this._setUploadState('working', 'Checking your model…');
		try {
			await validateGlb(file);
			this._setUploadState('working', 'Uploading… 0%');
			const url = await uploadGlb(file, (p) => this._setUploadState('working', `Uploading… ${Math.round(p * 100)}%`));
			this._addUploadedAvatar(url, file.name);
			this._setUploadState('done', `“${file.name}” is now your avatar.`);
		} catch (err) {
			this._setUploadState('error', err?.message || 'Upload failed.');
		} finally {
			this._uploading = false;
		}
	}

	_setUploadState(state, msg) {
		this.uploadStatus.hidden = false;
		this.uploadStatus.setAttribute('data-state', state);
		this.uploadStatus.textContent = msg;
		this.uploadBtn.classList.toggle('cc-busy', state === 'working');
		clearTimeout(this._uploadStatusTimer);
		if (state === 'done' || state === 'error') {
			const ttl = state === 'done' ? 4000 : 7000;
			this._uploadStatusTimer = setTimeout(() => { this.uploadStatus.hidden = true; }, ttl);
		}
	}

	// Surface the uploaded avatar as its own selected chip (replacing any prior
	// upload chip) and make it the active avatar.
	_addUploadedAvatar(url, name) {
		if (this._uploadChip?.isConnected) this._uploadChip.remove();
		const chip = el('button', {
			class: 'cc-avatar-chip cc-avatar-loading cc-avatar-upload',
			title: name || 'Your uploaded avatar', 'aria-label': name || 'Your uploaded avatar',
			onclick: () => this._setAvatar(url, false),
		}, [el('span', { class: 'cc-avatar-glyph', text: '🧑‍🎨' })]);
		chip._url = url;
		this._uploadChip = chip;
		this.presetRow.insertBefore(chip, this.presetRow.firstChild);
		this._renderChipPreview(chip, { url, label: name || 'Your avatar' });
		this._setAvatar(url, false);
	}

	// ---------------------------------------------------------- create avatar
	// The complete in-lobby creation workflow. A method chooser opens over the
	// lobby; each method ends with a real GLB the player can drop in with:
	//   • Create     → the in-app avatar creator (design from scratch / from a
	//                  photo). Anonymous, exports a GLB Blob we adopt instantly.
	//   • Upload     → reuse the bar's validated .glb upload.
	//   • Studio     → the full sculpt/outfit builder at /create/studio (richer,
	//                  saves to your three.ws account). Opens in a new tab.
	// Confine Tab/Shift+Tab focus to an open modal so keyboard focus can't walk
	// out to the obscured lobby behind an aria-modal dialog. Returns a release
	// function the close path calls; pair with restoring focus to the opener.
	_trapFocus(container) {
		const SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
		const handler = (e) => {
			if (e.key !== 'Tab') return;
			const items = [...container.querySelectorAll(SEL)].filter((n) => n.offsetParent !== null);
			if (!items.length) return;
			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement;
			if (e.shiftKey && (active === first || !container.contains(active))) { e.preventDefault(); last.focus(); }
			else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
		};
		container.addEventListener('keydown', handler);
		return () => container.removeEventListener('keydown', handler);
	}

	_openCreate() {
		if (this._createModal) return;

		const card = (icon, title, desc, badge, onActivate) => {
			const c = el('button', {
				type: 'button', class: 'cc-create-card',
				onclick: () => onActivate(),
			}, [
				el('span', { class: 'cc-create-card-ico', 'aria-hidden': 'true', text: icon }),
				el('span', { class: 'cc-create-card-body' }, [
					el('span', { class: 'cc-create-card-title' }, [
						document.createTextNode(title),
						badge ? el('span', { class: 'cc-create-card-badge', text: badge }) : null,
					]),
					el('span', { class: 'cc-create-card-desc', text: desc }),
				]),
				el('span', { class: 'cc-create-card-arrow', 'aria-hidden': 'true', text: '→' }),
			]);
			return c;
		};

		const cards = el('div', { class: 'cc-create-methods' }, [
			card('✦', 'Design your avatar', 'Build a 3D character from scratch or from a selfie, then drop straight into the world. No sign-in needed.', 'Recommended', () => this._launchEditor()),
			card('⬆', 'Upload a model', 'Already have a .glb or .vrm from Blender, Mixamo, VRoid, or any avatar tool? Bring it in.', '', () => { this._closeCreate(); this.uploadFile.click(); }),
			card('✨', 'Advanced studio', 'Sculpt face & body, layer outfits and accessories, and save it to your three.ws account.', 'Opens in a new tab', () => { window.open('/create/studio', '_blank', 'noopener'); this._closeCreate(); }),
		]);

		const closeBtn = el('button', { type: 'button', class: 'cc-create-close', 'aria-label': 'Close', text: '×', onclick: () => this._closeCreate() });
		const modal = el('div', {
			class: 'cc-create-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cc-create-title',
		}, [
			el('div', { class: 'cc-create-head' }, [
				el('div', {}, [
					el('h2', { id: 'cc-create-title', class: 'cc-create-title', text: 'Create your avatar' }),
					el('p', { class: 'cc-create-sub', text: 'However you make it, your avatar is ready to play the moment it’s done.' }),
				]),
				closeBtn,
			]),
			cards,
		]);
		const overlay = el('div', { class: 'cc-create-overlay', onclick: (e) => { if (e.target === overlay) this._closeCreate(); } }, [modal]);

		this._createModal = overlay;
		this._createKeyHandler = (e) => {
			if (e.key === 'Escape') { e.stopPropagation(); this._closeCreate(); }
		};
		document.addEventListener('keydown', this._createKeyHandler, true);
		document.body.appendChild(overlay);
		this._createTrapRelease = this._trapFocus(overlay);
		// Animate in on the next frame and move focus into the dialog.
		requestAnimationFrame(() => {
			overlay.classList.add('cc-on');
			cards.querySelector('.cc-create-card')?.focus();
		});
	}

	_closeCreate() {
		const overlay = this._createModal;
		if (!overlay) return;
		this._createModal = null;
		if (this._createKeyHandler) {
			document.removeEventListener('keydown', this._createKeyHandler, true);
			this._createKeyHandler = null;
		}
		if (this._createTrapRelease) { this._createTrapRelease(); this._createTrapRelease = null; }
		overlay.classList.remove('cc-on');
		const done = () => overlay.remove();
		overlay.addEventListener('transitionend', done, { once: true });
		setTimeout(done, 260); // fallback if transitionend never fires
		this.createBtn.focus();
	}

	// Open the in-app avatar creator (Studio builder + photo editor) in a modal.
	// On export it hands us a GLB Blob, which we adopt as the active avatar.
	async _launchEditor() {
		this._closeCreate();
		this.createBtn.classList.add('cc-busy');
		try {
			const { AvatarCreator } = await import('../avatar-creator.js');
			this._creator?.dispose?.();
			this._creator = new AvatarCreator(document.body, (blob, meta = {}) => {
				this._adoptCreatedAvatar(blob, meta);
			});
			await this._creator.openDefaultEditor();
		} catch (err) {
			log.warn('[coincommunities] avatar creator failed to open:', err?.message);
			this.toast('Couldn’t open the avatar creator. Try uploading a .glb instead.', 'warn');
		} finally {
			this.createBtn.classList.remove('cc-busy');
		}
	}

	// Stage a freshly-created GLB locally (instant self-preview), surface it as the
	// selected chip, and make the guest sentinel the active avatar. The world reads
	// the sentinel, shows it to the creator immediately from the local blob, and
	// uploads it in the background so peers can load it too (see play-handoff.js).
	async _adoptCreatedAvatar(blob, meta = {}) {
		this._setUploadState('working', 'Saving your new avatar…');
		try {
			// Pass the player's chosen name only if they set one, playAs persists it as
			// the display name, and we don't want a placeholder shadowing the guest-id
			// fallback the world assigns to unnamed players.
			const name = this.getName();
			await playAs({ blob, name, source: meta.provider || 'three-ws-create', dest: null });
			this._addCreatedChip(name || 'My avatar');
			this._setUploadState('done', 'Your avatar is ready, pick a community to drop in.');
			this.toast('Your avatar is ready, pick a community below to drop in.', 'info');
		} catch (err) {
			log.warn('[coincommunities] could not adopt created avatar:', err?.message);
			this._setUploadState('error', 'Couldn’t save your new avatar. Please try again.');
		}
	}

	// Surface the just-created avatar as its own selected chip (replacing any prior
	// one) and make the guest sentinel the active avatar. The chip starts with a
	// loading shimmer, then renders a real portrait of the new model, the sentinel
	// resolves to the locally-staged blob, so no upload round-trip is needed.
	_addCreatedChip(name) {
		if (this._createdChip?.isConnected) this._createdChip.remove();
		const chip = el('button', {
			class: 'cc-avatar-chip cc-avatar-loading cc-avatar-created',
			title: name || 'Your new avatar', 'aria-label': name || 'Your new avatar',
			onclick: () => this._setAvatar(GUEST_SENTINEL, false),
		}, [el('span', { class: 'cc-avatar-glyph', text: '✦' })]);
		chip._url = GUEST_SENTINEL;
		this._createdChip = chip;
		this.presetRow.insertBefore(chip, this.presetRow.firstChild);
		this._renderChipPreview(chip, { url: GUEST_SENTINEL, label: name || 'Your avatar' });
		this._setAvatar(GUEST_SENTINEL, false);
	}

	// Open the platform avatar gallery (your own avatars + the public gallery)
	// with live 3D previews, and adopt the chosen one. Lazy-loaded so the picker
	// and its model-viewer dependency aren't in the lobby's critical bundle.
	async _openGallery() {
		this.galleryBtn.classList.add('cc-busy');
		try {
			const { openAvatarPicker } = await import('../avatar-gallery-picker.js');
			const selected = await openAvatarPicker({
				source: 'both',
				showModes: false,
				title: 'Choose your avatar',
				ctaLabel: 'Use this avatar',
				selectedId: this._galleryChip?._avatarId || '',
			});
			if (selected) this._adoptGalleryAvatar(selected);
		} catch (err) {
			log.warn('[coincommunities] gallery picker failed:', err?.message);
		} finally {
			this.galleryBtn.classList.remove('cc-busy');
		}
	}

	// Surface a gallery pick as its own selected chip and make it the active
	// avatar. Stores the canonical avatar id when available (so the picker can
	// pre-select it next time); the scene resolves it to a loadable URL before
	// broadcasting to peers.
	_adoptGalleryAvatar(a) {
		const value = a.id || a.model_url;
		if (!value) return;
		if (this._galleryChip?.isConnected) this._galleryChip.remove();
		const chip = el('button', {
			class: 'cc-avatar-chip cc-avatar-loading cc-avatar-gallery',
			title: a.name || 'Your avatar', 'aria-label': a.name || 'Your avatar',
			onclick: () => this._setAvatar(value, false),
		}, [
			a.thumbnail_url
				? el('img', {
						src: proxiedImageURL(a.thumbnail_url, a.id || '', { width: 192 }), alt: a.name || 'Avatar', loading: 'lazy',
						// A stale thumbnail (e.g. a legacy OG key that 404s before the
						// avatar self-heals) shouldn't leave a broken-image icon: drop it
						// and let _renderChipPreview's live model render stand in. Removing
						// the node is also what makes the mobile skip-the-render path fall
						// back to a real render when the thumbnail turns out to be dead.
						onerror: (e) => { e.target.remove(); this._renderChipPreview(chip, { url: a.model_url || value, label: a.name || 'Your avatar' }); },
					})
				: el('span', { class: 'cc-avatar-glyph', text: '🧑' }),
		]);
		chip._url = value;
		chip._avatarId = a.id || '';
		this._galleryChip = chip;
		this.presetRow.insertBefore(chip, this.presetRow.firstChild);
		this._renderChipPreview(chip, { url: a.model_url || value, label: a.name || 'Your avatar', thumb: a.thumbnail_url });
		this._setAvatar(value, false);
	}

	async _renderPresets() {
		// Default + a few real three.ws community avatars (best-effort fetch).
		const presets = [{ label: 'Default', url: DEFAULT_AVATAR, icon: '🧍' }];
		try {
			const r = await fetch('/api/explore?source=avatar&only3d=1&limit=6', { headers: { accept: 'application/json' } });
			if (r.ok) {
				const data = await r.json();
				for (const it of (data.items || [])) {
					if (it.glbUrl) presets.push({ label: it.name || 'Avatar', url: it.glbUrl, thumb: it.image });
				}
			}
		} catch { /* offline / no API, default preset still works */ }
		this.presets = presets.slice(0, 7);
		this.presetRow.textContent = '';
		for (const p of this.presets) {
			// Start with the best instantly-available fallback (API thumbnail, else
			// emoji) so the chip is never empty, then render the real model and swap
			// it in. The chip carries a loading shimmer until a preview resolves.
			// Avatar art lives on third-party and R2 buckets that answer browser
			// requests with no CORS header, so Chrome's Opaque Response Blocking kills
			// the tile and logs ERR_BLOCKED_BY_ORB. Same-origin through /api/img, which
			// always answers with a valid image, the art actually shows and the console
			// stays clean. Same reason every other art surface on the platform proxies.
			const fallback = p.thumb
				? el('img', {
						src: proxiedImageURL(p.thumb, p.url || '', { width: 192 }), alt: p.label, loading: 'lazy',
						// Broken thumb: drop it and render the real model instead, so the
						// chip is never left empty (on mobile a live thumbnail is what lets
						// us skip that render in the first place).
						onerror: (e) => { e.target.remove(); this._renderChipPreview(chip, { ...p, thumb: null }); },
					})
				: el('span', { class: 'cc-avatar-glyph', text: p.icon || '🙂' });
			const chip = el('button', {
				class: 'cc-avatar-chip cc-avatar-loading' + (p.url === this.avatar ? ' cc-on' : ''),
				title: p.label,
				'aria-label': p.label,
				onclick: () => this._setAvatar(p.url, false),
			}, [fallback]);
			chip._url = p.url;
			this.presetRow.appendChild(chip);
			this._renderChipPreview(chip, p);
		}
	}

	// Render the real avatar model to a portrait and swap it into the chip,
	// replacing the placeholder. Leaves the fallback in place if rendering fails
	// (no WebGL, model load error) so the chip stays meaningful.
	async _renderChipPreview(chip, p) {
		// Rendering a chip means downloading the whole model: community avatars run
		// to 24 MB, and the row holds seven of them. On a phone that is up to a few
		// hundred megabytes of geometry bought for seven 160px portraits, on the
		// lobby screen, before the world has even loaded. When the API already gave
		// us a real portrait of the same avatar, the chip is already correct, so
		// keep it and skip the download. Desktop still gets the live render.
		if (p.thumb && this._touchPrimary()) {
			chip.classList.remove('cc-avatar-loading');
			return;
		}
		let dataUrl = null;
		try {
			dataUrl = await renderAvatarThumb(await resolveAvatarUrl(p.url));
		} catch { /* keep fallback */ }
		if (!chip.isConnected) return;
		chip.classList.remove('cc-avatar-loading');
		if (!dataUrl) {
			// Nothing rendered, so whatever the chip already shows is the best we
			// have. Unless it shows nothing: a thumbnail that 404s removes its own
			// <img> on the way here, and a chip with an empty box and no glyph is
			// indistinguishable from a broken one. Put the glyph back.
			if (!chip.childElementCount) {
				chip.appendChild(el('span', { class: 'cc-avatar-glyph', text: p.icon || '🙂' }));
			}
			return;
		}
		chip.textContent = '';
		chip.appendChild(el('img', { class: 'cc-avatar-render', src: dataUrl, alt: p.label }));
		// The portrait mirrors whichever chip is selected, and this render may be
		// the one it was waiting for.
		if (chip._url === this.avatar) this._syncPortrait();
	}

	// True on phones and tablets: a coarse pointer is the primary input. Used to
	// spend the memory and bandwidth budget differently, never to hide a feature.
	_touchPrimary() {
		return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
	}

	_setAvatar(url, fromCustom) {
		this.avatar = url || DEFAULT_AVATAR;
		lsSet('cc-avatar', this.avatar);
		for (const chip of this.presetRow.children) chip.classList.toggle('cc-on', chip._url === this.avatar);
		if (!fromCustom) this.customInput.value = (this.avatar === DEFAULT_AVATAR || !/^https?:|^\//.test(this.avatar)) ? '' : this.avatar;
		this._syncPortrait();
		this.h.onAvatarChange?.(this.avatar);
	}

	// Mirror the selected chip into the identity portrait. Deliberately a mirror
	// and not a second render: the chips already paid for the model download and
	// the offscreen render, so the summary costs one <img> src copy. A chip that
	// has not finished rendering yet leaves the glyph up and re-syncs when it does.
	_syncPortrait() {
		if (!this.idPortrait) return;
		const chip = [...this.presetRow.children].find((c) => c._url === this.avatar);
		const img = chip?.querySelector('img');
		const label = chip?.getAttribute('title') || 'Custom avatar';
		this.idSummary.textContent = this.avatar === DEFAULT_AVATAR ? 'Default avatar' : label;
		this.idPortrait.textContent = '';
		if (img?.src) {
			this.idPortrait.appendChild(el('img', { src: img.src, alt: '', class: img.className }));
		} else {
			this.idPortrait.appendChild(el('span', { class: 'cc-id-portrait-glyph', text: '🧍' }));
		}
	}

	getAvatar() { return this.customInput.value.trim() || this.avatar; }

	setCoinsLoading() {
		this.grid.textContent = '';
		// Keep the pinned official town visible while the live grid loads, so the
		// flagship never blinks out behind the skeletons.
		if (this.featured) this.grid.appendChild(this._coinCard(this.featured, true));
		for (let i = 0; i < 8; i++) {
			this.grid.appendChild(el('div', { class: 'cc-card cc-skeleton' }, [
				el('div', { class: 'cc-card-img' }),
				el('div', { class: 'cc-card-body' }, [el('div', { class: 'cc-card-name' }), el('div', { class: 'cc-card-meta' })]),
			]));
		}
	}

	setCoins(list) {
		this.coins = list || [];
		this._renderGrid();
		this._enrichCoins();
	}

	/** Pin an official town (e.g. the $THREE flagship) to the top of the lobby. */
	setFeatured(coin) { this.featured = coin && coin.mint ? coin : null; this._renderGrid(); }

	setCoinsError(retry) {
		this.grid.textContent = '';
		this.grid.appendChild(el('div', { class: 'cc-state' }, [
			el('span', { class: 'cc-state-ico', text: '📡' }),
			el('div', { text: 'Could not load live coins right now.' }),
			el('button', { text: 'Retry', onclick: retry }),
		]));
	}

	// Debounced live search: filter the loaded trending grid instantly for
	// snappy feedback, then query all of pump.fun so any coin (not just the
	// trending 30) becomes reachable as a world.
	_onSearchInput() {
		const q = this.searchInput.value.trim();
		this.searchClear.hidden = !this.searchInput.value;
		clearTimeout(this._searchTimer);
		if (q.length < 2) {
			this.searchResults = [];
			this.searching = false;
			this._searchSeq++; // invalidate any in-flight search
			this._renderGrid();
			return;
		}
		this._renderGrid(); // instant local filter
		this._searchTimer = setTimeout(() => this._remoteSearch(q), 280);
	}

	async _remoteSearch(query) {
		if (!this.h.onSearch) return;
		const seq = ++this._searchSeq;
		this.searching = true;
		this.searchError = false;
		this._renderGrid();
		let results = [];
		try {
			results = (await this.h.onSearch(query)) || [];
		} catch (err) {
			// A search outage is not "no matches": keep the states distinct so a
			// pump.fun blip renders as a retryable error, never as an empty result
			// that gaslights the player about the coin they just typed.
			log.warn('[coincommunities] search failed:', err?.message);
			if (seq === this._searchSeq) this.searchError = true;
		}
		if (seq !== this._searchSeq) return; // a newer query superseded this one
		this.searchResults = results;
		this.searching = false;
		this._renderGrid();
	}

	// Clear the query and put the full trending grid back. Shared by the field's
	// Escape key and the clear button, so both paths always agree.
	_clearSearch() {
		this.searchInput.value = '';
		this.searchClear.hidden = true;
		this.searchResults = [];
		this.searching = false;
		this.searchError = false;
		this._searchSeq++; // invalidate any in-flight search
		clearTimeout(this._searchTimer);
		this._renderGrid();
	}

	/** Live headcount for one coin's worlds, or 0 when nobody is measured inside. */
	_popFor(mint) {
		return (this.popByCoin && mint && this.popByCoin[mint]) || 0;
	}

	// Order the grid by the active sort. Ties fall back to market cap so the
	// ordering is total and the grid never reshuffles between identical renders.
	_sortCoins(list) {
		const cap = (c) => Number(c.marketCap) || 0;
		const born = (c) => Number(this.enriched.get(c.mint)?.createdAt) || 0;
		const sorted = [...list];
		if (this.sort === 'people') sorted.sort((a, b) => this._popFor(b.mint) - this._popFor(a.mint) || cap(b) - cap(a));
		else if (this.sort === 'mcap') sorted.sort((a, b) => cap(b) - cap(a));
		// Unknown launch times sort last rather than jumping to the top as 0.
		else if (this.sort === 'new') sorted.sort((a, b) => (born(b) || -Infinity) - (born(a) || -Infinity) || cap(b) - cap(a));
		return sorted;
	}

	_renderGrid() {
		const q = this.searchInput.value.trim().toLowerCase();
		const matches = (c) =>
			!q || (c.name || '').toLowerCase().includes(q) || (c.symbol || '').toLowerCase().includes(q) || (c.mint || '').toLowerCase().includes(q);
		// The pinned official town leads the grid when it matches the current query,
		// and is excluded from the regular list so it never appears twice.
		const featured = this.featured && matches(this.featured) ? this.featured : null;
		// Trending matches first, then live search hits not already on screen,
		// deduped by mint so a coin never appears twice.
		const list = this.coins.filter((c) => matches(c) && c.mint !== this.featured?.mint);
		const seen = new Set(list.map((c) => c.mint));
		if (this.featured) seen.add(this.featured.mint);
		for (const c of this.searchResults) {
			if (c.mint && !seen.has(c.mint)) { seen.add(c.mint); list.push(c); }
		}
		this._paintStats(list, featured);
		this.grid.textContent = '';
		if (!featured && !list.length) {
			if (this.searching) { this._renderSearching(); return; }
			if (this.searchError && q) {
				this.grid.appendChild(el('div', { class: 'cc-state' }, [
					el('span', { class: 'cc-state-ico', text: '📡' }),
					el('div', { text: 'Search is unavailable right now. Your coin may still exist; retry in a moment.' }),
					el('button', {
						text: 'Retry search',
						onclick: () => { this.searchError = false; this._remoteSearch(q); },
					}),
				]));
				return;
			}
			this.grid.appendChild(el('div', { class: 'cc-state' }, [
				el('span', { class: 'cc-state-ico', text: '🪙' }),
				el('div', { text: q ? 'No coins match, try a different name, symbol, or mint.' : 'No communities yet, be the first in!' }),
			]));
			return;
		}
		if (featured) this.grid.appendChild(this._coinCard(featured, true));
		for (const c of this._sortCoins(list)) this.grid.appendChild(this._coinCard(c, false));
		// Entrance: cards fade up in reading order, capped so a 50-card grid does
		// not crawl in. The delay is a custom property the stylesheet reads, and
		// the whole animation is off under prefers-reduced-motion.
		[...this.grid.children].forEach((card, i) => {
			card.style.setProperty('--cc-in-delay', `${Math.min(i * 22, 320)}ms`);
		});
		// Searching beyond the trending grid while results are already showing.
		if (this.searching) this.grid.appendChild(el('div', { class: 'cc-search-more' }, [
			el('span', { class: 'cc-spinner' }), document.createTextNode('Searching all of pump.fun…'),
		]));
	}

	// The hero counters and the result count over the grid. Only measured values
	// land here: the market-cap total sums the coins actually on screen, and the
	// headcount stat stays hidden until a real population read has arrived.
	_paintStats(list, featured) {
		const shown = list.length + (featured ? 1 : 0);
		const cap = list.reduce((sum, c) => sum + (Number(c.marketCap) || 0), 0) + (Number(featured?.marketCap) || 0);
		const q = this.searchInput.value.trim();
		this.feedCount.textContent = shown ? `${shown} ${shown === 1 ? 'world' : 'worlds'}${q ? ' matching' : ''}` : '';
		countUp(this.statWorlds, Number(this.statWorlds.dataset.v) || 0, shown, { format: (n) => String(Math.round(n)) });
		this.statWorlds.dataset.v = String(shown);
		countUp(this.statCap, Number(this.statCap.dataset.v) || 0, cap, { format: (n) => fmtMc(n) || '$0' });
		this.statCap.dataset.v = String(cap);
		if (this.popTotal !== null) {
			this.statPeopleWrap.hidden = false;
			countUp(this.statPeople, Number(this.statPeople.dataset.v) || 0, this.popTotal, { format: (n) => String(Math.round(n)) });
			this.statPeople.dataset.v = String(this.popTotal);
		}
	}

	// ------------------------------------------------------- live headcounts
	// Poll the matchmaker-backed population endpoint and paint the result on the
	// cards in place, without rebuilding the grid (a rebuild would drop hover and
	// keyboard focus every 20 seconds). A failed or unavailable read leaves the
	// last real numbers alone: the count is either measured or absent.
	_startPopulation() {
		this._readPopulation();
		this._popTimer = setInterval(() => {
			if (document.hidden || this.lobby.hidden) return;
			this._readPopulation();
		}, POPULATION_POLL_MS);
		// A tab that comes back after minutes away should not show a stale count
		// until the next tick.
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden && !this.lobby.hidden) this._readPopulation();
		});
	}

	async _readPopulation() {
		if (this._popBusy) return;
		this._popBusy = true;
		try {
			const r = await fetch(POPULATION_URL, { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error('HTTP ' + r.status);
			const body = await r.json();
			if (body?.ok !== true) return; // multiplayer server down: keep what we had
			this.popTotal = Math.max(0, Math.floor(Number(body.players) || 0));
			this.popByCoin = body.byCoin && typeof body.byCoin === 'object' ? body.byCoin : null;
			this._paintPopulation();
		} catch (err) {
			log.info('[coincommunities] population read failed:', err?.message);
		} finally {
			this._popBusy = false;
		}
	}

	_paintPopulation() {
		this._setPeopleSortAvailable(!!this.popByCoin);
		if (this.popTotal !== null && this.statPeopleWrap) {
			this.statPeopleWrap.hidden = false;
			countUp(this.statPeople, Number(this.statPeople.dataset.v) || 0, this.popTotal, { format: (n) => String(Math.round(n)) });
			this.statPeople.dataset.v = String(this.popTotal);
		}
		for (const card of this.grid.querySelectorAll('.cc-card[data-mint]')) {
			const pill = card.querySelector('.cc-card-pop');
			if (!pill) continue;
			const n = this._popFor(card.dataset.mint);
			pill.hidden = !n;
			if (n) {
				pill.querySelector('.cc-card-pop-n').textContent = String(n);
				pill.querySelector('.cc-card-pop-l').textContent = n === 1 ? 'person inside' : 'people inside';
			}
		}
		// "Most people" is an ordering over numbers that just changed.
		if (this.sort === 'people') this._renderGrid();
	}

	// ------------------------------------------------------- coin enrichment
	// Second read of the same trending feed for the fields the thin projection
	// drops (launch time, replies, bonding-curve completion). Best effort by
	// design: on failure the cards keep exactly the data they already had.
	async _enrichCoins() {
		if (this._enrichDone || this._enrichBusy) return;
		this._enrichBusy = true;
		try {
			const r = await fetch(ENRICH_URL, { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error('HTTP ' + r.status);
			const body = await r.json();
			const rows = Array.isArray(body) ? body : body?.data || [];
			for (const row of rows) {
				const mint = row?.mint || row?.address;
				if (!mint) continue;
				this.enriched.set(mint, {
					createdAt: Number(row.created_timestamp) || 0,
					replies: Math.max(0, Math.floor(Number(row.reply_count) || 0)),
					graduated: row.complete === true,
				});
			}
			this._enrichDone = this.enriched.size > 0;
			if (this._enrichDone) this._renderGrid();
		} catch (err) {
			log.info('[coincommunities] coin enrichment skipped:', err?.message);
		} finally {
			this._enrichBusy = false;
		}
	}

	// Build one lobby card. The featured (official) town gets a distinct frame, an
	// OFFICIAL badge, and a "home town" call to action so it reads as the flagship.
	_coinCard(c, featured) {
		const mc = fmtMc(c.marketCap);
		const sym = c.symbol ? '$' + c.symbol.toUpperCase().replace(/^\$/, '') : 'this coin';
		const liveBadge = featured
			? el('span', { class: 'cc-card-official', title: 'Official three.ws town' }, [
				el('span', { class: 'cc-card-official-ico', text: '◇' }),
				document.createTextNode('OFFICIAL'),
			])
			: el('span', { class: 'cc-card-live' }, [el('span', { class: 'cc-dot' }), document.createTextNode('LIVE')]);
		// Every coin has two worlds: the open General room (the card body) and a
		// gated Holders room. The badge is always visible so the holders' world is
		// discoverable on touch too; clicking it routes the player through the gate.
		const holdersBadge = el('button', {
			type: 'button', class: 'cc-card-holders',
			title: `Holders only, hold ${sym} to enter this coin’s gated world`,
			'aria-label': `Enter the ${sym} holders-only world`,
			onclick: (e) => { e.stopPropagation(); this.h.onEnter(c, 'holders'); },
		}, [el('span', { class: 'cc-card-holders-ico', 'aria-hidden': 'true', text: '🔒' }), document.createTextNode('Holders')]);
		// A real interactive element for keyboard and assistive tech: the grid is
		// the lobby's primary action, and a bare div with onclick left it
		// unreachable by Tab and invisible to screen readers.
		const cardName = c.name || (c.symbol ? '$' + c.symbol : 'this coin');
		const extra = this.enriched.get(c.mint);
		const age = fmtAge(extra?.createdAt);
		const fresh = !featured && extra?.createdAt > 0 && Date.now() - extra.createdAt < NEW_COIN_MS;
		const onCurve = !featured && extra !== undefined && extra.graduated === false;
		// Live headcount, painted here on first render and updated in place by
		// _paintPopulation on every poll. Hidden while it reads zero: an empty
		// world is the normal state and "0 people inside" is discouraging noise.
		const here = this._popFor(c.mint);
		const popPill = el('div', { class: 'cc-card-pop', hidden: !here }, [
			el('span', { class: 'cc-card-pop-dot', 'aria-hidden': 'true' }),
			el('strong', { class: 'cc-card-pop-n', text: String(here || 0) }),
			el('span', { class: 'cc-card-pop-l', text: here === 1 ? 'person inside' : 'people inside' }),
		]);
		// Whatever the artwork does, the card keeps an identity mark: the monogram
		// sits under the background image, so a dead IPFS gateway leaves the coin's
		// initial rather than an empty grey box.
		const mono = el('span', { class: 'cc-card-mono', 'aria-hidden': 'true', text: (c.symbol || c.name || '?').replace(/^\$/, '').charAt(0).toUpperCase() });
		return el('div', {
			class: 'cc-card' + (featured ? ' cc-card-featured' : ''),
			role: 'button', tabindex: '0', 'data-mint': c.mint || '',
			'aria-label': `Enter the ${cardName} community world`,
			onclick: () => this.h.onEnter(c, ''),
			onkeydown: (e) => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.h.onEnter(c, ''); }
			},
		}, [
			// Badges anchor to the artwork on a regular card, where the art IS the
			// card's top edge. On the featured hero the art is only the left ~38%,
			// so anchoring there stranded the Holders badge in the middle of the
			// card, floating over the seam. Hang them off the card instead, which
			// is also position:relative, so they land on its real top corners.
			// The monogram is a layer BELOW the artwork, not a fallback swapped in on
			// error: a CSS background cannot report a load failure, so the mark simply
			// stays behind the image and shows through when there is no image to paint.
			el('div', { class: 'cc-card-img' }, [
				mono,
				el('div', { class: 'cc-card-art', style: cssBgImage(c.image) }),
				...(featured ? [] : [liveBadge, holdersBadge, popPill]),
			]),
			el('div', { class: 'cc-card-body' }, [
				el('div', { class: 'cc-card-name', text: c.name || 'Unnamed coin' }),
				el('div', { class: 'cc-card-meta' }, [
					el('span', { class: 'cc-card-sym', text: c.symbol ? '$' + c.symbol : '' }),
					mc ? el('span', { text: mc + ' mcap' }) : null,
					age ? el('span', { class: 'cc-card-age', text: age }) : null,
				]),
				// Signals worth one glance, and only the ones that actually separate this
				// coin from its neighbours. A completed bonding curve is true of nearly
				// everything on a market-cap-ranked feed, so a badge for it said nothing
				// on 28 cards out of 30; the rare, useful state is the inverse, a coin
				// still on its curve. Replies say how loud the coin's own board is.
				(fresh || onCurve || extra?.replies)
					? el('div', { class: 'cc-card-tags' }, [
						fresh ? el('span', { class: 'cc-tag cc-tag-new', title: 'Launched in the last 24 hours', text: 'NEW' }) : null,
						onCurve ? el('span', { class: 'cc-tag', title: 'Still on its pump.fun bonding curve, not graduated to a DEX yet', text: 'On curve' }) : null,
						extra?.replies ? el('span', { class: 'cc-tag cc-tag-quiet', title: `${extra.replies} replies on this coin’s pump.fun board`, text: `${fmtCompact(extra.replies)} replies` }) : null,
					])
					: null,
				el('div', { class: 'cc-card-cta', text: featured ? 'Enter home town →' : 'Enter community →' }),
			]),
			...(featured ? [liveBadge, holdersBadge, popPill] : []),
		]);
	}

	_renderSearching() {
		this.grid.appendChild(el('div', { class: 'cc-state' }, [
			el('span', { class: 'cc-spinner cc-spinner-lg' }),
			el('div', { text: 'Searching all of pump.fun…' }),
		]));
	}

	// ---------------------------------------------------------------- holder gate
	// A coin's Holders world is gated: the player must prove they hold ≥ the floor
	// (default $8) of the coin. This overlay is a thin view over the scene's gate
	// state machine (coincommunities.js _passHolderGate), the scene drives us
	// through setHolderGate(state, data) and we report the player's choice back via
	// onHolderAction(action): 'signin' | 'wallet' | 'switch' | 'buy' | 'recheck' |
	// 'general' (continue this entry into the open world) | 'cancel'.
	openHolderGate(coin) {
		if (this._gate) return; // already open, the scene re-uses it across states
		this._gateBody = el('div', { class: 'cc-gate-body' });
		const modal = el('div', {
			class: 'cc-gate-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Holder verification',
		}, [
			el('div', { class: 'cc-gate-head' }, [
				el('span', { class: 'cc-gate-tag', text: '🔒 Holders only' }),
				el('button', {
					type: 'button', class: 'cc-gate-x', 'aria-label': 'Cancel', text: '×',
					onclick: () => this.h.onHolderAction?.('cancel'),
				}),
			]),
			this._gateBody,
		]);
		// Backdrop click and Escape both read as "I don't want in" → cancel, which
		// drops the player back to the lobby (free to enter the open world instead).
		const overlay = el('div', {
			class: 'cc-gate-overlay',
			onclick: (e) => { if (e.target === overlay) this.h.onHolderAction?.('cancel'); },
		}, [modal]);
		this._gate = overlay;
		this._gateKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.h.onHolderAction?.('cancel'); } };
		document.addEventListener('keydown', this._gateKey, true);
		// Remember who opened the gate so focus returns there when it closes.
		this._gateOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		document.body.appendChild(overlay);
		this._gateTrapRelease = this._trapFocus(overlay);
		requestAnimationFrame(() => {
			overlay.classList.add('cc-on');
			(modal.querySelector('.cc-gate-x') || modal).focus?.();
		});
	}

	closeHolderGate() {
		const o = this._gate;
		if (!o) return;
		this._gate = null;
		this._gateBody = null;
		if (this._gateKey) { document.removeEventListener('keydown', this._gateKey, true); this._gateKey = null; }
		if (this._gateTrapRelease) { this._gateTrapRelease(); this._gateTrapRelease = null; }
		if (this._gateOpener?.isConnected) this._gateOpener.focus();
		this._gateOpener = null;
		o.classList.remove('cc-on');
		const done = () => o.remove();
		o.addEventListener('transitionend', done, { once: true });
		setTimeout(done, 280); // fallback if transitionend never fires
	}

	// Reveal the creator-only gate control once the server confirms ownership.
	setWorldCreator(isCreator) {
		if (this.gateBtn) this.gateBtn.hidden = !isCreator;
	}

	// Friends HUD state (W09). The badge shows unread DMs (capped at 9+ so it never
	// widens the button); `setFriendsOpen` keeps aria-expanded honest for screen
	// readers and lets CSS mark the button active while the panel is up.
	setFriendsUnread(count) {
		if (!this.friendsBadge) return;
		const n = Number(count) || 0;
		this.friendsBadge.textContent = n > 9 ? '9+' : String(n);
		this.friendsBadge.hidden = n <= 0;
		if (this.friendsBtn) {
			this.friendsBtn.setAttribute(
				'aria-label',
				n > 0 ? `Open friends panel, ${n} unread message${n === 1 ? '' : 's'}` : 'Open friends panel',
			);
		}
	}

	setFriendsOpen(open) {
		if (!this.friendsBtn) return;
		this.friendsBtn.setAttribute('aria-expanded', String(!!open));
		this.friendsBtn.classList.toggle('is-active', !!open);
	}

	// Avatar-switcher drawer state: keeps the HUD button's aria-expanded honest
	// and lets CSS mark it active while the panel is up.
	setAvatarPanelOpen(open) {
		if (!this.avatarBtn) return;
		this.avatarBtn.setAttribute('aria-expanded', String(!!open));
		this.avatarBtn.classList.toggle('is-active', !!open);
	}

	// Mirror an avatar picked from the in-world switcher into the lobby bar's
	// state (chip highlight + custom field) WITHOUT firing onAvatarChange: the
	// scene already rebuilt the rig and broadcast the change, and re-firing the
	// handler would send it twice.
	reflectAvatar(value) {
		this.avatar = value || DEFAULT_AVATAR;
		lsSet('cc-avatar', this.avatar);
		for (const chip of this.presetRow.children) chip.classList.toggle('cc-on', chip._url === this.avatar);
		this.customInput.value = (this.avatar === DEFAULT_AVATAR || !/^https?:|^\//.test(this.avatar)) ? '' : this.avatar;
	}

	// Creator gate config (R24). A small modal where the coin's creator sets the
	// token amount a wallet must hold to enter the Holders world, or removes the
	// requirement. `onSave(minTokens)` returns a promise that resolves to the saved
	// config or rejects with a coded error; we drive the busy/error states off it.
	openGateConfig(coin, { minTokens = 0, unknown = false, onSave } = {}) {
		this.closeGateConfig();
		const sym = coin?.symbol ? '$' + String(coin.symbol).replace(/^\$/, '').toUpperCase() : 'this coin';
		const input = el('input', {
			type: 'number', min: '0', step: '1', inputmode: 'numeric',
			class: 'cc-gatecfg-input', value: minTokens > 0 ? String(minTokens) : '',
			placeholder: 'e.g. 1000000', 'aria-label': `Minimum ${sym} to enter the holders world`,
		});
		const errLine = el('p', { class: 'cc-gatecfg-err', hidden: !unknown });
		if (unknown) errLine.textContent = 'Couldn’t load the current gate, saving will overwrite it.';
		const hint = el('p', { class: 'cc-gatecfg-hint', text: `Leave blank to use the default ($-value) floor. Set a number to require that many ${sym} on-chain.` });
		const saveBtn = el('button', { type: 'button', class: 'cc-gate-btn cc-gate-primary', text: 'Save gate' });
		// "Remove gate" whenever a gate exists, or might exist (the read failed). Only
		// a confirmed-ungated world shows a plain "Cancel".
		const canRemove = minTokens > 0 || unknown;
		const clearBtn = el('button', {
			type: 'button', class: 'cc-gate-btn cc-gate-ghost',
			text: canRemove ? 'Remove gate' : 'Cancel',
		});
		const busy = (on) => {
			saveBtn.disabled = on; clearBtn.disabled = on; input.disabled = on;
			saveBtn.textContent = on ? 'Saving…' : 'Save gate';
		};
		const fail = (msg) => { errLine.textContent = msg; errLine.hidden = false; busy(false); };
		const commit = async (value) => {
			errLine.hidden = true; errLine.textContent = '';
			busy(true);
			try {
				await onSave?.(value);
				this.closeGateConfig();
				this.toast(value > 0 ? `Holders world now needs ${fmtCompact(value)} ${sym}.` : 'Holders gate removed, default floor applies.', 'success');
			} catch (err) {
				fail(err?.message || 'Couldn’t save the gate. Try again.');
			}
		};
		saveBtn.onclick = () => {
			const v = Math.floor(Number(input.value));
			if (!Number.isFinite(v) || v <= 0) return fail('Enter a positive number of tokens, or use Remove gate.');
			commit(v);
		};
		clearBtn.onclick = () => { if (canRemove) commit(0); else this.closeGateConfig(); };
		input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); } e.stopPropagation(); };

		const body = el('div', { class: 'cc-gate-body' }, [
			el('h3', { class: 'cc-gate-title', text: 'Holders world gate' }),
			el('p', { class: 'cc-gate-msg', text: `Require holding ${sym} to enter this coin’s Holders world.` }),
			el('label', { class: 'cc-gatecfg-row' }, [
				el('span', { class: 'cc-gatecfg-label', text: `Minimum ${sym}` }), input,
			]),
			hint, errLine,
			el('div', { class: 'cc-gate-actions' }, [saveBtn, clearBtn]),
		]);
		const modal = el('div', {
			class: 'cc-gate-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Holders world gate',
		}, [
			el('div', { class: 'cc-gate-head' }, [
				el('span', { class: 'cc-gate-tag', text: '🔑 Creator' }),
				el('button', { type: 'button', class: 'cc-gate-x', 'aria-label': 'Close', text: '×', onclick: () => this.closeGateConfig() }),
			]),
			body,
		]);
		const overlay = el('div', {
			class: 'cc-gate-overlay', onclick: (e) => { if (e.target === overlay) this.closeGateConfig(); },
		}, [modal]);
		this._gateCfg = overlay;
		this._gateCfgKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.closeGateConfig(); } };
		document.addEventListener('keydown', this._gateCfgKey, true);
		this._gateCfgOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		document.body.appendChild(overlay);
		this._gateCfgTrapRelease = this._trapFocus(overlay);
		requestAnimationFrame(() => { overlay.classList.add('cc-on'); input.focus(); });
	}

	closeGateConfig() {
		const o = this._gateCfg;
		if (!o) return;
		this._gateCfg = null;
		if (this._gateCfgKey) { document.removeEventListener('keydown', this._gateCfgKey, true); this._gateCfgKey = null; }
		if (this._gateCfgTrapRelease) { this._gateCfgTrapRelease(); this._gateCfgTrapRelease = null; }
		if (this._gateCfgOpener?.isConnected) this._gateCfgOpener.focus();
		this._gateCfgOpener = null;
		o.classList.remove('cc-on');
		const done = () => o.remove();
		o.addEventListener('transitionend', done, { once: true });
		setTimeout(done, 280);
	}

	// One invariant across every state below: a visitor who cannot clear the
	// holder floor, or who does not want to sign in, or whose check simply broke,
	// is always offered the open world ('general') rather than only a retry and a
	// Cancel back to the lobby. Someone arriving from a shared link came to see a
	// world, and the open one beside it is live for everyone, so a gate that can
	// only say no is a wall. Only 'checking' and 'granted' are transient enough to
	// need no exit.
	setHolderGate(state, data = {}) {
		if (!this._gate) this.openHolderGate(data);
		const body = this._gateBody;
		if (!body) return;
		const sym = data.symbol ? '$' + String(data.symbol).replace(/^\$/, '').toUpperCase() : 'this coin';
		const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
		const usd = '$' + round2(data.usd);
		// R24: a coin's creator can gate on a *token amount* instead of the USD floor.
		// When set, state the requirement and the player's holding in tokens of the
		// coin ("hold 1M $SYM"); otherwise fall back to the dollar floor.
		const tokenGated = Number(data.minTokens) > 0;
		const fmtAmt = (n) => fmtCompact(Number(n) || 0);
		const min = tokenGated
			? `${fmtAmt(data.minTokens)} ${sym}`
			: '$' + (data.minUsd ? round2(data.minUsd) : 8);
		const held = tokenGated ? `${fmtAmt(data.amount)} ${sym}` : usd;
		const btn = (label, action, variant = '') => el('button', {
			type: 'button', class: 'cc-gate-btn' + (variant ? ' ' + variant : ''),
			onclick: () => this.h.onHolderAction?.(action),
		}, [label]);
		const spin = () => el('div', { class: 'cc-gate-spin' }, [el('span', { class: 'cc-spinner cc-spinner-lg' })]);
		const title = (copy) => el('h3', { class: 'cc-gate-title', text: copy });
		const msg = (copy) => el('p', { class: 'cc-gate-msg', text: copy });
		const errLine = data.error ? el('p', { class: 'cc-gate-err', text: data.error }) : null;
		const actions = (...kids) => el('div', { class: 'cc-gate-actions' }, kids.filter(Boolean));

		let nodes;
		switch (state) {
			case 'checking':
				nodes = [spin(), title('Checking your holdings'), msg(`Pricing your ${sym} balance on-chain…`)];
				break;
			case 'working':
				nodes = [spin(), title('One moment'), msg(data.msg || 'Working…')];
				break;
			case 'granted':
				nodes = [el('div', { class: 'cc-gate-check', text: '✓' }), title('You’re in'), msg(`Verified ${held} of ${sym}. Welcome to the holders’ world.`)];
				break;
			case 'short':
				nodes = [
					el('div', { class: 'cc-gate-lock', text: '🔒' }),
					title('Holders only'),
					msg(`You hold ${held} of ${sym}. This world is for holders of ${min} or more.`),
					actions(
						btn(`Buy ${sym}`, 'buy', 'cc-gate-primary'),
						btn('I bought, re-check', 'recheck'),
						btn('Use a different wallet', 'switch'),
						btn('Enter the open world instead', 'general', 'cc-gate-ghost'),
					),
				];
				break;
			case 'unavailable':
				// Holder verification is down deployment-wide (cc_unconfigured).
				// Retrying or switching wallets cannot succeed, so lead with the
				// open world; keep one retry for when the service comes back.
				nodes = [
					el('div', { class: 'cc-gate-lock', text: '🛠' }),
					title('Holder check is offline'),
					msg(`We can’t verify holdings of ${sym} right now. That’s on our side, not yours, and your tokens are unaffected. The open world is live for everyone.`),
					actions(
						btn('Enter the open world', 'general', 'cc-gate-primary'),
						btn('Try again', 'recheck'),
						btn('Back to the lobby', 'cancel', 'cc-gate-ghost'),
					),
				];
				break;
			case 'auth':
				nodes = [
					el('div', { class: 'cc-gate-lock', text: '𝕏' }),
					title('Verify you’re a holder'),
					msg(`Sign in with X so we can check the wallet you hold ${sym} in. Your wallet is read server-side and never shared.`),
					errLine,
					actions(
						btn('Sign in with X', 'signin', 'cc-gate-primary'),
						btn('Enter the open world instead', 'general'),
						btn('Cancel', 'cancel', 'cc-gate-ghost'),
					),
				];
				break;
			case 'wallet':
				nodes = [
					el('div', { class: 'cc-gate-lock', text: '◎' }),
					title('Link your Solana wallet'),
					msg(`Connect the wallet that holds ${sym} and sign a message to link it. No transaction, no fee.`),
					errLine,
					actions(
						btn('Connect wallet', 'wallet', 'cc-gate-primary'),
						btn('Enter the open world instead', 'general'),
						btn('Cancel', 'cancel', 'cc-gate-ghost'),
					),
				];
				break;
			case 'error':
			default:
				nodes = [
					el('div', { class: 'cc-gate-lock', text: '!' }),
					title('Couldn’t verify'),
					msg(data.error || 'Something went wrong checking your holdings.'),
					actions(
						btn('Try again', 'recheck', 'cc-gate-primary'),
						btn('Enter the open world instead', 'general'),
						btn('Use a different wallet', 'switch'),
						btn('Cancel', 'cancel', 'cc-gate-ghost'),
					),
				];
				break;
		}
		body.replaceChildren(...nodes.filter(Boolean));
	}

	// ---------------------------------------------------------------- HUD
	_buildHud() {
		// The coin art comes from a shared link's ?image= (an /api/img proxy in front
		// of IPFS), so it can fail on a bad venue connection while everything else
		// about the world is fine. A blank 40px hole in the corner of the HUD reads
		// as broken; the monogram below stands in and keeps the banner whole.
		this.coinImg = el('img', {
			class: 'cc-coin-img', alt: '', loading: 'eager', decoding: 'async',
			onerror: () => { this.coinImg.hidden = true; this.coinMono.hidden = false; },
		});
		this.coinMono = el('span', { class: 'cc-coin-mono', 'aria-hidden': 'true', hidden: true, text: '' });
		this.coinName = el('div', { class: 'cc-coin-name', text: '' });
		this.coinSym = el('span', { class: 'cc-coin-sym', text: '' });
		this.onlineCount = el('span', { text: t('play.online', '{{n}} online', { n: 1 }) });
		this._online = 1;
		// Marks the gated Holders world so the player always knows which room they're
		// in and the floor they cleared. Hidden in the open General world.
		this.tierBadge = el('span', { class: 'cc-tier-badge', hidden: true });
		// Buy this coin from inside its own world, the most natural action in a
		// pump.fun community. Opens the native on-chain buy modal (lazy chunk).
		this.buyBtnLabel = el('span', { class: 'cc-buy-btn-text', text: 'Buy', 'data-i18n': 'play.buy' });
		this.buyBtn = el('button', {
			class: 'cc-buy-btn', type: 'button', title: 'Buy this coin',
			'data-i18n-attr': 'title:play.buy_title',
			onclick: () => this.h.onBuy?.(),
		}, [el('span', { class: 'cc-buy-btn-ico', 'aria-hidden': 'true', text: '⚡' }), this.buyBtnLabel]);
		// Creator-only (R24): set the token threshold to enter this coin's Holders
		// world. Hidden until the server confirms this player is the coin's creator
		// (build-perms snapshot); shown in both the General and Holders worlds.
		this.gateBtn = el('button', {
			class: 'cc-gate-cfg-btn', type: 'button', hidden: true,
			title: 'Set who can enter the Holders world', 'aria-label': 'Configure the holders gate',
			'data-i18n-attr': 'title:play.gate_title;aria-label:play.gate_aria',
			onclick: () => this.h.onConfigureGate?.(),
		}, [el('span', { class: 'cc-gate-cfg-ico', 'aria-hidden': 'true', text: '🔑' }), el('span', { class: 'cc-gate-cfg-text', text: 'Gate', 'data-i18n': 'play.gate' })]);
		// Open the cosmetics shop, browse + try cosmetics on your avatar live.
		this.shopBtn = el('button', {
			class: 'cc-shop-btn', type: 'button', title: 'Cosmetics: try looks on your avatar',
			'aria-label': 'Open cosmetics shop',
			'data-i18n-attr': 'title:play.shop_title;aria-label:play.shop_aria',
			onclick: () => this.h.onShop?.(),
		}, [el('span', { class: 'cc-shop-btn-ico', 'aria-hidden': 'true', text: '🛍️' }), el('span', { class: 'cc-shop-btn-text', text: 'Shop', 'data-i18n': 'play.shop' })]);
		// Change avatar without leaving the world: opens the in-world switcher
		// drawer (saved avatars, quick picks, gallery, upload, creator). Touch
		// equivalent of the V hotkey.
		this.avatarBtn = el('button', {
			class: 'cc-avatarbtn', type: 'button', title: 'Change your avatar (V)',
			'aria-label': 'Change your avatar', 'aria-expanded': 'false',
			'data-i18n-attr': 'title:play.avatar_title;aria-label:play.avatar_aria',
			onclick: () => this.h.onAvatarPanel?.(),
		}, [el('span', { class: 'cc-avatarbtn-ico', 'aria-hidden': 'true', text: '🧍' }), el('span', { class: 'cc-avatarbtn-text', text: 'Avatar', 'data-i18n': 'play.avatar' })]);
		// Open the "My Cosmetics" wardrobe, equip owned items, persists across worlds.
		this.wardrobeBtn = el('button', {
			class: 'cc-wardrobe-btn', type: 'button', title: 'My Cosmetics: equip your owned looks',
			'aria-label': 'Open my cosmetics wardrobe',
			'data-i18n-attr': 'title:play.wardrobe_title;aria-label:play.wardrobe_aria',
			onclick: () => this.h.onWardrobe?.(),
		}, [el('span', { class: 'cc-wardrobe-btn-ico', 'aria-hidden': 'true', text: '👗' }), el('span', { class: 'cc-wardrobe-btn-text', text: 'My Fits', 'data-i18n': 'play.wardrobe' })]);
		// Open the Jobs Board (W08 hooking W05), dailies, repeatable work, and
		// the co-op vault heist, the same board every quest-giver NPC opens.
		this.jobsBtn = el('button', {
			class: 'cc-jobs-btn', type: 'button', title: 'Jobs Board: dailies, courier runs, and the vault heist',
			'aria-label': 'Open the jobs board',
			'data-i18n-attr': 'title:play.jobs_title;aria-label:play.jobs_aria',
			onclick: () => this.h.onJobs?.(),
		}, [el('span', { class: 'cc-jobs-btn-ico', 'aria-hidden': 'true', text: '🎯' }), el('span', { class: 'cc-jobs-btn-text', text: 'Jobs', 'data-i18n': 'play.jobs' })]);
		// Friends panel (W09), the account-level social graph: requests, live
		// presence across every coin world, and DM threads. The badge carries the
		// unread-DM count so a message landing while the panel is closed still
		// shows; the button is also the touch equivalent of the J hotkey, since
		// mobile has no keyboard.
		this.friendsBadge = el('span', { class: 'cc-friends-badge', hidden: true });
		this.friendsBtn = el('button', {
			class: 'cc-friends-btn', type: 'button', title: 'Friends: presence and messages (J)',
			'aria-label': 'Open friends panel', 'aria-expanded': 'false',
			'data-i18n-attr': 'title:play.friends_title;aria-label:play.friends_aria',
			onclick: () => this.h.onFriends?.(),
		}, [
			el('span', { class: 'cc-friends-btn-ico', 'aria-hidden': 'true', text: '👥' }),
			el('span', { class: 'cc-friends-btn-text', text: 'Friends', 'data-i18n': 'play.friends' }),
			this.friendsBadge,
		]);
		const banner = el('div', { class: 'cc-coin-banner' }, [
			this.coinImg,
			this.coinMono,
			el('div', { class: 'cc-coin-info' }, [
				this.coinName,
				el('div', { class: 'cc-coin-sub' }, [
					this.coinSym,
					el('span', { class: 'cc-online' }, [el('span', { class: 'cc-dot' }), this.onlineCount]),
					this.tierBadge,
				]),
			]),
			this.friendsBtn,
			this.jobsBtn,
			this.avatarBtn,
			this.wardrobeBtn,
			this.shopBtn,
			this.gateBtn,
			this.buyBtn,
		]);

		const leave = el('button', { class: 'cc-leave', type: 'button', onclick: () => this.h.onLeave() }, [
			el('span', { 'aria-hidden': 'true', text: '←' }),
			el('span', { text: 'Communities', 'data-i18n': 'play.leave' }),
		]);

		this.statusText = el('span', { text: 'connecting…' });
		this.pingText = el('span', { class: 'cc-ping', hidden: true });
		const tryRetry = () => {
			if (['offline', 'failed'].includes(this.statusPill.getAttribute('data-state'))) this.h.onRetry?.();
		};
		this.statusPill = el('div', {
			id: 'cc-status', 'data-state': 'connecting',
			// Live region so screen readers announce connect/disconnect; becomes a
			// real keyboard-operable button only while a retry is possible (see
			// setStatus, which toggles tabindex + aria-label).
			role: 'status', 'aria-live': 'polite',
			onclick: tryRetry,
			onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tryRetry(); } },
		}, [el('span', { class: 'cc-dot' }), this.statusText, this.pingText]);

		// role=log + polite live region: an incoming line is the one thing in this
		// world a screen-reader player cannot see happening, so it has to be read
		// out. Polite (not assertive) so a busy room never talks over the player.
		this.chatLog = el('div', {
			class: 'cc-chat-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions text',
			'aria-label': 'Chat messages', 'data-i18n-attr': 'aria-label:play.chat_log_aria',
		});
		this.chatInput = el('input', {
			type: 'text', maxlength: '200', placeholder: 'Say something…',
			'aria-label': 'Chat message',
			'data-i18n-attr': 'placeholder:play.chat_placeholder;aria-label:play.chat_input_aria',
			onkeydown: (e) => {
				if (e.key === 'Enter') this._sendChat();
				else if (e.key === 'Escape') this.chatInput.blur();
				e.stopPropagation();
			},
		});
		this.chatUnread = el('span', { class: 'cc-chat-unread', hidden: true });
		this.chatChevron = el('span', { class: 'cc-chat-chevron', text: '▾' });
		const head = el('div', {
			class: 'cc-chat-head', role: 'button', tabindex: '0', 'aria-label': 'Toggle chat',
			'aria-expanded': 'true', 'aria-controls': 'cc-chat-body',
			'data-i18n-attr': 'aria-label:play.chat_toggle_aria',
			onclick: () => this.toggleChat(),
			onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.toggleChat(); } },
		}, [
			el('span', { class: 'cc-chat-title' }, [el('span', { class: 'cc-chat-ico', 'aria-hidden': 'true', text: '💬' }), el('span', { text: 'Chat', 'data-i18n': 'play.chat' })]),
			this.chatUnread,
			this.chatChevron,
		]);
		this.chatBody = el('div', { class: 'cc-chat-body', id: 'cc-chat-body' }, [
			this.chatLog,
			el('div', { class: 'cc-chat-input' }, [this.chatInput, el('button', { class: 'cc-chat-send', type: 'button', text: 'Send', 'data-i18n': 'play.send', onclick: () => this._sendChat() })]),
		]);
		this.chatHead = head;
		this.chat = el('div', { id: 'cc-chat', role: 'region', 'aria-label': 'Chat', 'data-i18n-attr': 'aria-label:play.chat' }, [head, this.chatBody]);
		// Default: collapsed on touch (small screens), open on desktop, unless the
		// user has expressed a preference before.
		const stored = lsGet('cc-chat-min');
		this._unread = 0;
		this.toggleChat(stored != null ? stored === '1' : matchMedia('(pointer: coarse)').matches);
		const chat = this.chat;

		this.emoteTray = el('div', { id: 'cc-emotes', role: 'toolbar', 'aria-label': 'Emotes', 'data-i18n-attr': 'aria-label:play.emotes' });
		// Reaction bar (R04): 6 emoji that broadcast a floating sprite above the sender's avatar.
		this.reactionBar = el('div', { id: 'cc-reactions', role: 'toolbar', 'aria-label': 'Reactions', 'data-i18n-attr': 'aria-label:play.reactions' });

		// Spatial voice toggle. Off by default (no mic until the player opts in);
		// the icon + label reflect every state (connecting / live / muted / blocked).
		// The SVG carries its own mute slash, shown via the button's data-state.
		this.voiceLabel = el('span', { class: 'cc-voice-label', text: 'Voice', 'data-i18n': 'play.voice' });
		this.voiceBtn = el('button', {
			class: 'cc-voice', type: 'button', 'data-state': 'off',
			'aria-label': 'Voice chat', title: 'Join voice: talk to people near you',
			'data-i18n-attr': 'aria-label:play.voice_aria;title:play.voice_title',
			onclick: () => this.h.onVoiceToggle?.(),
		}, [
			el('span', { class: 'cc-voice-ico', html:
				'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
				+ '<rect class="cc-voice-cap" x="9" y="2.5" width="6" height="11" rx="3"/>'
				+ '<path class="cc-voice-stand" d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/>'
				+ '<line class="cc-voice-slash" x1="4" y1="3.4" x2="20" y2="20.6"/>'
				+ '</svg>' }),
			this.voiceLabel,
		]);

		// Power saver, one shared preference across every three.ws 3D surface
		// (also read by /club). Caps the render loop at 30fps and drops to the
		// cheapest render state so laptops stay cool and quiet. The button both
		// toggles and mirrors the preference, so a change made on another page
		// (or another tab) is reflected here live.
		this.powerBtn = el('button', {
			class: 'cc-power-btn', type: 'button',
			'aria-pressed': getPowerSaver() ? 'true' : 'false',
			'aria-label': 'Power saver', title: 'Power saver: 30fps and lighter rendering, for a cooler, quieter machine',
			'data-i18n-attr': 'aria-label:play.eco_aria;title:play.eco_title',
			onclick: () => setPowerSaver(this.powerBtn.getAttribute('aria-pressed') !== 'true'),
		}, [
			el('span', { class: 'cc-power-ico', 'aria-hidden': 'true', text: '⚡' }),
			el('span', { class: 'cc-power-label', text: 'Eco', 'data-i18n': 'play.eco' }),
		]);
		onPowerSaverChange((on) => this.powerBtn.setAttribute('aria-pressed', on ? 'true' : 'false'));

		// Photo mode, capture the world (never the chrome) onto a share card.
		// Survives zen mode by design (see the zen block in coincommunities.css):
		// a clean world is exactly when someone wants the shot. The host loads
		// src/game/photo-mode.js on the first press, so nothing here costs a
		// player who never uses it.
		this.photoBtn = el('button', {
			id: 'cc-photo-btn', class: 'cc-photo-hud-btn', type: 'button', 'aria-pressed': 'false',
			'aria-label': 'Take a photo', title: 'Photo mode: capture this world as a share card (P)',
			onclick: () => this.h.onPhoto?.(),
		}, [
			el('span', { class: 'cc-photo-hud-ico', 'aria-hidden': 'true', html:
				'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
				+ '<path d="M3 8.2h3.4L8.1 5.4h7.8l1.7 2.8H21v10.4H3z"/><circle cx="12" cy="13.2" r="3.4"/>'
				+ '</svg>' }),
			el('span', { class: 'cc-photo-hud-label', text: 'Photo' }),
		]);

		// Zen mode: hide every overlay so the world renders clean. Same
		// body.is-zen contract as /walk; Z is the hotkey (wired by the host) and
		// the floating exit pill below is the only control left on screen.
		this.zenBtn = el('button', {
			class: 'cc-zen-btn', type: 'button', 'aria-pressed': 'false',
			'aria-label': 'Zen mode', title: 'Zen mode: hide every panel, just the world (Z)',
			'data-i18n-attr': 'aria-label:play.zen_aria;title:play.zen_title',
			onclick: () => this.h.onZen?.(),
		}, [
			el('span', { class: 'cc-zen-ico', 'aria-hidden': 'true', text: '🧘' }),
			el('span', { class: 'cc-zen-label', text: 'Zen', 'data-i18n': 'play.zen' }),
		]);
		this.zenExit = el('button', {
			id: 'cc-zen-exit', type: 'button',
			'aria-label': 'Show controls', title: 'Show controls (Z)',
			'data-i18n-attr': 'aria-label:play.show_ui_aria;title:play.show_ui_title',
			onclick: () => this.h.onZen?.(),
		}, [
			el('span', { 'aria-hidden': 'true', html:
				'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" focusable="false">'
				+ '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>'
				+ '</svg>' }),
			el('span', { text: 'Show UI', 'data-i18n': 'play.show_ui' }),
		]);
		document.body.appendChild(this.zenExit);

		// Dance floor button, hidden until the player steps onto the pad.
		this.danceBtnLabel = el('span', { class: 'cc-dance-label', text: 'Dance', 'data-i18n': 'play.dance' });
		this.danceBtn = el('button', {
			class: 'cc-dance-btn', type: 'button', hidden: true,
			'aria-label': 'Dance on the floor', title: 'Sync-dance with everyone on the floor',
			'data-i18n-attr': 'aria-label:play.dance_aria;title:play.dance_title',
			onclick: () => this.h.onDance?.(),
		}, [
			el('span', { class: 'cc-dance-ico', 'aria-hidden': 'true', text: '🪩' }),
			this.danceBtnLabel,
		]);

		const hint = el('div', {
			id: 'cc-hint', 'data-i18n-html': 'play.hint',
			// Duplicated by the canvas aria-label in pages/play.html, which is what a
			// screen reader reads; this strip is the sighted player's copy.
			'aria-hidden': 'true',
			html: '<kbd>W A S D</kbd> / drag-joystick to move · <kbd>drag</kbd> to look · scroll zoom · <kbd>Enter</kbd> chat · <kbd>Q</kbd> emotes · <kbd>I</kbd> inspect · <kbd>P</kbd> photo · <kbd>Z</kbd> zen',
		});

		// Touch-only control surface: it has no keyboard equivalent to offer and
		// nothing a screen reader can act on, so it stays out of both trees.
		this.joystick = el('div', { id: 'cc-joystick', 'aria-hidden': 'true' });

		this._buildTagHud();
		this._buildKingHud();
		// A labelled landmark, so a screen reader can jump straight to the world
		// controls instead of arrowing through the whole document.
		this.hud = el('div', { id: 'cc-hud', hidden: true, role: 'region', 'aria-label': 'World controls' }, [banner, leave, this.statusPill, this.voiceBtn, this.powerBtn, this.zenBtn, this.photoBtn, this.danceBtn, chat, this.emoteTray, this.reactionBar, hint, this.joystick]);
		document.body.appendChild(this.hud);
	}

	// ── Tag mini-game HUD (R08) ───────────────────────────────────────────────

	_buildTagHud() {
		// "Who's IT" strip at bottom-right, only shown when game is active (≥2 players).
		this._tagItName = el('span', { class: 'cc-tag-name' });
		this._tagLeaderboard = el('div', { class: 'cc-tag-leaderboard' });
		this._tagHud = el('div', { id: 'cc-tag-hud', hidden: true }, [
			el('div', { class: 'cc-tag-who' }, [
				el('span', { class: 'cc-tag-label', text: '🏃 IT: ' }),
				this._tagItName,
			]),
			this._tagLeaderboard,
		]);
		document.body.appendChild(this._tagHud);
		// Flash overlay shown when YOU become it.
		this._tagAlert = el('div', { id: 'cc-tag-alert', text: "YOU'RE IT! 🏃", 'aria-live': 'assertive' });
		document.body.appendChild(this._tagAlert);
	}

	/** Called on each 'tag:state' broadcast. `localId` lets us highlight our own row. */
	setTagState({ itId, leaderboard, localId }) {
		if (!itId) {
			this._tagHud.hidden = true;
			return;
		}
		this._tagHud.hidden = false;
		// Find the current it player's name from the leaderboard (or fall back to id).
		const itRow = leaderboard.find(r => r.id === itId);
		this._tagItName.textContent = itRow ? itRow.name : (itId.slice(0, 6) + '…');
		// Rebuild leaderboard rows.
		this._tagLeaderboard.innerHTML = '';
		for (const row of leaderboard) {
			const isMe = row.id === localId;
			const secs = Math.floor(row.timeMs / 1000);
			const left = secs >= 60 ? `${Math.floor(secs/60)}m ${secs%60}s` : `${secs}s`;
			this._tagLeaderboard.appendChild(
				el('div', { class: `cc-tag-row${isMe ? ' cc-tag-me' : ''}` }, [
					el('span', { class: 'cc-tag-row-name', text: row.name }),
					el('span', { class: 'cc-tag-row-time', text: left }),
				]),
			);
		}
	}

	/** Flash the "YOU'RE IT!" alert for 2.5 s then fade. */
	showYoureIt() {
		const a = this._tagAlert;
		a.classList.remove('cc-tag-alert--show');
		// Force reflow so removing and re-adding the class restarts the animation.
		void a.offsetWidth;
		a.classList.add('cc-tag-alert--show');
		clearTimeout(this._tagAlertTimer);
		this._tagAlertTimer = setTimeout(() => a.classList.remove('cc-tag-alert--show'), 2500);
	}

	/** Hide the tag HUD (called on leave). */
	hideTagHud() {
		if (this._tagHud) this._tagHud.hidden = true;
		if (this._tagAlert) this._tagAlert.classList.remove('cc-tag-alert--show');
	}

	// ── King of the Totem HUD (R07) ───────────────────────────────────────────
	// Top-centre panel: round countdown, who holds the totem, a live scoreboard
	// (your row highlighted, the king crowned), and a centre-screen winner banner.
	// Every value here is server-authoritative, the HUD only renders the last
	// snapshot and runs a local countdown between the per-second broadcasts.

	_buildKingHud() {
		this._kingTimer = el('div', { class: 'cc-king-timer', text: '1:30' });
		this._kingTimerCap = el('div', { class: 'cc-king-timer-cap', text: 'round time' });
		// aria-live on the status line only (not the whole panel) so a screen reader
		// announces phase changes, "X holds the totem", "Round over", without
		// reading the per-second countdown.
		this._kingPhase = el('div', { class: 'cc-king-phase', 'aria-live': 'polite' });
		this._kingBoard = el('div', { class: 'cc-king-board', role: 'list', 'aria-label': 'King of the Totem scoreboard' });
		this._kingEmpty = el('div', { class: 'cc-king-empty', hidden: true });
		this._kingHud = el('div', { id: 'cc-king-hud', hidden: true }, [
			el('div', { class: 'cc-king-head' }, [
				el('span', { class: 'cc-king-head-ico', 'aria-hidden': 'true', text: '👑' }),
				el('span', { class: 'cc-king-head-txt', text: 'King of the Totem' }),
			]),
			el('div', { class: 'cc-king-clock' }, [this._kingTimer, this._kingTimerCap]),
			this._kingPhase,
			this._kingBoard,
			this._kingEmpty,
		]);
		document.body.appendChild(this._kingHud);

		// Centre-screen winner flash, mirroring the tag "YOU'RE IT!" alert.
		this._kingBanner = el('div', { id: 'cc-king-banner', 'aria-live': 'assertive' });
		document.body.appendChild(this._kingBanner);
	}

	/** Drive the HUD from a server snapshot (round start/tick/end + join sync). */
	setKingState({ phase, now, endsAt, nextAt, kingId, winner, scores = [], localId }) {
		if (!this._kingHud) return;
		this._kingHud.hidden = false;
		// Anchor the local countdown to the SERVER clock: estimate the skew once per
		// snapshot so the timer keeps ticking smoothly between the per-second beats
		// (and through the intermission, which the server doesn't tick every second).
		this._kingClock = {
			phase,
			skew: (typeof now === 'number' ? now : Date.now()) - Date.now(),
			endsAt: endsAt || 0,
			nextAt: nextAt || 0,
		};
		this._renderKingTimer();
		if (!this._kingTimerInt) this._kingTimerInt = setInterval(() => this._renderKingTimer(), 250);

		if (phase === 'idle') {
			this._kingBoard.hidden = true;
			this._kingEmpty.hidden = false;
			this._kingEmpty.textContent = 'Waiting for players, step onto the gold ring at the totem to start a round.';
			this._kingPhase.textContent = 'Waiting for players';
			return;
		}

		this._kingEmpty.hidden = true;
		this._kingBoard.hidden = false;
		this._renderKingBoard(scores, kingId, localId);

		if (phase === 'intermission') {
			this._kingPhase.textContent = winner ? `🏆 ${winner.name} won the round` : 'Round over, nobody held it';
		} else {
			const kRow = kingId ? scores.find((s) => s.id === kingId) : null;
			this._kingPhase.textContent = kingId
				? (kingId === localId ? '👑 You hold the totem!' : `👑 ${kRow ? kRow.name : 'Someone'} holds the totem`)
				: 'Totem is open, claim it!';
		}
	}

	/** Re-render just the countdown from the stored server-clock anchor. */
	_renderKingTimer() {
		const c = this._kingClock;
		if (!c || !this._kingTimer) return;
		const serverNow = Date.now() + c.skew;
		if (c.phase === 'idle') {
			this._kingTimer.textContent = ', ';
			this._kingTimer.classList.remove('cc-king-low');
			this._kingTimerCap.textContent = 'waiting';
			return;
		}
		const target = c.phase === 'intermission' ? c.nextAt : c.endsAt;
		const secs = Math.max(0, Math.ceil((target - serverNow) / 1000));
		this._kingTimer.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
		this._kingTimer.classList.toggle('cc-king-low', c.phase === 'active' && secs <= 10);
		this._kingTimerCap.textContent = c.phase === 'intermission' ? 'next round' : 'round time';
	}

	/** Rebuild the scoreboard rows: sorted by the server, your row highlighted, the
	 *  current king crowned, the leader medalled. Caps at the rows the server sent. */
	_renderKingBoard(scores, kingId, localId) {
		this._kingBoard.innerHTML = '';
		if (!scores.length) {
			this._kingBoard.appendChild(el('div', { class: 'cc-king-row cc-king-row--empty', text: 'No players yet' }));
			return;
		}
		scores.forEach((s, i) => {
			const isMe = s.id === localId;
			const isKing = s.id === kingId;
			const tag = isKing ? '👑 ' : (i === 0 && s.score > 0 ? '🥇 ' : '');
			this._kingBoard.appendChild(
				el('div', { class: `cc-king-row${isMe ? ' cc-king-me' : ''}${isKing ? ' cc-king-holding' : ''}`, role: 'listitem' }, [
					el('span', { class: 'cc-king-rank', text: String(i + 1) }),
					el('span', { class: 'cc-king-name', text: tag + (isMe ? 'You' : s.name) }),
					el('span', { class: 'cc-king-score', text: String(s.score) }),
				]),
			);
		});
	}

	/** Flash the centre-screen winner banner for 5 s, then fade. */
	showKingWinner(winner, isMe) {
		const b = this._kingBanner;
		if (!b || !winner) return;
		b.innerHTML = '';
		b.appendChild(el('div', { class: 'cc-king-banner-crown', 'aria-hidden': 'true', text: '👑' }));
		b.appendChild(el('div', { class: 'cc-king-banner-title', text: isMe ? "You're the King of the Totem!" : `${winner.name} wins the round!` }));
		b.appendChild(el('div', { class: 'cc-king-banner-sub', text: `${winner.score} points` }));
		b.classList.remove('cc-king-banner--show');
		void b.offsetWidth; // restart the animation
		b.classList.add('cc-king-banner--show');
		clearTimeout(this._kingBannerTimer);
		this._kingBannerTimer = setTimeout(() => b.classList.remove('cc-king-banner--show'), 5000);
	}

	/** Hide the King HUD + banner and stop the local countdown (called on leave). */
	hideKingHud() {
		if (this._kingHud) this._kingHud.hidden = true;
		if (this._kingBanner) this._kingBanner.classList.remove('cc-king-banner--show');
		clearInterval(this._kingTimerInt);
		this._kingTimerInt = null;
		this._kingClock = null;
	}

	// ---------------------------------------------------------------- build structures (R20)
	// The structures toolbar that rides above the block hotbar while build mode is
	// on: pick a composite piece (wall / floor / stairs / doorway) instead of a
	// single block, rotate it, screenshot-and-share the build, or open this coin's
	// featured builds. The block hotbar itself lives in build-voxels.js; this panel
	// is the "structures" layer on top of it.
	_buildStructures() {
		this._activePiece = null;

		// "Block" is the default single-cell tool; each composite piece follows.
		const tools = [{ id: null, name: 'Block', icon: '▪', key: 'B' }, ...COMPOSITE_PIECES];
		this._pieceBtns = new Map();
		const pieceRow = el('div', { class: 'cc-st-pieces', role: 'radiogroup', 'aria-label': 'Build tool' },
			tools.map((p) => {
				const btn = el('button', {
					class: 'cc-st-piece' + (p.id === null ? ' cc-on' : ''), type: 'button',
					role: 'radio', 'aria-checked': p.id === null ? 'true' : 'false',
					title: p.id === null ? 'Single block' : `${p.name}, one-click structure (R rotates)`,
					'aria-label': p.name,
					onclick: () => this.h.onPickPiece?.(p.id),
				}, [
					el('span', { class: 'cc-st-piece-ico', 'aria-hidden': 'true', text: p.icon || '▦' }),
					el('span', { class: 'cc-st-piece-name', text: p.name }),
				]);
				this._pieceBtns.set(p.id, btn);
				return btn;
			}));

		this.rotateBtn = el('button', {
			class: 'cc-st-rotate', type: 'button', disabled: true,
			title: 'Rotate the piece a quarter-turn (R)', 'aria-label': 'Rotate piece',
			onclick: () => this.h.onRotateBuild?.(),
		}, [
			el('span', { class: 'cc-st-rotate-ico', 'aria-hidden': 'true', text: '⟳' }),
			el('span', { class: 'cc-st-rotate-deg', text: ROT_DEG[0] }),
		]);

		const shareBtn = el('button', {
			class: 'cc-st-action', type: 'button', title: 'Screenshot & share this build',
			onclick: () => this.h.onShareBuild?.(),
		}, [el('span', { 'aria-hidden': 'true', text: '📸' }), document.createTextNode('Share')]);

		const featuredBtn = el('button', {
			class: 'cc-st-action', type: 'button', title: 'Featured builds in this world',
			onclick: () => this.h.onOpenFeatured?.(),
		}, [el('span', { 'aria-hidden': 'true', text: '🏛' }), document.createTextNode('Builds')]);

		this.structures = el('div', { id: 'cc-structures', hidden: true, 'aria-label': 'Build structures' }, [
			pieceRow,
			el('div', { class: 'cc-st-tools' }, [this.rotateBtn, el('span', { class: 'cc-st-sep' }), shareBtn, featuredBtn]),
		]);
		document.body.appendChild(this.structures);
	}

	/** Show/hide the structures toolbar with build mode. */
	setBuildToolsVisible(on) { if (this.structures) this.structures.hidden = !on; }

	/** Reflect the armed composite piece (null = single block); toggles rotate. */
	setBuildPiece(id) {
		this._activePiece = id ?? null;
		for (const [pid, btn] of this._pieceBtns) {
			const on = pid === this._activePiece;
			btn.classList.toggle('cc-on', on);
			btn.setAttribute('aria-checked', on ? 'true' : 'false');
		}
		this.rotateBtn.disabled = this._activePiece == null;
	}

	/** Reflect the current quarter-turn rotation on the rotate button. */
	setBuildRotation(rot) {
		this.rotateBtn.querySelector('.cc-st-rotate-deg').textContent = ROT_DEG[((rot % 4) + 4) % 4];
	}

	// ---------------------------------------------------------------- build props (R18)
	// The props palette that rides beside the structures toolbar in build mode: a
	// scroll-row of placeable props (crates, lamps, arches, a stage…) plus a rotate
	// button for touch (desktop also has the R key). Selecting a prop arms the object
	// placement layer; selecting it again returns to voxel building. Deleting your own
	// props reuses the build HUD's place/break toggle (break + tap removes).
	_buildPropPalette() {
		this._activeProp = null;
		this._propBtns = new Map();
		// Gallery streaming state: every public community model is placeable, paged in
		// after the built-in props as the user scrolls / searches / hits "More".
		this._gallery = { cursor: null, loading: false, done: false, started: false, q: '' };

		const items = PROP_CATALOG.map((p) => this._propButton(p));

		// A thin rule separates the hand-authored props from the community gallery that
		// streams in after them; hidden until the first gallery model lands.
		this._galleryDivider = el('div', { class: 'cc-prop-divider', hidden: true, 'aria-hidden': 'true' });
		this._galleryMore = el('button', {
			class: 'cc-prop cc-prop-more', type: 'button', hidden: true,
			title: 'Load more community models', 'aria-label': 'Load more community models',
			onclick: () => this._loadGalleryPage(),
		}, [
			el('span', { class: 'cc-prop-ico', 'aria-hidden': 'true', text: '＋' }),
			el('span', { class: 'cc-prop-name', text: 'More' }),
		]);
		this.propRow = el('div', { class: 'cc-prop-row', role: 'radiogroup', 'aria-label': 'Place a prop' },
			[...items, this._galleryDivider, this._galleryMore]);

		this.propSearch = el('input', {
			type: 'search', class: 'cc-prop-search', placeholder: 'Search models…',
			'aria-label': 'Search community models', maxlength: '60', autocomplete: 'off',
			oninput: (e) => this._onGallerySearch(e.target.value),
			// Swallow keys so typing in the search box never steers the avatar/build hotkeys.
			onkeydown: (e) => e.stopPropagation(),
		});

		this.propRotateBtn = el('button', {
			class: 'cc-prop-rotate', type: 'button', disabled: true,
			title: 'Rotate the prop a quarter-turn (R)', 'aria-label': 'Rotate prop',
			onclick: () => this.h.onRotateProp?.(),
		}, [el('span', { 'aria-hidden': 'true', text: '⟳' })]);

		// P3.3: bring your own prop. Same drop-a-model gesture as the lobby's avatar
		// upload, pointed at the build palette: validated here, uploaded to storage,
		// then armed as the active prop so the very next click places it.
		this.propUploadFile = el('input', {
			type: 'file', accept: '.glb,.vrm,model/gltf-binary', class: 'cc-upload-file',
			onchange: (e) => { const f = e.target.files?.[0]; if (f) this.h.onUploadProp?.(f); e.target.value = ''; },
		});
		this.propUploadBtn = el('label', {
			class: 'cc-prop-upload', title: 'Upload your own .glb or .vrm model to place in this world',
		}, [
			el('span', { 'aria-hidden': 'true', text: '⬆' }),
			el('span', { class: 'cc-prop-upload-text', text: 'Upload' }),
			this.propUploadFile,
		]);

		// Forge-in-world: describe an item (or attach a reference photo) and the free
		// forge lane turns it into a real GLB prop, armed for placement like an upload.
		// The button toggles an inline form row; generation itself is driven by the
		// game (h.onForgeProp), which reports progress through the shared status strip.
		this.forgeBtn = el('button', {
			class: 'cc-prop-forge-btn', type: 'button', 'aria-expanded': 'false',
			title: 'Forge a new prop from a text prompt or photo (free)',
			onclick: () => this.toggleForge(),
		}, [
			el('span', { 'aria-hidden': 'true', text: '✨' }),
			el('span', { class: 'cc-prop-forge-text', text: 'Forge' }),
		]);
		this._buildForgeRow();

		const head = el('div', { class: 'cc-prop-head' }, [
			el('span', { class: 'cc-prop-title', text: 'Props' }),
			this.forgeBtn,
			this.propSearch,
			this.propUploadBtn,
			this.propRotateBtn,
		]);

		this._galleryStatus = el('div', { class: 'cc-prop-gstatus', role: 'status', 'aria-live': 'polite', hidden: true });

		this.propPalette = el('div', { id: 'cc-props', hidden: true, 'aria-label': 'Build props' }, [head, this.forgeRow, this.propRow, this._galleryStatus]);
		document.body.appendChild(this.propPalette);
	}

	// The inline forge form: prompt input, optional reference image, submit. Typing
	// swallows keys so WASD/build hotkeys never fire mid-sentence, matching the
	// gallery search box above it.
	_buildForgeRow() {
		this._forgeFile = null;
		this.forgePrompt = el('input', {
			type: 'text', class: 'cc-forge-prompt', maxlength: '300', autocomplete: 'off',
			placeholder: 'Describe an item: a glowing campfire, a neon arcade cabinet…',
			'aria-label': 'Describe the item to forge',
			onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') this._submitForge(); if (e.key === 'Escape') this.forgePrompt.blur(); },
		});
		this.forgeAttachFile = el('input', {
			type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'cc-upload-file',
			onchange: (e) => { this._setForgeFile(e.target.files?.[0] || null); e.target.value = ''; },
		});
		this._forgeAttachText = el('span', { class: 'cc-forge-attach-text', text: 'Photo' });
		this.forgeAttachBtn = el('label', {
			class: 'cc-forge-attach', title: 'Attach a reference photo (optional): the forge builds the item in it',
		}, [el('span', { 'aria-hidden': 'true', text: '📎' }), this._forgeAttachText, this.forgeAttachFile]);
		this.forgeAttachClear = el('button', {
			class: 'cc-forge-attach-clear', type: 'button', hidden: true,
			title: 'Remove the attached photo', 'aria-label': 'Remove the attached photo',
			onclick: () => this._setForgeFile(null),
		}, [el('span', { 'aria-hidden': 'true', text: '✕' })]);
		this.forgeGo = el('button', {
			class: 'cc-forge-go', type: 'button', title: 'Forge it (free, about 30 seconds)',
			onclick: () => this._submitForge(),
		}, ['Forge']);
		this.forgeRow = el('div', { class: 'cc-forge-row', hidden: true }, [
			this.forgePrompt, this.forgeAttachBtn, this.forgeAttachClear, this.forgeGo,
		]);
	}

	/** Show/hide the forge form. Pass a boolean to force a state. */
	toggleForge(force) {
		if (!this.forgeRow) return;
		const on = typeof force === 'boolean' ? force : this.forgeRow.hidden;
		this.forgeRow.hidden = !on;
		this.forgeBtn.classList.toggle('cc-on', on);
		this.forgeBtn.setAttribute('aria-expanded', String(on));
		if (on) this.forgePrompt.focus();
	}

	_setForgeFile(file) {
		this._forgeFile = file || null;
		this._forgeAttachText.textContent = file ? (file.name || 'photo').slice(0, 14) : 'Photo';
		this.forgeAttachBtn.classList.toggle('cc-on', !!file);
		this.forgeAttachClear.hidden = !file;
	}

	_submitForge() {
		if (this._forgeBusy) return;
		const prompt = this.forgePrompt.value.trim();
		const file = this._forgeFile;
		if (!prompt && !file) {
			this.setPropUploadStatus('Describe the item in a few words (or attach a photo).', true);
			this.forgePrompt.focus();
			return;
		}
		this.h.onForgeProp?.({ prompt, file });
	}

	/** Lock the forge form while a generation is in flight (one at a time). */
	setForgeBusy(on) {
		this._forgeBusy = !!on;
		if (!this.forgeGo) return;
		this.forgeGo.disabled = this._forgeBusy;
		this.forgeGo.textContent = this._forgeBusy ? 'Forging…' : 'Forge';
		this.forgePrompt.disabled = this._forgeBusy;
	}

	/** Reset the forge form after a successful generation. */
	clearForgeForm() {
		if (!this.forgeRow) return;
		this.forgePrompt.value = '';
		this._setForgeFile(null);
	}

	// One placeable-prop button. Built-in props show their emoji glyph; gallery models
	// show a real thumbnail (falling back to the glyph when a model has no render yet).
	_propButton(p) {
		const ico = p.thumbnail
			? el('img', { class: 'cc-prop-thumb', src: proxiedImageURL(p.thumbnail, p.id || '', { width: 192 }), alt: '', loading: 'lazy', decoding: 'async' })
			: el('span', { class: 'cc-prop-ico', 'aria-hidden': 'true', text: p.icon || '◆' });
		const btn = el('button', {
			class: 'cc-prop', type: 'button',
			role: 'radio', 'aria-checked': 'false',
			title: `${p.name}, place a prop (R rotates, break mode removes yours)`,
			'aria-label': p.name,
			onclick: () => this.h.onPickProp?.(this._activeProp === p.id ? null : p.id),
		}, [ico, el('span', { class: 'cc-prop-name', text: p.name })]);
		this._propBtns.set(p.id, btn);
		return btn;
	}

	/** Show/hide the props palette with build mode; first open kicks off the gallery. */
	setPropPaletteVisible(on) {
		if (!this.propPalette) return;
		this.propPalette.hidden = !on;
		if (on) this._startGallery();
	}

	/** Reflect the armed prop (null = voxel layer); toggles the rotate button. */
	setPropSelected(id) {
		this._activeProp = id ?? null;
		let foundActive = false;
		for (const [pid, btn] of this._propBtns) {
			const on = pid === this._activeProp;
			if (on) foundActive = true;
			btn.classList.toggle('cc-on', on);
			btn.setAttribute('aria-checked', on ? 'true' : 'false');
		}
		// A gallery prop can be armed before its button has paged in (e.g. armed by a
		// deep link); scroll the active button into view when it exists.
		if (foundActive) this._propBtns.get(this._activeProp)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
		if (this.propRotateBtn) this.propRotateBtn.disabled = this._activeProp == null;
	}

	// ---- community gallery as placeable props -------------------------------------
	// Kick the first gallery page when the palette first opens; cheap no-op after.
	_startGallery() {
		if (this._gallery.started) return;
		this._gallery.started = true;
		this._loadGalleryPage();
	}

	// Debounced search: re-query the gallery for models matching the typed text.
	_onGallerySearch(value) {
		const q = (value || '').trim();
		if (q === this._gallery.q) return;
		this._gallery.q = q;
		clearTimeout(this._gallerySearchT);
		this._gallerySearchT = setTimeout(() => this._resetGallery(), 260);
	}

	// Drop every streamed gallery button (keeping built-in props) and re-page from the
	// top, used when the search query changes.
	_resetGallery() {
		for (const [id, btn] of this._propBtns) {
			if (id.startsWith(GALLERY_PROP_PREFIX)) { btn.remove(); this._propBtns.delete(id); }
		}
		this._galleryDivider.hidden = true;
		this._gallery.cursor = null;
		this._gallery.done = false;
		this._loadGalleryPage();
	}

	// Fetch one page of public gallery models and stream them in as placeable props.
	async _loadGalleryPage() {
		const g = this._gallery;
		if (g.loading || g.done) return;
		g.loading = true;
		this._galleryMore.hidden = true;
		const first = !g.cursor;
		if (first) this._setGalleryStatus('Loading community models…', false);
		try {
			const params = new URLSearchParams({ limit: '48' });
			if (g.cursor) params.set('cursor', g.cursor);
			if (g.q) params.set('q', g.q);
			const r = await fetch(`/api/avatars/public?${params}`, { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error(`gallery ${r.status}`);
			const { avatars, next_cursor: next } = await r.json();
			const list = (avatars || []).filter((a) => a.id && (a.model_url || a.base_model_url));
			for (const a of list) this._appendGalleryItem(a);
			g.cursor = next || null;
			g.done = !g.cursor || list.length === 0;
			const count = this._galleryCount();
			this._galleryMore.hidden = g.done || !count;
			this._setGalleryStatus(count ? '' : (g.q ? `No models match “${g.q}”.` : 'No community models yet.'), false);
		} catch (e) {
			log.warn('[cc-ui] gallery load failed', e?.message || e);
			this._setGalleryStatus('Couldn’t load models, tap to retry.', true);
			this._galleryMore.hidden = true;
		} finally {
			g.loading = false;
		}
	}

	_galleryCount() {
		let n = 0;
		for (const id of this._propBtns.keys()) if (id.startsWith(GALLERY_PROP_PREFIX)) n++;
		return n;
	}

	// Register a gallery model with the world-object catalog (so it can be placed +
	// rendered) and add its button to the palette, just before the trailing "More".
	_appendGalleryItem(a) {
		const id = GALLERY_PROP_PREFIX + a.id;
		if (this._propBtns.has(id)) return;
		registerGalleryProp(a.id, { url: a.model_url || a.base_model_url, name: a.name, thumbnail: a.thumbnail_url });
		const btn = this._propButton({ id, name: a.name || 'Model', icon: '🧍', thumbnail: a.thumbnail_url });
		btn.classList.add('cc-prop-gallery');
		this.propRow.insertBefore(btn, this._galleryMore);
		this._galleryDivider.hidden = false;
	}

	// ---- player-uploaded props (P3.3) ---------------------------------------------
	/**
	 * Add an uploaded model to the palette as a first-class prop button and select
	 * it, so the next click in the world places it. Idempotent per model id, a
	 * re-upload of the same file re-selects the existing button instead of stacking
	 * duplicates.
	 * @param {{id:string,name?:string,thumbnail?:string}} def
	 */
	addUploadedProp(def) {
		if (!def?.id) return;
		if (!this._propBtns.has(def.id)) {
			const btn = this._propButton({ id: def.id, name: def.name || 'Your model', icon: '📤', thumbnail: def.thumbnail });
			btn.classList.add('cc-prop-upload-item');
			// Uploads sit with the hand-authored props, ahead of the gallery rule, so
			// the thing you just added is where you expect it: at the end of "yours".
			this.propRow.insertBefore(btn, this._galleryDivider);
		}
		this.setPropSelected(def.id);
	}

	/**
	 * One-line status for the prop upload (validating / progress / error), rendered
	 * in the same strip as the gallery status so the palette has one message area.
	 * @param {string} msg
	 * @param {boolean} [isError]
	 */
	setPropUploadStatus(msg, isError = false) {
		this._setGalleryStatus(msg, false);
		this._galleryStatus?.classList.toggle('cc-err', !!isError);
	}

	// Render a one-line gallery status (loading / empty / error). The error variant is
	// tappable to retry the failed page.
	_setGalleryStatus(msg, isError) {
		const s = this._galleryStatus;
		if (!s) return;
		s.textContent = msg || '';
		s.hidden = !msg;
		s.classList.toggle('cc-err', !!isError);
		if (isError) {
			s.setAttribute('role', 'button');
			s.tabIndex = 0;
			s.onclick = () => { this._gallery.done = false; this._loadGalleryPage(); };
		} else {
			s.setAttribute('role', 'status');
			s.removeAttribute('tabindex');
			s.onclick = null;
		}
	}

	// ---------------------------------------------------------------- share sheet (R20)
	// A modal that shows the captured screenshot and offers three ways to share the
	// build: copy a deep link back into this world, download the image, or publish
	// it to the coin's featured builds. The scene captures the shot and owns the
	// publish call; this only renders and routes the user's choice.
	openShareSheet({ image, link, blocks, coinName, canPublish }) {
		this.closeShareSheet();
		const titleInput = el('input', {
			type: 'text', maxlength: '60', class: 'cc-share-title',
			placeholder: 'Name your build (optional)', 'aria-label': 'Build name',
			onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') publish(); },
		});
		const status = el('div', { class: 'cc-share-status', role: 'status', 'aria-live': 'polite', hidden: true });
		const setStatus = (msg, kind) => {
			status.hidden = !msg;
			status.textContent = msg || '';
			status.setAttribute('data-kind', kind || '');
		};

		const copyBtn = el('button', { class: 'cc-share-btn', type: 'button' },
			[el('span', { 'aria-hidden': 'true', text: '🔗' }), document.createTextNode('Copy link')]);
		copyBtn.addEventListener('click', async () => {
			try { await navigator.clipboard.writeText(link); setStatus('Link copied to clipboard.', 'ok'); }
			catch { setStatus('Couldn’t copy, select and copy the link manually.', 'warn'); }
		});

		const dlBtn = el('a', {
			class: 'cc-share-btn', href: image, download: `threews-build-${Date.now()}.jpg`,
		}, [el('span', { 'aria-hidden': 'true', text: '⬇' }), document.createTextNode('Download')]);

		const publishBtn = el('button', {
			class: 'cc-share-btn cc-primary', type: 'button', disabled: !canPublish,
			title: canPublish ? 'Publish to this world’s featured builds' : 'Build something first',
		}, [el('span', { 'aria-hidden': 'true', text: '🏛' }), document.createTextNode('Publish to featured')]);
		const publish = async () => {
			if (publishBtn.disabled) return;
			publishBtn.disabled = true;
			setStatus('Publishing…', '');
			const res = await this.h.onPublishBuild?.({ image, title: titleInput.value });
			if (res?.ok) {
				setStatus('Published! It’s now in this world’s featured builds.', 'ok');
				publishBtn.textContent = '✓ Published';
			} else {
				setStatus(res?.error || 'Couldn’t publish, try again.', 'warn');
				publishBtn.disabled = false;
			}
		};
		publishBtn.addEventListener('click', publish);

		const closeBtn = el('button', {
			class: 'cc-share-close', type: 'button', 'aria-label': 'Close', title: 'Close',
			onclick: () => this.closeShareSheet(),
		}, ['✕']);

		const card = el('div', {
			class: 'cc-share-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Share your build',
			onclick: (e) => e.stopPropagation(),
		}, [
			closeBtn,
			el('div', { class: 'cc-share-head' }, [
				el('h3', { class: 'cc-share-h', text: 'Share your build' }),
				el('p', { class: 'cc-share-sub', text: `${coinName} · ${blocks.toLocaleString()} block${blocks === 1 ? '' : 's'}` }),
			]),
			el('div', { class: 'cc-share-shot' }, [el('img', { src: image, alt: 'Screenshot of your build' })]),
			titleInput,
			el('div', { class: 'cc-share-actions' }, [copyBtn, dlBtn, publishBtn]),
			status,
		]);
		this.shareSheet = el('div', { id: 'cc-share', onclick: () => this.closeShareSheet() }, [card]);
		this._shareKeydown = (e) => { if (e.key === 'Escape') this.closeShareSheet(); };
		document.addEventListener('keydown', this._shareKeydown);
		document.body.appendChild(this.shareSheet);
		requestAnimationFrame(() => this.shareSheet?.classList.add('cc-on'));
		(canPublish ? titleInput : copyBtn).focus();
	}

	closeShareSheet() {
		if (this._shareKeydown) { document.removeEventListener('keydown', this._shareKeydown); this._shareKeydown = null; }
		if (this.shareSheet) { this.shareSheet.remove(); this.shareSheet = null; }
	}

	// ---------------------------------------------------------------- featured builds (R20)
	// A per-coin surface of shared builds. Designed for every state: loading
	// (skeletons), empty (a clear call to be the first), error (retry), and a
	// populated grid whose cards link back into the world.
	openFeatured(coinLabel) {
		if (this.featuredPanel) { this.featuredPanel.remove(); this.featuredPanel = null; }
		this._featuredBody = el('div', { class: 'cc-fb-body' });
		const closeBtn = el('button', {
			class: 'cc-fb-close', type: 'button', 'aria-label': 'Close', title: 'Close',
			onclick: () => this.closeFeatured(),
		}, ['✕']);
		const card = el('div', {
			class: 'cc-fb-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Featured builds',
			onclick: (e) => e.stopPropagation(),
		}, [
			closeBtn,
			el('div', { class: 'cc-fb-head' }, [
				el('h3', { class: 'cc-fb-h', html: '🏛 Featured builds' }),
				el('p', { class: 'cc-fb-sub', text: `Creations shared in ${coinLabel}` }),
			]),
			this._featuredBody,
		]);
		this.featuredPanel = el('div', { id: 'cc-featured', onclick: () => this.closeFeatured() }, [card]);
		this._featuredKeydown = (e) => { if (e.key === 'Escape') this.closeFeatured(); };
		document.addEventListener('keydown', this._featuredKeydown);
		document.body.appendChild(this.featuredPanel);
		requestAnimationFrame(() => this.featuredPanel?.classList.add('cc-on'));
		closeBtn.focus();
	}

	closeFeatured() {
		if (this._featuredKeydown) { document.removeEventListener('keydown', this._featuredKeydown); this._featuredKeydown = null; }
		if (this.featuredPanel) { this.featuredPanel.remove(); this.featuredPanel = null; }
		this.h.onFeaturedClosed?.();
	}

	setFeaturedLoading() {
		if (!this._featuredBody) return;
		this._featuredBody.textContent = '';
		const grid = el('div', { class: 'cc-fb-grid', 'aria-busy': 'true' },
			Array.from({ length: 4 }, () => el('div', { class: 'cc-fb-skel' })));
		this._featuredBody.appendChild(grid);
	}

	setFeaturedError(retry) {
		if (!this._featuredBody) return;
		this._featuredBody.textContent = '';
		this._featuredBody.appendChild(el('div', { class: 'cc-fb-state' }, [
			el('span', { class: 'cc-fb-state-ico', 'aria-hidden': 'true', text: '⚠️' }),
			el('p', { class: 'cc-fb-state-msg', text: 'Couldn’t load featured builds.' }),
			el('button', { class: 'cc-fb-retry', type: 'button', text: 'Try again', onclick: () => retry?.() }),
		]));
	}

	setFeaturedBuilds(list) {
		if (!this._featuredBody) return;
		this._featuredBody.textContent = '';
		if (!list || list.length === 0) {
			this._featuredBody.appendChild(el('div', { class: 'cc-fb-state' }, [
				el('span', { class: 'cc-fb-state-ico', 'aria-hidden': 'true', text: '🏗️' }),
				el('p', { class: 'cc-fb-state-msg', text: 'No featured builds yet.' }),
				el('p', { class: 'cc-fb-state-hint', text: 'Build something, hit Share, and publish it to be the first.' }),
			]));
			return;
		}
		const grid = el('div', { class: 'cc-fb-grid' }, list.map((b) => this._featuredCard(b)));
		this._featuredBody.appendChild(grid);
	}

	_featuredCard(b) {
		const q = new URLSearchParams({ coin: b.mint || '' });
		if (b.coinName) q.set('name', b.coinName);
		if (b.coinSymbol) q.set('symbol', b.coinSymbol);
		const href = `/play?${q.toString()}`;
		const meta = [b.author ? `by ${b.author}` : null, b.blocks ? `${Number(b.blocks).toLocaleString()} blocks` : null, timeAgo(b.createdAt)]
			.filter(Boolean).join(' · ');
		return el('a', { class: 'cc-fb-item', href, title: 'Enter this world' }, [
			el('div', { class: 'cc-fb-thumb' }, [
				b.thumb ? el('img', { src: proxiedImageURL(b.thumb, b.id || b.coinMint || '', { width: 320 }), alt: b.title || 'Featured build', loading: 'lazy' })
					: el('div', { class: 'cc-fb-thumb-empty', 'aria-hidden': 'true', text: '🧱' }),
			]),
			el('div', { class: 'cc-fb-meta' }, [
				el('div', { class: 'cc-fb-title', text: b.title || 'Untitled build' }),
				el('div', { class: 'cc-fb-byline', text: meta }),
			]),
			el('span', { class: 'cc-fb-enter', 'aria-hidden': 'true', text: 'Enter →' }),
		]);
	}

	// Reflect the voice engine's state on the mic button: label, tooltip, and the
	// data-state hook the CSS uses to colour the icon / show the mute slash.
	setVoiceState(state) {
		if (!this.voiceBtn) return;
		const map = {
			off:        ['Voice',        'Join voice, talk to people near you'],
			connecting: ['Connecting…',  'Requesting microphone access…'],
			on:         ['Mic on',       'You’re live, click to mute'],
			muted:      ['Muted',        'Muted, click to unmute (you can still hear everyone)'],
			denied:     ['Mic blocked',  'Microphone blocked, allow it in your browser settings'],
			error:      ['Voice error',  'Couldn’t start voice, check your mic and try again'],
			unsupported:['No voice',     'Voice chat isn’t supported in this browser'],
		};
		const [label, title] = map[state] || map.off;
		this.voiceBtn.setAttribute('data-state', state);
		this.voiceLabel.textContent = label;
		this.voiceBtn.title = title;
		this.voiceBtn.disabled = state === 'unsupported';
		if (state !== 'on') this.voiceBtn.classList.remove('cc-voice-speaking');
	}

	// Pulse the mic button while the local player is actually speaking.
	setMicSpeaking(on) { this.voiceBtn?.classList.toggle('cc-voice-speaking', !!on); }

	// Show or hide the dance floor button (called when player steps on / off the pad).
	setOnFloor(on) {
		if (!this.danceBtn) return;
		this.danceBtn.hidden = !on;
		if (!on) this.setDancing(false);
	}

	// Mirror the zen state on both toggles (the HUD button and the exit pill).
	setZen(on) {
		this.zenBtn?.setAttribute('aria-pressed', on ? 'true' : 'false');
	}

	// Light the camera button while the photo preview is up, so the HUD says
	// where that card came from and pressing P again reads as a retake.
	setPhotoActive(on) {
		this.photoBtn?.setAttribute('aria-pressed', on ? 'true' : 'false');
	}

	// The capture itself is work: one extra render, a full pixel readback and a
	// PNG encode. On a GPU that is a blink, but on a software rasterizer or a
	// tired phone it can run for seconds, and a shutter flash followed by a long
	// nothing reads as a dead button (measured at 59s on a loaded software-GL
	// box). Mark the control busy for the duration so the press is visibly
	// acknowledged and assistive tech hears it too.
	setPhotoBusy(on) {
		if (!this.photoBtn) return;
		if (on) this.photoBtn.setAttribute('aria-busy', 'true');
		else this.photoBtn.removeAttribute('aria-busy');
	}

	// Toggle the button's armed state (lit = will dance on next beat).
	setDancing(on) {
		if (!this.danceBtn) return;
		this.danceBtn.classList.toggle('cc-on', !!on);
		this.danceBtnLabel.textContent = on ? 'Ready ✓' : 'Dance';
		this.danceBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
	}

	setEmotes(list) {
		this.emoteTray.textContent = '';
		for (const e of list) {
			this.emoteTray.appendChild(el('button', {
				// The visible text is an emoji, so give SR users the emote's real
				// name as the accessible label rather than the raw glyph.
				class: 'cc-emote', type: 'button', title: e.label || e.name,
				'aria-label': e.label || e.name, text: e.icon || '🙂',
				onclick: () => this.h.onEmote(e.name),
			}));
		}
		// Wheel launcher, opens the full radial emote wheel.
		this.wheelBtn = el('button', {
			class: 'cc-emote cc-emote-wheel-btn', type: 'button',
			'aria-label': 'All emotes, open emote wheel (hold Q)',
			title: 'All emotes (hold Q)',
			text: '⋯',
			onclick: () => this.openEmoteWheel(),
		});
		this.emoteTray.appendChild(this.wheelBtn);
	}

	// ---------------------------------------------------------------- emote wheel (R09)

	// Store the full manifest list; the wheel is built lazily on first open.
	setAllEmotes(allDefs) {
		this._ewAllDefs = allDefs || [];
	}

	// Open the radial emote wheel. No-ops if already open or manifest not ready.
	openEmoteWheel() {
		if (this._ewOpen) return;
		if (!this._ewAllDefs?.length) return;
		if (!this._ewEl) this._buildEmoteWheelDom(_ewCategorize(this._ewAllDefs));
		this._ewOpen = true;
		this._ewSelectedEmote = null;
		this._ewActiveCat = null;
		this._ewUpdateCenter(null, null);
		for (const p of this._ewClipPanels) p.hidden = true;
		for (const b of this._ewCatBtns) b.classList.remove('cc-on');
		for (const s of this._ewEl.querySelectorAll('.cc-ew-sector')) s.classList.remove('cc-ew-sector-active');
		this._ewEl.hidden = false;
		document.addEventListener('pointermove', this._ewPointerMoveH, { passive: true });
		document.addEventListener('keydown', this._ewKeydownH, true);
		requestAnimationFrame(() => this._ewEl?.classList.add('cc-on'));
		this._ewCatBtns[0]?.focus();
	}

	// Close the wheel. Pass play=true to emit the currently selected emote.
	closeEmoteWheel(play = false) {
		if (!this._ewOpen) return;
		this._ewOpen = false;
		if (play && this._ewSelectedEmote) this.h.onEmote(this._ewSelectedEmote);
		document.removeEventListener('pointermove', this._ewPointerMoveH);
		document.removeEventListener('keydown', this._ewKeydownH, true);
		if (this._ewEl) {
			this._ewEl.classList.remove('cc-on');
			const done = () => { if (this._ewEl) this._ewEl.hidden = true; };
			this._ewEl.addEventListener('transitionend', done, { once: true });
			setTimeout(done, 260);
		}
		this.wheelBtn?.focus();
	}

	get emoteWheelOpen() { return !!this._ewOpen; }

	_buildEmoteWheelDom(categories) {
		this._ewCategories = categories;
		const RING_R = 112; // px: distance from center to category label
		const SVG_SIZE = 300; const OUTER_R = 148; const INNER_R = 54;
		const cxy = SVG_SIZE / 2;

		// SVG background arcs, one donut sector per category (68° each).
		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('viewBox', `0 0 ${SVG_SIZE} ${SVG_SIZE}`);
		svg.setAttribute('class', 'cc-ew-sectors');
		svg.setAttribute('aria-hidden', 'true');
		categories.forEach((cat, i) => {
			const path = document.createElementNS(svgNS, 'path');
			path.setAttribute('d', _ewSectorPath(cxy, cxy, INNER_R, OUTER_R, cat.angle - 34, cat.angle + 34));
			path.setAttribute('class', `cc-ew-sector cc-ew-s-${cat.id}`);
			path.dataset.idx = i;
			svg.appendChild(path);
		});

		// Category buttons positioned at their angles using CSS custom properties.
		this._ewCatBtns = categories.map((cat, i) => {
			const rad = (cat.angle * Math.PI) / 180;
			return el('button', {
				class: 'cc-ew-cat-btn',
				type: 'button',
				'aria-label': `${cat.label} emotes`,
				title: cat.label,
				'data-idx': i,
				style: `--ew-x:${Math.round(Math.cos(rad) * RING_R)}px;--ew-y:${Math.round(Math.sin(rad) * RING_R)}px`,
				onmouseenter: () => this._ewSetCat(i),
				onfocus: () => this._ewSetCat(i),
			}, [
				el('span', { class: 'cc-ew-cat-ico', 'aria-hidden': 'true', text: cat.icon }),
				el('span', { class: 'cc-ew-cat-lbl', text: cat.label }),
			]);
		});

		// Center label, updated on hover / keyboard navigation.
		this._ewCenterEl = el('div', {
			class: 'cc-ew-center', 'aria-live': 'polite', 'aria-atomic': 'true',
		}, [
			el('span', { class: 'cc-ew-center-ico' }),
			el('span', { class: 'cc-ew-center-txt', text: 'Move to select' }),
		]);

		// Per-category clip grids, one panel per category, shown for the active one.
		this._ewClipPanels = categories.map((cat) => {
			const segs = cat.clips.map((d) =>
				el('button', {
					class: 'cc-ew-seg',
					type: 'button',
					'aria-label': d.label || d.name,
					title: d.label || d.name,
					'data-emote': d.name,
					onmouseenter: () => this._ewSetEmote(d),
					onfocus: () => this._ewSetEmote(d),
					onclick: () => { this._ewSetEmote(d); this.closeEmoteWheel(true); },
				}, [
					el('span', { class: 'cc-ew-seg-ico', 'aria-hidden': 'true', text: d.icon || '🙂' }),
					el('span', { class: 'cc-ew-seg-lbl', text: d.label || d.name }),
				])
			);
			return el('div', {
				class: 'cc-ew-clips', role: 'group', 'aria-label': `${cat.label} emotes`, hidden: true,
			}, segs);
		});

		// Close button accessible without keyboard or mouse movement.
		const closeBtn = el('button', {
			class: 'cc-ew-close', type: 'button', 'aria-label': 'Close emote wheel',
			onclick: () => this.closeEmoteWheel(false),
		}, ['✕']);

		const ring = el('div', {
			class: 'cc-ew-ring', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Emote wheel',
		}, [svg, ...this._ewCatBtns, this._ewCenterEl, ...this._ewClipPanels, closeBtn]);
		this._ewRing = ring;

		// Bound handlers stored for later removeEventListener calls.
		this._ewPointerMoveH = (e) => this._ewPointerMove(e);
		this._ewKeydownH = (e) => {
			if (e.key === 'Escape') { e.stopPropagation(); this.closeEmoteWheel(false); return; }
			if ((e.key === 'Enter' || e.key === ' ') && this._ewSelectedEmote) {
				e.preventDefault(); this.closeEmoteWheel(true); return;
			}
			if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); this._ewNavigate(-1); }
			if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); this._ewNavigate(1); }
		};

		this._ewEl = el('div', { id: 'cc-emote-wheel', hidden: true }, [
			el('div', { class: 'cc-ew-bg', 'aria-hidden': 'true', onclick: () => this.closeEmoteWheel(false) }),
			ring,
		]);
		document.body.appendChild(this._ewEl);
	}

	_ewPointerMove(e) {
		if (!this._ewOpen || !this._ewRing) return;
		const rect = this._ewRing.getBoundingClientRect();
		const dx = e.clientX - (rect.left + rect.width / 2);
		const dy = e.clientY - (rect.top + rect.height / 2);
		if (Math.sqrt(dx * dx + dy * dy) < 44) return; // dead zone, no jitter at center
		const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
		let best = 0; let bestD = Infinity;
		for (let i = 0; i < this._ewCategories.length; i++) {
			const diff = Math.abs(((angle - this._ewCategories[i].angle) % 360 + 540) % 360 - 180);
			if (diff < bestD) { bestD = diff; best = i; }
		}
		if (this._ewActiveCat !== best) this._ewSetCat(best);
	}

	_ewSetCat(idx) {
		if (this._ewActiveCat === idx) return;
		this._ewActiveCat = idx;
		this._ewSelectedEmote = null;
		for (let i = 0; i < this._ewCatBtns.length; i++) this._ewCatBtns[i].classList.toggle('cc-on', i === idx);
		for (let i = 0; i < this._ewClipPanels.length; i++) this._ewClipPanels[i].hidden = i !== idx;
		this._ewEl.querySelectorAll('.cc-ew-sector').forEach((p, pi) => p.classList.toggle('cc-ew-sector-active', pi === idx));
		const cat = this._ewCategories[idx];
		this._ewUpdateCenter(cat.icon, cat.label);
	}

	_ewSetEmote(def) {
		this._ewSelectedEmote = def.name;
		this._ewUpdateCenter(def.icon || '🙂', def.label || def.name);
		for (const b of this._ewEl.querySelectorAll('.cc-ew-seg')) b.classList.toggle('cc-on', b.dataset.emote === def.name);
	}

	_ewUpdateCenter(ico, txt) {
		if (!this._ewCenterEl) return;
		this._ewCenterEl.querySelector('.cc-ew-center-ico').textContent = ico ?? '';
		this._ewCenterEl.querySelector('.cc-ew-center-txt').textContent = txt ?? 'Move to select';
	}

	_ewNavigate(dir) {
		if (this._ewActiveCat == null) { this._ewSetCat(0); return; }
		const panel = this._ewClipPanels[this._ewActiveCat];
		const clips = panel ? [...panel.querySelectorAll('.cc-ew-seg')] : [];
		if (!clips.length) return;
		const cur = clips.findIndex((b) => b.dataset.emote === this._ewSelectedEmote);
		const next = clips[((cur < 0 ? 0 : cur) + dir + clips.length) % clips.length];
		next.focus();
		const def = this._ewAllDefs?.find((d) => d.name === next.dataset.emote);
		if (def) this._ewSetEmote(def);
	}

	// Called from coincommunities.js _loop for gamepad support: the left stick steers
	// the category selection, the south button plays the selected clip, and the east
	// button closes the wheel without playing (cancel).
	ewGamepadTick(stickX, stickY, btnPlay, btnCancel = false) {
		if (!this._ewOpen) return;
		if (btnCancel) { this.closeEmoteWheel(false); return; }
		if (Math.hypot(stickX, stickY) > 0.35) {
			const angle = (Math.atan2(stickY, stickX) * 180) / Math.PI;
			let best = 0; let bestD = Infinity;
			for (let i = 0; i < this._ewCategories.length; i++) {
				const diff = Math.abs(((angle - this._ewCategories[i].angle) % 360 + 540) % 360 - 180);
				if (diff < bestD) { bestD = diff; best = i; }
			}
			if (this._ewActiveCat !== best) this._ewSetCat(best);
		}
		if (btnPlay && this._ewSelectedEmote) this.closeEmoteWheel(true);
	}

	// Populate the reaction bar (R04). Each button sends one emoji; a short cooldown
	// class prevents confusion when a rapid second tap is dropped by the server.
	setReactions(list) {
		this.reactionBar.textContent = '';
		this._reactionBtns = [];
		for (const r of list) {
			const btn = el('button', {
				class: 'cc-reaction', type: 'button',
				title: r.label, 'aria-label': r.label,
				text: r.emoji,
				onclick: () => this._sendReaction(r.emoji, btn),
			});
			this._reactionBtns.push(btn);
			this.reactionBar.appendChild(btn);
		}
	}

	_sendReaction(emoji, btn) {
		if (btn.classList.contains('cc-cooldown')) return;
		this.h.onReaction?.(emoji);
		// Briefly dim the button so a rapid second tap clearly can't fire.
		btn.classList.add('cc-cooldown');
		setTimeout(() => btn.classList.remove('cc-cooldown'), 620);
	}

	_sendChat() {
		const text = this.chatInput.value.trim();
		if (!text) return;
		// `/forge <prompt>` forges an item without opening the build palette: the
		// finished prop lands armed for placement, announced by a local system line.
		// A bare `/forge` is a mistyped command, not a message: answer it locally
		// rather than broadcasting the slash text to everyone in the world.
		if (/^\/forge\s*$/i.test(text)) {
			this.chatInput.value = '';
			this.addChat({ name: 'Forge', text: 'Say what to forge, e.g. /forge a glowing campfire', mine: true });
			return;
		}
		const forge = text.match(/^\/forge\s+(.+)/i);
		if (forge) {
			this.chatInput.value = '';
			const prompt = forge[1].trim();
			this.addChat({ name: 'Forge', text: `Forging "${prompt.slice(0, 80)}"… it will land in your props when ready.`, mine: true });
			this.h.onForgeProp?.({ prompt, fromChat: true });
			return;
		}
		this.h.onChat(text);
		this.chatInput.value = '';
	}

	enterWorld(coin) {
		this.lobby.hidden = true;
		this.hud.hidden = false;
		this.coinName.textContent = coin.name || 'Community';
		this.coinSym.textContent = coin.symbol ? '$' + coin.symbol : '';
		this.buyBtnLabel.textContent = coin.symbol ? 'Buy $' + coin.symbol.toUpperCase() : 'Buy';
		// Monogram first, art over it: whichever of the two ends up visible, the
		// banner always has a 40px identity mark and never a hole.
		this.coinMono.textContent = (coin.symbol || coin.name || '?').replace(/^\$/, '').charAt(0).toUpperCase();
		if (coin.image) {
			this.coinMono.hidden = true;
			this.coinImg.hidden = false;
			this.coinImg.src = coin.image;
		} else {
			this.coinImg.hidden = true;
			this.coinMono.hidden = false;
		}
		this.refreshTierBadge(coin);
		this.chatLog.textContent = '';
		this._unread = 0;
		this.chatUnread.hidden = true;
		this.pingText.hidden = true;
	}

	// The Holders badge states the real entry bar: a creator-set token threshold
	// (R24) reads "1M $SYM+", otherwise the USD floor reads "$8+". Extracted so the
	// creator can update it live after saving a new gate without rebuilding the HUD.
	refreshTierBadge(coin) {
		const holders = coin.tier === 'holders';
		this.tierBadge.hidden = !holders;
		const sym = coin.symbol ? '$' + String(coin.symbol).replace(/^\$/, '').toUpperCase() : '';
		const req = coin.holderMinTokens > 0
			? `${fmtCompact(coin.holderMinTokens)} ${sym}+`
			: `$${coin.holderMinUsd ? Math.round(coin.holderMinUsd * 100) / 100 : 8}+`;
		this.tierBadge.textContent = holders ? `🔒 Holders · ${req}` : '';
	}

	showLobby() {
		this.hud.hidden = true;
		this.lobby.hidden = false;
		this._renderGrid();
		// Coming back out of a world, the headcounts on the cards are as old as the
		// session that just ended. Re-read them now rather than at the next tick.
		this._readPopulation();
	}

	setStatus(state, error = null) {
		this._statusState = state;
		this._statusError = error;
		const labels = {
			connecting: t('play.status_connecting', 'connecting…'),
			online: t('play.status_online', 'connected'),
			offline: t('play.status_offline', 'reconnecting…'),
			unavailable: t('play.status_unavailable', 'multiplayer unavailable'),
			failed: t('play.status_failed', 'offline, tap to retry'),
			denied: t('play.status_denied', 'sign-in required'),
			idle: t('play.status_idle', 'idle'),
		};
		// 'offline' is two different truths: a transient drop mid-reconnect (no
		// error) vs the client having exhausted its retries (community-net attaches
		// an error string). Telling a player "reconnecting…" forever after the
		// client gave up is a lie; show the retryable offline label instead.
		const gaveUp = state === 'offline' && !!error;
		this.statusPill.setAttribute('data-state', state);
		this.statusText.textContent = gaveUp ? labels.failed : (labels[state] || state);
		// The latency readout is only meaningful while the link is live.
		if (state !== 'online') this.pingText.hidden = true;
		// Only expose the pill to the keyboard / label it as actionable while a
		// retry actually does something, otherwise it's a passive status readout.
		const retryable = state === 'offline' || state === 'failed';
		if (retryable) {
			this.statusPill.setAttribute('tabindex', '0');
			this.statusPill.setAttribute('role', 'button');
			this.statusPill.setAttribute('aria-label', t('play.status_retry_aria', 'Connection {{state}}. Activate to reconnect.', { state: this.statusText.textContent }));
			this.statusPill.title = t('play.status_retry_title', 'Reconnect');
		} else {
			this.statusPill.removeAttribute('tabindex');
			this.statusPill.setAttribute('role', 'status');
			this.statusPill.removeAttribute('aria-label');
			this.statusPill.removeAttribute('title');
		}
	}

	// Show the live round-trip latency next to the status dot. Colour-coded so a
	// glance reads as healthy (green), okay (amber), or laggy (red).
	setPing(ms) {
		if (this.statusPill.getAttribute('data-state') !== 'online') return;
		this.pingText.hidden = false;
		this.pingText.textContent = `${ms}ms`;
		this.pingText.setAttribute('data-grade', ms < 90 ? 'good' : ms < 200 ? 'ok' : 'bad');
	}

	setOnline(n) {
		this._online = n;
		this.onlineCount.textContent = t('play.online', '{{n}} online', { n });
	}

	/** Persist the typed display name and, if connected, broadcast it live. */
	_commitName() {
		const name = this.nameInput.value.trim().slice(0, 24);
		if (name) lsSet('cc-name', name);
		this.h.onRename?.(name);
	}

	/** The chosen display name, or '' to let the caller fall back to a guest id. */
	getName() { return this.nameInput.value.trim().slice(0, 24); }

	/** Reflect a name assigned elsewhere (e.g. a generated guest id) in the field. */
	setName(name) { if (name) this.nameInput.value = name; }

	// Transient bottom-center toast for one-off notices (avatar fell back to a
	// stand-in, etc.). Self-dismisses; a new toast replaces the previous one.
	toast(msg, kind = '') {
		if (!this._toast) {
			this._toast = el('div', { id: 'cc-toast', role: 'status', 'aria-live': 'polite' });
			document.body.appendChild(this._toast);
		}
		clearTimeout(this._toastTimer);
		// A warning is something the player has to act on (an expired pass, a
		// refused trade) and the toast is gone in 4.2s, so it interrupts; ordinary
		// confirmations stay polite and wait their turn.
		const urgent = kind === 'warn' || kind === 'err';
		this._toast.setAttribute('role', urgent ? 'alert' : 'status');
		this._toast.setAttribute('aria-live', urgent ? 'assertive' : 'polite');
		this._toast.textContent = msg;
		this._toast.setAttribute('data-kind', kind);
		this._toast.classList.add('cc-on');
		this._toastTimer = setTimeout(() => this._toast.classList.remove('cc-on'), 4200);
	}

	addChat({ name, text, mine }) {
		const now = new Date();
		const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
		// Stick to bottom only if the user is already near it, so reading scrollback
		// isn't yanked away when a new message lands.
		const nearBottom = this.chatLog.scrollHeight - this.chatLog.scrollTop - this.chatLog.clientHeight < 60;
		const row = el('div', { class: 'cc-chat-msg' + (mine ? ' cc-mine' : '') }, [
			el('span', { class: 'cc-chat-meta' }, [
				el('b', { text: name }),
				el('time', { text: stamp }),
			]),
			el('span', { class: 'cc-chat-text', text }),
		]);
		this.chatLog.appendChild(row);
		while (this.chatLog.children.length > 200) this.chatLog.removeChild(this.chatLog.firstChild);
		if (nearBottom || mine) this.chatLog.scrollTop = this.chatLog.scrollHeight;
		if (this._chatMin && !mine) {
			this._unread += 1;
			this.chatUnread.textContent = this._unread > 99 ? '99+' : String(this._unread);
			this.chatUnread.hidden = false;
			// The log is a live region, but a collapsed sidebar is display:none and
			// a hidden live region is never spoken. Route the line through the
			// standalone announcer so a message still reaches a screen reader when
			// the panel is shut (which is the default on touch).
			announce(t('play.chat_from', '{{name}} says: {{text}}', { name, text }));
		}
	}

	/** Collapse/expand the chat sidebar. Pass a boolean to force a state. */
	toggleChat(force) {
		this._chatMin = typeof force === 'boolean' ? force : !this._chatMin;
		this.chat.classList.toggle('cc-min', this._chatMin);
		this.chatChevron.textContent = this._chatMin ? '▴' : '▾';
		// aria-expanded belongs on the control that does the expanding, not on the
		// region it expands; it was on the region, where nothing announces it.
		this.chatHead.setAttribute('aria-expanded', String(!this._chatMin));
		lsSet('cc-chat-min', this._chatMin ? '1' : '0');
		if (!this._chatMin) {
			this._unread = 0;
			this.chatUnread.hidden = true;
			this.chatLog.scrollTop = this.chatLog.scrollHeight;
		}
	}

	/** Open the sidebar (if collapsed) and put the cursor in the input. */
	focusChat() {
		if (this._chatMin) this.toggleChat(false);
		this.chatInput.focus();
	}

	get chatFocused() { return document.activeElement === this.chatInput; }
}
