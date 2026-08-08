// war.js — the Coin Wars arena page (/play/war).
//
// A player presses "Enter the war" at the portal in their coin's world; the
// matchmaker pairs their community with another and hands both sides the same
// signed pairing. This page is where that battle is actually fought: it joins
// ClashRoom under the shared matchKey, renders every fighter, sends movement and
// swing INTENT (the server decides what lands), and walks the player back into
// the world they came from when the round is over.
//
// Everything on screen is real room state. There is no demo mode, no local
// simulation: with no valid pairing the page says so and offers the way back.
//
// URL contract, produced by src/game/war-portal.js:
//   /play/war?match=<matchKey>&ticket=<signed pairing>&side=a|b
//            &coin=<mint>&name=&symbol=&image=&network=
//            &holderPass=<signed holding>&return=<url back into the coin world>

import { Client, getStateCallbacks } from 'colyseus.js';
import { joinRoomWithTimeout } from '../shared/colyseus-connect.js';
import { defaultGameServerUrl } from '../shared/game-server-url.js';
import { ensurePlayAccess } from '../game/play-gate.js';
import { requestHolderPass } from '../community/town-auth.js';
import { createLogger } from '../shared/log.js';
import { WarWorld } from './war-world.js';
import './war.css';

const log = createLogger('war');

const ROOM = 'clash_arena';
const SEND_HZ = 15;
const AVATAR_KEY = 'cc-avatar';          // the avatar the player picked in /play
const FALLBACK_AVATAR = '/avatars/default.glb';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const cfg = {
	matchKey: (params.get('match') || '').trim(),
	ticket: (params.get('ticket') || '').trim(),
	side: params.get('side') === 'b' ? 'b' : 'a',
	coin: (params.get('coin') || '').trim(),
	name: (params.get('name') || '').slice(0, 48),
	symbol: (params.get('symbol') || '').slice(0, 16),
	image: (params.get('image') || '').slice(0, 400),
	network: (params.get('network') || 'mainnet').toLowerCase().replace(/[^a-z]/g, '') || 'mainnet',
	holderPass: (params.get('holderPass') || '').trim(),
	// Only ever a same-origin path, so a crafted link cannot use the arena as an
	// open redirect off the site.
	returnTo: safeReturn(params.get('return')),
};

function safeReturn(v) {
	const s = String(v || '');
	return /^\/[^/\\]/.test(s) ? s : '/play';
}

let world = null;
let room = null;
let localId = '';
let phase = 'lobby';
let ended = null;      // { winner, reason, scoreA, scoreB, mvp }
let labelEls = new Map();
let sendTimer = 0;
let clockTimer = 0;
let lastSent = { x: NaN, z: NaN, yaw: NaN, motion: '' };
let attackCooldownUntil = 0;

// ── boot ─────────────────────────────────────────────────────────────────────

