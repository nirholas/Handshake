// Instant Agent Genesis — selfie/prompt/remix → rigged 3D avatar → agent +
// custodial Solana/EVM wallet → optional ERC-8004 on-chain identity, in one
// guided flow. Every step is real:
//
//   • 3D body          POST /api/avatars/reconstruct  (text prompt OR photo),
//                      poll /api/avatars/regenerate-status  — the same rigged-
//                      avatar pipeline /create/prompt and /create/selfie use.
//                      Remix instead forks a public avatar (POST /api/avatars/fork).
//   • agent + wallet   reconstruct/fork auto-provision the agent; we resolve it
//                      via GET /api/agents?avatar_id=… and guarantee both wallets
//                      with POST /api/agents/:id/wallet/provision (real addresses).
//   • persona + voice  POST /api/persona/extract synthesizes a system prompt,
//                      PATCH /api/agents/:id persists name + persona + voice.
//   • on-chain id      bindExistingAgentOnchain() mints a real ERC-8004 record
//                      and returns a real tx hash.
//
// No mocks, no fake progress: the bar is driven by the real job state, the wallet
// address is the real custodial address, the tx hash is the real signature.

import { apiFetch } from './api.js';
import { getMe } from './account.js';
import { rippleOnce } from './ui-juice.js';
// wallet-auth.js and erc8004/agent-registry.js pull in ethers — heavy and only
// needed when the user actually signs in or registers an identity. They're
// dynamically imported at those call sites so the initial genesis bundle stays light.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ── Constants ──────────────────────────────────────────────────────────────
const RECONSTRUCT_ENDPOINT = '/api/avatars/reconstruct';
const STATUS_ENDPOINT = '/api/avatars/regenerate-status';
const POLL_FIRST_MS = 1500;
const POLL_BACKOFF = 1.4;
const POLL_MAX_MS = 12000;
const GENERATION_DEADLINE_MS = 8 * 60 * 1000;
const AGENT_RESOLVE_DEADLINE_MS = 60 * 1000;
const REGISTER_CHAIN_ID = 8453; // Base — same default as the rest of the platform

const EXAMPLE_PROMPTS = [
	'A silver-haired explorer in a teal flight jacket',
	'A neon cyber-samurai with a glowing visor',
	'A friendly robot barista with copper plating',
	'A cosmic oracle in flowing star-speckled robes',
	'A rugged desert ranger in a dust-worn cloak',
];

// ── State ──────────────────────────────────────────────────────────────────
const state = {
	authed: false,
	mode: 'text',
	photoDataUrl: null,
	remixAvatarId: null,
	abort: null,
	startedAt: 0,
	elapsedTimer: null,
	// outputs
	avatarId: null,
	agent: null, // { id, solana_address, wallet_address, home_url, name }
	modelUrl: null,
	onchain: null,
};

// ── Stage helpers ──────────────────────────────────────────────────────────
function showStage(name) {
	$$('[data-stage]').forEach((el) => {
		el.hidden = el.dataset.stage !== name;
	});
	window.scrollTo({ top: 0, behavior: 'smooth' });
	// The reveal is the real "it shipped" beat — the agent is born and on screen.
	// One restrained ripple on the reveal card marks it (reduced-motion-safe).
	if (name === 'reveal') rippleOnce(document.querySelector('.gx-stage[data-stage="reveal"] .gx-reveal'));
}

function showError(elId, message, onRetry) {
	const el = document.getElementById(elId);
	if (!el) return;
	el.innerHTML = '';
	const p = document.createElement('div');
	p.textContent = message;
	el.appendChild(p);
	if (onRetry) {
		const btn = document.createElement('button');
		btn.className = 'gx-btn gx-btn-ghost';
		btn.textContent = 'Try again';
		btn.addEventListener('click', onRetry);
		el.appendChild(btn);
	}
	el.hidden = false;
}

function clearError(elId) {
	const el = document.getElementById(elId);
	if (el) el.hidden = true;
}

function setStep(step, stateName, detail) {
	const el = $(`.gx-step[data-step="${step}"]`);
	if (!el) return;
	el.dataset.state = stateName;
	if (detail != null) {
		const d = $('[data-role="detail"]', el);
		if (d) d.textContent = detail;
	}
}

