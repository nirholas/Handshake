// /agent-screen — live agent screen viewer + workspace.
//
// URL: /agent-screen?agentId=<uuid>
//
// A full-bleed live "Screen" fills the stage; everything else is a floating,
// draggable, minimizable panel laid over it:
//
//   • Avatar Cam — an offscreen Three.js render of the agent's avatar head,
//     giving the agent presence. Drag, resize, minimize, hide.
//   • Activity Log — what the agent narrated with each push. Filter by type,
//     clear, drag, resize, minimize, hide.
//   • Stream Stats — live FPS / frames / resolution / data / uptime, computed
//     from the real SSE frame stream (advanced; hidden by default).
//
// Two viewing modes, both one keystroke away:
//   • Default — screen + panels + task bar + header chrome.
//   • Zen (Z) — hide ALL chrome for a clean screenshot: just the screen, and
//     optionally the avatar cam. Built for sharing.
//
// Layout (panel positions, sizes, visibility, mode, fit) persists per browser.

import {
	PerspectiveCamera,
	WebGLRenderer,
	Scene,
	AmbientLight,
	DirectionalLight,
	Box3,
	Quaternion,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinnedScene } from 'three/addons/utils/SkeletonUtils.js';
import { AnimationManager } from './animation-manager.js';
import { makeGltfRig, poseFromMannequinPreset } from './pose-rig.js';
import { matchPose, presetPoseById, POSE_QUICK_PICKS } from './pose-match.js';
import { StageShow } from './agent-screen-stage.js';
import { createAgentScreenClient } from './shared/agent-screen-client.js';
import { mountAgentReactions } from './agent-reactions.js';
import { handleTourFrame } from './agent-screen-tour.js';
import { buildRunCommand, buildRunCommandHtml, RUNTIME_LABELS } from './agent-screen-runcmd.js';
import { applyCinematicDefaults, detectQualityTier, loadEnvironment } from './shared/cinematic-render.js';
import { createNewsroomAnchor } from './agent-screen-anchor.js';
import { createTreasuryCockpit } from './agent-screen-treasury.js';
import { MirrorPanel } from './agent-screen-mirror.js';
import { createHireVisualizer } from './agent-screen-hire.js';
import { createReputationPanel } from './agent-screen-reputation.js';
import { createDiaryPanel } from './agent-screen-diary.js';
import {
	parsePnlDelta, accumulatePnl, emptyPnlState, unrealizedTotalUsd, emoteForExit, formatSol, formatUsd,
} from './shared/trade-pnl.js';
import { classify, colorHex } from './activity-cinema.js';
import {
	parseLaunchCommand, validateLaunchParams, narrate as narrateLaunch,
	renderLaunchHud, truncMid,
} from './launch-director.js';
import { parseGrindCommand } from './vanity-grind-director.js';
import {
	clampPrompt,
	validatePrompt,
	forgeStageNarration,
	finalForgeFrame,
	parseForgeFrame,
	viewerLinkFor,
} from './shared/forge-frames.js';
import { agentAvatarGlb } from './shared/agent-3d.js';
import { getMeshoptDecoder } from './viewer/internal.js';
import { ScreenshotModal } from './components/screenshot-modal.js';
import { SentimentHeatmap3D } from './sentiment-heatmap-3d.js';
import { createHeatmapPoller, buildNarrationContext } from './sentiment-heatmap-data.js';
import { createPnlHud } from './agent-screen-pnl-hud.js';
import { createAmbientWorld, phaseLabel } from './agent-screen-world.js';
import { createDjScript } from './agent-screen-dj.js';
import { mountScreenControl } from './agent-screen-control.js';
import { LipSyncAnalyser } from './lip-sync-analyser.js';
import { createVisemeDriver } from './runtime/lipsync.js';
import { classifyTaskInput, ensureSessionId } from './shared/ask-routing.js';
import { createCollabGraph } from './shared/collab-graph.js';

// One meshopt-aware loader, built once. Optimized agent avatars ship with
// EXT_meshopt_compression, so the decoder must be wired before the loader can
// parse a single bufferView — otherwise GLTFLoader throws on compressed files.
let _glbLoaderPromise = null;
function getAvatarLoader() {
	if (!_glbLoaderPromise) {
		_glbLoaderPromise = getMeshoptDecoder()
			.then((decoder) => {
				const loader = new GLTFLoader();
				loader.setMeshoptDecoder(decoder);
				return loader;
			})
			.catch(() => new GLTFLoader()); // uncompressed avatars still load
	}
	return _glbLoaderPromise;
}

const params = new URLSearchParams(location.search);
const agentId = params.get('agentId') || '';

const noAgentEl = document.getElementById('asc-no-agent');
const stageEl = document.getElementById('asc-stage');
const agentNameEl = document.getElementById('asc-agent-name');
const liveBadgeEl = document.getElementById('asc-live-badge');
const badgeTextEl = document.getElementById('asc-badge-text');
const backEl = document.getElementById('asc-back');
const agentLinkEl = document.getElementById('asc-agent-link');
const controlsEl = document.getElementById('asc-controls');
const fsBtn = document.getElementById('asc-fullscreen-btn');
const toastWrap = document.getElementById('asc-toast-wrap');

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// ── transient toast ─────────────────────────────────────────────────────────
function toast(msg, ms = 2200) {
	const el = document.createElement('div');
	el.className = 'asc-toast';
	el.textContent = msg;
	toastWrap.appendChild(el);
	setTimeout(() => {
		el.classList.add('out');
		setTimeout(() => el.remove(), 260);
	}, ms);
}

if (!agentId) {
	renderSetup();
} else {
	noAgentEl.style.display = 'none';
	boot(agentId);
}

// ── Worker Setup Panel ─────────────────────────────────────────────────────
// Rendered when no agentId is in the URL. Walks through:
//   1. Pick an agent (shows UUIDs)
//   2. Generate an API key (used as AGENT_JWT)
//   3. Copy the exact run command

async function renderSetup() {
	document.title = 'Deploy to the wall · Agent Screen · three.ws';
	agentNameEl.textContent = 'Deploy to wall';
	liveBadgeEl.style.display = 'none';
	controlsEl.style.display = 'none';

	const container = noAgentEl;
	container.className = 'ws-setup';
	container.style.display = 'flex';

	// ── wizard state (persists across re-renders for the session) ────────────
	let selectedAgent = null;   // { id, name }
	let apiKey = null;          // 'sk_live_...' — the real minted key, shown once
	let activeTab = 'local';    // 'local' | 'docker' | 'bb'
	let agentSearch = '';       // step-1 filter (overflow: 100s of agents)
	let keyError = '';          // inline error from the mint call

	// ── go-live detector state ───────────────────────────────────────────────
	// liveState drives step 4. The SSE first-frame is ground truth for "live";
	// the public directory check is a secondary signal that surfaces the most
	// common silent failure (agent is private → never shows on the wall).
	let liveState = 'idle';     // 'idle' | 'watching' | 'live'
	let privateWarning = false; // agent not found in the public directory
	const detector = { client: null, pollTimer: null, started: false };

	// ── Check auth ─────────────────────────────────────────────────────────
	let agents = [];
	let isSignedIn = false;
	try {
		const r = await fetch('/api/agents', { credentials: 'include' });
		if (r.ok) {
			const j = await r.json();
			agents = j.agents || j.data || [];
			isSignedIn = true;
		} else if (r.status === 401) {
			isSignedIn = false;
		}
	} catch { /* network error — treat as signed-out */ }

	// Command builders pull from the shared, unit-tested module so the copied
	// command and the highlighted display can never drift. Placeholders are only
	// shown before an agent/key exist; once both are real, so is the command.
	const cmdOpts = () => ({
		runtime: activeTab,
		agentId: selectedAgent?.id || '<AGENT_ID>',
		agentJwt: apiKey || '<AGENT_JWT>',
		origin: location.origin,
	});

	function agentCardHTML(a) {
		const initials = (a.name || '?').slice(0, 2).toUpperCase();
		const thumbUrl = a.avatar_thumbnail_url || a.avatar_url || '';
		const avatarEl = thumbUrl
			? `<img class="ws-agent-avatar" src="${esc(thumbUrl)}" alt="" loading="lazy">`
			: `<div class="ws-agent-avatar-placeholder">${esc(initials)}</div>`;
		const shortId = (a.id || '').slice(0, 8) + '…';
		return `<button class="ws-agent-card${selectedAgent?.id === a.id ? ' selected' : ''}" data-id="${esc(a.id)}" data-name="${esc(a.name || 'Agent')}">
			${avatarEl}
			<div class="ws-agent-info">
				<div class="ws-agent-name">${esc(a.name || 'Agent')}</div>
				<div class="ws-agent-uuid">${esc(shortId)}</div>
			</div>
		</button>`;
	}

	function filteredAgents() {
		const q = agentSearch.trim().toLowerCase();
		if (!q) return agents;
		return agents.filter((a) =>
			(a.name || '').toLowerCase().includes(q) || (a.id || '').toLowerCase().includes(q));
	}

	function agentGridHTML() {
		const list = filteredAgents();
		if (agents.length === 0) {
			return `<div class="ws-agent-empty">
				${isSignedIn
					? `No agents yet. <a href="/agents/new">Create one →</a>`
					: `<a href="/login">Sign in</a> to see your agents.`}
			</div>`;
		}
		if (list.length === 0) {
			return `<div class="ws-agent-empty">No agents match “${esc(agentSearch)}”.</div>`;
		}
		return list.map(agentCardHTML).join('');
	}

	function progressHTML() {
		const currentStep = liveState === 'live' ? 4 : apiKey ? 3 : selectedAgent ? 2 : 1;
		const labels = ['Pick agent', 'Generate key', 'Run command', 'Go live'];
		return labels.map((label, i) => {
			const n = i + 1;
			const done = n < currentStep || (n === 4 && liveState === 'live');
			const active = n === currentStep && !done;
			return `<div class="ws-prog-node${done ? ' done' : active ? ' active' : ''}">
				<span class="ws-prog-dot">${done ? '✓' : n}</span>
				<span class="ws-prog-label">${label}</span>
			</div>`;
		}).join('<span class="ws-prog-line"></span>');
	}

	function goLiveHTML() {
		const watchLink = selectedAgent ? `/agent-screen?agentId=${encodeURIComponent(selectedAgent.id)}` : '#';
		const privateNote = privateWarning ? `
			<div class="ws-golive-note">
				This agent isn't in the public directory yet. Make it public so viewers can find it on the wall —
				<a href="${selectedAgent ? `/agents/${encodeURIComponent(selectedAgent.id)}` : '/agents'}">agent settings →</a>
			</div>` : '';

		if (liveState === 'live') {
			return `
				<div class="ws-golive live">
					<span class="ws-golive-check">✓</span>
					<div>
						<strong>You're live on the wall</strong>
						<span>${esc(selectedAgent?.name || 'Your agent')} is broadcasting — it's now on the public live wall.</span>
					</div>
				</div>
				<div class="ws-golive-actions">
					<a class="ws-watch-link" href="/agents-live">See it on the wall →</a>
					<a class="ws-btn ws-btn-ghost ws-golive-open" href="${watchLink}">Open your screen</a>
				</div>`;
		}
		if (liveState === 'watching') {
			return `
				<div class="ws-golive watching">
					<span class="ws-golive-pulse"></span>
					<div>
						<strong>Watching for your agent's first frame…</strong>
						<span>Run the command above. The moment your caster pushes a frame, this flips to live.</span>
					</div>
				</div>
				${privateNote}`;
		}
		return `<div class="ws-golive idle">
			<span class="ws-golive-dot"></span>
			<div><span>Generate a key and copy the command — go-live detection starts automatically.</span></div>
		</div>`;
	}

	function render() {
		const step1Done = !!selectedAgent;
		const step2Done = !!apiKey;
		const showSearch = agents.length > 8;

		container.innerHTML = `
		<div class="ws-setup-inner">
			<div class="ws-setup-hero">
				<h1>Deploy your agent to the wall</h1>
				<p>Pick an agent, generate its key, copy one command — and watch it go live on the public wall.</p>
			</div>

			<div class="ws-progress" aria-hidden="true">${progressHTML()}</div>

			${!isSignedIn ? `
			<div class="ws-not-signed-in">
				<span>⚠</span>
				<span>You need to <a href="/login">sign in</a> to generate an API key and select an agent.</span>
			</div>` : ''}

			<!-- Step 1: Pick agent -->
			<div class="ws-setup-step">
				<div class="ws-setup-step-head">
					<div class="ws-step-num${step1Done ? ' done' : ''}">${step1Done ? '✓' : '1'}</div>
					<div>
						<h3>${step1Done ? `Agent: ${esc(selectedAgent.name)}` : 'Select an agent'}</h3>
						<p>${step1Done ? esc(selectedAgent.id) : 'Choose which agent will broadcast its screen'}</p>
					</div>
					${step1Done ? `<button class="ws-btn ws-btn-ghost" id="ws-change-agent" style="margin-left:auto;font-size:0.75rem;padding:0.3rem 0.6rem;">Change</button>` : ''}
				</div>
				${!step1Done ? `
				<div class="ws-setup-step-body">
					${showSearch ? `<input class="ws-agent-search" id="ws-agent-search" type="search" placeholder="Search your agents…" value="${esc(agentSearch)}" spellcheck="false">` : ''}
					<div class="ws-agent-grid" id="ws-agent-grid">${agentGridHTML()}</div>
				</div>` : ''}
			</div>

			<!-- Step 2: API key -->
			<div class="ws-setup-step" ${!step1Done ? 'style="opacity:0.45;pointer-events:none"' : ''}>
				<div class="ws-setup-step-head">
					<div class="ws-step-num${step2Done ? ' done' : ''}">${step2Done ? '✓' : '2'}</div>
					<div>
						<h3>Generate an API key</h3>
						<p>Used as <code style="font-size:0.78rem;color:#d4d4d8">AGENT_JWT</code> — authenticates the worker as you</p>
					</div>
				</div>
				<div class="ws-setup-step-body">
					<div class="ws-key-row">
						<div class="ws-key-display${apiKey ? '' : ' placeholder'}" id="ws-key-display">
							${apiKey ? esc(apiKey) : 'Click Generate to create a key'}
						</div>
						${apiKey
							? `<button class="ws-btn ws-btn-copy" id="ws-copy-key">Copy</button>
							   <button class="ws-btn ws-btn-ghost" id="ws-regen-key" title="Generate a fresh key" style="font-size:0.78rem;">New</button>`
							: `<button class="ws-btn ws-btn-primary" id="ws-gen-key" ${!isSignedIn ? 'disabled' : ''}>Generate</button>`
						}
					</div>
					${keyError ? `<p class="ws-key-error">${esc(keyError)} <button class="ws-link-btn" id="ws-retry-key">Try again</button></p>` : ''}
					${apiKey
						? `<p class="ws-key-note"><strong>Save this key now.</strong> It won't be shown again. It grants access to your account — treat it like a password.</p>`
						: `<p class="ws-key-note">Creates a new <code style="font-size:0.78rem">agents:write</code>-scoped API key. You can manage keys at <a href="/dashboard-next/developers" style="color:#d4d4d8">Developers →</a></p>`
					}
				</div>
			</div>

			<!-- Step 3: Run command -->
			<div class="ws-setup-step" ${!step1Done ? 'style="opacity:0.45;pointer-events:none"' : ''}>
				<div class="ws-setup-step-head">
					<div class="ws-step-num${liveState === 'live' ? ' done' : ''}">${liveState === 'live' ? '✓' : '3'}</div>
					<div>
						<h3>Run the worker</h3>
						<p>Copy and run in your terminal from the <code style="font-size:0.78rem;color:#d4d4d8">workers/agent-screen-worker/</code> directory</p>
					</div>
				</div>
				<div class="ws-setup-step-body">
					<div class="ws-cmd-tabs">
						${['local', 'docker', 'bb'].map((t) => `<button class="ws-cmd-tab${activeTab === t ? ' active' : ''}" data-tab="${t}">${esc(RUNTIME_LABELS[t])}</button>`).join('')}
					</div>
					<div class="ws-cmd-block">
						<button class="ws-btn ws-btn-copy ws-cmd-copy" id="ws-copy-cmd">Copy</button>
						<pre id="ws-cmd-pre">${buildRunCommandHtml(cmdOpts())}</pre>
					</div>
					${activeTab === 'bb' ? `<p class="ws-key-note" style="margin-top:0.7rem">Get your Browserbase key + project ID at <a href="https://browserbase.com" target="_blank" rel="noopener" style="color:#d4d4d8">browserbase.com</a> — no Docker needed, the browser runs in their cloud.</p>` : ''}
					<p class="ws-key-note" style="margin-top:0.7rem">The worker authenticates with your <code style="font-size:0.78rem">AGENT_JWT</code> alone — no other secret to set.</p>
				</div>
			</div>

			<!-- Step 4: Go live -->
			<div class="ws-setup-step" ${!step2Done ? 'style="opacity:0.45;pointer-events:none"' : ''}>
				<div class="ws-setup-step-head">
					<div class="ws-step-num${liveState === 'live' ? ' done' : ''}">${liveState === 'live' ? '✓' : '4'}</div>
					<div>
						<h3>${liveState === 'live' ? "You're live on the wall" : 'Go live'}</h3>
						<p>${liveState === 'live' ? 'Your agent is broadcasting to viewers' : "We watch for your agent's first frame and confirm it's live"}</p>
					</div>
				</div>
				<div class="ws-setup-step-body">
					${goLiveHTML()}
					<details class="ws-trouble">
						<summary>Not appearing? Common fixes</summary>
						<ul>
							<li><strong>Worker not started</strong> — run the command above; frames land within seconds.</li>
							<li><strong>Wrong directory</strong> — run it from <code>workers/agent-screen-worker/</code> after <code>npm install</code>.</li>
							<li><strong>Key revoked or wrong</strong> — generate a fresh key in step 2 and recopy the command.</li>
							<li><strong>Agent is private</strong> — public visibility is required to appear on <a href="/agents-live">/agents-live</a>.</li>
						</ul>
					</details>
				</div>
			</div>
		</div>`;

		bindAgentCards();
		const searchEl = container.querySelector('#ws-agent-search');
		if (searchEl) {
			searchEl.addEventListener('input', () => {
				agentSearch = searchEl.value;
				const grid = container.querySelector('#ws-agent-grid');
				if (grid) { grid.innerHTML = agentGridHTML(); bindAgentCards(); }
			});
		}
		container.querySelector('#ws-change-agent')?.addEventListener('click', () => {
			selectedAgent = null;
			resetDetector();
			render();
		});
		container.querySelector('#ws-gen-key')?.addEventListener('click', generateKey);
		container.querySelector('#ws-regen-key')?.addEventListener('click', generateKey);
		container.querySelector('#ws-retry-key')?.addEventListener('click', generateKey);
		container.querySelector('#ws-copy-key')?.addEventListener('click', () => copyText(apiKey, 'ws-copy-key'));
		container.querySelector('#ws-copy-cmd')?.addEventListener('click', () => copyText(buildRunCommand(cmdOpts()), 'ws-copy-cmd'));
		container.querySelectorAll('.ws-cmd-tab').forEach((tab) => {
			tab.addEventListener('click', () => { activeTab = tab.dataset.tab; render(); });
		});

		// Everything needed to go live exists → start watching for the first frame.
		if (selectedAgent && apiKey) startGoLiveDetector();
	}

	function bindAgentCards() {
		container.querySelectorAll('.ws-agent-card').forEach((card) => {
			card.addEventListener('click', () => {
				selectedAgent = { id: card.dataset.id, name: card.dataset.name };
				resetDetector();
				render();
			});
		});
	}

	async function generateKey() {
		keyError = '';
		const btn = container.querySelector('#ws-gen-key') || container.querySelector('#ws-regen-key');
		if (btn) { btn.disabled = true; btn.innerHTML = '<span class="ws-spinner"></span>'; }
		try {
			const csrf = await fetch('/api/csrf-token', { credentials: 'include' })
				.then((r) => r.json())
				.then((j) => j.data?.token || j.token || '')
				.catch(() => '');

			const r = await fetch('/api/api-keys', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
				body: JSON.stringify({ name: `agent-screen:${selectedAgent?.name || 'worker'}`, scope: 'agents:write agents:read' }),
			});
			const j = await r.json().catch(() => ({}));
			if (r.ok && (j.data?.token || j.token)) {
				apiKey = j.data?.token || j.token;
				resetDetector();
				render();
			} else if (r.status === 429) {
				keyError = 'Rate limited — wait a moment before generating another key.';
				render();
			} else {
				keyError = j.message || j.error_description || 'Could not generate a key. Check you are signed in and try again.';
				render();
			}
		} catch {
			keyError = 'Network error while generating the key — check your connection.';
			render();
		}
	}

	// ── go-live detector ─────────────────────────────────────────────────────
	function startGoLiveDetector() {
		if (detector.started || !selectedAgent || !apiKey) return;
		detector.started = true;
		liveState = 'watching';

		detector.client = createAgentScreenClient(selectedAgent.id, {
			onFrame() {
				if (liveState === 'live') return;
				liveState = 'live';
				stopDetectorConnections();
				render();
			},
		});
		detector.client.connect();

		// Secondary signal: is the agent indexed in the public directory? Surfaces
		// the "agent is private" failure mode while we wait for the first frame.
		checkDirectory();
		detector.pollTimer = setInterval(checkDirectory, 8000);
		render();
	}

	function stopDetectorConnections() {
		detector.client?.disconnect();
		detector.client = null;
		if (detector.pollTimer) { clearInterval(detector.pollTimer); detector.pollTimer = null; }
	}

	function resetDetector() {
		stopDetectorConnections();
		detector.started = false;
		liveState = 'idle';
		privateWarning = false;
	}

	async function checkDirectory() {
		if (!selectedAgent) return;
		try {
			const r = await fetch(`/api/agents/public?q=${encodeURIComponent(selectedAgent.name || '')}&limit=48`);
			if (!r.ok) return;
			const j = await r.json();
			const list = j.agents || j.data || [];
			const found = list.some((a) => a.id === selectedAgent.id);
			if (privateWarning !== !found) {
				privateWarning = !found;
				if (liveState !== 'live') render();
			}
		} catch { /* non-fatal — the SSE frame is the authoritative signal */ }
	}

	async function copyText(text, btnId) {
		let ok = false;
		try {
			await navigator.clipboard.writeText(text);
			ok = true;
		} catch {
			// Clipboard API blocked (insecure context / permissions) → textarea fallback.
			try {
				const ta = document.createElement('textarea');
				ta.value = text;
				ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
				document.body.appendChild(ta);
				ta.focus(); ta.select();
				ok = document.execCommand('copy');
				ta.remove();
			} catch { ok = false; }
		}
		const el = container.querySelector(`#${btnId}`);
		if (!el) return;
		const orig = el.dataset.label || el.textContent;
		el.dataset.label = orig;
		el.textContent = ok ? 'Copied!' : 'Press ⌘C';
		el.classList.toggle('copied', ok);
		setTimeout(() => { el.textContent = orig; el.classList.remove('copied'); }, 1800);
	}

	window.addEventListener('beforeunload', stopDetectorConnections);

	render();
}