(async function boot() {
	wireChrome();

	if (!cfg.matchKey || !cfg.ticket || !cfg.coin) {
		return fail(
			'No battle to join',
			'This link is missing its pairing, so there is no arena to open. Walk up to the war portal in your coin world and press E to queue for a war.',
		);
	}

	const serverUrl = defaultGameServerUrl();
	if (!serverUrl) {
		return fail(
			'The arena server is unreachable',
			'No game server is configured for this deployment, so a battle cannot be hosted right now. Your place in the league is unaffected.',
		);
	}

	setStatus('Building the arena…');
	world = new WarWorld($('scene'));
	world.setFactions({ a: '', b: '' });
	world.start();
	world.setLabelUpdater(updateLabels);

	try {
		await world.loadAnimations();
	} catch (err) {
		log.warn('animations failed to load', err);
	}

	// The platform play gate, exactly as /play runs it. Open deployments resolve
	// instantly with no overlay.
	let access = { required: false };
	try {
		access = await ensurePlayAccess();
	} catch (err) {
		log.warn('play gate failed, continuing to the room gate', err);
	}

	// The holder pass. The portal usually hands one over; a shared or refreshed
	// link mints its own, which is also what makes this page work as a direct
	// destination rather than only as a hand-off target.
	setStatus('Verifying your holding…');
	let holderPass = cfg.holderPass;
	if (!holderPass) {
		try {
			const res = await requestHolderPass(cfg.coin);
			if (!res?.eligible || !res.holderPass) {
				return fail(
					`You do not hold enough ${coinLabel()} to fight for it`,
					`A war is fought BY a community, so the arena only seats holders of the coin. You hold ${fmtUsd(res?.usd)} of ${coinLabel()}; the floor is ${fmtUsd(res?.minUsd)}.`,
					'Back to the world',
				);
			}
			holderPass = res.holderPass;
		} catch (err) {
			const msg = err?.code === 'auth_required'
				? 'Sign in on the coin world first, then walk back to the war portal.'
				: err?.code === 'wallet_required'
					? 'Link a Solana wallet on the coin world, then walk back to the war portal.'
					: err?.message || 'Your holding could not be verified right now.';
			return fail('Could not verify your holding', msg, 'Back to the world');
		}
	}

	setStatus('Joining the battle…');
	try {
		const client = new Client(serverUrl);
		room = await joinRoomWithTimeout(client, ROOM, {
			matchKey: cfg.matchKey,
			warTicket: cfg.ticket,
			coin: cfg.coin,
			holderPass,
			playPass: access?.playPass || '',
			name: displayName(),
			avatar: savedAvatar(),
		});
	} catch (err) {
		return fail('Could not join the battle', joinErrorText(err), 'Back to the world');
	}

	localId = room.sessionId;
	wireRoom(room);
	setStatus(null);
	$('hud').hidden = false;
	$('controls').hidden = false;

	sendTimer = setInterval(sendPose, 1000 / SEND_HZ);
	// The round clock is derived from `endsAt`, which only changes when the match
	// starts — so it has to be ticked locally or it would freeze between the
	// state patches that carry a score change.
	clockTimer = setInterval(tickClock, 500);
	addEventListener('beforeunload', () => { try { room?.leave(); } catch { /* closing anyway */ } });
})();

// ── room wiring ──────────────────────────────────────────────────────────────

function wireRoom(r) {
	const $$ = getStateCallbacks(r);
	const s = r.state;

	$$(s).fighters.onAdd((f, id) => {
		world.spawnFighter(id, {
			avatarUrl: f.avatar || FALLBACK_AVATAR,
			faction: f.faction,
			name: f.name,
			x: f.x, y: f.y, z: f.z, yaw: f.yaw,
		}).then((avatar) => {
			if (!avatar) return;
			if (id === localId) world.setLocal(id);
			addLabel(id, f);
		});
		$$(f).onChange(() => {
			world.updateFighter(id, { x: f.x, y: f.y, z: f.z, yaw: f.yaw, motion: f.motion, dead: f.dead });
			if (id === localId) renderVitals(f);
			renderRoster();
		});
	});

	$$(s).fighters.onRemove((f, id) => {
		world.removeFighter(id);
		removeLabel(id);
		renderRoster();
	});

	$$(s).onChange(() => {
		world.setFactions({ a: s.aMint, b: s.bMint });
		if (s.phase !== phase) onPhase(s.phase, s);
		phase = s.phase;
		renderScore(s);
	});

	// The server resolved a swing. A hit shows where it landed; a whiff still
	// shows the shot, so a miss reads as a miss and not as a dropped input.
	r.onMessage('clash:swing', (m) => {
		world.swing(m.id, m.target, { hit: !!m.hit, killed: !!m.killed });
		if (m.killed && m.id === localId) world.celebrate(localId);
	});

	r.onMessage('clash:end', (m) => {
		ended = m;
		showResult(m);
	});

	r.onLeave((code) => {
		if (ended) return; // the result screen already owns the page
		fail(
			'You left the battle',
			code === 1000
				? 'The connection to the arena closed. The result, if the battle finished, is already in the league.'
				: 'The connection to the arena dropped. The result, if the battle finished, is already in the league.',
			'Back to the world',
		);
	});
}