function setStepBar(step, pct) {
	const el = $(`.gx-step[data-step="${step}"] [data-role="bar"]`);
	if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

// ── Model viewer ───────────────────────────────────────────────────────────
function mountModelViewer(container, src) {
	container.innerHTML = '';
	const mv = document.createElement('model-viewer');
	mv.setAttribute('src', src);
	mv.setAttribute('alt', 'Your new 3D agent');
	mv.setAttribute('auto-rotate', '');
	mv.setAttribute('rotation-per-second', '14deg');
	mv.setAttribute('interaction-prompt', 'none');
	mv.setAttribute('camera-controls', '');
	mv.setAttribute('shadow-intensity', '0.8');
	mv.setAttribute('shadow-softness', '0.9');
	mv.setAttribute('environment-image', 'neutral');
	mv.setAttribute('exposure', '0.95');
	mv.setAttribute('camera-orbit', '0deg 80deg auto');
	mv.setAttribute('loading', 'eager');
	container.appendChild(mv);
}

// ── Auth ───────────────────────────────────────────────────────────────────
async function refreshAuth() {
	let me = null;
	try {
		me = await getMe();
	} catch {
		me = null;
	}
	state.authed = !!(me && me.id);
	const banner = $('#gx-auth');
	if (banner) banner.hidden = state.authed;
	return state.authed;
}

async function handleSignIn() {
	const btn = $('#gx-signin');
	if (btn) {
		btn.disabled = true;
		btn.textContent = 'Connecting…';
	}
	try {
		const { signInWithWallet } = await import('./wallet-auth.js');
		await signInWithWallet();
		await refreshAuth();
	} catch (err) {
		showError('gx-input-error', err?.message || 'Sign-in failed. Try again.');
	} finally {
		if (btn) {
			btn.disabled = false;
			btn.textContent = 'Sign in';
		}
	}
}

// ── Input wiring ───────────────────────────────────────────────────────────
function selectMode(mode) {
	state.mode = mode;
	$$('.gx-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
	$$('.gx-panel').forEach((p) => {
		p.hidden = p.dataset.panel !== mode;
	});
	if (mode === 'remix') loadRemixGallery();
}

function renderExampleChips() {
	const wrap = $('#gx-chips');
	if (!wrap) return;
	EXAMPLE_PROMPTS.forEach((text) => {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'gx-chip';
		b.textContent = text;
		b.addEventListener('click', () => {
			$('#gx-prompt').value = text;
			$('#gx-prompt').focus();
		});
		wrap.appendChild(b);
	});
}

async function loadVoices() {
	try {
		const res = await fetch('/api/tts/voices', { credentials: 'omit' });
		if (!res.ok) return;
		const data = await res.json();
		const select = $('#gx-voice');
		if (!select || !Array.isArray(data.voices)) return;
		for (const v of data.voices) {
			const id = v.id || v.voice_id;
			if (!id) continue;
			const opt = document.createElement('option');
			opt.value = id;
			opt.textContent = v.name || v.label || id;
			select.appendChild(opt);
		}
	} catch {
		/* voice picker stays at browser default — non-fatal */
	}
}

function handlePhotoFile(file) {
	if (!file || !file.type.startsWith('image/')) return;
	const reader = new FileReader();
	reader.onload = () => {
		state.photoDataUrl = String(reader.result || '');
		$('#gx-photo-img').src = state.photoDataUrl;
		$('#gx-photo-preview').classList.add('is-on');
	};
	reader.readAsDataURL(file);
}

function wirePhotoInput() {
	const input = $('#gx-photo-input');
	const drop = $('#gx-drop');
	input.addEventListener('change', () => handlePhotoFile(input.files?.[0]));
	['dragenter', 'dragover'].forEach((ev) =>
		drop.addEventListener(ev, (e) => {
			e.preventDefault();
			drop.classList.add('is-drag');
		}),
	);
	['dragleave', 'drop'].forEach((ev) =>
		drop.addEventListener(ev, (e) => {
			e.preventDefault();
			drop.classList.remove('is-drag');
		}),
	);
	drop.addEventListener('drop', (e) => handlePhotoFile(e.dataTransfer?.files?.[0]));
	$('#gx-photo-clear').addEventListener('click', () => {
		state.photoDataUrl = null;
		input.value = '';
		$('#gx-photo-preview').classList.remove('is-on');
	});
}

async function loadRemixGallery() {
	const grid = $('#gx-remix-grid');
	if (!grid || grid.dataset.loaded) return;
	try {
		const res = await fetch('/api/avatars/featured?limit=18', { credentials: 'include' });
		const data = await res.json();
		const avatars = (data.avatars || data.data || []).filter((a) => a && a.id);
		if (!avatars.length) {
			grid.innerHTML = '<p class="gx-hint">No public avatars to fork yet — try Describe or Selfie.</p>';
			return;
		}
		grid.innerHTML = '';
		for (const a of avatars) {
			const thumb = a.thumbnail_url || a.thumbnail || a.poster_url;
			if (!thumb) continue;
			const tile = document.createElement('button');
			tile.type = 'button';
			tile.className = 'gx-remix-tile';
			tile.setAttribute('aria-pressed', 'false');
			tile.innerHTML = `<img loading="lazy" src="${thumb}" alt="${(a.name || 'Avatar').replace(/"/g, '')}" /><span>${a.name || 'Avatar'}</span>`;
			tile.addEventListener('click', () => {
				state.remixAvatarId = a.id;
				$$('.gx-remix-tile').forEach((t) => t.setAttribute('aria-pressed', 'false'));
				tile.setAttribute('aria-pressed', 'true');
				if (!$('#gx-name').value) $('#gx-name').value = a.name || '';
			});
			grid.appendChild(tile);
		}
		grid.dataset.loaded = '1';
		if (!grid.children.length) {
			grid.innerHTML = '<p class="gx-hint">No public avatars to fork yet — try Describe or Selfie.</p>';
		}
	} catch {
		grid.innerHTML = '<p class="gx-hint">Couldn\'t load avatars. Try Describe or Selfie instead.</p>';
	}
}

// ── Genesis orchestration ──────────────────────────────────────────────────
async function beginGenesis() {
	clearError('gx-input-error');

	if (!(await refreshAuth())) {
		showError('gx-input-error', 'Sign in first — genesis claims the agent and wallet to your account.');
		$('#gx-auth')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		return;
	}

	// Validate per-mode input before leaving the form.
	const prompt = $('#gx-prompt').value.trim();
	if (state.mode === 'text' && prompt.length < 3) {
		showError('gx-input-error', 'Describe your agent in a few words to begin.');
		return;
	}
	if (state.mode === 'photo' && !state.photoDataUrl) {
		showError('gx-input-error', 'Choose a photo to build your agent from.');
		return;
	}
	if (state.mode === 'remix' && !state.remixAvatarId) {
		showError('gx-input-error', 'Pick a public avatar to fork.');
		return;
	}

	// Reset run state.
	state.abort = new AbortController();
	state.avatarId = null;
	state.agent = null;
	state.modelUrl = null;
	state.onchain = null;
	clearError('gx-forge-error');
	resetForgeUi();
	showStage('forging');
	startElapsed();

	const name = $('#gx-name').value.trim() || null;
	const personaText = $('#gx-persona').value.trim();
	const voiceId = $('#gx-voice').value || null;

	// Persona synthesis (LLM) needs no avatar — run it in parallel with the mesh.
	// Swallow its failure here so a later abort/throw can't surface as an unhandled
	// rejection; a null persona just falls back to the raw text.
	const personaPromise = (personaText ? extractPersona(personaText, name) : Promise.resolve(null)).catch(
		() => null,
	);

	try {
		// 1) Body → avatarId (also auto-provisions the agent server-side).
		let forkAgent = null;
		if (state.mode === 'remix') {
			const forked = await forkAvatar(state.remixAvatarId);
			state.avatarId = forked.avatar.id;
			forkAgent = forked.agent || null;
			setStep('model', 'done', 'Forked into your namespace.');
			setStepBar('model', 100);
		} else {
			const jobId = await submitReconstruct({ name, prompt });
			state.avatarId = await pollReconstruct(jobId);
			setStep('model', 'done', 'Rigged and ready.');
			setStepBar('model', 100);
		}
		if (state.abort.signal.aborted) return;

		// 2) Resolve the agent + guarantee a real custodial wallet.
		setStep('wallet', 'active', 'Provisioning Solana + EVM wallets…');
		const agentId = forkAgent?.id || (await resolveAgentId(state.avatarId));
		const wallet = await provisionWallet(agentId, forkAgent);
		state.agent = {
			id: agentId,
			solana_address: wallet.solana_address,
			wallet_address: wallet.wallet_address,
		};
		setStep('wallet', 'done', 'Wallet live.');
		if (state.abort.signal.aborted) return;

		// 3) Persona + voice + name onto the agent.
		setStep('persona', 'active', personaText ? 'Writing the persona…' : 'Saving identity…');
		const persona = await personaPromise;
		await applyAgentProfile(agentId, { name, persona, personaText, voiceId });
		setStep('persona', 'done', persona ? 'Persona set.' : 'Saved.');

		// 4) Hydrate the reveal.
		await hydrateReveal(agentId, state.avatarId, name);
		stopElapsed();
		showStage('reveal');
	} catch (err) {
		if (state.abort?.signal.aborted) return;
		stopElapsed();
		const active = $('.gx-step[data-state="active"]');
		if (active) active.dataset.state = 'failed';
		showError('gx-forge-error', err?.message || 'Genesis hit a snag. Your inputs are safe — try again.', () => {
			clearError('gx-forge-error');
			showStage('input');
		});
	}
}

async function readJson(res) {
	return res.json().catch(() => ({}));
}

function apiError(data, fallback) {
	return (
		data?.error_description ||
		(typeof data?.error === 'string' ? data.error : null) ||
		data?.message ||
		fallback
	);
}

async function submitReconstruct({ name, prompt }) {
	// A selfie stays private; a described avatar is unlisted — usable and
	// shareable by its owner, but never auto-injected into public galleries.
	const body = { name: name || undefined, visibility: state.mode === 'photo' ? 'private' : 'unlisted' };
	if (state.mode === 'photo') {
		body.photos = [state.photoDataUrl];
		body.params = { bodyType: $('#gx-bodytype').value, style: $('#gx-style').value };
	} else {
		body.prompt = prompt;
		const key = $('#gx-meshy-key')?.value.trim();
		if (key) {
			body.provider_key = key;
			body.provider_name = 'meshy';
		}
	}
	const res = await apiFetch(RECONSTRUCT_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal: state.abort.signal,
	});
	const data = await readJson(res);
	if (!res.ok || !data.jobId) {
		throw new Error(mapReconstructError(res.status, data));
	}
	return data.jobId;
}

function mapReconstructError(status, data) {
	const code = typeof data?.error === 'string' ? data.error : data?.code;
	if (status === 429 || code === 'txt2img_rate_limited') return 'The avatar engine is busy. Wait a moment and try again.';
	if (code === 'txt2img_error') return "Couldn't render from that prompt. Try rewording it.";
	if (code === 'regen_needs_byok') return 'Avatar generation needs a 3D engine key on this deployment. Add a Meshy or Tripo key in settings, or use the selfie scanner.';
	if (code === 'regen_provider_error') return 'The avatar engines are all busy right now. Try again shortly.';
	if (status === 413) return 'That photo is too large. Try a smaller image.';
	return apiError(data, `The avatar engine returned ${status}. Try again.`);
}

const RECON_PROGRESS = {
	queued: [5, 18, 'Queued behind the avatar engine…'],
	running: [18, 78, 'Sculpting your 3D body…'],
	rigging: [78, 96, 'Rigging the skeleton so it can move…'],
};

async function pollReconstruct(jobId) {
	const deadline = Date.now() + GENERATION_DEADLINE_MS;
	let wait = POLL_FIRST_MS;
	let shown = 5;
	setStepBar('model', shown);
	while (Date.now() < deadline) {
		if (state.abort.signal.aborted) throw new Error('cancelled');
		await sleep(wait, state.abort.signal);
		wait = Math.min(wait * POLL_BACKOFF, POLL_MAX_MS);

		const res = await apiFetch(`${STATUS_ENDPOINT}?jobId=${encodeURIComponent(jobId)}`, {
			allowAnonymous: true,
			signal: state.abort.signal,
		});
		const data = await readJson(res);
		if (!res.ok) throw new Error(apiError(data, `Status check failed (${res.status}).`));

		const band = RECON_PROGRESS[data.status];
		if (band) {
			const [floor, ceil, label] = band;
			shown = Math.min(ceil, Math.max(shown + 3, floor));
			setStepBar('model', shown);
			setStep('model', 'active', label);
		}
		if (data.status === 'done' && data.resultAvatarId) return data.resultAvatarId;
		if (data.status === 'failed') throw new Error(friendlyJobError(data.error));
	}
	throw new Error('Generation took too long. Try a simpler prompt or photo.');
}

function friendlyJobError(code) {
	const map = {
		moderation_blocked: 'That photo was flagged by moderation. Try a clear, front-facing photo of a person.',
		no_face_detected: "Couldn't find a face in that photo. Use a clear, front-facing shot.",
		provider_error: 'The avatar engine failed on this one. Try again or tweak your input.',
	};
	return map[code] || 'The avatar engine couldn\'t finish this one. Try again with a different input.';
}

async function forkAvatar(sourceAvatarId) {
	const res = await apiFetch('/api/avatars/fork', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ source_avatar_id: sourceAvatarId }),
		signal: state.abort.signal,
	});
	const data = await readJson(res);
	if (res.status === 409 && data?.error === 'royalty_consent_required') {
		const pct = data?.royalty?.total_pct ?? 0;
		const ok = window.confirm(
			`This avatar charges a ${pct}% fork royalty to its creators on tips & streams. Fork it on these terms?`,
		);
		if (!ok) throw new Error('Fork cancelled — no royalty accepted.');
		return forkAvatarWithConsent(sourceAvatarId);
	}
	if (!res.ok || !data.avatar?.id) throw new Error(apiError(data, 'Could not fork that avatar.'));
	return data;
}