// ── workspace layout persistence ─────────────────────────────────────────────

// Bumped v1 → v2 to retire the old six-panels-open layout. Returning visitors
// get the calm two-panel default once, then their re-arrangements persist again.
const LS_KEY = 'twx_asc_workspace_v2';

function defaultLayout() {
	return {
		zen: false,
		zenCam: true,          // keep the avatar cam visible in zen by default
		fit: 'contain',        // 'contain' | 'cover'
		// Calm default: the avatar is the hero, so it owns the whole stage. Only two
		// panels open on first load — Reputation and Activity Log — docked to a tidy
		// right rail (reputation top, log bottom, no overlap). Everything else is one
		// toolbar click away. Bumping LS_KEY resets returning visitors to this baseline.
		panels: {
			cam:      { hidden: true,  min: false, x: null, y: null, w: 260 },
			log:      { hidden: false, min: false, x: null, y: null, w: 320, h: 280 },
			stats:    { hidden: true,  min: false, x: null, y: null, w: 218 },
			treasury: { hidden: true,  min: false, x: null, y: null, w: 344, h: null },
			mirror:   { hidden: true,  min: false, x: null, y: null, w: 380, h: null },
			stage:    { hidden: true,  min: false, x: null, y: null, w: 320, h: null },
			heatmap:  { hidden: true,  min: false, x: null, y: null, w: 460, h: 340 },
			hud:      { hidden: true,  min: false, x: null, y: null, w: 288, h: null },
			diary:    { hidden: true,  min: false, x: null, y: null, w: 360, h: 332 },
			hire:     { hidden: true,  min: false, x: null, y: null, w: 340, h: null },
			reputation: { hidden: false, min: false, x: null, y: null, w: 320, h: 340 },
		},
	};
}

function loadLayout() {
	const base = defaultLayout();
	try {
		const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
		base.zen = !!saved.zen;
		base.zenCam = saved.zenCam !== false;
		base.fit = saved.fit === 'cover' ? 'cover' : 'contain';
		for (const k of Object.keys(base.panels)) {
			if (saved.panels && saved.panels[k]) Object.assign(base.panels[k], saved.panels[k]);
		}
	} catch { /* corrupt or absent — defaults */ }
	return base;
}

// Detect a Team Task command in the task bar. A lead agent splits the goal,
// delegates sub-tasks and hires teammates over x402 (api/agent-collab). Matches
// an explicit `team:` prefix or natural phrasings; returns the cleaned goal or
// null. The owner gate and hard spend cap live server-side — this only routes.
export function parseTeamCommand(raw) {
	const text = String(raw == null ? '' : raw).trim();
	if (!text) return null;
	// Explicit prefix: "team: <goal>" / "team task: <goal>".
	const prefix = text.match(/^team(?:\s+task)?\s*[:\-—]\s*(.+)$/is);
	if (prefix && prefix[1].trim()) return prefix[1].trim();
	// Natural phrasing: "assemble a team to …", "lead a team to …",
	// "delegate to your team: …", "with your team, …".
	const natural = text.match(
		/^(?:assemble|lead|gather|rally|build)\s+(?:a|your|the)?\s*team\b[\s,:to-]*([\s\S]+)$/i,
	) || text.match(/^delegate\s+to\s+(?:your|the)\s+team\b[\s,:-]*([\s\S]+)$/i);
	if (natural && natural[1].trim()) return natural[1].trim();
	return null;
}

// ─────────────────────────────────────────────────────────────────────────────