function onPhase(next, s) {
	// Movement is only legal while the fight is on; the countdown and the aftermath
	// hold everyone in place, matching what the server will accept.
	world.setLocked(next !== 'live' && next !== 'sudden_death');
	const banner = $('phase');
	const text = {
		lobby: 'Waiting for the other community',
		countdown: 'Get ready',
		live: 'Fight',
		sudden_death: 'Sudden death — next kill takes it',
		ended: 'Battle over',
	}[next] || next;
	banner.textContent = text;
	banner.dataset.phase = next;
	banner.hidden = false;
	if (next === 'live') setTimeout(() => { if (phase === 'live') banner.hidden = true; }, 1800);
	if (next === 'lobby') {
		$('lobby-note').hidden = false;
		$('lobby-note').textContent = `Holding the line for ${factionLabel(s, cfg.side)} — the battle starts when ${factionLabel(s, cfg.side === 'a' ? 'b' : 'a')} fields a fighter.`;
	} else {
		$('lobby-note').hidden = true;
	}
}

// ── sending ──────────────────────────────────────────────────────────────────

// Position updates are rate-limited server-side (20/s) and rejected outright as
// teleports past 3 m, so we send at 15 Hz and only when something actually moved.
function sendPose() {
	if (!room) return;
	const pose = world?.localPose();
	if (!pose) return;
	if (Math.abs(pose.x - lastSent.x) < 0.01
		&& Math.abs(pose.z - lastSent.z) < 0.01
		&& Math.abs(pose.yaw - lastSent.yaw) < 0.01
		&& pose.motion === lastSent.motion) return;
	lastSent = pose;
	room.send('move', pose);
}

function attack() {
	if (!room || (phase !== 'live' && phase !== 'sudden_death')) return;
	const now = Date.now();
	// Mirrors ClashRoom's ATTACK_COOLDOWN_MS so the button reflects the real rule
	// rather than firing messages the server silently drops.
	if (now < attackCooldownUntil) return;
	attackCooldownUntil = now + 450;
	room.send('attack');
	const btn = $('attack');
	btn.classList.add('is-cooling');
	setTimeout(() => btn.classList.remove('is-cooling'), 450);
}

// ── HUD ──────────────────────────────────────────────────────────────────────

function renderScore(s) {
	const mine = cfg.side === 'a' ? s.aScore : s.bScore;
	const theirs = cfg.side === 'a' ? s.bScore : s.aScore;
	$('score-us').textContent = String(mine);
	$('score-them').textContent = String(theirs);
	$('name-us').textContent = factionLabel(s, cfg.side);
	$('name-them').textContent = factionLabel(s, cfg.side === 'a' ? 'b' : 'a');
	$('cap').textContent = s.scoreCap ? `first to ${s.scoreCap}` : '';

	tickClock();
}

function tickClock() {
	const s = room?.state;
	if (!s) return;
	if (s.phase === 'sudden_death') { $('clock').textContent = 'OT'; return; }
	if (s.phase === 'lobby') { $('clock').textContent = '—'; return; }
	const target = s.phase === 'countdown' ? s.countdownEndsAt : s.endsAt;
	$('clock').textContent = clock(target - Date.now());
}

function renderVitals(f) {
	$('kills').textContent = String(f.kills || 0);
	$('deaths').textContent = String(f.deaths || 0);
	$('downed').hidden = !f.dead;
	$('attack').disabled = !!f.dead;
}

function renderRoster() {
	if (!room) return;
	let us = 0, them = 0;
	for (const [, f] of room.state.fighters) {
		if (f.faction === (cfg.side === 'a' ? room.state.aMint : room.state.bMint)) us++;
		else them++;
	}
	$('roster-us').textContent = `${us} fighting`;
	$('roster-them').textContent = `${them} fighting`;
}