async function forkAvatarWithConsent(sourceAvatarId) {
	const res = await apiFetch('/api/avatars/fork', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ source_avatar_id: sourceAvatarId, accept_royalty: true }),
		signal: state.abort.signal,
	});
	const data = await readJson(res);
	if (!res.ok || !data.avatar?.id) throw new Error(apiError(data, 'Could not fork that avatar.'));
	return data;
}

async function resolveAgentId(avatarId) {
	const deadline = Date.now() + AGENT_RESOLVE_DEADLINE_MS;
	let wait = 800;
	while (Date.now() < deadline) {
		if (state.abort.signal.aborted) throw new Error('cancelled');
		const res = await apiFetch(`/api/agents?avatar_id=${encodeURIComponent(avatarId)}`, {
			allowAnonymous: true,
			signal: state.abort.signal,
		});
		const data = await readJson(res);
		const agents = data.agents || data.data?.agents || [];
		const agent = agents.find((a) => a && a.id);
		if (agent) return agent.id;
		await sleep(wait, state.abort.signal);
		wait = Math.min(wait * 1.4, 4000);
	}
	throw new Error('Your agent is taking longer than usual to wake up. Refresh in a moment — it will be in your account.');
}

async function provisionWallet(agentId, forkAgent) {
	// Fork already provisioned both wallets synchronously and handed them back.
	if (forkAgent?.solana_address || forkAgent?.wallet_address) {
		return { solana_address: forkAgent.solana_address, wallet_address: forkAgent.wallet_address };
	}
	const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/wallet/provision`, {
		method: 'POST',
		signal: state.abort.signal,
	});
	const data = await readJson(res);
	if (!res.ok) throw new Error(apiError(data, 'Could not provision the wallet.'));
	return { solana_address: data.solana_address, wallet_address: data.wallet_address };
}

async function extractPersona(freeform, name) {
	const res = await apiFetch('/api/persona/extract', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ freeform: name ? `${name}: ${freeform}` : freeform }),
	});
	if (!res.ok) return null;
	const data = await readJson(res);
	return data.persona || null;
}

function composePersonaPrompt(name, persona, fallbackText) {
	if (!persona) return fallbackText || null;
	const who = name || 'this agent';
	const lines = [`You are ${who}, a 3D AI agent on three.ws.`];
	if (persona.tone) lines.push(persona.tone);
	if (persona.communication_style) lines.push(`Your communication style is ${persona.communication_style}.`);
	if (Array.isArray(persona.interests) && persona.interests.length) {
		lines.push(`You care about ${persona.interests.join(', ')}.`);
	}
	if (Array.isArray(persona.vocabulary) && persona.vocabulary.length) {
		lines.push(`You naturally say things like: ${persona.vocabulary.slice(0, 6).join('; ')}.`);
	}
	if (Array.isArray(persona.dont_say) && persona.dont_say.length) {
		lines.push(`Never say: ${persona.dont_say.join('; ')}.`);
	}
	return lines.join(' ');
}

async function applyAgentProfile(agentId, { name, persona, personaText, voiceId }) {
	const personaPrompt = composePersonaPrompt(name, persona, personaText);
	const meta = { created_via: 'genesis' };
	if (voiceId) {
		meta.voice_preference = voiceId;
		meta.voice_id = voiceId;
	}
	if (persona?.sample_greeting) meta.greeting = persona.sample_greeting;
	const body = { meta };
	if (name) body.name = name;
	if (personaPrompt) body.persona_prompt = personaPrompt.slice(0, 8000);

	// Best-effort: a profile-write hiccup must not lose the already-created agent.
	try {
		await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	} catch {
		/* the agent exists and is owned; profile can be edited from its page */
	}
}

async function hydrateReveal(agentId, avatarId, name) {
	// Pull the agent for its real name + home_url, and the avatar for its model URL.
	let agentRow = null;
	try {
		const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, { allowAnonymous: true });
		if (res.ok) agentRow = (await readJson(res)).agent;
	} catch {
		/* fall back to local state below */
	}
	if (agentRow) {
		state.agent.solana_address = agentRow.solana_address || state.agent.solana_address;
		state.agent.wallet_address = agentRow.wallet_address || state.agent.wallet_address;
		state.agent.home_url = agentRow.home_url || null;
		state.agent.name = agentRow.name || name;
	}

	try {
		const res = await apiFetch(`/api/avatars/${encodeURIComponent(avatarId)}`, { allowAnonymous: true });
		if (res.ok) {
			const av = (await readJson(res)).avatar;
			state.modelUrl = av?.model_url || av?.url || null;
		}
	} catch {
		/* viewer falls back to placeholder */
	}

	renderReveal(name);
}

// ── Reveal rendering ───────────────────────────────────────────────────────
function shorten(addr) {
	if (!addr) return '—';
	return addr.length > 16 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr;
}

function walletRow(chainLabel, address) {
	const row = document.createElement('div');
	row.className = 'gx-addr';
	const left = document.createElement('div');
	left.className = 'gx-addr-l';
	left.innerHTML = `<div class="gx-addr-chain">${chainLabel}</div><code title="${address || ''}">${address ? shorten(address) : 'Provisioning…'}</code>`;
	row.appendChild(left);
	if (address) {
		const copy = document.createElement('button');
		copy.className = 'gx-copy';
		copy.type = 'button';
		copy.textContent = 'Copy';
		copy.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(address);
				copy.textContent = 'Copied';
				copy.classList.add('is-copied');
				setTimeout(() => {
					copy.textContent = 'Copy';
					copy.classList.remove('is-copied');
				}, 1600);
			} catch {
				copy.textContent = 'Copy failed';
			}
		});
		row.appendChild(copy);
	}
	return row;
}

function renderReveal(name) {
	const agent = state.agent;
	const displayName = agent.name || name || 'Your Agent';
	$('#gx-reveal-name').textContent = displayName;

	const viewer = $('#gx-reveal-viewer');
	if (state.modelUrl) {
		mountModelViewer(viewer, state.modelUrl);
	} else {
		viewer.innerHTML = '<div class="gx-placeholder" style="height:100%;display:grid;place-items:center"><div><div class="gx-orb"></div>Your agent is ready in your account.</div></div>';
	}

	const wallets = $('#gx-wallets');
	wallets.innerHTML = '';
	wallets.appendChild(walletRow('Solana', agent.solana_address));
	wallets.appendChild(walletRow('EVM · Base', agent.wallet_address));

	$('#gx-cta-fund').href = `/agents/${agent.id}/wallet#deposit`;
	$('#gx-cta-open').href = agent.home_url || `/agents/${agent.id}`;
	$('#gx-cta-share').href = `/api/agent-share?id=${encodeURIComponent(agent.id)}`;

	renderIdentity();
}