async function boot(id) {
	stageEl.style.display = '';
	const layout = loadLayout();

	let saveTimer = null;
	function saveLayout() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			try { localStorage.setItem(LS_KEY, JSON.stringify(layout)); } catch { /* quota — ignore */ }
		}, 250);
	}

	// Build the stage DOM: full-bleed screen + floating panels + task bar.
	stageEl.innerHTML = `
		<div class="asc-screen-stage">
			<canvas id="asc-screen-canvas"></canvas>
			<!-- Newsroom Anchor lower-third (slides up on a bulletin) -->
			<div class="asc-lt" id="asc-lowerthird" aria-live="polite">
				<div class="asc-lt-bar"></div>
				<div class="asc-lt-body">
					<span class="asc-lt-eyebrow"><span class="asc-lt-dot"></span>MARKET ANCHOR</span>
					<div class="asc-lt-headline" id="asc-lt-headline"></div>
					<div class="asc-lt-note" id="asc-lt-note" style="display:none"></div>
				</div>
				<button class="asc-lt-mute" id="asc-lt-mute" type="button" aria-pressed="false" title="Unmute anchor — A">🔇</button>
			</div>
			<!-- One-tap unmute CTA (audio is muted by default) -->
			<button class="asc-anchor-unmute" id="asc-anchor-unmute" type="button" style="display:none">
				<span class="asc-anchor-unmute-icon">🔊</span>
				<span>Tap to hear the anchor</span>
			</button>
		</div>
		<div class="asc-screen-overlay" id="asc-screen-overlay">
			<div class="pulse-ring"></div>
			<p>Waiting for agent…</p>
			<small>The agent will appear here once it starts broadcasting</small>
		</div>

		<!-- Avatar cam panel -->
		<div class="asc-panel asc-panel--cam" id="asc-panel-cam" data-panel="cam">
			<div class="asc-panel-head" data-drag>
				<span class="asc-panel-grip">⠿</span>
				<span class="asc-panel-title">Avatar Cam</span>
				<div class="asc-panel-btns">
					<button class="asc-panel-btn" data-act="min" title="Minimize">▁</button>
					<button class="asc-panel-btn" data-act="close" title="Hide (C)">✕</button>
				</div>
			</div>
			<div class="asc-panel-body asc-cam-body">
				<div class="asc-webcam-bezel" id="asc-webcam-bezel">
					<div class="asc-webcam-idle" id="asc-webcam-idle">Loading avatar…</div>
					<div class="asc-webcam-badge" id="asc-webcam-badge" style="display:none">
						<span class="cam-dot"></span>
						<span id="asc-webcam-name">—</span>
					</div>
				</div>
				<!-- Pose Studio Live: call out a pose, the avatar performs it -->
				<div class="asc-pose" id="asc-pose">
					<form class="asc-pose-form" id="asc-pose-form" autocomplete="off">
						<input class="asc-pose-input" id="asc-pose-input" type="text" maxlength="120" spellcheck="false" placeholder="Pose the avatar… try “take a bow”">
						<button class="asc-pose-go" id="asc-pose-go" type="submit" title="Perform pose">Pose</button>
					</form>
					<div class="asc-pose-chips" id="asc-pose-chips"></div>
					<div class="asc-pose-hint" id="asc-pose-hint">Try: wave · bow · warrior</div>
				</div>
			</div>
			<div class="asc-resize" data-resize="w"></div>
		</div>

		<!-- Activity log panel -->
		<div class="asc-panel asc-panel--log" id="asc-panel-log" data-panel="log">
			<div class="asc-panel-head" data-drag>
				<span class="asc-panel-grip">⠿</span>
				<span class="asc-panel-title">Activity Log</span>
				<div class="asc-panel-btns">
					<button class="asc-panel-btn" data-act="min" title="Minimize">▁</button>
					<button class="asc-panel-btn" data-act="close" title="Hide (L)">✕</button>
				</div>
			</div>
			<div class="asc-panel-body">
				<div class="asc-log-tools">
					<button class="asc-log-filter active" data-filter="all">All</button>
					<button class="asc-log-filter" data-filter="trade">Trade</button>
					<button class="asc-log-filter" data-filter="analysis">Analysis</button>
					<button class="asc-log-filter" data-filter="activity">Activity</button>
					<button class="asc-log-filter asc-log-clear" id="asc-log-clear" data-filter="">Clear</button>
				</div>
				<div id="asc-log">
					<div class="asc-log-empty" id="asc-log-empty">No activity yet</div>
				</div>
			</div>
			<div class="asc-resize" data-resize="wh"></div>
		</div>

		<!-- Stream stats panel (advanced) -->
		<div class="asc-panel asc-panel--stats" id="asc-panel-stats" data-panel="stats">
			<div class="asc-panel-head" data-drag>
				<span class="asc-panel-grip">⠿</span>
				<span class="asc-panel-title">Stream Stats</span>
				<div class="asc-panel-btns">
					<button class="asc-panel-btn" data-act="min" title="Minimize">▁</button>
					<button class="asc-panel-btn" data-act="close" title="Hide (I)">✕</button>
				</div>
			</div>
			<div class="asc-panel-body">
				<div class="asc-stats-grid">
					<div class="asc-stat-row"><span class="asc-stat-key">Status</span><span class="asc-stat-val dim" id="st-status">—</span></div>
					<div class="asc-stat-row"><span class="asc-stat-key">FPS</span><span class="asc-stat-val" id="st-fps">0.0</span></div>
					<div class="asc-stat-row"><span class="asc-stat-key">Frames</span><span class="asc-stat-val" id="st-frames">0</span></div>
					<div class="asc-stat-row"><span class="asc-stat-key">Resolution</span><span class="asc-stat-val" id="st-res">—</span></div>
					<div class="asc-stat-row"><span class="asc-stat-key">Data</span><span class="asc-stat-val" id="st-data">0<span class="unit">KB</span></span></div>
					<div class="asc-stat-row"><span class="asc-stat-key">Last frame</span><span class="asc-stat-val dim" id="st-age">—</span></div>
					<div class="asc-stat-row"><span class="asc-stat-key">Uptime</span><span class="asc-stat-val dim" id="st-uptime">—</span></div>
				</div>
			</div>
		</div>

		<!-- Treasury cockpit panel -->
		<div class="asc-panel asc-panel--treasury" id="asc-panel-treasury" data-panel="treasury">
			<div class="asc-panel-head" data-drag>
				<span class="asc-panel-grip">⠿</span>
				<span class="asc-panel-title">Treasury</span>
				<div class="asc-panel-btns">
					<button class="asc-panel-btn" data-act="min" title="Minimize">▁</button>
					<button class="asc-panel-btn" data-act="close" title="Hide (T)">✕</button>
				</div>
			</div>
			<div class="asc-panel-body" id="asc-treasury-body"></div>
			<div class="asc-resize" data-resize="wh"></div>
		</div>

		<!-- Copy-trade mirror panel -->
		<div class="asc-panel asc-panel--mirror" id="asc-panel-mirror" data-panel="mirror">
			<div class="asc-panel-head" data-drag>
				<span class="asc-panel-grip">⠿</span>
				<span class="asc-panel-title">Mirror</span>
				<div class="asc-panel-btns">
					<button class="asc-panel-btn" data-act="min" title="Minimize">▁</button>
					<button class="asc-panel-btn" data-act="close" title="Hide (M)">✕</button>
				</div>
			</div>
			<div class="asc-panel-body" id="asc-mirror-body"></div>
			<div class="asc-resize" data-resize="wh"></div>
		</div>

		<!-- Sentiment heatmap panel -->
		<div class="asc-panel asc-panel--heatmap" id="asc-panel-heatmap" data-panel="heatmap">
			<div class="asc-panel-head" data-drag>
				<span class="asc-panel-grip">⠿</span>
				<span class="asc-panel-title">Sentiment Heatmap</span>
				<div class="asc-panel-btns">
					<button class="asc-hm-focus" id="asc-hm-focus" title="Center on $THREE">◎ $THREE</button>
					<button class="asc-panel-btn" data-act="min" title="Minimize">▁</button>
					<button class="asc-panel-btn" data-act="close" title="Hide (H)">✕</button>
				</div>
			</div>
			<div class="asc-panel-body asc-hm-body">
				<canvas id="asc-heatmap-canvas"></canvas>
				<div class="asc-hm-overlay" id="asc-hm-overlay">
					<div class="pulse-ring"></div>
					<p>Reading the market…</p>
				</div>
				<div class="asc-hm-stale" id="asc-hm-stale" hidden>
					<span>stale — retrying</span>
					<button id="asc-hm-retry">Retry</button>
				</div>
				<div class="asc-hm-tooltip" id="asc-hm-tooltip" hidden></div>
				<div class="asc-hm-legend" id="asc-hm-legend">
					<span class="asc-hm-legend-label">cold</span>
					<span class="asc-hm-legend-ramp"></span>
					<span class="asc-hm-legend-label">hot</span>
					<span class="asc-hm-legend-meta" id="asc-hm-meta">—</span>
				</div>
			</div>
			<div class="asc-resize" data-resize="wh"></div>
		</div>

		<!-- Portfolio / PnL HUD panel -->
		<div class="asc-panel asc-panel--hud" id="asc-panel-hud" data-panel="hud">
			<div class="asc-panel-head" data-drag>
				<span class="asc-panel-grip">⠿</span>
				<span class="asc-panel-title">Portfolio</span>
				<div class="asc-panel-btns">
					<button class="asc-panel-btn" data-act="min" title="Minimize">▁</button>
					<button class="asc-panel-btn" data-act="close" title="Hide (B)">✕</button>
				</div>
			</div>
			<div class="asc-panel-body" id="asc-hud-body"></div>
			<div class="asc-resize" data-resize="wh"></div>
		</div>

		<!-- Live agent-to-agent hire visualizer (Moonshot 03) -->
		<div class="asc-panel asc-panel--hire" id="asc-panel-hire" data-panel="hire">
			<div class="asc-panel-head" data-drag>
				<span class="asc-panel-grip">⠿</span>
				<span class="asc-panel-title">Live Hire</span>
				<div class="asc-panel-btns">
					<button class="asc-panel-btn" data-act="min" title="Minimize">▁</button>
					<button class="asc-panel-btn" data-act="close" title="Hide (R)">✕</button>
				</div>
			</div>
			<div class="asc-panel-body" id="asc-hire-body"></div>
			<div class="asc-resize" data-resize="wh"></div>
		</div>

			<!-- Reputation arena panel (Moonshot 12): trust breakdown + the a2a-hire receipts that earned it -->
			<div class="asc-panel asc-panel--reputation" id="asc-panel-reputation" data-panel="reputation">
				<div class="asc-panel-head" data-drag>
					<span class="asc-panel-grip">⠿</span>
					<span class="asc-panel-title">Reputation</span>
					<div class="asc-panel-btns">
						<button class="asc-panel-btn" data-act="min" title="Minimize">▁</button>
						<button class="asc-panel-btn" data-act="close" title="Hide (E)">✕</button>
					</div>
				</div>
				<div class="asc-panel-body" id="asc-reputation-body"></div>
				<div class="asc-resize" data-resize="wh"></div>
			</div>

			<!-- Live stage show panel (Moonshot 08) -->
			<div class="asc-panel asc-panel--stage" id="asc-panel-stage" data-panel="stage">
				<div class="asc-panel-head" data-drag>
					<span class="asc-panel-grip">⠿</span>
					<span class="asc-panel-title">Live Show</span>
					<div class="asc-panel-btns">
						<button class="asc-panel-btn" data-act="min" title="Minimize">▁</button>
						<button class="asc-panel-btn" data-act="close" title="Hide (G)">✕</button>
					</div>
				</div>
				<div class="asc-panel-body asc-stage-body">
					<div class="asc-stage-status">
						<span class="asc-stage-dot is-ready" id="asc-stage-dot"></span>
						<span class="asc-stage-state" id="asc-stage-state">Stage ready</span>
						<span class="asc-stage-beat" id="asc-stage-beat"></span>
					</div>
					<div class="asc-stage-now" id="asc-stage-now">Press Start to bring the host on stage.</div>
					<button class="asc-stage-start" id="asc-stage-start" type="button">▶ Start the show</button>
					<div class="asc-stage-lead">
						<div class="asc-stage-lead-head">Top tippers · $THREE</div>
						<ol class="asc-stage-lead-list" id="asc-stage-lead-list"></ol>
					</div>
					<form class="asc-stage-ask" id="asc-stage-ask" autocomplete="off">
						<input class="asc-stage-ask-input" id="asc-stage-ask-input" type="text" maxlength="240" placeholder="Ask the host a question…" spellcheck="false">
						<button class="asc-stage-ask-send" type="submit" title="Ask the host">Ask</button>
					</form>
					<div class="asc-stage-ask-status" id="asc-stage-ask-status"></div>
				</div>
				<div class="asc-resize" data-resize="wh"></div>
			</div>

		<!-- Memory Diary panel -->
		<div class="asc-panel asc-panel--diary" id="asc-panel-diary" data-panel="diary">
			<div class="asc-panel-head" data-drag>
				<span class="asc-panel-grip">⠿</span>
				<span class="asc-panel-title">Diary</span>
				<div class="asc-panel-btns">
					<button class="asc-panel-btn" data-act="min" title="Minimize">▁</button>
					<button class="asc-panel-btn" data-act="close" title="Hide (D)">✕</button>
				</div>
			</div>
			<div class="asc-panel-body" id="asc-diary-body"></div>
			<div class="asc-resize" data-resize="wh"></div>
		</div>

		<!-- Task input -->
		<div class="asc-task-bar" id="asc-task-bar">
			<form class="asc-task-form" id="asc-task-form" autocomplete="off">
				<button class="asc-task-mode" id="asc-task-mode" type="button" hidden aria-pressed="false" title="Asking live — click to queue a background task">Ask</button>
				<input
					class="asc-task-input"
					id="asc-task-input"
					type="text"
					placeholder="Ask this agent anything…"
					maxlength="1000"
					spellcheck="false"
				>
				<button class="asc-task-forge-toggle" id="asc-forge-toggle" type="button" aria-pressed="false" aria-controls="asc-forge-form" title="Forge a 3D avatar from text — free">✦</button>
				<button class="asc-task-voice" id="asc-task-voice" type="button" aria-pressed="false" title="Voice on — click to mute">🔊</button>
				<button class="asc-task-send" id="asc-task-send" type="submit" title="Send">
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
						<path d="M14.5 8L1.5 1.5L5 8L1.5 14.5L14.5 8Z" fill="currentColor"/>
					</svg>
				</button>
			</form>
			<div class="asc-task-status" id="asc-task-status"></div>
			<!-- Live Avatar Forge: type a prompt → watch a 3D avatar get built, rigged, animated -->
			<form class="asc-forge-form" id="asc-forge-form" autocomplete="off">
				<div class="asc-forge-icon" title="Free TRELLIS text→3D">✦</div>
				<input
					class="asc-forge-input"
					id="asc-forge-input"
					type="text"
					placeholder="Forge an avatar — describe it (e.g. a glossy white robot mascot)"
					maxlength="1000"
					spellcheck="false"
				>
				<button class="asc-forge-btn" id="asc-forge-btn" type="submit" title="Forge a 3D avatar — free">
					<span class="asc-forge-btn-label">Forge</span>
					<span class="asc-forge-btn-spin" aria-hidden="true"></span>
				</button>
			</form>
			<div class="asc-forge-result" id="asc-forge-result" hidden>
				<a class="asc-forge-view" id="asc-forge-view" target="_blank" rel="noopener">Open in viewer ↗</a>
				<button class="asc-forge-use" id="asc-forge-use" type="button">Use as agent avatar</button>
			</div>
		</div>

		<!-- Zen exit hint -->
		<div class="asc-zen-hint" id="asc-zen-hint">
			<span>Zen mode · <kbd>C</kbd> cam · <kbd>Z</kbd> exit</span>
			<button id="asc-zen-exit">Exit</button>
		</div>
	`;

	const screenCanvas = document.getElementById('asc-screen-canvas');
	const screenOverlay = document.getElementById('asc-screen-overlay');
	const screenCtx = screenCanvas.getContext('2d');
	const logEl = document.getElementById('asc-log');
	let logEmpty = document.getElementById('asc-log-empty');
	const webcamBezel = document.getElementById('asc-webcam-bezel');
	const webcamIdle = document.getElementById('asc-webcam-idle');
	const webcamBadge = document.getElementById('asc-webcam-badge');
	const webcamName = document.getElementById('asc-webcam-name');

	// ── resolve agent metadata ─────────────────────────────────────────────
	let agentName = 'Agent';
	let agentRecord = null; // freshest agent record, for the tip modal's wallet resolution
	let avatarGlbUrl = null;
	// Q&A concierge state: whether this viewer owns the agent (unlocks the
	// queue-a-task mode) and the agent's configured TTS voice for spoken answers.
	let isOwner = false;
	let agentVoice = 'nova';
	try {
		// credentials:'include' so the server can tell whether this viewer owns the
		// agent — owners get the ask⇄task toggle; everyone else can still ask.
		const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, { credentials: 'include' });
		if (res.ok) {
			const j = await res.json();
			const agent = j.agent || j;
			agentRecord = agent;
			agentName = agent.name || 'Agent';
			agentNameEl.textContent = agentName;
			document.title = `${agentName} · Agent Screen · three.ws`;
			webcamName.textContent = agentName;
			backEl.href = `/agents/${id}`;
			agentLinkEl.href = `/agents/${id}`;
			agentLinkEl.innerHTML = `${esc(agentName)} →`;
			isOwner = !!agent.is_owner;
			if (agent.voice_id) agentVoice = agent.voice_id;
			try {
				avatarGlbUrl = await agentAvatarGlb(agent);
			} catch { /* fall through to default */ }
		}
	} catch { /* non-fatal */ }

	// A per-tab Q&A session id gives follow-up questions memory continuity.
	const qaSessionId = ensureSessionId();

	// ── avatar webcam ──────────────────────────────────────────────────────
	const webcamRenderer = new WebGLRenderer({ antialias: true, alpha: true });
	webcamRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	webcamRenderer.setClearColor(0x0a0d1a, 1);
	// ACES + sRGB + soft shadows, shared bar (src/shared/cinematic-render.js).
	const webcamQualityTier = detectQualityTier();
	applyCinematicDefaults(webcamRenderer, { tier: webcamQualityTier });

	const webcamScene = new Scene();
	// Real HDRI IBL for specular/rim detail on the avatar bust. No ground-contact
	// shadow here: this is a tight head-and-shoulders webcam crop with no floor
	// in frame, so a shadow catcher plane would never be visible.
	loadEnvironment(webcamRenderer, webcamScene, webcamQualityTier === 'mobile' ? null : 'studio');
	webcamScene.add(new AmbientLight(0xffffff, 0.7));
	const sun = new DirectionalLight(0xffffff, 1.2);
	sun.position.set(1.5, 2.5, 2);
	webcamScene.add(sun);
	const rim = new DirectionalLight(0x8090ff, 0.4);
	rim.position.set(-2, 1, -1);
	webcamScene.add(rim);

	const webcamCamera = new PerspectiveCamera(38, 4 / 3, 0.01, 20);
	webcamCamera.position.set(0, 1.62, 0.9);
	webcamCamera.lookAt(0, 1.55, 0);

	let webcamAnimManager = null;
	let webcamAvatar = null;
	let webcamRafId = null;
	let anchor = null;
	let webcamCanvas = null;

		// Shared AudioContext for stage-show TTS playback + lip-sync analysis. Created
		// lazily and resumed on a user gesture (the Start button) per autoplay policy.
		let sharedAudioCtx = null;
		function ensureAudioContext() {
			try {
				if (!sharedAudioCtx) {
					const AC = window.AudioContext || window.webkitAudioContext;
					if (!AC) return null;
					sharedAudioCtx = new AC();
				}
				if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume().catch(() => {});
				return sharedAudioCtx;
			} catch { return null; }
		}
	// Ambient-mode host: a subtle idle look-around (the avatar glances around like
	// a host) and a live lipsync sampler the TTS path installs while speaking.
	let hostLookActive = false;
	let hostLookT = 0;
	let lipsyncSampler = null;

	// ── Pose Studio Live ─────────────────────────────────────────────────────
	// A viewer calls out a pose ("wave hello", "take a bow", "warrior stance")
	// and the live avatar performs it: animated emotes drive a real canonical
	// clip through the AnimationManager; static poses tween the joint-rotation
	// map onto the same canonical bones the /pose studio uses, then settle back
	// to the live idle. Universal across rigs — no allowlist, never a T-pose.
	let poseRig = null;          // canonical rig over the loaded model (null ⇒ not skeleton-driveable)
	let poseDriver = null;       // active static-pose tween, or null
	let poseClipSettleAt = 0;    // perf-clock ms to settle a looping emote back to idle (0 ⇒ none)
	let lastPoseAt = 0;          // debounce: drop requests that would stomp a transition
	let performPose = null;      // assigned once the avatar + rig are mounted
	const _poseTmpQuat = new Quaternion();

	function sizeWebcam() {
		if (!webcamCanvas) return;
		const bw = webcamBezel.clientWidth || 256;
		const bh = Math.round(bw * 3 / 4);
		webcamRenderer.setSize(bw, bh, false);
	}

	async function mountAvatarWebcam(glbUrl) {
		try {
			const loader = await getAvatarLoader();
			const gltf = await loader.loadAsync(glbUrl || '/avatars/default.glb');
			const model = cloneSkinnedScene(gltf.scene);
			webcamScene.add(model);
			webcamAvatar = model;

			const box = new Box3().setFromObject(model);
			const h = box.max.y;
			webcamCamera.position.set(0, h - 0.12, 0.72);
			webcamCamera.lookAt(0, h - 0.18, 0);

			// Universal canonical clip library retargets the pre-baked idle onto ANY
			// humanoid rig (Mixamo, Avaturn, VRM, …). The GLB's own animations are
			// intentionally ignored — most avatars ship none, so the shared clip is
			// what gives every agent presence. A rig that can't be skeleton-driven
			// falls back to its authored bind pose (supportsCanonicalClips() gate).
			webcamAnimManager = new AnimationManager();
			webcamAnimManager.attach(model, { avatarUrl: glbUrl || '/avatars/default.glb' });
			// Canonical pose-rig over the SAME model so viewer-requested static poses
			// land on exactly the bones /pose drives. null ⇒ not skeleton-driveable
			// (poses then no-op gracefully — never a forced bind-pose T-pose).
			poseRig = makeGltfRig(model);
			if (webcamAnimManager.supportsCanonicalClips()) {
				try {
					const manifest = await fetch('/animations/manifest.json', { cache: 'force-cache' })
						.then((r) => {
							if (!r.ok) throw new Error(`HTTP ${r.status} fetching animation manifest`);
							return r.json();
						});
					// Register the idle loop plus the trade-reaction one-shots so the
					// avatar can celebrate a win, slump on a loss, and wave on session
					// start. The one-shots load lazily on first playOnce — only `idle`
					// is forced up front so the head is alive immediately.
					const REACTION_CLIPS = [
						'idle', 'celebrate', 'defeated', 'wave',
						// Live Pose Studio emotes — load lazily on first viewer request.
						'pray', 'dance', 'kiss', 'taunt', 'jump', 'facepalm',
						'av-cheering', 'av-brag-claps', 'av-arm-flex',
						// Q&A concierge: a "thinking" waiting pose while the answer streams
						// and a "talking" upper-body gesture overlaid while the agent speaks.
						'av-waiting', 'av-vtubing',
					];
					const defs = manifest.filter((d) => REACTION_CLIPS.includes(d.name));
					const idleDef = defs.filter((d) => d.name === 'idle');
					if (defs.length) {
						webcamAnimManager.setAnimationDefs(defs);
						if (idleDef.length) {
							await webcamAnimManager.ensureLoaded('idle');
							webcamAnimManager.play('idle');
						}
					}
				} catch (err) {
					console.warn('[agent-screen] idle clip load failed:', err);
				}
			}

			webcamCanvas = webcamRenderer.domElement;
			webcamCanvas.style.cssText = 'width:100%;height:100%;object-fit:cover;';
			sizeWebcam();
			webcamIdle.style.display = 'none';
			webcamBezel.appendChild(webcamCanvas);
			webcamBadge.style.display = 'flex';

			// ── pose performance helpers (Pose Studio Live) ──────────────────
			const POSE_IN_MS = 420, POSE_HOLD_MS = 2600, POSE_OUT_MS = 640;
			// Head-and-shoulders cam: skip lower-body bones so a pose never tips the
			// framed avatar. Upper-body joints carry every pose that reads on a webcam.
			const POSE_SKIP = new Set(['Hips', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase']);
			const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

			// Tween from the avatar's current displayed pose to the preset's joint map,
			// hold, then blend back into the live idle. Re-derives the rig from the
			// current model so it keeps working after a Live-Forge avatar swap.
			function startPoseDriver(poseMap, label) {
				if (webcamAvatar && (!poseRig || poseRig.root !== webcamAvatar)) {
					poseRig = makeGltfRig(webcamAvatar);
				}
				if (!poseRig) return false;
				const localTargets = poseRig.localTargetsForPose(poseFromMannequinPreset(poseMap));
				const targets = [];
				for (const [key, to] of localTargets) {
					if (POSE_SKIP.has(key)) continue;
					const node = poseRig.getNode(key);
					if (!node) continue;
					targets.push({ node, from: node.quaternion.clone(), to });
				}
				if (!targets.length) return false;
				// Keep the mixer's base layer on idle so the pose releases into a live
				// idle, not a held emote.
				webcamAnimManager?.crossfadeTo('idle', 0.3);
				poseClipSettleAt = 0;
				poseDriver = { targets, t0: performance.now(), label };
				return true;
			}

			// Per-frame: apply the active pose tween ON TOP of the idle the mixer just
			// wrote (called after webcamAnimManager.update). Ease in → hold → ease out.
			function updatePoseDriver(t) {
				if (!poseDriver) return;
				const e = t - poseDriver.t0;
				const { targets } = poseDriver;
				if (e <= POSE_IN_MS) {
					const w = easeInOut(e / POSE_IN_MS);
					for (const tg of targets) tg.node.quaternion.copy(tg.from).slerp(tg.to, w);
				} else if (e <= POSE_IN_MS + POSE_HOLD_MS) {
					for (const tg of targets) tg.node.quaternion.copy(tg.to);
				} else if (e <= POSE_IN_MS + POSE_HOLD_MS + POSE_OUT_MS) {
					const w = easeInOut((e - POSE_IN_MS - POSE_HOLD_MS) / POSE_OUT_MS);
					// node.quaternion holds the live idle frame the mixer just wrote.
					for (const tg of targets) {
						_poseTmpQuat.copy(tg.to).slerp(tg.node.quaternion, w);
						tg.node.quaternion.copy(_poseTmpQuat);
					}
				} else {
					poseDriver = null;
				}
			}

			// Perform a resolved pose action: a static pose tween, or a real animated
			// emote clip with a graceful static fallback (failed load / fallen-pose
			// guard rejection). Debounced so rapid requests don't stomp a transition.
			performPose = async function performPoseImpl(action) {
				if (!action) return;
				const now = performance.now();
				if (now - lastPoseAt < 200) return;
				lastPoseAt = now;
				addLogEntry({ ts: Date.now(), activity: `Pose: ${action.label}`, type: 'analysis' });

				if (action.kind === 'pose') { startPoseDriver(action.parameters, action.label); return; }

				const fallback = () => {
					const fb = action.fallbackPreset && presetPoseById(action.fallbackPreset);
					if (fb) startPoseDriver(fb, action.label);
				};
				if (!webcamAnimManager || !webcamAnimManager.supportsCanonicalClips()) { fallback(); return; }
				const ready = await webcamAnimManager.ensureLoaded(action.clip);
				if (!ready || !webcamAnimManager.canPlay(action.clip)) { fallback(); return; }
				poseDriver = null; // the clip drives the whole body
				const def = webcamAnimManager.getAnimationDefs().find((d) => d.name === action.clip);
				const looping = def ? def.loop !== false : false;
				if (looping) {
					await webcamAnimManager.crossfadeTo(action.clip, 0.4);
					if (webcamAnimManager.currentName === action.clip) poseClipSettleAt = performance.now() + 3400;
					else fallback();
				} else {
					poseClipSettleAt = 0;
					await webcamAnimManager.playOnce(action.clip, { settleTo: 'idle', fade: 0.4 });
					if (webcamAnimManager.currentName !== action.clip) fallback();
				}
			};

			let last = 0;
			function webcamTick(t) {
				webcamRafId = requestAnimationFrame(webcamTick);
				const dt = Math.min((t - last) / 1000, 0.1);
				last = t;
				webcamAnimManager?.update(dt);
				// Settle a looping pose-emote back to idle once its hold elapses.
				if (poseClipSettleAt && t >= poseClipSettleAt) { poseClipSettleAt = 0; webcamAnimManager?.crossfadeTo('idle', 0.5); }
				anchor?.tick();
				// Host presence in Ambient mode: a gentle two-frequency yaw so the
				// avatar reads as glancing around the world it's narrating, not frozen.
				if (hostLookActive && webcamAvatar) {
					hostLookT += dt;
					webcamAvatar.rotation.y = Math.sin(hostLookT * 0.32) * 0.34 + Math.sin(hostLookT * 0.11) * 0.12;
				} else if (webcamAvatar && webcamAvatar.rotation.y !== 0) {
					webcamAvatar.rotation.y *= 0.9;
					if (Math.abs(webcamAvatar.rotation.y) < 0.001) webcamAvatar.rotation.y = 0;
				}
				lipsyncSampler?.();
				syncTalkingEmote();
				updatePoseDriver(t); // apply any active static pose on top of idle
				webcamRenderer.render(webcamScene, webcamCamera);
			}
			webcamRafId = requestAnimationFrame(webcamTick);
		} catch (err) {
			console.warn('[agent-screen] avatar webcam load failed:', err);
			webcamIdle.textContent = 'Avatar unavailable';
		}
	}

	// ── Live Avatar Forge: swap the cam to a forged GLB ─────────────────────
	// Dispose the current model, load the forged GLB, retarget the canonical clip
	// library, then play idle → wave. Returns { animated } — false for a
	// non-riggable GLB (shown static, never a forced T-pose), gated on
	// AnimationManager.supportsCanonicalClips().
	function disposeForgeMaterial(m) {
		for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose?.(); }
		m.dispose?.();
	}
	function disposeForgeObject(rootObj) {
		rootObj.traverse((o) => {
			if (o.geometry) o.geometry.dispose?.();
			const m = o.material;
			if (Array.isArray(m)) m.forEach(disposeForgeMaterial);
			else if (m) disposeForgeMaterial(m);
		});
	}
	async function swapWebcamAvatar(glbUrl, { wave = false } = {}) {
		const loader = await getAvatarLoader();
		const gltf = await loader.loadAsync(glbUrl);
		const model = cloneSkinnedScene(gltf.scene);

		webcamAnimManager?.detach();
		webcamAnimManager = null;
		if (webcamAvatar) {
			webcamScene.remove(webcamAvatar);
			disposeForgeObject(webcamAvatar);
		}
		webcamAvatar = model;
		webcamScene.add(model);

		const box = new Box3().setFromObject(model);
		const h = box.max.y || 1.6;
		webcamCamera.position.set(0, h - 0.12, 0.72);
		webcamCamera.lookAt(0, h - 0.18, 0);

		webcamAnimManager = new AnimationManager();
		webcamAnimManager.attach(model, { avatarUrl: glbUrl });
		let animated = false;
		if (webcamAnimManager.supportsCanonicalClips()) {
			try {
				const manifest = await fetch('/animations/manifest.json', { cache: 'force-cache' })
					.then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status} fetching animation manifest`); return r.json(); });
				const defs = manifest.filter((d) => ['idle', 'wave'].includes(d.name));
				if (defs.length) {
					webcamAnimManager.setAnimationDefs(defs);
					await webcamAnimManager.ensureLoaded('idle');
					webcamAnimManager.play('idle');
					animated = true;
					if (wave) {
						await webcamAnimManager.ensureLoaded('wave').catch(() => {});
						webcamAnimManager.playOnce('wave', { settleTo: 'idle' }).catch(() => {});
					}
				}
			} catch (err) {
				console.warn('[agent-screen] forged clip load failed:', err);
			}
		}

		// First forge before any avatar mounted (default mount failed): bring the
		// cam canvas + a minimal render tick online so the forged model is visible.
		if (!webcamCanvas) {
			webcamCanvas = webcamRenderer.domElement;
			webcamCanvas.style.cssText = 'width:100%;height:100%;object-fit:cover;';
			webcamBezel.appendChild(webcamCanvas);
		}
		sizeWebcam();
		if (!webcamRafId) {
			let last = 0;
			const tick = (t) => {
				webcamRafId = requestAnimationFrame(tick);
				const dt = Math.min((t - last) / 1000, 0.1);
				last = t;
				webcamAnimManager?.update(dt);
				webcamRenderer.render(webcamScene, webcamCamera);
			};
			webcamRafId = requestAnimationFrame(tick);
		}
		webcamIdle.style.display = 'none';
		webcamBadge.style.display = 'flex';
		return { animated };
	}

	mountAvatarWebcam(avatarGlbUrl || '/avatars/default.glb');

	// ── newsroom anchor (lower-third + spoken bulletins + lip-sync) ─────────
	anchor = createNewsroomAnchor({
		agentId: id,
		els: {
			lowerthird: document.getElementById('asc-lowerthird'),
			headline: document.getElementById('asc-lt-headline'),
			note: document.getElementById('asc-lt-note'),
			muteBtn: document.getElementById('asc-lt-mute'),
			unmute: document.getElementById('asc-anchor-unmute'),
		},
		getAvatar: () => webcamAvatar,
	});
	// 'A' toggles anchor audio. ('M' is the mirror panel.) Own listener so this
	// stays out of the shared shortcut block.
	window.addEventListener('keydown', (e) => {
		if (e.target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
		if (e.key.toLowerCase() === 'a') { anchor?.toggleMute(); e.preventDefault(); }
	});

	// ── screen canvas rendering ────────────────────────────────────────────
	let lastFrameImg = null;

	function renderFrame(frame) {
		if (!frame?.data) return;
		const img = new Image();
		img.onload = () => {
			const w = img.naturalWidth || 1280;
			const h = img.naturalHeight || 720;
			if (screenCanvas.width !== w) screenCanvas.width = w;
			if (screenCanvas.height !== h) screenCanvas.height = h;
			screenCtx.drawImage(img, 0, 0);
			lastFrameImg = img;
		};
		img.src = frame.data;
	}

	function setLive() {
		liveBadgeEl.classList.remove('dark');
		badgeTextEl.textContent = 'LIVE';
		screenOverlay.style.display = 'none';
		liveNow = true;
		stopWatchStatus(); // real pixels — the handoff is done
	}

	function setDark() {
		liveBadgeEl.classList.add('dark');
		badgeTextEl.textContent = 'OFFLINE';
		screenOverlay.style.display = 'flex';
		screenOverlay.innerHTML = `
			<div class="pulse-ring" style="border-color:rgba(255,255,255,0.15)"></div>
			<p>Agent is offline</p>
			<small>Stream will resume when the agent reconnects</small>
		`;
		liveNow = false;
		// Still on this agent — ask the pool to cast and reflect the warming/queued
		// handoff honestly while we wait for the first frame.
		startWatchStatus();
	}

	// ── on-demand caster handoff (parity with the live wall) ─────────────────
	// Signal that this viewer is actively watching this agent so the bounded pool
	// (workers/agent-screen-pool) spins a real browser up for it, then poll
	// /api/agent/watch-status so the stage shows the same honest "warming up" /
	// "queued · #N in line" copy as the wall instead of a flat "offline".
	let liveNow = false;
	let watchStatusTimer = null;
	let watchStatusPolls = 0;
	let lastWatchState = null;

	function signalWatch() {
		try {
			fetch('/api/agent/watch-intent', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agentId: id }),
				keepalive: true,
			}).catch(() => {});
		} catch { /* the activity baseline works regardless */ }
	}

	function showWarmingOverlay(text, sub) {
		screenOverlay.style.display = 'flex';
		screenOverlay.innerHTML = `
			<div class="pulse-ring"></div>
			<p>${esc(text)}</p>
			<small>${esc(sub)}</small>
		`;
	}

	async function pollWatchStatus() {
		if (liveNow || document.hidden) return;
		watchStatusPolls++;
		try {
			const res = await fetch(`/api/agent/watch-status?agentId=${encodeURIComponent(id)}`, {
				headers: { accept: 'application/json' },
			});
			if (!res.ok) return;
			const data = await res.json();
			lastWatchState = data.state;
			if (data.state === 'warming') {
				showWarmingOverlay('Warming up a live view…', 'A real browser is spinning up for this agent');
			} else if (data.state === 'queued') {
				showWarmingOverlay(`Live view queued · #${data.position || 1} in line`, 'The live pool is full — you’ll go live the moment a slot frees');
			}
			// casting/activity → leave the existing waiting/offline overlay in place.
		} catch { /* degrade silently to the offline overlay */ }
	}

	function startWatchStatus() {
		stopWatchStatus();
		watchStatusPolls = 0;
		const tick = async () => {
			await pollWatchStatus();
			const working = lastWatchState === 'warming' || lastWatchState === 'queued';
			watchStatusTimer = (!liveNow && (working || watchStatusPolls < 3))
				? setTimeout(tick, 4000)
				: null;
		};
		tick();
	}

	function stopWatchStatus() {
		if (watchStatusTimer) { clearTimeout(watchStatusTimer); watchStatusTimer = null; }
	}

	// ── live stream stats (all real, derived from the SSE frames) ───────────
	const st = {
		status: document.getElementById('st-status'),
		fps: document.getElementById('st-fps'),
		frames: document.getElementById('st-frames'),
		res: document.getElementById('st-res'),
		data: document.getElementById('st-data'),
		age: document.getElementById('st-age'),
		uptime: document.getElementById('st-uptime'),
	};
	let frameCount = 0;
	let bytesTotal = 0;
	let streamStart = 0;
	let lastFrameAt = 0;
	const frameTimes = []; // recent arrival timestamps for FPS

	function recordFrame(frame) {
		const now = Date.now();
		frameCount++;
		if (!streamStart) streamStart = now;
		lastFrameAt = now;
		if (frame?.data) bytesTotal += Math.round(frame.data.length * 0.75); // base64 → bytes
		frameTimes.push(now);
		while (frameTimes.length > 30) frameTimes.shift();
	}

	function fmtBytes(b) {
		if (b < 1024) return `${b}<span class="unit">B</span>`;
		if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}<span class="unit">KB</span>`;
		return `${(b / 1024 / 1024).toFixed(2)}<span class="unit">MB</span>`;
	}
	function fmtClock(ms) {
		const s = Math.floor(ms / 1000);
		const m = Math.floor(s / 60);
		const ss = String(s % 60).padStart(2, '0');
		if (m >= 60) { const hh = Math.floor(m / 60); return `${hh}:${String(m % 60).padStart(2, '0')}:${ss}`; }
		return `${m}:${ss}`;
	}

	function updateStats() {
		const live = !liveBadgeEl.classList.contains('dark');
		st.status.textContent = live ? 'LIVE' : (streamStart ? 'OFFLINE' : '—');
		st.status.classList.toggle('dim', !live);
		// FPS over the rolling window
		let fps = 0;
		if (frameTimes.length >= 2) {
			const span = (frameTimes[frameTimes.length - 1] - frameTimes[0]) / 1000;
			if (span > 0) fps = (frameTimes.length - 1) / span;
		}
		st.fps.textContent = fps.toFixed(1);
		st.frames.textContent = String(frameCount);
		st.res.textContent = screenCanvas.width ? `${screenCanvas.width}×${screenCanvas.height}` : '—';
		st.data.innerHTML = fmtBytes(bytesTotal);
		st.age.textContent = lastFrameAt ? `${Math.round((Date.now() - lastFrameAt) / 1000)}s ago` : '—';
		st.uptime.textContent = streamStart ? fmtClock(Date.now() - streamStart) : '—';
	}
	setInterval(updateStats, 1000);

	// ── activity log (cinematic) ───────────────────────────────────────────
	// Each real action renders through classify(): an icon, a colour-graded chip,
	// and a severity ring (high → amber, celebratory → gold). Consecutive same-
	// kind actions collapse into one beat with a ×N count instead of flooding the
	// log. Newest is at the top; a "jump to latest" affordance appears when the
	// viewer has scrolled away.
	const MAX_LOG = 120;
	let logCount = 0;
	let lastBeat = null; // { key, el, count } — top row, for collapsing
	const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	// Map a classify category onto the existing filter buckets (trade/analysis/
	// activity) so the filter chips keep working across the richer taxonomy.
	function filterBucket(category) {
		if (category === 'buy' || category === 'sell' || category === 'trade') return 'trade';
		if (category === 'analysis' || category === 'memory') return 'analysis';
		return 'activity';
	}

	function fmtTime(ts) {
		const d = new Date(ts);
		return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}

	// "Jump to latest" — newest sits at the top, so this scrolls the log home.
	const jumpBtn = document.createElement('button');
	jumpBtn.className = 'asc-log-jump';
	jumpBtn.type = 'button';
	jumpBtn.hidden = true;
	jumpBtn.innerHTML = '↑ Latest';
	jumpBtn.addEventListener('click', () => {
		logEl.scrollTo({ top: 0, behavior: REDUCED ? 'auto' : 'smooth' });
	});
	logEl.parentElement.appendChild(jumpBtn);
	logEl.addEventListener('scroll', () => { jumpBtn.hidden = logEl.scrollTop < 24; }, { passive: true });

	function renderBeatRow(entry, { ts, activity, type, pnl }, count) {
		const c = classify({ ts, activity, type });
		const accent = colorHex(c.colorToken);
		const bucket = filterBucket(c.category);
		entry.className = `asc-log-entry type-${bucket} cat-${c.category} sev-${c.severity}`;
		entry.style.setProperty('--asc-accent', accent);
		// Tint realized exits by sign so the log reads as a green/red P&L tape.
		const exitDelta = parsePnlDelta(pnl);
		if (exitDelta?.phase === 'exit') {
			const v = exitDelta.solDelta != null ? exitDelta.solDelta : exitDelta.realizedUsd;
			entry.classList.toggle('pnl-pos', v > 0);
			entry.classList.toggle('pnl-neg', v < 0);
		}
		const badge = count > 1 ? `<span class="asc-log-count">×${count}</span>` : '';
		entry.innerHTML = `
			<span class="asc-log-time">${fmtTime(ts || Date.now())}</span>
			<span class="asc-log-icon" aria-hidden="true">${c.icon}</span>
			<span class="asc-log-type" style="color:${accent}">${esc(c.label)}</span>
			<span class="asc-log-text">${esc(activity || '')}</span>
			${badge}
		`;
	}

	function addLogEntry(raw) {
		if (logEmpty) { logEmpty.remove(); logEmpty = null; }
		const key = classify({ type: raw.type }).category;

		// Collapse a run of same-category actions into the existing top beat.
		if (lastBeat && lastBeat.key === key && logEl.firstElementChild === lastBeat.el) {
			lastBeat.count += 1;
			renderBeatRow(lastBeat.el, raw, lastBeat.count);
			if (!REDUCED) {
				lastBeat.el.classList.remove('beat-bump');
				void lastBeat.el.offsetWidth; // restart the bump animation
				lastBeat.el.classList.add('beat-bump');
			}
			return;
		}

		const entry = document.createElement('div');
		renderBeatRow(entry, raw, 1);
		logEl.prepend(entry);
		lastBeat = { key, el: entry, count: 1 };
		logCount++;
		while (logCount > MAX_LOG) {
			const removed = logEl.lastElementChild;
			if (removed === lastBeat?.el) lastBeat = null;
			removed?.remove();
			logCount--;
		}
	}

	// log filter chips + clear
	logEl.parentElement.querySelectorAll('.asc-log-filter').forEach((btn) => {
		btn.addEventListener('click', () => {
			if (btn.id === 'asc-log-clear') {
				logEl.querySelectorAll('.asc-log-entry').forEach((e) => e.remove());
				logCount = 0;
				lastBeat = null;
				logEmpty = document.createElement('div');
				logEmpty.className = 'asc-log-empty';
				logEmpty.textContent = 'No activity yet';
				logEl.appendChild(logEmpty);
				return;
			}
			const f = btn.dataset.filter;
			logEl.parentElement.querySelectorAll('.asc-log-filter:not(.asc-log-clear)')
				.forEach((b) => b.classList.toggle('active', b === btn));
			logEl.classList.remove('filtered-trade', 'filtered-analysis', 'filtered-activity', 'filtered-screenshot');
			if (f && f !== 'all') logEl.classList.add(`filtered-${f}`);
		});
	});

	// ── live PnL ticker ───────────────────────────────────────────────────
	// Folds real 'trade' frames into a running session total (realized +
	// unrealized, from real fills) and drives a transform-based count-up. Every
	// number comes from an actual fill — no fake progress. Frames are deduped by
	// timestamp so the reconnect backfill can't double-count an exit.
	const pnlBtn = document.getElementById('asc-pnl');
	const pnlValueEl = document.getElementById('asc-pnl-value');
	const pnlDetailEl = document.getElementById('asc-pnl-detail');
	let pnlState = emptyPnlState();
	const seenPnlTs = new Set();
	let sawUsd = false;           // at least one fill priced into USD
	let pnlDetailed = false;      // compact ⇄ detailed toggle
	let pnlAnimFrom = 0;          // count-up animation origin (primary unit)
	let pnlAnimTo = 0;
	let pnlAnimStart = 0;
	let pnlAnimRaf = null;

	// Primary display number: USD when any fill priced, else realized SOL.
	function pnlPrimary() {
		if (sawUsd) return pnlState.realizedUsd + unrealizedTotalUsd(pnlState);
		return pnlState.realizedSol;
	}

	function paintPnl(shownPrimary) {
		const sign = shownPrimary > 1e-9 ? 'pos' : shownPrimary < -1e-9 ? 'neg' : '';
		pnlBtn.classList.toggle('pos', sign === 'pos');
		pnlBtn.classList.toggle('neg', sign === 'neg');
		pnlValueEl.textContent = sawUsd
			? (formatUsd(shownPrimary) ?? '—')
			: formatSol(shownPrimary);
		if (pnlDetailed) {
			pnlDetailEl.hidden = false;
			const wl = `${pnlState.wins}W · ${pnlState.losses}L`;
			// Secondary unit = the one NOT used as the primary. With USD pricing the
			// primary is USD, so show SOL here; without it the primary is already SOL,
			// so there's no meaningful USD secondary to show.
			const realized = sawUsd ? formatSol(pnlState.realizedSol) : null;
			const unreal = unrealizedTotalUsd(pnlState);
			const unrealStr = sawUsd && Math.abs(unreal) > 1e-9 ? ` · unreal ${formatUsd(unreal)}` : '';
			pnlDetailEl.textContent = `${wl}${realized ? ` · ${realized}` : ''}${unrealStr}`;
		} else {
			pnlDetailEl.hidden = true;
		}
	}

	function animatePnl() {
		const DURATION = 520;
		const tick = (now) => {
			const t = Math.min(1, (now - pnlAnimStart) / DURATION);
			const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
			const shown = pnlAnimFrom + (pnlAnimTo - pnlAnimFrom) * eased;
			paintPnl(shown);
			if (t < 1) pnlAnimRaf = requestAnimationFrame(tick);
			else pnlAnimRaf = null;
		};
		if (pnlAnimRaf) cancelAnimationFrame(pnlAnimRaf);
		pnlAnimRaf = requestAnimationFrame(tick);
	}

	// Ingest one trade frame/log entry. Returns the parsed exit delta (or null)
	// so the caller can fire the matching avatar emote on a fresh exit only.
	function ingestTrade(entry) {
		const delta = parsePnlDelta(entry?.pnl);
		if (!delta) return null;
		const ts = Number(entry.ts) || 0;
		// Dedupe additive exits by timestamp; idempotent holds may always re-apply.
		if (delta.phase === 'exit') {
			if (ts && seenPnlTs.has(ts)) return null;
			if (ts) seenPnlTs.add(ts);
		}
		if (delta.realizedUsd != null) sawUsd = true;
		pnlState = accumulatePnl(pnlState, delta);

		pnlBtn.hidden = false;
		pnlAnimFrom = Number.isFinite(pnlAnimTo) ? pnlAnimTo : 0;
		pnlAnimTo = pnlPrimary();
		pnlAnimStart = performance.now();
		animatePnl();
		// brief bump only on a realized exit (the watchable moment)
		if (delta.phase === 'exit') {
			pnlBtn.classList.remove('bump');
			void pnlBtn.offsetWidth; // restart the keyframe
			pnlBtn.classList.add('bump');
		}
		return delta;
	}

	// Fire the avatar reaction for a realized exit. Gated on a skeleton-driveable
	// rig so avatars that can't take canonical clips simply skip the emote (never
	// a T-pose). Loads the one-shot lazily, then settles back to idle.
	function emoteForTrade(delta) {
		const clip = emoteForExit(delta);
		if (!clip) return;
		if (!webcamAnimManager || !webcamAnimManager.supportsCanonicalClips()) return;
		webcamAnimManager.playOnce(clip, { settleTo: 'idle' }).catch(() => {});
	}

	// ── Q&A concierge avatar emotes ──────────────────────────────────────────
	// thinking: a waiting pose held while the answer streams.
	// talking:  an upper-body gesture overlaid (additive) while the agent speaks,
	//           driven off the anchor's real speaking state so it stays in time
	//           with the voice — and so bulletins get the same liveliness for free.
	let qaThinking = false;     // a question is in flight / answer streaming
	let talkingEmoteOn = false; // additive talking overlay currently playing
	function emoteCan(name) {
		return !!webcamAnimManager?.supportsCanonicalClips?.() && webcamAnimManager.canPlay(name);
	}
	function avatarThinking() {
		qaThinking = true;
		if (emoteCan('av-waiting')) webcamAnimManager.crossfadeTo('av-waiting', 0.35);
	}
	function avatarSettle() {
		qaThinking = false;
		// If a voice is still playing, the talking overlay owns the body; the
		// settle-to-idle happens when speech ends (syncTalkingEmote).
		if (!talkingEmoteOn && emoteCan('idle')) webcamAnimManager.crossfadeTo('idle', 0.4);
	}
	// Reconcile the additive talking overlay with whether the agent is actually
	// speaking. Called every webcam frame.
	function syncTalkingEmote() {
		if (!webcamAnimManager?.supportsCanonicalClips?.()) return;
		const speaking = !!anchor?.isSpeaking?.();
		if (speaking && !talkingEmoteOn) {
			talkingEmoteOn = true;
			if (emoteCan('idle') && webcamAnimManager.currentName === 'av-waiting') {
				webcamAnimManager.crossfadeTo('idle', 0.3); // drop the thinking pose under the gesture
			}
			if (emoteCan('av-vtubing')) {
				webcamAnimManager.playOverlay('av-vtubing', { loop: true, upperBodyOnly: true, crossfade: 0.3 }).catch(() => {});
			}
		} else if (!speaking && talkingEmoteOn) {
			talkingEmoteOn = false;
			webcamAnimManager.stopOverlay({ crossfade: 0.3 });
			if (!qaThinking && emoteCan('idle')) webcamAnimManager.crossfadeTo('idle', 0.4);
		}
	}

	// De-dupe the multi-watcher echo: questions/answers we render locally also
	// arrive back over the SSE log (api/agent-ask echoes them so other watchers
	// see the exchange). Remember the exact strings we rendered and drop the
	// matching echo once, so the asker never sees a duplicate.
	const ECHO_MAX = 240; // within the server-side activity slice
	const pendingEchoes = new Set();
	function rememberEcho(text) {
		pendingEchoes.add(String(text).slice(0, ECHO_MAX));
	}
	function isOwnEcho(activity) {
		const key = String(activity || '').slice(0, ECHO_MAX);
		if (pendingEchoes.has(key)) { pendingEchoes.delete(key); return true; }
		return false;
	}

	// compact ⇄ detailed toggle (click or keyboard focus + Enter/Space on the button)
	pnlBtn.addEventListener('click', () => {
		pnlDetailed = !pnlDetailed;
		paintPnl(pnlAnimTo);
	});

	// ── SSE client ─────────────────────────────────────────────────────────
	let greeted = false; // wave once, on the first live connection only
	let treasuryCockpit = null; // set once the Treasury panel mounts (below)
	let mirrorPanel = null;     // set once the Mirror panel mounts (below)
	let diaryPanel = null;      // set once the Diary panel mounts (below)
	let pnlHud = null;          // set once the Portfolio HUD panel mounts (below)
	let hireViz = null;         // set once the Live Hire panel mounts (below)
	let reputationPanel = null; // set once the Reputation panel mounts (below)

	// ── spectator reactions + tips ───────────────────────────────────────────
	// A reaction bar under the stream: tap an emoji and it floats up over the
	// screen for everyone watching; tip and real value lands in the agent's wallet,
	// the avatar emotes, and it says thanks in its own voice. $THREE only. The
	// controller self-subscribes to the stream's reaction events, so it stays
	// decoupled from the frame client below.
	let reactions = null;
	const screenStageEl = stageEl.querySelector('.asc-screen-stage');
	if (screenStageEl) {
		if (!document.getElementById('asc-reactions-pos')) {
			const st = document.createElement('style');
			st.id = 'asc-reactions-pos';
			st.textContent =
				'.asc-reactions{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);z-index:7;' +
				'display:flex;align-items:center;padding:7px 10px;border-radius:14px;' +
				'background:rgba(10,10,14,.62);backdrop-filter:blur(10px);' +
				'border:1px solid rgba(255,255,255,.1);box-shadow:0 8px 28px rgba(0,0,0,.4);' +
				'transition:opacity .2s ease,transform .2s ease;max-width:calc(100% - 24px);}' +
				'body.asc-zen .asc-reactions{opacity:0;pointer-events:none;transform:translateX(-50%) translateY(8px);}';
			document.head.appendChild(st);
		}
		const reactBar = document.createElement('div');
		reactBar.className = 'asc-reactions';
		screenStageEl.appendChild(reactBar);
		reactions = mountAgentReactions({
			agentId: id,
			barHost: reactBar,
			overlayHost: screenStageEl,
			subscribe: true,
			getAgent: () => agentRecord || { id, name: agentName },
			getAnimManager: () => webcamAnimManager,
			getAudioContext: () => ensureAudioContext(),
			voiceId: agentVoice,
		});
	}

	// Owner-only: take the wheel of the agent's live cast browser. Watching is
	// public (above); driving is private. The controller drives the real Chromium
	// through the control channel, and the caster pauses its own task while a human
	// holds the wheel. The cast browser holds no wallet/keys, so this cannot move
	// funds, that boundary is what makes remote control safe to ship.
	let screenControl = null;
	if (isOwner && screenStageEl && screenCanvas) {
		screenControl = mountScreenControl({
			stage: screenStageEl,
			canvas: screenCanvas,
			agentId: id,
			isLive: () => liveNow,
			onStatus: (kind, msg) => {
				if (kind === 'error' && msg) toast(msg);
				else if (kind === 'driving') toast('You have the wheel, drive the agent live');
			},
		});
	}

	const client = createAgentScreenClient(id, {
		onOpen({ agentName: n }) {
			if (n) { agentNameEl.textContent = n; agentName = n; webcamName.textContent = n; }
			badgeTextEl.textContent = 'Connecting…';
		},
		onFrame(frame) {
			setLive();
			recordFrame(frame);
			if (frame.data) renderFrame(frame);
			handleTourFrame(frame);
			if (frame.activity) {
				if (!isOwnEcho(frame.activity)) addLogEntry(frame);
				treasuryCockpit?.observeLog([frame]);
			}
			const forgeHit = parseForgeFrame(frame);
			if (forgeHit) loadForgedAvatar(forgeHit);
			if (frame.meta?.kind === 'a2a_hire') hireViz?.ingest(frame.meta, { live: true });
			if (frame.meta?.collab) teamTask.ingest(frame.meta.collab);
			if (frame.type === 'trade') {
				const delta = ingestTrade(frame);
				if (delta) emoteForTrade(delta);
			}
			// A bulletin headline — slide up the lower-third and speak it on air.
			if (frame.type === 'analysis') anchor?.handleFrame(frame);
			// Greet on the first live frame if onOpen's metadata event was missed.
			if (!greeted) {
				greeted = true;
				if (webcamAnimManager?.supportsCanonicalClips()) {
					webcamAnimManager.playOnce('wave', { settleTo: 'idle' }).catch(() => {});
				}
			}
		},
		onLog(entries) {
			// Backfill: render the rows and fold their PnL in (deduped by ts), but
			// don't emote — these are history, not a fresh fill happening on camera.
			entries.forEach((e) => { if (!isOwnEcho(e.activity)) addLogEntry(e); ingestTrade(e); });
			treasuryCockpit?.observeLog(entries);
			const lastForge = [...entries].reverse().find((e) => parseForgeFrame(e));
			if (lastForge) loadForgedAvatar(parseForgeFrame(lastForge));
			// Replay any hire phases in order so a reconnect re-syncs to the latest
			// phase (no coin animation — this is history, not a fresh settle).
			entries.forEach((e) => { if (e.meta?.kind === 'a2a_hire') hireViz?.ingest(e.meta, { live: false }); });
			// Resync the Team Task graph to the latest pushed snapshot on reconnect.
			const lastCollab = [...entries].reverse().find((e) => e?.meta?.collab);
			if (lastCollab) teamTask.ingest(lastCollab.meta.collab);
		},
		onDark() { setDark(); },
		onError() {
			badgeTextEl.textContent = 'Reconnecting…';
			liveBadgeEl.classList.add('dark');
		},
	});

	client.connect();

	// ── sentiment heatmap (live 3D market field + narration) ─────────────────
	// A glowing 3D field of tokens — $THREE pinned at the centre — pulsing by 24h
	// momentum, with the agent calling out the movers. Real data via
	// /api/intel/heatmap; real narration via /api/brain/chat.
	const heatmapCanvas = document.getElementById('asc-heatmap-canvas');
	const hmOverlay = document.getElementById('asc-hm-overlay');
	const hmStale = document.getElementById('asc-hm-stale');
	const hmTooltip = document.getElementById('asc-hm-tooltip');
	const hmMeta = document.getElementById('asc-hm-meta');
	let heatmap = null;
	let heatmapPoller = null;
	let hmHasData = false;
	let hmCanPush = true;       // disabled after a 401/403 (viewer, not owner)
	let lastNarrationAt = 0;
	let lastPushAt = 0;
	const NARRATION_COOLDOWN_MS = 60_000;
	const PUSH_COOLDOWN_MS = 18_000;

	function sizeHeatmap() { heatmap?.resize(); }

	function showHmTooltip(token, x, y) {
		if (!token) { hmTooltip.hidden = true; return; }
		const pct = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${Number(n).toFixed(1)}%`);
		const vol = token.volume24h ? `$${Intl.NumberFormat('en', { notation: 'compact' }).format(token.volume24h)}` : '—';
		const sent = token.sentiment && Number.isFinite(token.sentiment.score)
			? `<div class="asc-hm-tip-row"><span>sentiment</span><b>${token.sentiment.posPct}% bullish</b></div>` : '';
		hmTooltip.innerHTML = `
			<div class="asc-hm-tip-head">${esc(token.label)}${token.featured ? ' <span class="asc-hm-tip-anchor">$THREE</span>' : ''}</div>
			<div class="asc-hm-tip-row"><span>momentum</span><b>${pct(token.change24h)}</b></div>
			<div class="asc-hm-tip-row"><span>24h vol</span><b>${vol}</b></div>
			${sent}`;
		hmTooltip.hidden = false;
		const r = heatmapCanvas.getBoundingClientRect();
		let lx = Math.min(x - r.left + 14, r.width - hmTooltip.offsetWidth - 8);
		let ly = Math.min(y - r.top + 14, r.height - hmTooltip.offsetHeight - 8);
		hmTooltip.style.left = `${Math.max(6, lx)}px`;
		hmTooltip.style.top = `${Math.max(6, ly)}px`;
	}

	function startHeatmap() {
		if (heatmap || !heatmapCanvas) return;
		heatmap = new SentimentHeatmap3D(heatmapCanvas, { onHover: showHmTooltip });
		heatmap.showLoadingLattice();
		requestAnimationFrame(() => sizeHeatmap());
		heatmapPoller = createHeatmapPoller({
			onUpdate({ tokens, spikes, movers, stale }) {
				if (!heatmap) return;
				hmHasData = tokens.length > 0;
				heatmap.setData(tokens);
				hmOverlay.hidden = hmHasData;
				if (tokens.length <= 1) {
					hmOverlay.hidden = false;
					hmOverlay.querySelector('p').textContent = 'Market quiet — watching $THREE.';
				}
				hmStale.hidden = !stale;
				const climate = movers.avgMomentum > 0.08 ? 'heating' : movers.avgMomentum < -0.08 ? 'cooling' : 'mixed';
				hmMeta.textContent = `${tokens.length} tokens · ${climate}`;
				maybeNarrate({ spikes, movers });
				maybePushWall(movers);
			},
			onError() {
				if (!hmHasData) {
					hmOverlay.hidden = false;
					hmOverlay.querySelector('p').textContent = 'Market feed unavailable — retrying…';
				} else {
					hmStale.hidden = false;
				}
			},
		});
		heatmapPoller.start();
	}

	// Narrate movers through the brain. Anonymous viewers get the free model; the
	// line names only $THREE and never recommends other tokens. Throttled so the
	// log never floods.
	async function maybeNarrate({ spikes, movers }) {
		const now = Date.now();
		if (now - lastNarrationAt < NARRATION_COOLDOWN_MS) return;
		const firstRun = lastNarrationAt === 0;
		if (!firstRun && !spikes.length) return;
		lastNarrationAt = now;
		const context = buildNarrationContext({ spikes, movers });
		const system = 'You are a terse live market-sentiment narrator on a trading wall. Given a snapshot of token momentum, say ONE punchy sentence (max 22 words) calling the moment. $THREE is the featured coin and the only one you may name approvingly; never recommend, endorse, or shill any other token — refer to others only by ticker as market data. No emojis, no hashtags, no financial advice.';
		try {
			const line = await narrateOnce(system, context);
			if (line) {
				addLogEntry({ ts: Date.now(), activity: line, type: 'analysis' });
				pushNarration(line);
			}
		} catch { /* narration is best-effort */ }
	}

	async function narrateOnce(system, content) {
		const res = await fetch('/api/brain/chat', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ provider: 'gpt-oss-120b', system, messages: [{ role: 'user', content }], maxTokens: 80 }),
		});
		if (!res.ok || !res.body) return '';
		const reader = res.body.getReader();
		const dec = new TextDecoder();
		let buf = '';
		let out = '';
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop();
			for (const l of lines) {
				const s = l.trim();
				if (!s.startsWith('data:')) continue;
				const raw = s.slice(5).trim();
				if (!raw || raw === '[DONE]') continue;
				try { const chunk = JSON.parse(raw); if (typeof chunk === 'string') out += chunk; } catch { /* meta/first/done events */ }
			}
		}
		return out.trim().replace(/^["']|["']$/g, '').slice(0, 220);
	}

	// Push the narration line to the wall (owners only). A 401/403 means this
	// viewer doesn't own the agent — disable further pushes silently.
	async function pushNarration(line) {
		if (!hmCanPush) return;
		try {
			const res = await fetch('/api/agent-screen-push', {
				method: 'POST', credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agentId: id, frame: { activity: line, type: 'activity' } }),
			});
			if (res.status === 401 || res.status === 403) hmCanPush = false;
		} catch { /* best-effort */ }
	}

	// Snapshot the heatmap onto the wall when the agent's screen is otherwise dark
	// — fills a blank stream rather than overriding an active browser stream.
	// Owners only; throttled.
	async function maybePushWall(movers) {
		if (!hmCanPush || !heatmap || !hmHasData) return;
		const now = Date.now();
		if (now - lastPushAt < PUSH_COOLDOWN_MS) return;
		const streamLive = !liveBadgeEl.classList.contains('dark') && lastFrameAt && (now - lastFrameAt < 80_000);
		if (streamLive) return;
		const data = heatmap.captureFrame(720);
		if (!data || data.length > 760_000) return;
		lastPushAt = now;
		const climate = movers.avgMomentum > 0.08 ? 'heating' : movers.avgMomentum < -0.08 ? 'cooling' : 'mixed';
		try {
			const res = await fetch('/api/agent-screen-push', {
				method: 'POST', credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agentId: id, frame: { data, activity: `Sentiment heatmap — market ${climate}`, type: 'analysis' } }),
			});
			if (res.status === 401 || res.status === 403) hmCanPush = false;
		} catch { /* best-effort */ }
	}

	document.getElementById('asc-hm-focus')?.addEventListener('click', () => heatmap?.focusThree());
	document.getElementById('asc-hm-retry')?.addEventListener('click', () => { hmStale.hidden = true; heatmapPoller?.refresh(); });

	if (!layout.panels.heatmap.hidden) startHeatmap();

	// Ask the on-demand pool to cast this agent and keep re-asserting while the tab
	// is open, so a viewer who lands here (not just the wall) gets a real browser
	// feed on demand. Status polling is kicked off by setDark() on the first poll.
	signalWatch();
	const watchPingTimer = setInterval(() => { if (!document.hidden) signalWatch(); }, 20000);

	// ── task input ──────────────────────────────────────────────────────────
	const taskForm = document.getElementById('asc-task-form');
	const taskInput = document.getElementById('asc-task-input');
	const taskStatus = document.getElementById('asc-task-status');
	const taskSend = document.getElementById('asc-task-send');

	// ── Pose Studio Live: quick-pick chips + free-text pose input ────────────
	// A chip or a typed phrase resolves through matchPose() (same preset library
	// as /pose and the get_pose_seed tool) and drives the live avatar via
	// performPose(). The hint line doubles as transient status.
	const poseChipsEl = document.getElementById('asc-pose-chips');
	const poseFormEl = document.getElementById('asc-pose-form');
	const poseInputEl = document.getElementById('asc-pose-input');
	const poseHintEl = document.getElementById('asc-pose-hint');
	const DEFAULT_POSE_HINT = 'Try: wave · bow · warrior';
	let poseHintTimer = null;
	function setPoseHint(msg, transient = false) {
		if (!poseHintEl) return;
		poseHintEl.textContent = msg;
		clearTimeout(poseHintTimer);
		if (transient) poseHintTimer = setTimeout(() => { poseHintEl.textContent = DEFAULT_POSE_HINT; }, 2600);
	}
	function runPose(prompt) {
		const text = String(prompt || '').trim();
		if (!text) return;
		if (!performPose) { setPoseHint('Warming up the avatar…', true); return; }
		const action = matchPose(text);
		setPoseHint(`${action.icon ? `${action.icon} ` : ''}${action.label}`, true);
		performPose(action);
	}
	if (poseChipsEl) {
		for (const qp of POSE_QUICK_PICKS) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'asc-pose-chip';
			b.dataset.prompt = qp.prompt;
			b.title = `Pose: ${qp.label}`;
			b.innerHTML = `<span class="asc-pose-chip-ico">${qp.icon}</span>${esc(qp.label)}`;
			b.addEventListener('click', () => runPose(qp.prompt));
			poseChipsEl.appendChild(b);
		}
	}
	poseFormEl?.addEventListener('submit', (e) => {
		e.preventDefault();
		const v = poseInputEl.value.trim();
		if (!v) return;
		runPose(v);
		poseInputEl.value = '';
		poseInputEl.blur();
	});

	// ── Live Q&A concierge ────────────────────────────────────────────────────
	// The task bar's default action: ask the agent a question and get a live,
	// spoken, remembered answer. Owners can flip to "Task" to queue a background
	// job instead (the original behaviour). Answer streams from /api/agent-ask
	// (persona + session memory + the brain router); voice + lip-sync reuse the
	// newsroom anchor; the avatar thinks while it streams and gestures while it
	// speaks.
	let taskMode = 'ask'; // 'ask' | 'task' (owner only)

	function lockBar(on) {
		taskInput.disabled = on;
		taskSend.disabled = on;
		taskSend.classList.toggle('sending', on);
	}

	// A live, streaming answer row in the activity log. Shows a typing indicator
	// until the first token, then fills in word by word.
	function startAnswerEntry() {
		if (logEmpty) { logEmpty.remove(); logEmpty = null; }
		const entry = document.createElement('div');
		entry.className = 'asc-log-entry type-analysis cat-analysis sev-info asc-qa-answer';
		entry.innerHTML = `
			<span class="asc-log-time">${fmtTime(Date.now())}</span>
			<span class="asc-log-icon" aria-hidden="true">💬</span>
			<span class="asc-log-type asc-qa-name">${esc(agentName)}</span>
			<span class="asc-log-text"><span class="asc-typing" aria-label="thinking"><i></i><i></i><i></i></span></span>
		`;
		logEl.prepend(entry);
		lastBeat = null; // never collapse a following beat into this custom row
		logCount++;
		while (logCount > MAX_LOG) { logEl.lastElementChild?.remove(); logCount--; }
		const textEl = entry.querySelector('.asc-log-text');
		const nameEl = entry.querySelector('.asc-qa-name');
		return {
			render(text) {
				textEl.textContent = text;
				if (logEl.scrollTop < 24) logEl.scrollTop = 0;
			},
			markSpoken() {
				if (entry.querySelector('.asc-qa-spk')) return;
				const s = document.createElement('span');
				s.className = 'asc-qa-spk';
				s.title = 'Spoken aloud';
				s.textContent = '🔊';
				nameEl.after(s);
			},
			fail(msg) {
				entry.classList.add('asc-qa-fail');
				textEl.textContent = msg;
			},
		};
	}

	async function askQuestion(text) {
		addLogEntry({ ts: Date.now(), activity: `Asked: ${text}`, type: 'analysis' });
		rememberEcho(`Asked: ${text}`);
		const entry = startAnswerEntry();
		avatarThinking();
		// The submit is a user gesture — unlock the AudioContext now so the spoken
		// answer can play even on the first question of the visit.
		try { ensureAudioContext?.(); } catch { /* no-op */ }

		let answer = '';
		try {
			const res = await fetch('/api/agent-ask', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agentId: id, question: text, sessionId: qaSessionId }),
			});
			if (!res.ok || !res.body) {
				let msg = 'I couldn’t reach my brain just now — try again.';
				if (res.status === 429) msg = 'I’m getting a lot of questions — give me a moment.';
				else { try { const j = await res.json(); if (j?.message) msg = j.message; } catch { /* keep default */ } }
				entry.fail(msg);
				avatarSettle();
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let idx;
				while ((idx = buf.indexOf('\n\n')) !== -1) {
					const ev = buf.slice(0, idx);
					buf = buf.slice(idx + 2);
					let evType = 'message';
					let data = '';
					for (const line of ev.split('\n')) {
						if (line.startsWith('event:')) evType = line.slice(6).trim();
						else if (line.startsWith('data:')) data += line.slice(5).trim();
					}
					if (evType === 'message' && data && data !== '[DONE]') {
						try { const t = JSON.parse(data); if (typeof t === 'string') { answer += t; entry.render(answer); } } catch { /* skip */ }
					} else if (evType === 'error' && !answer) {
						let m = 'I hit a snag mid-thought — try again.';
						try { m = JSON.parse(data).message || m; } catch { /* keep default */ }
						entry.fail(m);
					}
				}
			}
		} catch {
			if (!answer) { entry.fail('Network hiccup — try again.'); avatarSettle(); return; }
		}

		if (!answer.trim()) { entry.fail('I couldn’t find an answer — try again.'); avatarSettle(); return; }
		entry.render(answer);
		rememberEcho(answer);
		avatarSettle();
		// Voice is enhancement — a failure leaves the text answer intact. Honours
		// the anchor's mute (toggle in the task bar / the lower-third / key A).
		try { const spoke = await anchor?.speak(answer, { voice: agentVoice }); if (spoke) entry.markSpoken(); } catch { /* text stands alone */ }
	}

	// Ask⇄Task mode toggle (owners only — visitors always ask).
	const modeBtn = document.getElementById('asc-task-mode');
	if (modeBtn) {
		if (!isOwner) {
			modeBtn.hidden = true;
			taskInput.placeholder = 'Ask this agent anything…';
		} else {
			const paintMode = () => {
				const task = taskMode === 'task';
				modeBtn.textContent = task ? 'Task' : 'Ask';
				modeBtn.classList.toggle('is-task', task);
				modeBtn.setAttribute('aria-pressed', String(task));
				modeBtn.title = task
					? 'Queuing a background task — click to ask live'
					: 'Asking live — click to queue a background task';
				taskInput.placeholder = task ? 'Give your agent a background task…' : 'Ask this agent anything…';
			};
			modeBtn.addEventListener('click', () => {
				taskMode = taskMode === 'task' ? 'ask' : 'task';
				paintMode();
				taskInput.focus();
			});
			paintMode();
		}
	}

	// Voice (mute) toggle — mirrors the newsroom anchor's mute so one control
	// governs every spoken line on the screen.
	const voiceBtn = document.getElementById('asc-task-voice');
	if (voiceBtn) {
		const paintVoice = () => {
			const m = !!anchor?.isMuted?.();
			voiceBtn.textContent = m ? '🔇' : '🔊';
			voiceBtn.classList.toggle('is-muted', m);
			voiceBtn.setAttribute('aria-pressed', String(!m));
			voiceBtn.title = m ? 'Voice off — click to let the agent speak aloud' : 'Voice on — click to mute';
		};
		voiceBtn.addEventListener('click', () => {
			const next = !anchor?.isMuted?.(); // true → mute, false → unmute
			anchor?.setMuted(next, { speakNow: false });
			if (!next) { try { ensureAudioContext?.(); } catch { /* no-op */ } }
			paintVoice();
		});
		paintVoice();
	}

	taskForm.addEventListener('submit', async (e) => {
		e.preventDefault();
		const text = taskInput.value.trim();
		if (!text) return;

		// Launch Director: a "launch a coin named … ticker … uri https://…" command
		// runs a real, narrated coin launch on this screen instead of queuing a
		// browser task. Owner-gated by the launch endpoint itself.
		const launchParams = parseLaunchCommand(text);
		if (launchParams) {
			taskInput.value = '';
			await runLaunchDirector(launchParams);
			return;
		}

		// Vanity Grinder: "grind a wallet starting with pump" runs a real, live
		// keyspace search streamed to this screen instead of queuing a task. The
		// keypair is generated server-side; the secret is returned only to the owner.
		const grindParams = parseGrindCommand(text);
		if (grindParams) {
			taskInput.value = '';
			await runVanityGrind(grindParams);
			return;
		}

		// Default action: ask the agent a live question. Owners who flipped the
		// bar to "Task" mode fall through to the background-task queue below.
		if (classifyTaskInput({ isOwner, mode: taskMode }) === 'ask') {
			taskInput.value = '';
			taskStatus.className = 'asc-task-status';
			taskStatus.textContent = '';
			lockBar(true);
			try {
				await askQuestion(text);
			} finally {
				lockBar(false);
				taskInput.focus();
			}
			return;
		}

		taskInput.disabled = true;
		taskSend.disabled = true;
		taskSend.classList.add('sending');
		taskStatus.className = 'asc-task-status';
		taskStatus.textContent = 'Queuing task…';

		try {
			const res = await fetch('/api/agent-task', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agentId: id, task: text }),
			});
			const j = await res.json().catch(() => ({}));
			if (res.ok) {
				const prev = taskInput.value;
				taskInput.value = '';
				taskStatus.className = 'asc-task-status ok';
				taskStatus.textContent = 'Task sent — your agent will pick it up shortly';
				addLogEntry({ ts: Date.now(), activity: `Task queued: ${prev}`, type: 'analysis' });
				setTimeout(() => { taskStatus.textContent = ''; taskStatus.className = 'asc-task-status'; }, 5000);
			} else if (res.status === 401) {
				taskStatus.className = 'asc-task-status err';
				taskStatus.innerHTML = 'Sign in to send tasks. <a href="/login" style="color:#d4d4d8">Sign in →</a>';
			} else {
				taskStatus.className = 'asc-task-status err';
				taskStatus.textContent = j.message || j.error_description || 'Could not queue task — try again';
			}
		} catch {
			taskStatus.className = 'asc-task-status err';
			taskStatus.textContent = 'Network error — check your connection';
		} finally {
			taskInput.disabled = false;
			taskSend.disabled = false;
			taskSend.classList.remove('sending');
			taskInput.focus();
		}
	});

	// ── Live Avatar Forge: in-browser driver ────────────────────────────────
	// The viewer types a prompt; we drive the FREE NVIDIA NIM (Microsoft TRELLIS)
	// text→3D lane (POST/poll /api/forge — no payment, no key, no wallet), narrate
	// each REAL pipeline stage, broadcast the staged frames to every viewer via
	// screenPush, and on completion load + rig + animate the GLB in the Avatar Cam.
	const forgeForm = document.getElementById('asc-forge-form');
	const forgeInput = document.getElementById('asc-forge-input');
	const forgeBtn = document.getElementById('asc-forge-btn');
	const forgeResult = document.getElementById('asc-forge-result');
	const forgeView = document.getElementById('asc-forge-view');
	const forgeUse = document.getElementById('asc-forge-use');
	const forgeToggle = document.getElementById('asc-forge-toggle');
	const taskBarEl = document.getElementById('asc-task-bar');
	if (forgeToggle && taskBarEl) {
		forgeToggle.addEventListener('click', () => {
			const open = taskBarEl.classList.toggle('forge-open');
			forgeToggle.setAttribute('aria-pressed', open ? 'true' : 'false');
			if (open && forgeInput) forgeInput.focus();
		});
	}
	const forgeQueue = [];
	let forgeInFlight = false;
	let lastForgedGlb = '';
	let forgeOverlayEl = null;

	function ensureForgeOverlay() {
		if (!forgeOverlayEl) {
			forgeOverlayEl = document.createElement('div');
			forgeOverlayEl.className = 'asc-forge-cam-note';
			webcamBezel.appendChild(forgeOverlayEl);
		}
		return forgeOverlayEl;
	}
	function showForgeStage(text) { const el = ensureForgeOverlay(); el.textContent = text; el.dataset.show = '1'; }
	function hideForgeOverlay() { if (forgeOverlayEl) forgeOverlayEl.dataset.show = '0'; }
	function forgeStatus(msg, cls = '') {
		taskStatus.className = 'asc-task-status' + (cls ? ' ' + cls : '');
		taskStatus.textContent = msg;
		if (cls !== 'err' && msg) {
			setTimeout(() => {
				if (taskStatus.textContent === msg) { taskStatus.textContent = ''; taskStatus.className = 'asc-task-status'; }
			}, 5000);
		}
	}
	function setForgeBusy(b) {
		forgeInFlight = b;
		if (forgeBtn) forgeBtn.disabled = b;
		if (forgeInput) forgeInput.disabled = b;
		forgeBtn?.classList.toggle('forging', b);
	}
	async function screenPushForge(frame) {
		try {
			await fetch('/api/agent-screen-push', {
				method: 'POST', credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agentId: id, frame }),
			});
		} catch { /* best-effort broadcast — a non-owner viewer simply can't push */ }
	}
	async function pollForgeJob(jobId, narrate) {
		// Matches the 12-minute ceiling used by every other forge poll loop
		// (src/forge.js, home-forge.js, forge-studio/forge.js, scene-compose.js):
		// max-tier full-quality bakes legitimately run past 10 minutes, and queue
		// wait must not spend the run budget (a queued job is alive).
		let deadline = Date.now() + 12 * 60 * 1000;
		let lastStatus = 'queued';
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 3000)); // real poll interval, not fake progress
			let res;
			try {
				res = await fetch(`/api/forge?job=${encodeURIComponent(jobId)}`, { headers: { accept: 'application/json' } });
			} catch { continue; }
			const data = await res.json().catch(() => ({}));
			if (!res.ok) { if (res.status >= 500) continue; throw new Error(data.message || `forge poll returned ${res.status}`); }
			if (data.status && data.status !== lastStatus) { lastStatus = data.status; narrate(data); }
			if (data.status === 'done' && data.glb_url) return data;
			if (data.status === 'failed') throw new Error(data.error || 'generation failed');
			if (data.status === 'queued') deadline = Date.now() + 12 * 60 * 1000;
		}
		throw new Error('generation timed out — try again');
	}
	async function loadForgedAvatar(forge, opts = {}) {
		const fromDriver = opts.fromDriver === true;
		if (!forge || !forge.glbUrl) return;
		if (!fromDriver && forge.glbUrl === lastForgedGlb) return; // already on screen
		lastForgedGlb = forge.glbUrl;
		const viewerUrl = forge.viewerUrl || viewerLinkFor(forge.glbUrl, location.origin);
		showForgeStage('Loading model…');
		let result;
		try {
			result = await swapWebcamAvatar(forge.glbUrl, { wave: true });
		} catch (err) {
			console.warn('[agent-screen] forged GLB load failed:', err);
			showForgeStage('model produced but failed to load — open in viewer');
			if (forgeView) forgeView.href = viewerUrl;
			if (forgeUse) forgeUse.dataset.glb = forge.glbUrl;
			if (forgeResult) forgeResult.hidden = false;
			return;
		}
		if (result.animated) hideForgeOverlay();
		else showForgeStage('static model — no rig to animate');
		if (forgeView) forgeView.href = viewerUrl;
		if (forgeUse) forgeUse.dataset.glb = forge.glbUrl;
		if (forgeResult) forgeResult.hidden = false;
	}
	async function driveForge(rawPrompt) {
		const valid = validatePrompt(rawPrompt);
		if (!valid.ok) { forgeStatus(valid.reason, 'err'); return; }
		const clamped = clampPrompt(rawPrompt);
		const prompt = clamped.prompt;
		setForgeBusy(true);
		if (forgeResult) forgeResult.hidden = true;
		if (clamped.trimmed) forgeStatus('Prompt trimmed to the TRELLIS conditioning window', '');
		const narrate = (state) => {
			const line = forgeStageNarration(state);
			addLogEntry({ ts: Date.now(), activity: line, type: 'analysis' });
			showForgeStage(line);
			screenPushForge({ activity: line, type: 'analysis' });
		};
		narrate({ status: 'submitting' });
		try {
			const submitRes = await fetch('/api/forge', {
				method: 'POST', credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ prompt, tier: 'draft', backend: 'nvidia', path: 'image' }),
			});
			const submit = await submitRes.json().catch(() => ({}));
			if (submitRes.status === 503) throw new Error(submit.message || 'the free 3D lane is not configured');
			if (submitRes.status === 429) throw new Error(submit.message || 'forge lane busy — try again shortly');
			let done = null;
			if (submit.status === 'done' && submit.glb_url) done = submit;
			else if (!submitRes.ok || !submit.job_id) throw new Error(submit.message || `forge returned ${submitRes.status}`);
			else { narrate({ status: 'queued', eta_seconds: submit.eta_seconds, backend: submit.backend, cold_start: submit.cold_start, cold_seconds: submit.cold_start_seconds }); done = await pollForgeJob(submit.job_id, narrate); }

			const glbUrl = done.glb_url;
			const viewerUrl = viewerLinkFor(glbUrl, location.origin);
			lastForgedGlb = glbUrl; // ignore the SSE echo of our own final frame
			screenPushForge(finalForgeFrame({ prompt, glbUrl, viewerUrl, tier: done.tier, backend: done.backend, durable: done.durable }));
			await loadForgedAvatar({ glbUrl, viewerUrl, prompt }, { fromDriver: true });
			forgeStatus('Forged — breathing in idle, then a wave', 'ok');
		} catch (err) {
			const msg = String(err && err.message ? err.message : err);
			addLogEntry({ ts: Date.now(), activity: `Forge failed: ${msg}`, type: 'analysis' });
			hideForgeOverlay();
			if (/busy|rate|429|unavailable|temporarily|cold|degraded/i.test(msg)) forgeStatus('Forge lane busy — try again shortly', 'err');
			else if (/reject|invalid|concrete|moderat/i.test(msg)) forgeStatus('Prompt rejected — try a concrete object', 'err');
			else forgeStatus(`Forge failed: ${msg}`, 'err');
		} finally {
			setForgeBusy(false);
			const next = forgeQueue.shift();
			if (next) driveForge(next);
		}
	}
	if (forgeForm) {
		forgeForm.addEventListener('submit', (e) => {
			e.preventDefault();
			const raw = forgeInput.value.trim();
			if (!raw) { forgeInput.focus(); return; }
			forgeInput.value = '';
			if (forgeInFlight) { forgeQueue.push(raw); forgeStatus('Queued — one forge at a time', ''); return; }
			driveForge(raw);
		});
	}
	if (forgeUse) {
		forgeUse.addEventListener('click', () => {
			const glb = forgeUse.dataset.glb;
			if (!glb) return;
			navigator.clipboard?.writeText(glb).catch(() => {});
			toast('Forged model URL copied — set it on your agent');
			window.open(`/agents/${encodeURIComponent(id)}`, '_blank', 'noopener');
		});
	}

	// ── Launch Director ───────────────────────────────────────────────────────
	// Run a real coin launch as a narrated, staged console on this agent's screen.
	// Every stage is a real operation; each one paints a launch-console HUD and a
	// narration line, pushed to /api/agent-screen-push so the owner AND every
	// remote viewer watch the same live "go live" moment. Success renders only
	// after a real on-chain signature returns.
	let launchInFlight = false;

	// Push one HUD frame (image + narration) to the live stream. The owner and all
	// viewers receive it back through the same SSE pipe, so we never render locally
	// — one source of truth, no double-counting.
	async function pushLaunchFrame({ data, activity, type = 'analysis' }) {
		try {
			await fetch('/api/agent-screen-push', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ agentId: id, frame: { data, activity, type } }),
			});
		} catch { /* a dropped frame is non-fatal — the on-chain tx is the truth */ }
	}

	function setLaunchStatus(kind, html) {
		taskStatus.className = `asc-task-status ${kind}`;
		taskStatus.innerHTML = html;
	}

	async function runLaunchDirector(params) {
		if (launchInFlight) { setLaunchStatus('err', 'A launch is already in progress.'); return; }

		const { ok, errors } = validateLaunchParams(params);
		if (!ok) {
			setLaunchStatus('err', esc(errors[0]));
			addLogEntry({ ts: Date.now(), activity: `Launch rejected — ${errors.join(' ')}`, type: 'analysis' });
			return;
		}

		launchInFlight = true;
		taskInput.disabled = true;
		taskSend.disabled = true;
		taskSend.classList.add('sending');
		setLaunchStatus('', `Launching ${esc(params.symbol ? `$${params.symbol}` : params.name)}…`);

		const ctx = { name: params.name, symbol: params.symbol, network: params.network, solBuyIn: params.sol_buy_in };
		const token = { name: params.name, symbol: params.symbol, imageUrl: null };

		// Paint one stage: render the HUD, narrate, push.
		const paint = async (stageKey, status = 'active') => {
			const narration = narrateLaunch(stageKey, ctx);
			const data = await renderLaunchHud({ params, token, stageKey, status, narration });
			await pushLaunchFrame({ data, activity: narration, type: 'analysis' });
			return narration;
		};

		const fail = async (stageKey, message) => {
			const data = await renderLaunchHud({ params, token, stageKey, status: 'error', error: message });
			await pushLaunchFrame({ data, activity: `Launch failed — ${message}`, type: 'analysis' });
			setLaunchStatus('err', esc(message));
		};

		try {
			// 1 ── Prepare ────────────────────────────────────────────────────────
			await paint('prepare');

			// 2 ── Metadata: read the real token metadata to assemble the card ──────
			try {
				const metaRes = await fetch(params.uri, { headers: { accept: 'application/json' } });
				if (metaRes.ok) {
					const meta = await metaRes.json().catch(() => null);
					if (meta && typeof meta === 'object' && typeof meta.image === 'string') {
						token.imageUrl = meta.image;
					}
				}
			} catch { /* metadata read is best-effort; the URI is what lands on-chain */ }
			try { ctx.metaHost = new URL(params.uri).hostname; } catch { /* ignore */ }
			await paint('metadata');

			// 3 ── Spend policy: surface the agent's real SOL ceiling ───────────────
			try {
				const limRes = await fetch(
					`/api/agents/${encodeURIComponent(id)}/solana/limits?network=${params.network}`,
					{ credentials: 'include' },
				);
				if (limRes.ok) {
					const lj = await limRes.json().catch(() => ({}));
					const sp = lj?.data?.spend_policy;
					if (sp && Number.isFinite(sp.max_sol_per_tx)) ctx.ceilingSol = sp.max_sol_per_tx;
				}
			} catch { /* non-fatal — the endpoint enforces the real cap regardless */ }
			if (ctx.ceilingSol != null && params.sol_buy_in > ctx.ceilingSol) {
				await fail('policy', `Dev buy ${params.sol_buy_in} SOL exceeds the agent's ${ctx.ceilingSol} SOL/tx ceiling — lower it or raise the policy.`);
				return;
			}
			await paint('policy');

			// 4 ── Broadcast: real launch via the agent custodial wallet ────────────
			await paint('broadcast');
			const launchRes = await fetch('/api/pump/launch-agent', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					agent_id: id,
					name: params.name,
					symbol: params.symbol,
					uri: params.uri,
					network: params.network,
					buyback_bps: params.buyback_bps,
					sol_buy_in: params.sol_buy_in,
				}),
			});
			const lr = await launchRes.json().catch(() => ({}));
			if (!launchRes.ok || !lr?.signature) {
				const msg = launchRes.status === 401
					? 'Sign in as the agent owner to launch.'
					: launchRes.status === 404
						? "You don't own this agent — only the owner can launch."
						: (lr.message || lr.error_description || 'Launch broadcast failed.');
				await fail('broadcast', msg);
				if (launchRes.status === 401) {
					setLaunchStatus('err', 'Sign in as the agent owner to launch. <a href="/login" style="color:#d4d4d8">Sign in →</a>');
				}
				return;
			}

			// 5 ── Confirmed: real signature in hand ───────────────────────────────
			const result = {
				mint: lr.mint,
				signature: lr.signature,
				pumpfunUrl: lr.pumpfun_url || `https://pump.fun/coin/${lr.mint}`,
				explorerUrl: lr.explorer || `https://solscan.io/tx/${lr.signature}${params.network === 'devnet' ? '?cluster=devnet' : ''}`,
			};
			ctx.mint = result.mint;
			ctx.signature = result.signature;
			{
				const narration = narrateLaunch('confirm', ctx);
				const data = await renderLaunchHud({ params, token, stageKey: 'confirm', status: 'active', narration, result });
				await pushLaunchFrame({ data, activity: narration, type: 'analysis' });
			}

			// 6 ── Live feed: verify the coin surfaced on /launches ─────────────────
			ctx.onFeed = await verifyOnLaunchesFeed(result.mint, params.network);
			{
				const narration = narrateLaunch('feed', ctx);
				const data = await renderLaunchHud({ params, token, stageKey: 'feed', status: 'done', narration, result: { ...result, onFeed: ctx.onFeed } });
				await pushLaunchFrame({ data, activity: narration, type: 'analysis' });
			}

			appendLaunchResult({ ...result, params, onFeed: ctx.onFeed });
			setLaunchStatus('ok', `Launched ${esc(params.symbol ? `$${params.symbol}` : params.name)} — live on-chain`);
			setTimeout(() => { taskStatus.textContent = ''; taskStatus.className = 'asc-task-status'; }, 8000);
		} catch (err) {
			await fail('broadcast', err?.message || 'Unexpected launch error.');
		} finally {
			launchInFlight = false;
			taskInput.disabled = false;
			taskSend.disabled = false;
			taskSend.classList.remove('sending');
			taskInput.focus();
		}
	}

	// Confirm the freshly launched mint shows on the public /launches feed.
	async function verifyOnLaunchesFeed(mint, network) {
		try {
			const res = await fetch(`/api/pump/launches?network=${encodeURIComponent(network)}&limit=50`, { credentials: 'include' });
			if (!res.ok) return false;
			const j = await res.json().catch(() => ({}));
			const list = j?.data?.launches || j?.launches || (Array.isArray(j) ? j : []);
			return list.some((l) => l?.mint === mint);
		} catch {
			return false;
		}
	}

	// Append the clickable result card to the activity log — the real explorer +
	// pump.fun links and the "View on /launches" CTA. Built as DOM (anchors) since
	// the canvas HUD can only paint the URLs, not make them clickable.
	function appendLaunchResult({ mint, signature, pumpfunUrl, explorerUrl, params, onFeed }) {
		if (logEmpty) { logEmpty.remove(); logEmpty = null; }
		const card = document.createElement('div');
		card.className = 'asc-log-entry type-analysis asc-launch-result';
		const sym = params.symbol ? `$${esc(params.symbol)}` : esc(params.name || 'coin');
		const feedHref = `/launches?mint=${encodeURIComponent(mint)}`;
		card.innerHTML = `
			<div class="asc-launch-result-head">🚀 ${sym} launched · <span class="asc-launch-mint">${esc(truncMid(mint, 6, 6))}</span></div>
			<div class="asc-launch-result-links">
				<a href="${esc(pumpfunUrl)}" target="_blank" rel="noopener">pump.fun ↗</a>
				<a href="${esc(explorerUrl)}" target="_blank" rel="noopener">explorer ↗</a>
				<a href="${esc(feedHref)}" class="asc-launch-cta">View on /launches →</a>
			</div>
			${onFeed ? '' : '<div class="asc-launch-result-note">Indexing on the feed — refresh /launches in a moment.</div>'}
		`;
		logEl.prepend(card);
		logCount++;
	}

	// ── Vanity Grinder ────────────────────────────────────────────────────────
	// Trigger a real, server-side ed25519 keyspace grind. The grind streams its
	// keyspace frames to this screen (and every viewer's) through the same SSE
	// pipe via /api/agent-vanity-grind; we hold the request open and render the
	// owner-only reveal (the secret + the launch hand-off) when it resolves.
	let grindInFlight = false;

	async function runVanityGrind(params) {
		if (grindInFlight) { setLaunchStatus('err', 'A grind is already running for this agent.'); return; }
		grindInFlight = true;
		taskInput.disabled = true;
		taskSend.disabled = true;
		taskSend.classList.add('sending');

		const pat = `${esc(params.prefix)}${params.suffix ? '…' + esc(params.suffix) : '…'}`;
		setLaunchStatus('', `Grinding a wallet · ${pat} — watch the keyspace burn`);
		addLogEntry({ ts: Date.now(), activity: `Vanity grind started · target ${params.prefix}${params.suffix ? '…' + params.suffix : '…'}`, type: 'analysis' });

		try {
			const res = await fetch('/api/agent-vanity-grind', {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					agentId: id,
					prefix: params.prefix,
					suffix: params.suffix || undefined,
					ignoreCase: params.ignoreCase,
				}),
			});
			const j = await res.json().catch(() => ({}));

			if (res.ok && j?.address) {
				setLaunchStatus('ok', `Matched ${esc(truncMid(j.address, 6, 4))} in ${Number(j.iterations).toLocaleString()} attempts`);
				appendGrindResult(j);
				setTimeout(() => { taskStatus.textContent = ''; taskStatus.className = 'asc-task-status'; }, 9000);
			} else if (res.status === 401) {
				setLaunchStatus('err', 'Sign in as the agent owner to grind. <a href="/login" style="color:#d4d4d8">Sign in →</a>');
			} else if (res.status === 504 || j?.error === 'vanity_capped') {
				setLaunchStatus('err', esc(j.message || j.error_description || 'No match within the attempt cap — try a shorter prefix.'));
				addLogEntry({ ts: Date.now(), activity: j.message || 'Grind capped — try a shorter prefix.', type: 'analysis' });
			} else {
				setLaunchStatus('err', esc(j.message || j.error_description || 'Grind failed — try again.'));
			}
		} catch {
			setLaunchStatus('err', 'Network error during grind — check your connection.');
		} finally {
			grindInFlight = false;
			taskInput.disabled = false;
			taskSend.disabled = false;
			taskSend.classList.remove('sending');
			taskInput.focus();
		}
	}

	// Render the owner-only reveal: the matched PUBLIC address, the secret (shown
	// once, copy-to-clipboard, never sent anywhere), and the launch hand-off CTA.
	// This card only ever exists in the triggering owner's own session — the
	// secret is never part of the live screen stream.
	function appendGrindResult(result) {
		if (logEmpty) { logEmpty.remove(); logEmpty = null; }
		const card = document.createElement('div');
		card.className = 'asc-log-entry type-analysis asc-grind-result';
		const addr = String(result.address || '');
		const launchable = !!result.launchable;
		const secs = (Math.round(result.durationMs || 0) / 1000).toFixed(1);
		card.innerHTML = `
			<div class="asc-launch-result-head">🔑 Vanity match · <span class="asc-launch-mint">${esc(truncMid(addr, 8, 6))}</span></div>
			<div class="asc-grind-meta">${Number(result.iterations || 0).toLocaleString()} attempts · expected ~${Number(result.estimatedIterations || 0).toLocaleString()} · ${secs}s</div>
			<div class="asc-grind-secret">
				<label>Private key (base58) — shown once, store it now</label>
				<div class="asc-grind-secret-row">
					<input type="password" readonly value="${esc(result.privateKey64 || '')}" class="asc-grind-secret-input" aria-label="private key" />
					<button type="button" class="asc-grind-reveal" title="Show or hide the key">show</button>
					<button type="button" class="asc-grind-copy" title="Copy the key">copy</button>
				</div>
			</div>
			<div class="asc-launch-result-links">
				${launchable
					? '<button type="button" class="asc-launch-cta asc-grind-launch">Use this address to launch →</button>'
					: '<span class="asc-grind-note">Branded wallet ready. A three.ws launch needs a mint carrying the "3ws" mark — grind <code>3ws</code> for a launchable one.</span>'}
				<a href="https://solscan.io/account/${encodeURIComponent(addr)}" target="_blank" rel="noopener">explorer ↗</a>
			</div>
		`;

		const secretInput = card.querySelector('.asc-grind-secret-input');
		card.querySelector('.asc-grind-reveal').addEventListener('click', (e) => {
			const show = secretInput.type === 'password';
			secretInput.type = show ? 'text' : 'password';
			e.currentTarget.textContent = show ? 'hide' : 'show';
		});
		card.querySelector('.asc-grind-copy').addEventListener('click', async (e) => {
			try {
				await navigator.clipboard.writeText(result.privateKey64 || '');
				e.currentTarget.textContent = 'copied';
				setTimeout(() => { e.currentTarget.textContent = 'copy'; }, 1500);
			} catch { e.currentTarget.textContent = 'copy failed'; }
		});
		const launchBtn = card.querySelector('.asc-grind-launch');
		if (launchBtn) {
			launchBtn.addEventListener('click', () => {
				taskInput.value = `launch a coin mint ${addr} `;
				taskInput.focus();
				toast('Mint address staged — add name, ticker, and metadata URI to launch');
			});
		}

		logEl.prepend(card);
		logCount++;
	}

		// ── live stage show (Moonshot 08) ────────────────────────────────────────
		// The avatar-cam host performs an always-live show: opener → banter → answer
		// audience questions → shout out fresh $THREE tippers → run a game round, on
		// loop, never silent. Real brain (api/brain/chat), real voice (api/tts/speak),
		// real settled tips (api/stage/tip). Audio needs a user gesture, so the show
		// arms on the panel's Start button.
		const stageShow = new StageShow({
			agentId: id,
			getHostName: () => agentName,
			getAvatar: () => webcamAvatar,
			getAnimManager: () => webcamAnimManager,
			ensureAudioContext,
			addLog: addLogEntry,
			toast,
			els: {
				dot: document.getElementById('asc-stage-dot'),
				state: document.getElementById('asc-stage-state'),
				beat: document.getElementById('asc-stage-beat'),
				now: document.getElementById('asc-stage-now'),
				startBtn: document.getElementById('asc-stage-start'),
				leaderboard: document.getElementById('asc-stage-lead-list'),
				qForm: document.getElementById('asc-stage-ask'),
				qInput: document.getElementById('asc-stage-ask-input'),
				qStatus: document.getElementById('asc-stage-ask-status'),
			},
		});
		// Pause the show when the tab is hidden (stops burning brain/TTS budget while
		// nobody's watching) and resume it when the viewer returns.
		let stagePausedByHide = false;
		document.addEventListener('visibilitychange', () => {
			if (document.hidden) {
				if (stageShow.running) { stagePausedByHide = true; stageShow.pause(); }
			} else if (stagePausedByHide) {
				stagePausedByHide = false;
				stageShow.start();
			}
		});

	// ── panels: drag / resize / minimize / hide + persistence ────────────────
	const panelEls = {
		cam: document.getElementById('asc-panel-cam'),
		log: document.getElementById('asc-panel-log'),
		stats: document.getElementById('asc-panel-stats'),
		treasury: document.getElementById('asc-panel-treasury'),
		mirror: document.getElementById('asc-panel-mirror'),
			stage: document.getElementById('asc-panel-stage'),
		hud: document.getElementById('asc-panel-hud'),
		diary: document.getElementById('asc-panel-diary'),
		hire: document.getElementById('asc-panel-hire'),
		reputation: document.getElementById('asc-panel-reputation'),
		heatmap: document.getElementById('asc-panel-heatmap'),
	};
	let zTop = 30;

	function focusPanel(el) {
		el.style.zIndex = String(++zTop);
	}

	function placePanel(name) {
		const el = panelEls[name];
		const p = layout.panels[name];
		const sr = stageEl.getBoundingClientRect();
		// width / height
		if (p.w) el.style.width = `${p.w}px`;
		if (p.h && (name === 'log' || name === 'treasury' || name === 'mirror' || name === 'hud' || name === 'stage' || name === 'hire' || name === 'heatmap' || name === 'reputation')) el.style.height = `${p.h}px`;
		// default position if none saved yet
		const pw = el.offsetWidth || p.w || 240;
		const ph = el.offsetHeight || 200;
		let x = p.x, y = p.y;
		if (x == null || y == null) {
			const M = 16;
			if (name === 'stats') { x = M; y = M; }
			else if (name === 'treasury') { x = M; y = M + 6; } // treasury → top-left cockpit
			else if (name === 'mirror') { x = M; y = sr.height - ph - M; } // mirror → bottom-left
			else if (name === 'log') { // log → right rail, stacked directly under reputation
				const rep = layout.panels.reputation;
				const repBottom = (rep && !rep.hidden) ? M + (rep.h || 340) + 12 : sr.height - ph - M;
				x = sr.width - pw - M; y = repBottom;
			}
			else if (name === 'heatmap') { x = M; y = sr.height - ph - M; } // heatmap → bottom-left
				else if (name === 'stage') { x = M; y = sr.height - ph - M; } // stage → bottom-left
			else if (name === 'hud') { x = M; y = sr.height - ph - M; } // HUD → bottom-left scoreboard
			else if (name === 'hire') { x = sr.width - pw - M; y = sr.height - ph - M - 8; } // hire → bottom-right above cam
			else if (name === 'diary') { x = Math.round((sr.width - pw) / 2); y = M + 40; } // diary → centre, beside the log
			else if (name === 'reputation') { x = sr.width - pw - M; y = M; } // reputation → top-right rail (log sits below)
			else { x = sr.width - pw - M; y = sr.height - ph - M; } // cam → bottom-right
		}
		x = clamp(x, 0, Math.max(0, sr.width - pw));
		y = clamp(y, 0, Math.max(0, sr.height - ph));
		el.style.left = `${x}px`;
		el.style.top = `${y}px`;
		el.style.right = 'auto';
		el.style.bottom = 'auto';
		el.classList.toggle('minimized', !!p.min);
		el.hidden = !!p.hidden;
		updateToggleButtons();
	}

	function makeDraggable(name) {
		const el = panelEls[name];
		const handle = el.querySelector('[data-drag]');
		let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
		handle.addEventListener('pointerdown', (e) => {
			if (e.target.closest('.asc-panel-btn')) return;
			dragging = true;
			handle.setPointerCapture(e.pointerId);
			el.classList.add('dragging');
			focusPanel(el);
			const r = el.getBoundingClientRect();
			const sr = stageEl.getBoundingClientRect();
			ox = r.left - sr.left; oy = r.top - sr.top;
			sx = e.clientX; sy = e.clientY;
		});
		handle.addEventListener('pointermove', (e) => {
			if (!dragging) return;
			const sr = stageEl.getBoundingClientRect();
			const nx = clamp(ox + (e.clientX - sx), 0, sr.width - el.offsetWidth);
			const ny = clamp(oy + (e.clientY - sy), 0, sr.height - el.offsetHeight);
			el.style.left = `${nx}px`;
			el.style.top = `${ny}px`;
		});
		const end = () => {
			if (!dragging) return;
			dragging = false;
			el.classList.remove('dragging');
			layout.panels[name].x = parseFloat(el.style.left) || 0;
			layout.panels[name].y = parseFloat(el.style.top) || 0;
			saveLayout();
		};
		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
	}

	function makeResizable(name) {
		const el = panelEls[name];
		const handle = el.querySelector('[data-resize]');
		if (!handle) return;
		const mode = handle.dataset.resize; // 'w' | 'wh'
		let resizing = false, sx = 0, sy = 0, sw = 0, sh = 0;
		handle.addEventListener('pointerdown', (e) => {
			e.stopPropagation();
			resizing = true;
			handle.setPointerCapture(e.pointerId);
			focusPanel(el);
			sx = e.clientX; sy = e.clientY;
			sw = el.offsetWidth; sh = el.offsetHeight;
		});
		handle.addEventListener('pointermove', (e) => {
			if (!resizing) return;
			const sr = stageEl.getBoundingClientRect();
			const maxW = sr.width - el.offsetLeft - 8;
			const w = clamp(sw + (e.clientX - sx), 168, Math.max(168, maxW));
			el.style.width = `${w}px`;
			layout.panels[name].w = Math.round(w);
			if (mode === 'wh') {
				const maxH = sr.height - el.offsetTop - 8;
				const h = clamp(sh + (e.clientY - sy), 150, Math.max(150, maxH));
				el.style.height = `${h}px`;
				layout.panels[name].h = Math.round(h);
				if (name === 'heatmap') sizeHeatmap();
			} else {
				sizeWebcam(); // cam: keep renderer matched to new width
			}
		});
		const end = () => { if (resizing) { resizing = false; saveLayout(); sizeWebcam(); sizeHeatmap(); } };
		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
	}

	for (const name of Object.keys(panelEls)) {
		const el = panelEls[name];
		makeDraggable(name);
		makeResizable(name);
		el.addEventListener('pointerdown', () => focusPanel(el));
		el.querySelector('[data-act="min"]').addEventListener('click', () => {
			const p = layout.panels[name];
			p.min = !p.min;
			el.classList.toggle('minimized', p.min);
			saveLayout();
		});
		el.querySelector('[data-act="close"]').addEventListener('click', () => setPanelHidden(name, true));
	}

	// ── Treasury cockpit: live autonomous-treasury control surface ───────────
	// Mounts into the Treasury panel body; fetches its own real data (owner-only
	// GET, 403 ⇒ viewer explainer) and ticks the live balance. The SSE handlers
	// above forward activity into it via treasuryCockpit?.observeLog(...).
	treasuryCockpit = createTreasuryCockpit({
		agentId: id,
		bodyEl: document.getElementById('asc-treasury-body'),
		toast,
	});

	// ── Copy-trade mirror: live source/mirror cockpit ────────────────────────
	// Owner drives the source-detect → re-quote → guarded-replicate loop and
	// pushes the dual-column frame to the wall; a viewer sees a read-only armed
	// state. Owns its own SSE to /api/pump/trades-stream (real PumpPortal feed).
	mirrorPanel = new MirrorPanel({
		body: document.getElementById('asc-mirror-body'),
		agentId: id,
		agentName,
		onToast: toast,
	});

	// ── Memory Diary: the agent reflects on its day from real memory ─────
	diaryPanel = createDiaryPanel({
		agentId: id,
		body: document.getElementById('asc-diary-body'),
		getAvatar: () => webcamAvatar,
		pauseOtherNarration: () => { try { anchor?.setMuted?.(true, { speakNow: false }); } catch { /* */ } },
	});
	{
		const _prevDiarySampler = lipsyncSampler;
		lipsyncSampler = () => { _prevDiarySampler?.(); diaryPanel?.tick(); };
	}

	// ── Portfolio / PnL HUD: the live scoreboard ─────────────────────────────
	// Values this agent's wallet live (net worth, 24h delta, sparkline, ranked
	// holdings with $THREE featured). Polls the public balances endpoint; the
	// owner additionally gets pushed portfolio snapshots. Polling pauses while the
	// panel is hidden (setPanelHidden → setActive) or the tab is backgrounded.
	pnlHud = createPnlHud({
		bodyEl: document.getElementById('asc-hud-body'),
		agentId: id,
		network: 'mainnet',
	});
	pnlHud.start();
	pnlHud.setActive(!layout.panels.hud.hidden);

	// ── Live Hire visualizer (Moonshot 03) ───────────────────────────────────
	// Consumes the a2a-hire phase frames (kind: 'a2a_hire') this agent emits when
	// it hires another over x402: quote → reserve (cap badge) → settle (coin flies)
	// → on-chain receipt. On a live settle we auto-reveal the panel so the watchable
	// moment isn't missed, and flash it.
	hireViz = createHireVisualizer(document.getElementById('asc-hire-body'), {
		onSettled(meta) {
			if (layout.panels.hire?.hidden) setPanelHidden('hire', false);
			const el = panelEls.hire;
			if (el) { focusPanel(el); el.classList.remove('asc-hire-flash'); void el.offsetWidth; el.classList.add('asc-hire-flash'); }
			toast(`Hired ${truncMid(meta.providerName || 'provider', 18)}${meta.usd != null ? ' · $' + Number(meta.usd).toFixed(2) : ''}`);
			// A settled hire is a new receipt for whichever side this screen shows —
			// refresh the reputation panel so the timeline picks it up.
			reputationPanel?.observeHire();
		},
	});

	// ── Reputation arena panel (Moonshot 12) ─────────────────────────────────
	// The trust story beside the avatar: the full wallet-trust breakdown (real,
	// server-computed score + pillars + on-chain evidence) stacked over the
	// a2a-hire receipts that earned it, each a verifiable USDC settlement with an
	// explorer link and the 1–5★ the hirer gave. Self-loads its own real data.
	reputationPanel = createReputationPanel({
		agentId: id,
		bodyEl: document.getElementById('asc-reputation-body'),
		// Live nudge: a genuinely new hire receipt is real reputation movement —
		// surface it in the activity log (type:'analysis') and as a toast so the
		// climb shows even if the panel is closed.
		onNewReceipt(h) {
			const skill = truncMid(h.skill_name || h.service_slug || 'a hire', 22);
			const stars = h.rating != null ? `${h.rating}★ ` : '';
			addLogEntry({ ts: Date.now(), activity: `New ${stars}feedback on ${skill} — reputation climbing`, type: 'analysis' });
			toast(`New ${stars}hire receipt · reputation +`);
		},
	});

	function setPanelHidden(name, hidden) {
		layout.panels[name].hidden = hidden;
		const el = panelEls[name];
		el.hidden = hidden;
		if (!hidden) { placePanel(name); focusPanel(el); sizeWebcam(); sizeHeatmap(); if (name === 'heatmap') startHeatmap(); }
		if (name === 'hud') pnlHud?.setActive(!hidden);
		updateToggleButtons();
		saveLayout();
	}
	function togglePanel(name) { setPanelHidden(name, !layout.panels[name].hidden); }

	function updateToggleButtons() {
		controlsEl.querySelectorAll('[data-panel-toggle]').forEach((b) => {
			b.classList.toggle('active', !layout.panels[b.dataset.panelToggle].hidden);
		});
	}

	controlsEl.querySelectorAll('[data-panel-toggle]').forEach((b) => {
		b.addEventListener('click', () => togglePanel(b.dataset.panelToggle));
	});

	// initial placement (after layout so offsetWidth is correct)
	requestAnimationFrame(() => {
		for (const name of Object.keys(panelEls)) placePanel(name);
		sizeWebcam();
		sizeHeatmap();
	});

	// keep panels inside the stage on resize
	window.addEventListener('resize', () => {
		for (const name of Object.keys(panelEls)) {
			if (!layout.panels[name].hidden) placePanel(name);
		}
		sizeWebcam();
		sizeHeatmap();
	});

	// ── fit / fill ───────────────────────────────────────────────────────────
	const fitBtn = document.getElementById('asc-fit-btn');
	function applyFit() {
		stageEl.classList.toggle('fit-cover', layout.fit === 'cover');
		fitBtn.classList.toggle('active', layout.fit === 'cover');
		fitBtn.title = layout.fit === 'cover' ? 'Fill (cropped) — click to fit — V' : 'Fit (letterboxed) — click to fill — V';
	}
	function toggleFit() {
		layout.fit = layout.fit === 'cover' ? 'contain' : 'cover';
		applyFit();
		saveLayout();
		toast(layout.fit === 'cover' ? 'Screen: fill' : 'Screen: fit');
	}
	fitBtn.addEventListener('click', toggleFit);
	applyFit();

	// ── zen mode ──────────────────────────────────────────────────────────────
	const zenBtn = document.getElementById('asc-zen-btn');
	document.getElementById('asc-zen-exit').addEventListener('click', () => setZen(false));
	function applyZen() {
		document.body.classList.toggle('asc-zen', layout.zen);
		document.body.classList.toggle('asc-zen-cam', layout.zen && layout.zenCam);
		zenBtn.classList.toggle('active', layout.zen);
	}
	function setZen(on) {
		layout.zen = on;
		applyZen();
		saveLayout();
		if (on) toast('Zen mode — press Z to exit, C for cam');
	}
	zenBtn.addEventListener('click', () => setZen(!layout.zen));
	applyZen();

	// peek header / task bar near edges while in zen
	let peekTimer = null;
	stageEl.addEventListener('pointermove', (e) => {
		if (!layout.zen) return;
		const r = stageEl.getBoundingClientRect();
		const nearTop = e.clientY - r.top < 56;
		const nearBottom = r.bottom - e.clientY < 80;
		document.body.classList.toggle('asc-peek', nearTop);
		document.body.classList.toggle('asc-peek-bottom', nearBottom);
		clearTimeout(peekTimer);
		peekTimer = setTimeout(() => {
			document.body.classList.remove('asc-peek', 'asc-peek-bottom');
		}, 2400);
	});

	// ── screenshot (real canvas capture → share modal) ───────────────────────
	const shotModal = new ScreenshotModal(document.body);
	const shotBtn = document.getElementById('asc-shot-btn');
	function screenshot() {
		if (!screenCanvas.width || !lastFrameImg) { toast('No frame to capture yet'); return; }
		screenCanvas.toBlob((blob) => {
			if (blob) shotModal.show(blob);
			else toast('Capture failed');
		}, 'image/png');
	}
	shotBtn.addEventListener('click', screenshot);

	// ── picture-in-picture (real PiP of the live screen) ─────────────────────
	const pipBtn = document.getElementById('asc-pip-btn');
	let pipVideo = null;
	if (!document.pictureInPictureEnabled) pipBtn.style.display = 'none';
	async function togglePip() {
		try {
			if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
			if (!screenCanvas.width) { toast('No frame yet'); return; }
			if (!pipVideo) {
				pipVideo = document.createElement('video');
				pipVideo.muted = true;
				pipVideo.playsInline = true;
				pipVideo.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px';
				document.body.appendChild(pipVideo);
				pipVideo.srcObject = screenCanvas.captureStream(15);
				pipVideo.addEventListener('leavepictureinpicture', () => pipBtn.classList.remove('active'));
			}
			await pipVideo.play().catch(() => {});
			await pipVideo.requestPictureInPicture();
			pipBtn.classList.add('active');
		} catch (err) {
			console.warn('[agent-screen] PiP failed:', err);
			toast('Picture-in-picture unavailable');
		}
	}
	pipBtn.addEventListener('click', togglePip);

	// ── fullscreen ───────────────────────────────────────────────────────────
	fsBtn.addEventListener('click', () => {
		if (!document.fullscreenElement) stageEl.requestFullscreen?.().catch(() => {});
		else document.exitFullscreen?.().catch(() => {});
	});
	document.addEventListener('fullscreenchange', () => {
		fsBtn.classList.toggle('active', !!document.fullscreenElement);
	});

	// ── Ambient World DJ mode (Brief 22) ─────────────────────────────────────
	// An alternate "calm channel": the agent stops trading and hosts a living 3D
	// world — seeded biome, deterministic day/night, wandering NPCs — narrating it
	// as host, optionally in its own voice over a soft synthesized ambient pad.
	const ambientBtn = document.getElementById('asc-ambient-btn');
	const audioBtn = document.getElementById('asc-audio-btn');
	const todReadout = document.getElementById('asc-tod');
	const screenStage = stageEl.querySelector('.asc-screen-stage');

	let ambientWorld = null;
	let ambientDj = null;
	let ambientHost = null;
	let djTimer = null;
	let todTimer = null;
	let ambientOn = false;

	let audioOn = false;
	let audioCtx = null;
	let ambientPad = null;
	let ttsAudio = null;
	let lipAnalyser = null;
	let visemeDriver = null;

	const TOD_ICON = { sunrise: '🌅', day: '☀️', dusk: '🌇', night: '🌙' };

	function updateTod() {
		if (!todReadout || !ambientWorld) return;
		const label = phaseLabel(ambientWorld.getState().phase);
		todReadout.textContent = `${TOD_ICON[label] || '·'} ${label}`;
	}

	function tickDj() {
		if (!ambientOn || !ambientWorld || !ambientDj || document.hidden) return;
		const line = ambientDj.observe(ambientWorld.getState(), Date.now());
		if (!line) return;
		addLogEntry({ ts: Date.now(), activity: line.text, type: 'activity' });
		pushNarration(line.text);
		if (audioOn) speakLine(line.text);
	}

	// A soft, fully-synthesized ambient bed: two detuned oscillators under a slow
	// cutoff LFO. Real WebAudio (no asset, no fake loop); ducks while the host
	// speaks so narration sits on top.
	function createAmbientPad(ctx) {
		const out = ctx.createGain(); out.gain.value = 0.0;
		const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 620;
		lp.connect(out); out.connect(ctx.destination);
		const oscA = ctx.createOscillator(); oscA.type = 'sine'; oscA.frequency.value = 110;
		const oscB = ctx.createOscillator(); oscB.type = 'sine'; oscB.frequency.value = 165; oscB.detune.value = -6;
		const mix = ctx.createGain(); mix.gain.value = 0.5;
		oscA.connect(mix); oscB.connect(mix); mix.connect(lp);
		const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.05;
		const lfoGain = ctx.createGain(); lfoGain.gain.value = 160;
		lfo.connect(lfoGain); lfoGain.connect(lp.frequency);
		oscA.start(); oscB.start(); lfo.start();
		const FULL = 0.05;
		out.gain.linearRampToValueAtTime(FULL, ctx.currentTime + 4);
		return {
			duck() { out.gain.cancelScheduledValues(ctx.currentTime); out.gain.linearRampToValueAtTime(FULL * 0.35, ctx.currentTime + 0.3); },
			restore() { out.gain.cancelScheduledValues(ctx.currentTime); out.gain.linearRampToValueAtTime(FULL, ctx.currentTime + 1.2); },
			dispose() { try { oscA.stop(); oscB.stop(); lfo.stop(); } catch { /* already stopped */ } try { out.disconnect(); } catch { /* detached */ } },
		};
	}

	function stopTts() {
		lipsyncSampler = null;
		if (visemeDriver) { try { visemeDriver.reset(); } catch { /* no morphs */ } visemeDriver = null; }
		if (lipAnalyser) { try { lipAnalyser.disconnect(); } catch { /* already closed */ } lipAnalyser = null; }
		if (ttsAudio) {
			try { ttsAudio.pause(); } catch { /* not playing */ }
			if (ttsAudio.src && ttsAudio.src.startsWith('blob:')) URL.revokeObjectURL(ttsAudio.src);
			ttsAudio = null;
		}
		ambientPad?.restore();
	}

	// Speak one host line with real TTS and drive the avatar's mouth from the live
	// audio. Missing/!ok TTS → silent text-only narration; never a synthesized
	// fake voice.
	async function speakLine(text) {
		if (!audioOn || !audioCtx) return;
		try {
			if (audioCtx.state === 'suspended') await audioCtx.resume();
			stopTts();
			const r = await fetch('/api/tts/speak', {
				method: 'POST', credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text, format: 'mp3' }),
			});
			if (!r.ok) return;
			const blob = await r.blob();
			const url = URL.createObjectURL(blob);
			ttsAudio = new Audio(url);
			ambientPad?.duck();
			lipAnalyser = new LipSyncAnalyser();
			visemeDriver = webcamAvatar ? createVisemeDriver(webcamAvatar) : null;
			ttsAudio.addEventListener('playing', () => {
				try { lipAnalyser?.connect(ttsAudio); } catch { /* autoplay/CORS — stay silent-mouthed */ }
				if (visemeDriver) {
					lipsyncSampler = () => {
						const out = lipAnalyser?.sample();
						if (!out || !visemeDriver) return;
						let best = '', bestW = 0;
						for (const k in out) if (out[k] > bestW) { bestW = out[k]; best = k; }
						visemeDriver.step(bestW > 0.04 ? best : '');
					};
				}
			});
			ttsAudio.addEventListener('ended', stopTts);
			ttsAudio.addEventListener('error', stopTts);
			await ttsAudio.play().catch(() => {});
		} catch (err) {
			console.warn('[agent-screen] ambient TTS failed:', err);
		}
	}

	function setAudio(on) {
		if (on === audioOn) return;
		if (on) {
			try {
				const AC = window.AudioContext || window.webkitAudioContext;
				if (!AC) { toast('Audio unavailable on this device'); return; }
				audioCtx = audioCtx || new AC();
				if (audioCtx.state === 'suspended') audioCtx.resume();
				ambientPad = createAmbientPad(audioCtx);
				audioOn = true;
				audioBtn?.classList.add('active');
				toast('Voice on — your agent will narrate aloud');
			} catch { toast('Audio unavailable on this device'); }
		} else {
			audioOn = false;
			audioBtn?.classList.remove('active');
			stopTts();
			ambientPad?.dispose(); ambientPad = null;
		}
	}

	function enterAmbient() {
		if (ambientOn) return;
		const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
		ambientHost = document.createElement('div');
		ambientHost.className = 'asc-ambient-host';
		screenStage.appendChild(ambientHost);
		try {
			ambientWorld = createAmbientWorld({ agentId: id, container: ambientHost, reducedMotion });
		} catch (err) {
			console.warn('[agent-screen] ambient world unavailable:', err);
			toast('3D world unavailable on this device');
			ambientHost.remove(); ambientHost = null;
			return;
		}
		ambientWorld.start();
		const st0 = ambientWorld.getState();
		ambientDj = createDjScript({ place: st0.biomeLabel, landmark: st0.landmark });
		ambientOn = true;
		hostLookActive = true;
		screenStage.classList.add('ambient');
		screenOverlay.style.display = 'none';
		ambientBtn?.classList.add('active');
		if (audioBtn) audioBtn.hidden = false;
		if (todReadout) todReadout.hidden = false;
		badgeTextEl.textContent = 'AMBIENT';
		liveBadgeEl.classList.remove('dark');
		addLogEntry({ ts: Date.now(), activity: `${agentName} is hosting the ambient world — ${st0.biomeLabel}`, type: 'activity' });
		djTimer = setInterval(tickDj, 4000);
		todTimer = setInterval(updateTod, 1000);
		updateTod();
		toast('Ambient mode — your agent is hosting the world');
	}

	function exitAmbient() {
		if (!ambientOn) return;
		ambientOn = false;
		hostLookActive = false;
		clearInterval(djTimer); djTimer = null;
		clearInterval(todTimer); todTimer = null;
		setAudio(false);
		ambientWorld?.dispose(); ambientWorld = null;
		ambientDj = null;
		ambientHost?.remove(); ambientHost = null;
		screenStage.classList.remove('ambient');
		ambientBtn?.classList.remove('active');
		if (audioBtn) { audioBtn.hidden = true; audioBtn.classList.remove('active'); }
		if (todReadout) todReadout.hidden = true;
		// Hand the surface back to the live stream.
		if (liveBadgeEl.classList.contains('dark')) setDark();
		else { badgeTextEl.textContent = 'LIVE'; screenOverlay.style.display = lastFrameImg ? 'none' : 'flex'; }
	}

	function toggleAmbient() { if (ambientOn) exitAmbient(); else enterAmbient(); }

	ambientBtn?.addEventListener('click', toggleAmbient);
	audioBtn?.addEventListener('click', () => setAudio(!audioOn));

	// Pause the world + DJ while the tab is hidden; resume on return — a calm
	// channel must never burn GPU in the background.
	document.addEventListener('visibilitychange', () => {
		if (!ambientOn) return;
		if (document.hidden) ambientWorld?.stop();
		else ambientWorld?.start();
	});

	// ── keyboard shortcuts ───────────────────────────────────────────────────
	const help = buildHelpOverlay();
	window.addEventListener('keydown', (e) => {
		if (e.target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
		const k = e.key.toLowerCase();
		if (k === 'z') { setZen(!layout.zen); e.preventDefault(); }
		else if (k === 'c') { if (layout.zen) { layout.zenCam = !layout.zenCam; applyZen(); saveLayout(); } else togglePanel('cam'); e.preventDefault(); }
		else if (k === 'l') { togglePanel('log'); e.preventDefault(); }
		else if (k === 'i') { togglePanel('stats'); e.preventDefault(); }
		else if (k === 'h') { togglePanel('heatmap'); e.preventDefault(); }
			else if (k === 'g') { togglePanel('stage'); e.preventDefault(); }
		else if (k === 't') { togglePanel('treasury'); e.preventDefault(); }
		else if (k === 'm') { togglePanel('mirror'); e.preventDefault(); }
		else if (k === 'd') { togglePanel('diary'); e.preventDefault(); }
		else if (k === 'r') { togglePanel('hire'); e.preventDefault(); }
		else if (k === 'b') { togglePanel('hud'); e.preventDefault(); }
		else if (k === 'e') { togglePanel('reputation'); e.preventDefault(); }
		else if (k === 's') { screenshot(); e.preventDefault(); }
		else if (k === 'p') { togglePip(); e.preventDefault(); }
		else if (k === 'v') { toggleFit(); e.preventDefault(); }
		else if (k === 'f') { fsBtn.click(); e.preventDefault(); }
		else if (k === 'a') { toggleAmbient(); e.preventDefault(); }
		else if (k === '?' || (k === '/' && e.shiftKey)) { help.toggle(); e.preventDefault(); }
		else if (k === 'escape') {
			if (help.isOpen()) help.close();
			else if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
			else if (ambientOn) exitAmbient();
			else if (layout.zen) setZen(false);
		}
	});

	// Resume the caster handoff when the tab regains focus: re-assert intent and,
	// if we're not already live, restart status polling (it may have settled while
	// hidden). IntersectionObserver-style re-fire doesn't apply to this single page.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) return;
		signalWatch();
		if (!liveNow) startWatchStatus();
	});

	// Cleanup on unload
	window.addEventListener('beforeunload', () => {
		client.disconnect();
		heatmapPoller?.stop();
		heatmap?.dispose();
		clearInterval(watchPingTimer);
		stopWatchStatus();
		screenControl?.destroy();
		treasuryCockpit?.destroy();
		mirrorPanel?.destroy();
		pnlHud?.destroy();
		anchor?.destroy();
		diaryPanel?.destroy();
		if (pnlAnimRaf) cancelAnimationFrame(pnlAnimRaf);
			stageShow.dispose();
			sharedAudioCtx?.close?.().catch(() => {});
		if (webcamRafId) cancelAnimationFrame(webcamRafId);
		webcamAnimManager?.detach();
		webcamRenderer.dispose();
		exitAmbient();
		audioCtx?.close?.().catch(() => {});
		if (pipVideo?.srcObject) pipVideo.srcObject.getTracks().forEach((t) => t.stop());
	});
}

