// /stage — Living Stages audience surface (Moonshot 04).
//
// Two modes off one entry:
//   • directory (no ?id)  — the marquee: live shows first, then upcoming, then
//     recently-ended, each a card into a venue.
//   • venue (?id=<stage>) — enter the 3D room, hear the embodied host with
//     spatial voice + lip-sync synchronized across every connected client, see
//     the co-present crowd + their reactions, tip the host in real $THREE on the
//     spot, watch the live tipper leaderboard, and queue a question.
//
// The host's words arrive as a timed `utterance` broadcast (one per beat) that
// every client renders identically: we fetch /api/tts/speak for the text, route
// it through a THREE.PositionalAudio (so it gets louder as you move closer) with
// a real AnalyserNode driving lip-sync, and show the text as live captions. A tip
// settles on-chain to the host wallet, we record it via /api/stage/tip, and the
// room makes the host react within ~1s. Every state is designed; with no WebGL
// the captions, tips, and leaderboard still work (audio + text, no 3D).

import {
	Scene, PerspectiveCamera, WebGLRenderer, Color, Fog,
	AmbientLight, DirectionalLight, SpotLight, PointLight,
	Mesh, CylinderGeometry, CircleGeometry, PlaneGeometry,
	MeshStandardMaterial, MeshBasicMaterial, Group,
	AudioListener, PositionalAudio, SRGBColorSpace, ACESFilmicToneMapping,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { apiFetch } from './api.js';
import { StageNet } from './stage-net.js';
import { tipAgent, TipError } from './shared/agent-tip.js';
import { StageVoice, MouthTarget, findHead, modelHeight } from './shared/stage-voice.js';
import { loadEnvironment } from './shared/cinematic-render.js';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const THREE_DECIMALS = 6;
const TIP_PRESETS = [100, 500, 2000, 10000]; // $THREE
const REACTIONS = [
	{ id: 'clap', emoji: '👏' },
	{ id: 'fire', emoji: '🔥' },
	{ id: 'heart', emoji: '💜' },
	{ id: 'laugh', emoji: '😂' },
	{ id: 'wow', emoji: '😮' },
	{ id: 'cheer', emoji: '🎉' },
];
const REACTION_EMOJI = Object.fromEntries(REACTIONS.map((r) => [r.id, r.emoji]));
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

const fmtThree = (atomic) => Math.round(Number(atomic || 0) / 10 ** THREE_DECIMALS).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const root = document.getElementById('stage-app');
const params = new URLSearchParams(location.search);
const stageId = params.get('id');

if (stageId) bootVenue(stageId);
else bootDirectory();

// ─────────────────────────────────────────────────────────────────────────────
// Directory
// ─────────────────────────────────────────────────────────────────────────────
async function bootDirectory() {
	root.innerHTML = `
		<header class="stage-dir-head">
			<h1>Living Stages</h1>
			<p>Live, embodied AI performances. Show up, hear the host, tip in $THREE: the biggest tippers get the floor.</p>
		</header>
		<div id="stage-dir" class="stage-dir" aria-live="polite">${skeletonCards(6)}</div>`;
	const grid = document.getElementById('stage-dir');
	try {
		const res = await apiFetch('/api/stage', { allowAnonymous: true });
		const data = await res.json();
		const stages = data.stages || [];
		if (!stages.length) {
			grid.innerHTML = emptyState(
				'No stages yet',
				'Be the first to put an agent on stage. Open an agent you own and start a stage from its profile.',
				'/agents', 'Browse agents',
			);
			return;
		}
		// Live first — the marquee.
		grid.innerHTML = stages.map(stageCard).join('');
	} catch (err) {
		grid.innerHTML = errorState('Could not load stages');
		wireRetry(grid, () => bootDirectory());
	}
}

function stageCard(s) {
	const live = s.live;
	const when = s.next_show_at && !live ? `Next show ${new Date(s.next_show_at).toLocaleString()}` : '';
	const tips = s.recentTipsAtomic ? `${fmtThree(s.recentTipsAtomic)} $THREE tipped` : 'New stage';
	return `
		<a class="stage-card ${live ? 'is-live' : ''}" href="/stage?id=${encodeURIComponent(s.id)}">
			<div class="stage-card-art" style="${s.host_avatar ? `background-image:url('${esc(s.host_avatar)}')` : ''}">
				${live ? '<span class="stage-badge-live">● LIVE</span>' : '<span class="stage-badge-soon">SOON</span>'}
			</div>
			<div class="stage-card-body">
				<h3>${esc(s.title || s.host_name || 'Untitled stage')}</h3>
				<p class="stage-card-host">${esc(s.host_name || 'AI host')} · ${esc(s.format || 'live')}</p>
				<p class="stage-card-meta">${live ? '<b>On now</b> · ' : ''}${esc(when || tips)}</p>
			</div>
		</a>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Venue
// ─────────────────────────────────────────────────────────────────────────────
async function bootVenue(id) {
	root.innerHTML = venueShell();
	const els = {
		canvas: document.getElementById('stage-canvas'),
		stageWrap: document.getElementById('stage-3d'),
		title: document.getElementById('stage-title'),
		hostName: document.getElementById('stage-host-name'),
		phase: document.getElementById('stage-phase'),
		caption: document.getElementById('stage-caption'),
		captionText: document.querySelector('#stage-caption .cap-text'),
		audienceCount: document.getElementById('stage-aud-count'),
		ticker: document.getElementById('stage-ticker'),
		leaderboard: document.getElementById('stage-leaderboard'),
		total: document.getElementById('stage-total'),
		tipBtns: document.getElementById('stage-tip-presets'),
		tipCustom: document.getElementById('stage-tip-custom'),
		tipSend: document.getElementById('stage-tip-send'),
		tipMsg: document.getElementById('stage-tip-msg'),
		tipStatus: document.getElementById('stage-tip-status'),
		reactions: document.getElementById('stage-reactions'),
		askInput: document.getElementById('stage-ask-input'),
		askBtn: document.getElementById('stage-ask-btn'),
		askStatus: document.getElementById('stage-ask-status'),
		netPill: document.getElementById('stage-net-pill'),
		closer: document.getElementById('stage-closer'),
		farther: document.getElementById('stage-farther'),
		soundBtn: document.getElementById('stage-sound'),
	};

	// Load stage config.
	// Two different failures, two different answers: an id that resolves to
	// nothing is a dead link (send them to the marquee), a request that never
	// completed is a network blip (let them retry in place).
	let detail;
	try {
		const res = await apiFetch(`/api/stage?id=${encodeURIComponent(id)}`, { allowAnonymous: true });
		// 404 is an unknown stage, 400 is an id the API would never mint (a
		// hand-edited or truncated link): both are dead links, not blips.
		if (res.status === 404 || res.status === 400) {
			els.stageWrap.innerHTML = emptyState(
				'Stage not found',
				'This stage does not exist or has been taken down. The live ones are on the marquee.',
				'/stage', 'Browse live stages',
			);
			return;
		}
		if (!res.ok) throw new Error(`http ${res.status}`);
		detail = await res.json();
	} catch (err) {
		els.stageWrap.innerHTML = errorState('Could not load this stage');
		wireRetry(els.stageWrap, () => bootVenue(id));
		return;
	}
	const stage = detail.stage;
	document.title = `${stage.title || stage.host_name} · Living Stage · three.ws`;
	els.title.textContent = stage.title || `${stage.host_name} Live`;
	els.hostName.textContent = stage.host_name || 'AI host';

	const ctrl = new VenueController(id, stage, detail, els);
	ctrl.start();
	window.addEventListener('beforeunload', () => ctrl.dispose());
}

class VenueController {
	constructor(stageId, stage, detail, els) {
		this.stageId = stageId;
		this.stage = stage;
		this.detail = detail;
		this.els = els;
		this.hostWallet = detail.hostWallet || null;
		this.lastUtteranceId = -1;
		this.tipAmount = TIP_PRESETS[1];
		this.tipping = false;
		this.three = null; // {renderer,scene,camera,listener,host,mouth,...}
		this.audioCtxResumed = false;
		this.audPositions = new Map();
		// The host's voice: TTS → the avatar's spatial audio → lip-sync. Shared with
		// the in-world plaza stage (src/shared/stage-voice.js) so both surfaces
		// render the same broadcast identically. Reads `this.three` lazily, so a
		// still-streaming avatar simply plays flat until its rig lands.
		this.voice = new StageVoice({
			getPositionalAudio: () => this.three?.positionalAudio || null,
			getMouthTarget: () => this.three?.mouthTarget || null,
			onAutoplayBlocked: () => { this.els.soundBtn.hidden = false; },
			onSpeaking: (speaking) => { if (!speaking) this.three?.setCue('idle', false); },
		});
	}

	start() {
		this.renderPhase(this.detail.live ? 'live' : (this.stage.next_show_at ? 'between' : 'preshow'));
		this.renderLeaderboard(this.detail.leaderboard || [], this.detail.currentShow || this.detail.lastShow);
		this.buildTipControls();
		this.buildReactions();
		this.initThree();
		this.connect();
		this.wireControls();
	}

	// ── realtime ──────────────────────────────────────────────────────────────
	connect() {
		const me = readSelfIdentity();
		this.net = new StageNet({ stageId: this.stageId, name: me.name, avatar: me.avatar });
		this.net.on('status', ({ status }) => this.onNetStatus(status));
		this.net.on('host', (h) => this.onHost(h));
		this.net.on('utterance', (u) => this.onUtterance(u));
		this.net.on('audience', (a) => this.onAudience(a));
		this.net.on('tip', (t) => this.onTip(t));
		this.net.on('leaderboard', (lb) => this.onLeaderboard(lb));
		this.net.on('reaction', (r) => this.onReaction(r));
		this.net.connect();
	}

	onNetStatus(status) {
		const pill = this.els.netPill;
		const map = {
			online: ['● live feed', 'ok', 'Live feed connected'],
			connecting: ['connecting…', 'warn', 'Connecting to the live feed'],
			offline: ['reconnecting…', 'warn', 'Reconnecting to the live feed'],
			failed: ['feed offline · tap to retry', 'bad', 'Live feed offline. Tap to reconnect'],
			unavailable: ['feed offline · tap to retry', 'bad', 'Live feed offline. Tap to reconnect'],
			idle: ['…', 'warn', 'Live feed'],
		};
		const [label, cls, aria] = map[status] || ['…', 'warn', 'Live feed'];
		pill.textContent = label;
		pill.className = `stage-net-pill ${cls}`;
		pill.setAttribute('aria-label', aria);
		pill.disabled = cls !== 'bad';
		pill.hidden = false;
	}

	onHost(h) {
		if (!h) return;
		if (h.name && this.els.hostName.textContent !== h.name) this.els.hostName.textContent = h.name;
		// Render the current caption even for a late joiner (state-synced).
		if (h.caption) this.showCaption(h.caption, h.speaking);
		if (this.three) this.three.setCue(h.cue, h.speaking);
		if (h.beat) this.renderPhase('live');
	}

	// A timed spoken beat — fetch TTS, play it spatially with lip-sync, show captions.
	async onUtterance(u) {
		if (!u || u.id === this.lastUtteranceId) return;
		this.lastUtteranceId = u.id;
		this.showCaption(u.text, true);
		this.renderPhase('live');
		if (this.three) this.three.setCue(u.cue, true);
		await this.speak(u.text, u.voice);
	}

	onAudience(a) {
		this.els.audienceCount.textContent = a.count === 1 ? '1 here' : `${a.count} here`;
		if (this.three) this.three.setAudience(a.members, a.selfId);
	}

	onTip(t) {
		this.pushTicker(`${t.label} tipped ${fmtThree(t.amount)} $THREE${t.isNewTopTipper ? ', now the top tipper 👑' : ''}`, 'tip', t.explorer);
		if (this.three) this.three.burst(t.isNewTopTipper ? 'gold' : 'cheer');
	}

	onLeaderboard(lb) {
		this.renderLeaderboardRows(lb.rows || []);
		this.els.total.textContent = `${fmtThree(lb.totalTipsAtomic)} $THREE · ${lb.tipCount} tips`;
		if (lb.phase === 'between' || lb.phase === 'ended') this.renderPhase(lb.phase);
		else if (lb.phase === 'live') this.renderPhase('live');
	}

	onReaction(r) {
		if (r?.ack) {
			this.els.askStatus.textContent = r.ack.ok ? 'Queued. The host will get to it.' : 'Slow down a moment.';
			return;
		}
		if (this.three && r?.emoji) this.three.floatEmoji(r.id, REACTION_EMOJI[r.emoji] || '✨');
	}

	// ── host voice: spatial + lip-sync, synced across clients ───────────────────
	async speak(text, voice) {
		this.three?.resumeAudio();
		await this.voice.speak(text, voice);
	}

	// ── tipping ─────────────────────────────────────────────────────────────────
	buildTipControls() {
		this.els.tipBtns.innerHTML = TIP_PRESETS.map(
			(v, i) => `<button type="button" class="stage-tip-preset ${i === 1 ? 'active' : ''}" data-amt="${v}">${v.toLocaleString()}</button>`,
		).join('');
		this.els.tipBtns.querySelectorAll('button').forEach((b) => {
			b.addEventListener('click', () => {
				this.tipAmount = Number(b.dataset.amt);
				this.els.tipCustom.value = '';
				this.els.tipBtns.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
			});
		});
		this.els.tipCustom.addEventListener('input', () => {
			const v = Number(this.els.tipCustom.value);
			if (v > 0) {
				this.tipAmount = v;
				this.els.tipBtns.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
			}
		});
		this.els.tipSend.addEventListener('click', () => this.sendTip());
	}

	async sendTip() {
		if (this.tipping) return;
		const amount = Number(this.tipAmount);
		if (!(amount > 0)) { this.tipStatus('Enter an amount to tip.', 'warn'); return; }
		if (!this.hostWallet) { this.tipStatus('This host has no wallet to tip yet.', 'bad'); return; }
		if (!this.detail.live && !document.querySelector('.stage-phase.is-live')) {
			this.tipStatus('Tips open when the host goes live.', 'warn');
			return;
		}
		this.tipping = true;
		this.els.tipSend.disabled = true;
		const msg = this.els.tipMsg.value.trim().slice(0, 140);
		try {
			this.tipStatus('Connecting your wallet…', 'warn');
			const settle = await tipAgent({
				toAddress: this.hostWallet,
				token: 'SPL',
				mint: THREE_MINT,
				decimals: THREE_DECIMALS,
				amount,
				network: 'mainnet',
				noBalanceMsg: 'Your wallet holds no $THREE to tip with.',
				onStage: (s) => this.tipStatus(tipStageLabel(s), 'warn'),
			});
			this.tipStatus('Recording your tip…', 'warn');
			const body = JSON.stringify({
				stageId: this.stageId,
				signature: settle.signature,
				currencyMint: THREE_MINT,
				amount: Math.round(amount * 10 ** THREE_DECIMALS),
				message: msg,
				network: 'solana',
				tipperSession: this.net?.sessionId || null,
			});
			const post = async () => {
				const res = await apiFetch('/api/stage/tip', {
					method: 'POST',
					allowAnonymous: true,
					headers: { 'content-type': 'application/json' },
					body,
				});
				const out = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(out.message || out.error || 'could not record tip');
				return out;
			};
			// The server verifies the transfer on-chain before the tip counts. Our
			// own RPC can lag the one that confirmed the transfer by a few seconds,
			// in which case it holds the tip and answers `pending`. The POST is
			// idempotent, so re-posting is the retry: the tip lands the moment the
			// chain shows it.
			let out = await post();
			for (let attempt = 0; out.pending && attempt < 4; attempt++) {
				this.tipStatus('Confirming on-chain…', 'warn');
				await new Promise((r) => setTimeout(r, 3000));
				out = await post();
			}
			if (out.pending) {
				this.tipStatus('Sent. It will appear on the leaderboard once the network confirms it.', 'warn');
				this.els.tipMsg.value = '';
				return;
			}
			this.tipStatus(`Tipped ${amount.toLocaleString()} $THREE 🎉`, 'ok');
			this.els.tipMsg.value = '';
		} catch (err) {
			const code = err instanceof TipError ? err.code : '';
			if (code === 'cancelled') this.tipStatus('Tip cancelled.', 'warn');
			else this.tipStatus(err?.message || 'Tip failed. Try again.', 'bad');
		} finally {
			this.tipping = false;
			this.els.tipSend.disabled = false;
		}
	}

	tipStatus(text, cls) {
		this.els.tipStatus.textContent = text;
		this.els.tipStatus.className = `stage-tip-status ${cls || ''}`;
	}

	// ── reactions + questions ───────────────────────────────────────────────────
	buildReactions() {
		this.els.reactions.innerHTML = REACTIONS.map(
			(r) => `<button type="button" class="stage-react" data-id="${r.id}" aria-label="React ${r.id}">${r.emoji}</button>`,
		).join('');
		this.els.reactions.querySelectorAll('button').forEach((b) => {
			b.addEventListener('click', () => {
				this.net?.react(b.dataset.id);
				if (this.three) this.three.floatEmoji(this.net?.sessionId, REACTION_EMOJI[b.dataset.id]);
				b.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.4)' }, { transform: 'scale(1)' }], { duration: 240 });
			});
		});
		const ask = () => {
			const text = this.els.askInput.value.trim();
			if (!text) return;
			const ok = this.net?.ask(text);
			this.els.askStatus.textContent = ok ? 'Sent. The host picks from the queue.' : 'Live feed offline. Tap the feed pill to reconnect, then ask again.';
			if (ok) this.els.askInput.value = '';
		};
		this.els.askBtn.addEventListener('click', ask);
		this.els.askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });
	}

	// ── captions + ticker + phases ──────────────────────────────────────────────
	showCaption(text, speaking) {
		this.els.captionText.textContent = text;
		this.els.caption.classList.toggle('speaking', !!speaking);
		this.els.caption.hidden = false;
	}

	pushTicker(text, kind, link) {
		const item = document.createElement('div');
		item.className = `stage-ticker-item ${kind || ''}`;
		item.innerHTML = link
			? `<a href="${esc(link)}" target="_blank" rel="noopener">${esc(text)}</a>`
			: esc(text);
		this.els.ticker.prepend(item);
		while (this.els.ticker.children.length > 6) this.els.ticker.lastChild.remove();
		if (!REDUCED_MOTION) item.animate?.([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 260 });
	}

	renderPhase(phase) {
		const el = this.els.phase;
		el.className = 'stage-phase';
		if (phase === 'live') { el.classList.add('is-live'); el.innerHTML = '<span class="dot"></span> LIVE'; }
		else if (phase === 'between') { el.textContent = nextShowLabel(this.stage.next_show_at) || 'Between shows'; }
		else if (phase === 'ended') { el.textContent = 'Show ended. Highlights below'; }
		else { el.textContent = this.stage.next_show_at ? nextShowLabel(this.stage.next_show_at) : 'Pre-show'; }
	}

	renderLeaderboard(rows, show) {
		this.renderLeaderboardRows(rows);
		const total = show?.total_tips_atomic || 0;
		const count = show?.tip_count || 0;
		this.els.total.textContent = total ? `${fmtThree(total)} $THREE · ${count} tips` : 'No tips yet. Be the first';
	}

	renderLeaderboardRows(rows) {
		if (!rows.length) {
			this.els.leaderboard.innerHTML = '<li class="stage-lb-empty">Tip the host to take the top spot 👑</li>';
			return;
		}
		this.els.leaderboard.innerHTML = rows
			.map((r, i) => `<li class="${i === 0 ? 'top' : ''}"><span class="rank">${i + 1}</span><span class="who">${esc(r.label)}</span><span class="amt">${fmtThree(r.total)}</span></li>`)
			.join('');
	}

	// ── 3D venue ────────────────────────────────────────────────────────────────
	initThree() {
		if (!hasWebGL()) {
			this.els.stageWrap.classList.add('no-webgl');
			this.els.stageWrap.querySelector('.stage-3d-fallback').hidden = false;
			return;
		}
		try {
			this.three = new StageScene(this.els.canvas, this.stage);
			this.three.load();
		} catch (err) {
			this.els.stageWrap.classList.add('no-webgl');
			this.els.stageWrap.querySelector('.stage-3d-fallback').hidden = false;
		}
	}

	wireControls() {
		const resume = () => {
			if (this.three) this.three.resumeAudio();
			this.els.soundBtn.hidden = true;
			this.audioCtxResumed = true;
			// Replay the current line so a gesture-gated first utterance is heard.
			this.voice.resume();
		};
		this.els.soundBtn.addEventListener('click', resume);
		// The feed pill doubles as the reconnect control once the feed is down.
		this.els.netPill.addEventListener('click', () => this.net?.retry());
		this.els.closer?.addEventListener('click', () => this.three?.dolly(-1));
		this.els.farther?.addEventListener('click', () => this.three?.dolly(1));
		// First interaction anywhere resumes audio (browsers gate autoplay).
		window.addEventListener('pointerdown', () => { if (!this.audioCtxResumed) resume(); }, { once: true });
	}

	dispose() {
		try { this.net?.destroy(); } catch {}
		this.voice.dispose();
		try { this.three?.dispose(); } catch {}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// StageScene — the Three.js venue
// ─────────────────────────────────────────────────────────────────────────────
class StageScene {
	constructor(canvas, stage) {
		this.canvas = canvas;
		this.stage = stage;
		this.scene = new Scene();
		this.scene.background = new Color(0x07060d);
		this.scene.fog = new Fog(0x07060d, 14, 42);

		this.camera = new PerspectiveCamera(52, 1, 0.1, 200);
		this.camDist = 9;
		this.camHeight = 2.4;
		this.camera.position.set(0, this.camHeight, this.camDist);
		this.camera.lookAt(0, 1.6, 0);

		this.listener = new AudioListener();
		this.camera.add(this.listener);

		this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.1;

		// Real HDRI image-based lighting so the host/audience avatars' PBR
		// materials pick up believable reflections. Falls back to a procedural
		// room environment internally on fetch failure.
		loadEnvironment(this.renderer, this.scene, 'studio');

		this._buildVenue();
		this.hostGroup = new Group();
		this.hostGroup.position.set(0, 0, 0);
		this.scene.add(this.hostGroup);
		this.audienceGroup = new Group();
		this.scene.add(this.audienceGroup);
		this.emojiSprites = [];
		this.audienceMeshes = new Map();

		this.mouthTarget = null;
		this.positionalAudio = null;
		this._cue = 'idle';
		this._speaking = false;
		this._t = 0;
		this._raf = 0;
		this._onResize = () => this._resize();
		window.addEventListener('resize', this._onResize);
		this._resize();
		this._loop();
	}

	_buildVenue() {
		this.scene.add(new AmbientLight(0x404060, 1.1));
		const key = new DirectionalLight(0xffffff, 1.4);
		key.position.set(4, 9, 6);
		this.scene.add(key);
		// Stage spotlights — the show look.
		const spot = new SpotLight(0x9b6bff, 60, 30, Math.PI / 6, 0.4, 1.2);
		spot.position.set(0, 9, 4);
		spot.target.position.set(0, 1.5, 0);
		this.scene.add(spot, spot.target);
		const spot2 = new SpotLight(0x32d6ff, 40, 30, Math.PI / 5, 0.5, 1.2);
		spot2.position.set(-6, 8, 2);
		spot2.target.position.set(0, 1.5, 0);
		this.scene.add(spot2, spot2.target);
		this.rim = new PointLight(0xff5db1, 30, 18, 1.5);
		this.rim.position.set(0, 3, -3);
		this.scene.add(this.rim);

		const floor = new Mesh(
			new PlaneGeometry(80, 80),
			new MeshStandardMaterial({ color: 0x0c0b16, roughness: 0.85, metalness: 0.1 }),
		);
		floor.rotation.x = -Math.PI / 2;
		this.scene.add(floor);
		// Raised stage disc.
		const disc = new Mesh(
			new CylinderGeometry(3.4, 3.6, 0.4, 48),
			new MeshStandardMaterial({ color: 0x1a1730, roughness: 0.5, metalness: 0.3, emissive: 0x140a2e, emissiveIntensity: 0.6 }),
		);
		disc.position.y = 0.2;
		this.scene.add(disc);
		const ring = new Mesh(
			new CircleGeometry(3.3, 48),
			new MeshBasicMaterial({ color: 0x9b6bff }),
		);
		ring.rotation.x = -Math.PI / 2;
		ring.position.y = 0.41;
		ring.scale.setScalar(1);
		this.ring = ring;
		this.scene.add(ring);
	}

	load() {
		// Placeholder host so the stage is never empty while the GLB streams in.
		this.placeholder = new Mesh(
			new CylinderGeometry(0.5, 0.6, 1.7, 20),
			new MeshStandardMaterial({ color: 0x6b4bd6, emissive: 0x3a1f7a, emissiveIntensity: 0.7, roughness: 0.4 }),
		);
		this.placeholder.position.set(0, 1.25, 0);
		this.hostGroup.add(this.placeholder);

		const url = this.stage.host_avatar;
		if (!url) return;
		const loader = new GLTFLoader();
		try { loader.setMeshoptDecoder(MeshoptDecoder); } catch {}
		loader.load(
			url,
			(gltf) => this._mountHost(gltf.scene),
			undefined,
			() => { /* keep the placeholder — a missing GLB must not empty the stage */ },
		);
	}

	_mountHost(model) {
		if (this.placeholder) { this.hostGroup.remove(this.placeholder); this.placeholder = null; }
		// Normalize to ~1.7m tall, feet on the disc.
		model.updateMatrixWorld(true);
		const height = modelHeight(model);
		const scale = height > 0 ? 1.7 / height : 1;
		model.scale.setScalar(scale);
		model.position.y = 0.4;
		this.hostGroup.add(model);
		this.hostModel = model;
		this.mouthTarget = new MouthTarget(model);

		// Attach positional audio to the host head (or the model root).
		this.positionalAudio = new PositionalAudio(this.listener);
		this.positionalAudio.setRefDistance(2.4);
		this.positionalAudio.setRolloffFactor(1.1);
		this.positionalAudio.setDistanceModel('inverse');
		const head = findHead(model) || model;
		head.add(this.positionalAudio);
	}

	resumeAudio() {
		const ctx = this.listener?.context;
		if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
	}

	setCue(cue, speaking) {
		this._cue = cue || 'idle';
		this._speaking = !!speaking;
	}

	setAudience(members, selfId) {
		const seen = new Set();
		for (const m of members) {
			seen.add(m.id);
			let mesh = this.audienceMeshes.get(m.id);
			if (!mesh) {
				mesh = new Mesh(
					new CylinderGeometry(0.28, 0.34, 1.1, 12),
					new MeshStandardMaterial({ color: m.id === selfId ? 0x32d6ff : 0x4a4470, roughness: 0.7, emissive: m.vip ? 0xffb020 : 0x000000, emissiveIntensity: m.vip ? 0.5 : 0 }),
				);
				mesh.position.set(m.x, 0.55, m.z);
				this.audienceGroup.add(mesh);
				this.audienceMeshes.set(m.id, mesh);
			} else if (m.vip) {
				mesh.material.emissive.setHex(0xffb020);
				mesh.material.emissiveIntensity = 0.5;
			}
		}
		for (const [id, mesh] of this.audienceMeshes) {
			if (!seen.has(id)) { this.audienceGroup.remove(mesh); disposeMesh(mesh); this.audienceMeshes.delete(id); }
		}
	}

	floatEmoji(_id, emoji) {
		if (REDUCED_MOTION || !emoji) return;
		// A lightweight DOM emoji floating up from the stage (no sprite atlas needed).
		const el = document.createElement('div');
		el.className = 'stage-float-emoji';
		el.textContent = emoji;
		el.style.left = `${40 + Math.random() * 20}%`;
		this.canvas.parentElement.appendChild(el);
		el.animate([{ transform: 'translateY(0) scale(1)', opacity: 1 }, { transform: 'translateY(-140px) scale(1.6)', opacity: 0 }], { duration: 1400, easing: 'ease-out' })
			.addEventListener('finish', () => el.remove());
	}

	burst(kind) {
		if (REDUCED_MOTION) return;
		const color = kind === 'gold' ? 0xffd24a : 0x9b6bff;
		this.rim.color.setHex(color);
		this.ring.material.color.setHex(color);
		this._burstT = 1;
	}

	dolly(dir) {
		this.camDist = Math.max(4.5, Math.min(16, this.camDist + dir * 1.6));
	}

	_resize() {
		const w = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
		const h = this.canvas.clientHeight || this.canvas.parentElement.clientHeight;
		if (!w || !h) return;
		this.renderer.setSize(w, h, false);
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
	}

	_loop() {
		this._raf = requestAnimationFrame(() => this._loop());
		const dt = REDUCED_MOTION ? 0 : 0.016;
		this._t += dt;
		// Ease camera toward target distance (proximity → louder host via listener).
		const tx = 0, tz = this.camDist;
		this.camera.position.x += (tx - this.camera.position.x) * 0.06;
		this.camera.position.z += (tz - this.camera.position.z) * 0.06;
		this.camera.position.y = this.camHeight;
		this.camera.lookAt(0, 1.5, 0);

		// Host idle bob + a stronger sway while speaking.
		if (this.hostModel) {
			const amp = this._speaking ? 0.05 : 0.02;
			this.hostModel.position.y = 0.4 + Math.sin(this._t * 2) * amp;
			if (this._cue === 'dj') this.hostModel.rotation.y = Math.sin(this._t * 3) * 0.25;
			else this.hostModel.rotation.y += ((0) - this.hostModel.rotation.y) * 0.05;
		}
		if (this.placeholder) this.placeholder.position.y = 1.25 + Math.sin(this._t * 2) * 0.04;

		// Pulse the stage ring while speaking.
		if (this.ring) {
			const s = 1 + (this._speaking ? Math.abs(Math.sin(this._t * 4)) * 0.04 : 0);
			this.ring.scale.setScalar(s);
		}
		if (this._burstT > 0) {
			this._burstT -= 0.02;
			if (this._burstT <= 0) { this.rim.color.setHex(0xff5db1); this.ring.material.color.setHex(0x9b6bff); }
		}
		this.renderer.render(this.scene, this.camera);
	}

	dispose() {
		cancelAnimationFrame(this._raf);
		window.removeEventListener('resize', this._onResize);
		try { this.renderer.dispose(); } catch {}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────
function venueShell() {
	return `
	<div class="stage-venue">
		<div class="stage-main">
			<div id="stage-3d" class="stage-3d">
				<canvas id="stage-canvas" aria-label="Live 3D stage"></canvas>
				<div class="stage-3d-fallback" hidden>
					<div class="stage-fallback-card">
						<h2>Audio + captions mode</h2>
						<p>Your browser can't render the 3D venue, but the show goes on: you'll hear the host and read every line below, and you can still tip in $THREE.</p>
					</div>
				</div>
				<div id="stage-caption" class="stage-caption" hidden><span class="cap-text"></span></div>
				<div class="stage-overlay-top">
					<div class="stage-id">
						<span id="stage-phase" class="stage-phase">…</span>
						<h1 id="stage-title">Live stage</h1>
						<p class="stage-host">with <span id="stage-host-name">the host</span> · <span id="stage-aud-count">0 here</span></p>
					</div>
					<button id="stage-net-pill" type="button" class="stage-net-pill warn" aria-label="Live feed" hidden>…</button>
				</div>
				<div class="stage-overlay-bottom">
					<button id="stage-sound" type="button" class="stage-sound" hidden>🔊 Tap for sound</button>
					<div class="stage-dolly">
						<button id="stage-farther" type="button" aria-label="Step back">−</button>
						<span>proximity</span>
						<button id="stage-closer" type="button" aria-label="Step closer">+</button>
					</div>
				</div>
				<div id="stage-ticker" class="stage-ticker" aria-live="polite"></div>
				<div id="stage-reactions" class="stage-reactions" role="group" aria-label="Reactions"></div>
			</div>
		</div>
		<aside class="stage-side">
			<section class="stage-panel">
				<h2>Tip the host <span class="stage-coin">$THREE</span></h2>
				<div id="stage-tip-presets" class="stage-tip-presets"></div>
				<div class="stage-tip-row">
					<input id="stage-tip-custom" type="number" min="1" step="1" placeholder="Custom" inputmode="numeric" aria-label="Custom tip amount" />
					<button id="stage-tip-send" type="button" class="stage-tip-send">Tip</button>
				</div>
				<input id="stage-tip-msg" class="stage-tip-msg" maxlength="140" placeholder="Add a message (optional)" aria-label="Tip message" />
				<p id="stage-tip-status" class="stage-tip-status" aria-live="polite"></p>
			</section>
			<section class="stage-panel">
				<h2>Top tippers <span id="stage-total" class="stage-total"></span></h2>
				<ol id="stage-leaderboard" class="stage-leaderboard"></ol>
			</section>
			<section class="stage-panel">
				<h2>Ask the host</h2>
				<div class="stage-ask-row">
					<input id="stage-ask-input" maxlength="240" placeholder="Type a question…" aria-label="Ask the host a question" />
					<button id="stage-ask-btn" type="button">Ask</button>
				</div>
				<p id="stage-ask-status" class="stage-ask-status" aria-live="polite"></p>
			</section>
		</aside>
	</div>`;
}

function readSelfIdentity() {
	let name = '';
	let avatar = '';
	try {
		name = localStorage.getItem('threews:displayName') || localStorage.getItem('walk:name') || '';
		avatar = localStorage.getItem('walk:avatar') || '';
	} catch {}
	return { name: name.slice(0, 40), avatar: avatar.slice(0, 512) };
}

function tipStageLabel(s) {
	return {
		connecting: 'Connecting your wallet…',
		building: 'Building the transfer…',
		signing: 'Approve in your wallet…',
		sending: 'Sending on-chain…',
		confirming: 'Confirming settlement…',
	}[s] || 'Working…';
}

function nextShowLabel(ms) {
	if (!ms) return '';
	const d = new Date(ms);
	if (d.getTime() < Date.now()) return '';
	return `Next show ${d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

function disposeMesh(mesh) {
	try { mesh.geometry?.dispose(); mesh.material?.dispose?.(); } catch {}
}

function hasWebGL() {
	try {
		const c = document.createElement('canvas');
		return !!(c.getContext('webgl2') || c.getContext('webgl'));
	} catch { return false; }
}

function skeletonCards(n) {
	return Array.from({ length: n }, () => '<div class="stage-card stage-card-skel"><div class="stage-card-art"></div><div class="stage-card-body"><div class="sk-line"></div><div class="sk-line short"></div></div></div>').join('');
}

function emptyState(title, body, href, cta) {
	return `<div class="stage-empty"><h2>${esc(title)}</h2><p>${esc(body)}</p>${href ? `<a class="stage-cta" href="${href}">${esc(cta)}</a>` : ''}</div>`;
}

function errorState(title) {
	return `<div class="stage-empty stage-error"><h2>${esc(title)}</h2><p>Something went wrong loading this. Check your connection and try again.</p><button type="button" class="stage-cta" data-retry>Try again</button></div>`;
}

// Retry in place: re-run the loader that failed instead of reloading the whole
// page, so a venue keeps its 3D context and the directory keeps its scroll.
function wireRetry(container, retry) {
	container.querySelector('[data-retry]')?.addEventListener('click', retry);
}