function renderIdentity() {
	const badge = $('#gx-identity-badge');
	const body = $('#gx-identity-body');
	if (state.onchain?.txHash) {
		badge.textContent = 'Verified on-chain';
		badge.className = 'gx-badge gx-badge-live';
		const explorer = `https://basescan.org/tx/${state.onchain.txHash}`;
		body.innerHTML = `
			<p class="gx-identity-status">ERC-8004 agent #${state.onchain.agentId ?? ''} on Base. Identity tx:</p>
			<a class="gx-tx" href="${explorer}" target="_blank" rel="noopener">${state.onchain.txHash}</a>`;
		// A real ERC-8004 record just landed — ripple the badge once to mark it.
		rippleOnce(badge);
		return;
	}
	badge.textContent = 'Not registered';
	badge.className = 'gx-badge gx-badge-pending';
	// keep the existing register button + status (set in HTML / reset below)
	if (!$('#gx-register')) {
		body.innerHTML = `
			<button class="gx-btn gx-btn-primary" id="gx-register" type="button" style="width:100%">Register ERC-8004 identity</button>
			<p class="gx-identity-status" id="gx-identity-status">Connect an EVM wallet to mint a verifiable, tradeable identity. Optional — you can do this anytime.</p>`;
	}
	wireRegister();
}