// ── keyboard help overlay ─────────────────────────────────────────────────────
function buildHelpOverlay() {
	const el = document.createElement('div');
	el.className = 'asc-help';
	el.innerHTML = `
		<div class="asc-help-card">
			<div class="asc-help-head">
				<h3>Keyboard shortcuts</h3>
				<button class="asc-panel-btn" id="asc-help-close" title="Close">✕</button>
			</div>
			<div class="asc-help-body">
				<div class="asc-help-row"><span>Zen mode (hide chrome)</span><kbd>Z</kbd></div>
				<div class="asc-help-row"><span>Toggle avatar cam</span><kbd>C</kbd></div>
				<div class="asc-help-row"><span>Toggle activity log</span><kbd>L</kbd></div>
				<div class="asc-help-row"><span>Toggle stream stats</span><kbd>I</kbd></div>
				<div class="asc-help-row"><span>Toggle sentiment heatmap</span><kbd>H</kbd></div>
					<div class="asc-help-row"><span>Toggle live stage show</span><kbd>G</kbd></div>
				<div class="asc-help-row"><span>Toggle treasury</span><kbd>T</kbd></div>
				<div class="asc-help-row"><span>Toggle memory diary</span><kbd>D</kbd></div>
				<div class="asc-help-row"><span>Toggle portfolio HUD</span><kbd>B</kbd></div>
				<div class="asc-help-row"><span>Toggle reputation</span><kbd>E</kbd></div>
				<div class="asc-help-row"><span>Capture screenshot</span><kbd>S</kbd></div>
				<div class="asc-help-row"><span>Picture-in-picture</span><kbd>P</kbd></div>
				<div class="asc-help-row"><span>Fit / fill screen</span><kbd>V</kbd></div>
				<div class="asc-help-row"><span>Fullscreen</span><kbd>F</kbd></div>
				<div class="asc-help-row"><span>This help</span><kbd>?</kbd></div>
			</div>
		</div>
	`;
	document.body.appendChild(el);
	const close = () => el.classList.remove('open');
	el.addEventListener('click', (e) => { if (e.target === el) close(); });
	el.querySelector('#asc-help-close').addEventListener('click', close);
	return {
		toggle: () => el.classList.toggle('open'),
		open: () => el.classList.add('open'),
		close,
		isOpen: () => el.classList.contains('open'),
	};
}

function esc(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