// Name tags pinned over each fighter's head, coloured by faction so a crowded
// midfield still reads. DOM, not sprites: crisp at any resolution and free.
function addLabel(id, f) {
	if (labelEls.has(id)) return;
	const el = document.createElement('div');
	el.className = `war-tag ${f.faction === room.state.aMint ? 'war-tag-a' : 'war-tag-b'}${id === localId ? ' war-tag-me' : ''}`;
	el.textContent = f.name || 'fighter';
	$('labels').appendChild(el);
	labelEls.set(id, el);
}

function removeLabel(id) {
	labelEls.get(id)?.remove();
	labelEls.delete(id);
}

const _pt = { x: 0, y: 0 };
function updateLabels() {
	for (const [id, el] of labelEls) {
		const p = world.projectHead(id, _pt);
		if (!p) { el.style.opacity = '0'; continue; }
		el.style.opacity = '1';
		el.style.transform = `translate(-50%, -100%) translate(${p.x}px, ${p.y}px)`;
	}
}

// ── result ───────────────────────────────────────────────────────────────────

function showResult(m) {
	const s = room.state;
	const myMint = cfg.side === 'a' ? s.aMint : s.bMint;
	const won = m.winner === myMint;
	const drew = m.winner === 'draw' || !m.winner;
	const mine = cfg.side === 'a' ? m.scoreA : m.scoreB;
	const theirs = cfg.side === 'a' ? m.scoreB : m.scoreA;

	$('result-title').textContent = drew ? 'Draw' : won ? 'Victory' : 'Defeat';
	$('result-title').dataset.outcome = drew ? 'draw' : won ? 'win' : 'loss';
	$('result-score').textContent = `${mine} — ${theirs}`;
	$('result-reason').textContent = reasonLine(m.reason);
	$('result-mvp').textContent = m.mvp
		? `MVP: ${m.mvp.kills} kills, ${m.mvp.deaths} deaths, ${m.mvp.damage} damage${m.mvp.id === localId ? ' — that was you' : ''}`
		: 'No knockdowns were scored.';
	$('result').hidden = false;
	$('controls').hidden = true;
	world?.setLocked(true);
	// The league write happens as the room ends, so the world we return to can
	// read this battle straight out of the ledger.
	$('result-back').textContent = `Back to ${coinLabel()}`;
}

function goBack() {
	// The return link carries the match key, so the portal board echoes THIS
	// result the moment the world finishes loading.
	const url = new URL(cfg.returnTo, location.origin);
	if (cfg.matchKey && !url.searchParams.get('war')) url.searchParams.set('war', cfg.matchKey);
	try { room?.leave(); } catch { /* leaving anyway */ }
	location.href = url.pathname + url.search;
}

// ── chrome, states, helpers ──────────────────────────────────────────────────

function wireChrome() {
	$('attack').addEventListener('click', attack);
	$('leave').addEventListener('click', goBack);
	$('result-back').addEventListener('click', goBack);
	$('fail-back').addEventListener('click', goBack);
	addEventListener('keydown', (e) => {
		if (e.repeat) return;
		const k = e.key.toLowerCase();
		if (k === ' ' || k === 'f') { e.preventDefault(); attack(); }
		if (k === 'escape' && !$('result').hidden) goBack();
	});
	mountJoystick();
	// The coin the player fights for, painted into the page chrome the moment it
	// loads — before any room state arrives — so the page is never anonymous.
	$('coin-label').textContent = coinLabel();
	if (cfg.image) {
		const img = $('coin-img');
		img.src = cfg.image;
		img.alt = '';
		img.hidden = false;
	}
}