function wireRegister() {
	const btn = $('#gx-register');
	if (!btn || btn.dataset.wired) return;
	btn.dataset.wired = '1';
	btn.addEventListener('click', registerIdentity);
}

async function registerIdentity() {
	const btn = $('#gx-register');
	const status = $('#gx-identity-status');
	if (!btn) return;
	btn.disabled = true;
	const setStatus = (m) => {
		if (status) status.textContent = m;
	};
	setStatus('Connecting your wallet…');
	try {
		const { bindExistingAgentOnchain } = await import('./erc8004/agent-registry.js');
		const result = await bindExistingAgentOnchain(state.agent.id, REGISTER_CHAIN_ID, {
			onStatus: setStatus,
		});
		state.onchain = {
			txHash: result.txHash || result.onchain?.tx_hash || null,
			agentId: result.agentId,
			chainId: result.chainId || REGISTER_CHAIN_ID,
		};
		if (result.alreadyBound && !state.onchain.txHash) {
			state.onchain.txHash = result.onchain?.tx_hash || null;
		}
		if (!state.onchain.txHash) {
			setStatus('Identity registered. Indexing the transaction…');
		}
		renderIdentity();
	} catch (err) {
		btn.disabled = false;
		const msg = err?.message || 'Registration failed.';
		setStatus(
			/wallet|account|reject|connect/i.test(msg)
				? 'Connect an EVM wallet (e.g. MetaMask) to register. You can do this anytime — your agent is already yours.'
				: `${msg} You can retry anytime.`,
		);
	}
}

// ── Forge UI lifecycle ─────────────────────────────────────────────────────
function resetForgeUi() {
	setStep('model', 'active', state.mode === 'remix' ? 'Forking into your namespace…' : 'Warming up the avatar engine…');
	setStepBar('model', 5);
	setStep('wallet', 'pending', 'Waiting on your agent…');
	setStep('persona', 'pending', $('#gx-persona').value.trim() ? 'Queued — writing once the body lands.' : 'Queued.');
	$('#gx-forge-preview').innerHTML =
		'<div class="gx-placeholder"><div class="gx-orb" aria-hidden="true"></div>Your agent is taking shape…</div>';
}

function startElapsed() {
	state.startedAt = Date.now();
	const el = $('#gx-elapsed');
	stopElapsed();
	state.elapsedTimer = setInterval(() => {
		const s = Math.floor((Date.now() - state.startedAt) / 1000);
		if (el) el.textContent = `Elapsed ${s}s`;
	}, 1000);
}

function stopElapsed() {
	if (state.elapsedTimer) {
		clearInterval(state.elapsedTimer);
		state.elapsedTimer = null;
	}
}

function cancelGenesis() {
	state.abort?.abort();
	stopElapsed();
	showStage('input');
}

function resetToInput() {
	state.onchain = null;
	state.agent = null;
	state.avatarId = null;
	state.modelUrl = null;
	state.photoDataUrl = null;
	state.remixAvatarId = null;
	$('#gx-photo-preview')?.classList.remove('is-on');
	$$('.gx-remix-tile').forEach((t) => t.setAttribute('aria-pressed', 'false'));
	showStage('input');
}

// ── Utils ──────────────────────────────────────────────────────────────────
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		if (signal) {
			signal.addEventListener(
				'abort',
				() => {
					clearTimeout(t);
					reject(new Error('cancelled'));
				},
				{ once: true },
			);
		}
	});
}

// ── Init ───────────────────────────────────────────────────────────────────
function init() {
	renderExampleChips();
	wirePhotoInput();
	loadVoices();
	refreshAuth();

	$$('.gx-tab').forEach((tab) => tab.addEventListener('click', () => selectMode(tab.dataset.mode)));
	$('#gx-signin')?.addEventListener('click', handleSignIn);
	$('#gx-begin')?.addEventListener('click', beginGenesis);
	$('#gx-cancel')?.addEventListener('click', cancelGenesis);
	$('#gx-again')?.addEventListener('click', resetToInput);
	wireRegister();
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