// A thumb stick for phones. Pointer events only — no library, no dependency, and
// it releases cleanly if the finger leaves the screen mid-drag.
function mountJoystick() {
	const pad = $('stick');
	const nub = $('stick-nub');
	let active = null;
	const R = 46;
	const set = (dx, dy) => {
		const d = Math.min(1, Math.hypot(dx, dy) / R);
		const a = Math.atan2(dy, dx);
		const x = Math.cos(a) * d;
		const y = -Math.sin(a) * d;
		nub.style.transform = `translate(${Math.cos(a) * d * R}px, ${Math.sin(a) * d * R}px)`;
		world?.setJoystick(x, y);
	};
	const release = () => {
		active = null;
		nub.style.transform = 'translate(0,0)';
		world?.setJoystick(0, 0);
	};
	pad.addEventListener('pointerdown', (e) => {
		active = { id: e.pointerId, cx: e.clientX, cy: e.clientY };
		pad.setPointerCapture?.(e.pointerId);
		e.preventDefault();
	});
	pad.addEventListener('pointermove', (e) => {
		if (active?.id !== e.pointerId) return;
		set(e.clientX - active.cx, e.clientY - active.cy);
	});
	pad.addEventListener('pointerup', release);
	pad.addEventListener('pointercancel', release);
	pad.addEventListener('lostpointercapture', release);
}

function setStatus(text) {
	const el = $('status');
	if (!text) { el.hidden = true; return; }
	el.hidden = false;
	$('status-text').textContent = text;
}

// Every terminal state is a designed card with a way out, never a blank screen
// or a console error.
function fail(title, detail, action = 'Back to the world') {
	setStatus(null);
	$('hud').hidden = true;
	$('controls').hidden = true;
	$('fail-title').textContent = title;
	$('fail-detail').textContent = detail;
	$('fail-back').textContent = action;
	$('fail').hidden = false;
	clearInterval(sendTimer);
	clearInterval(clockTimer);
}

// The room throws named errors; each one has a player-readable cause.
function joinErrorText(err) {
	const msg = String(err?.message || '');
	if (msg.includes('war_ticket')) return 'This pairing has expired. Walk back to the war portal and queue again — it only takes a moment.';
	if (msg.includes('holder_pass_mismatch')) return 'Your holding was verified for a different coin than the one this battle seats you under.';
	if (msg.includes('holder_pass_required')) return 'The arena needs a fresh proof that you hold this coin. Queue again from the portal.';
	if (msg.includes('play_pass')) return 'This deployment gates play on a token balance and yours did not clear it.';
	if (msg.includes('clash_faction_full')) return 'This community has already fielded a full roster for the battle. Try the next one.';
	if (msg.includes('clash_faction_mismatch')) return 'You hold a coin that is not one of the two communities in this battle.';
	if (msg.includes('timed out')) return 'The arena server did not answer in time. It may be restarting; try again in a moment.';
	return msg || 'The arena refused the join.';
}

function factionLabel(s, side) {
	const symbol = side === 'a' ? s.aSymbol : s.bSymbol;
	const name = side === 'a' ? s.aName : s.bName;
	return symbol ? `$${symbol}` : (name || 'Community');
}

function coinLabel() {
	return cfg.symbol ? `$${cfg.symbol}` : (cfg.name || 'your community');
}

function displayName() {
	try {
		const stored = localStorage.getItem('cc-name');
		if (stored) return stored.slice(0, 24);
	} catch { /* storage disabled */ }
	return '';
}

// The body the player picked in /play. The lobby also stores non-loadable values
// there (a locally-staged guest avatar that was never uploaded), so only a real
// URL or site path is carried into the arena; anything else takes the default rig
// rather than putting an unloadable body on the field.
function savedAvatar() {
	let stored = '';
	try {
		stored = localStorage.getItem(AVATAR_KEY) || '';
	} catch { /* storage disabled */ }
	return /^https?:\/\//i.test(stored) || stored.startsWith('/') ? stored : FALLBACK_AVATAR;
}

function clock(ms) {
	const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtUsd(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '$0';
	return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

function reasonLine(reason) {
	switch (reason) {
		case 'score_cap': return 'The kill cap was reached.';
		case 'timeout': return 'The round clock ran out.';
		case 'sudden_death': return 'Taken in sudden death.';
		case 'forfeit': return 'The other side withdrew.';
		default: return 'The battle ended.';
	}
}
