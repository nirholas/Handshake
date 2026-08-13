// Agent Genome — the breeding studio.
//
// Pick two parents (your own agents, or a public stud), preview the predicted
// offspring (a real trait blend, a playable blended voice, the skill alleles, the
// pedigree tier), then breed — which mints a genuinely new child agent with a
// fresh wallet, a synthesized body + voice + brain, inherited on-chain skills, and
// a verifiable lineage. Every API call is real (api/genome/*, api/tts/eleven).

import { apiFetch } from './api.js';

const $ = (id) => document.getElementById(id);

const state = {
	parents: { a: null, b: null },
	myAgents: [],
	seed: null,
	preview: null,
	picking: null, // 'a' | 'b'
	busy: false,
	signedIn: false,
};

// ── Boot ─────────────────────────────────────────────────────────────────────
init().catch((e) => console.error('[genome] init failed', e));

async function init() {
	wire();
	await Promise.all([loadMyAgents(), loadStuds()]);
	// Deep-link: /genome?a=<id>&b=<id> pre-selects parents (e.g. from a profile CTA).
	const params = new URLSearchParams(location.search);
	for (const slot of ['a', 'b']) {
		const id = params.get(slot);
		if (id) {
			const found = state.myAgents.find((x) => x.id === id);
			if (found) selectAgent(slot, found);
		}
	}
	refreshActions();
}

function wire() {
	document.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => openPicker(b.dataset.pick)));
	$('gnPreview').addEventListener('click', () => runPreview());
	$('gnBreed').addEventListener('click', () => runBreed());
	$('gnReroll').addEventListener('click', () => { state.seed = null; runPreview(); });
	$('gnModalClose').addEventListener('click', closePicker);
	$('gnModal').addEventListener('click', (e) => { if (e.target === $('gnModal')) closePicker(); });
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('gnModal').hidden) closePicker(); });
}

// ── Data ─────────────────────────────────────────────────────────────────────
async function loadMyAgents() {
	try {
		const r = await apiFetch('/api/agents', { allowAnonymous: true });
		if (r.status === 401) { note('Sign in to breed your agents.', 'error'); return; }
		const j = await r.json();
		state.myAgents = (j.agents || []).map(normalizeAgent);
		state.signedIn = true;
	} catch (e) {
		note('Could not load your agents — check your connection and retry.', 'error');
	}
	renderMyStuds();
}

async function loadStuds() {
	try {
		const r = await fetch('/api/genome/stud', { credentials: 'include' });
		const j = await r.json().catch(() => ({}));
		renderStuds(j.studs || []);
	} catch { renderStuds([]); }
}

function normalizeAgent(a) {
	return {
		id: a.id,
		name: a.name || 'Untitled agent',
		thumb: a.avatar_thumbnail_url || a.avatar_url || null,
		owner: 'you',
		generation: a.meta?.genome?.generation ?? 0,
		fee: 0,
		cross_owner: false,
		is_public: a.is_public !== false,
		listed: a.is_stud === true,
		listed_fee: Math.max(0, Number(a.stud_fee_three) || 0),
	};
}

// ── Parent selection ─────────────────────────────────────────────────────────
function selectAgent(slot, agent) {
	const other = slot === 'a' ? 'b' : 'a';
	if (state.parents[other]?.id === agent.id) { note('Pick two different agents to breed.', 'error'); return; }
	state.parents[slot] = agent;
	state.seed = null;
	state.preview = null;
	$('gnOffspring').hidden = true;
	renderParent(slot);
	refreshActions();
}

function renderParent(slot) {
	const agent = state.parents[slot];
	const card = $(slot === 'a' ? 'gnParentA' : 'gnParentB');
	const host = $(slot === 'a' ? 'gnSlotA' : 'gnSlotB');
	if (!agent) {
		card.classList.remove('is-filled');
		host.innerHTML = `<button class="gn-slot-empty" type="button" data-pick="${slot}">+ Choose an agent</button>`;
		host.querySelector('[data-pick]').addEventListener('click', () => openPicker(slot));
		return;
	}
	card.classList.add('is-filled');
	host.innerHTML = `
		<div class="gn-chosen">
			<div class="gn-thumb" ${agent.thumb ? `style="background-image:url('${escapeAttr(agent.thumb)}')"` : ''}>${agent.thumb ? '' : escapeHtml(initials(agent.name))}</div>
			<div class="gn-chosen-id">
				<div class="gn-chosen-name">${escapeHtml(agent.name)}</div>
				<div class="gn-chosen-sub">${agent.cross_owner ? `stud · ${agent.fee} $THREE` : `gen ${agent.generation} · yours`}</div>
			</div>
			<button class="gn-chosen-change" type="button">Change</button>
		</div>`;
	host.querySelector('.gn-chosen-change').addEventListener('click', () => openPicker(slot));
}

function refreshActions() {
	const ready = !!(state.parents.a && state.parents.b) && !state.busy;
	$('gnPreview').disabled = !ready;
	$('gnBreed').disabled = !ready;
}

// ── Picker modal ─────────────────────────────────────────────────────────────
function openPicker(slot) {
	state.picking = slot;
	$('gnModalTitle').textContent = `Choose parent ${slot.toUpperCase()}`;
	const other = slot === 'a' ? 'b' : 'a';
	const otherId = state.parents[other]?.id;
	const list = $('gnModalList');
	const candidates = state.myAgents.filter((a) => a.id !== otherId);
	if (!candidates.length) {
		list.innerHTML = `<div class="gn-empty-list">You have no agents yet. <a href="/create">Create one →</a></div>`;
	} else {
		list.innerHTML = candidates
			.map(
				(a) => `<button class="gn-pick" type="button" data-id="${escapeAttr(a.id)}">
					<div class="gn-thumb" ${a.thumb ? `style="background-image:url('${escapeAttr(a.thumb)}')"` : ''}>${a.thumb ? '' : escapeHtml(initials(a.name))}</div>
					<div>
						<div>${escapeHtml(a.name)}</div>
						<div class="gn-pick-sub">gen ${a.generation}</div>
					</div>
				</button>`,
			)
			.join('');
		list.querySelectorAll('.gn-pick').forEach((btn) =>
			btn.addEventListener('click', () => {
				const a = state.myAgents.find((x) => x.id === btn.dataset.id);
				if (a) { selectAgent(slot, a); closePicker(); }
			}),
		);
	}
	$('gnModal').hidden = false;
	$('gnModalClose').focus();
}

function closePicker() { $('gnModal').hidden = true; state.picking = null; }

// ── Preview ──────────────────────────────────────────────────────────────────
async function runPreview() {
	if (!state.parents.a || !state.parents.b) return;
	clearNotes();
	setBusy(true);
	renderOffspringSkeleton();
	try {
		const r = await apiFetch('/api/genome/preview', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ parent_a: state.parents.a.id, parent_b: state.parents.b.id, seed: state.seed || undefined }),
		});
		const j = await r.json().catch(() => ({}));
		if (!r.ok) { renderError(j); return; }
		state.seed = j.seed;
		state.preview = j;
		renderOffspring(j, false);
		$('gnReroll').hidden = false;
		if (j.consent_required && j.stud_fee_three > 0) {
			note(`This pairing uses a stud — breeding costs ${j.stud_fee_three} $THREE, paid to the stud owner.`, 'consent');
		}
	} catch (e) {
		note('Preview failed — please retry.', 'error');
	} finally {
		setBusy(false);
	}
}

// ── Breed ────────────────────────────────────────────────────────────────────
async function runBreed() {
	if (!state.parents.a || !state.parents.b) return;
	clearNotes();
	setBusy(true, 'Breeding…');
	try {
		const body = { parent_a: state.parents.a.id, parent_b: state.parents.b.id };
		if (state.seed) body.seed = state.seed; // commit exactly the previewed child
		const r = await apiFetch('/api/genome/breed', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
		const j = await r.json().catch(() => ({}));
		if (r.status === 402) {
			note(`Breeding with this stud costs ${j.stud_fee_three} $THREE. Settle the fee and retry — stud payments are coming to this surface; for now breed with agents you own.`, 'consent');
			return;
		}
		if (r.status === 409 && j.error === 'breeding_cooldown') {
			note(`A parent is still on breeding cooldown — ${j.cooldown_remaining_min} min remaining. Cooldowns keep rare pedigrees scarce.`, 'error');
			return;
		}
		if (!r.ok) { renderError(j); return; }
		renderBorn(j);
	} catch (e) {
		note('Breeding failed — please retry.', 'error');
	} finally {
		setBusy(false);
	}
}

// ── Rendering ────────────────────────────────────────────────────────────────
function renderOffspringSkeleton() {
	const el = $('gnOffspring');
	el.hidden = false;
	el.innerHTML = `<div class="gn-skel" style="height:24px;width:40%;margin-bottom:16px"></div>
		<div class="gn-grid">
			${'<div class="gn-panel"><div class="gn-skel" style="height:110px"></div></div>'.repeat(4)}
		</div>`;
}

function renderOffspring(data, born) {
	const g = data.genome;
	const el = $('gnOffspring');
	el.hidden = false;
	el.innerHTML = `
		<div class="gn-off-head">
			<span class="gn-off-name">${escapeHtml(data.child_name || (data.child && data.child.name) || 'Offspring')}</span>
			${tierBadge(g.pedigree)}
			<span class="gn-off-gen">Generation ${g.generation}</span>
		</div>
		<div class="gn-grid">
			${brainPanel(g.brain, g.mutations)}
			${voicePanel(g.voice, data)}
			${skillsPanel(g.skills)}
			${personaPanel(g.persona_prompt)}
		</div>
		<p class="gn-seed">seed ${escapeHtml(data.seed || state.seed || '')}${born ? ` · genome ${escapeHtml((data.genome_hash || '').slice(0, 16))}…` : ''}</p>`;
	wireVoice(g.voice);
}

function brainPanel(brain, mutations) {
	const mutSet = new Set((mutations || []).map((m) => m.locus.replace('brain.', '')));
	const loci = ['curiosity', 'boldness', 'humor', 'formality', 'verbosity', 'temperature'];
	return `<div class="gn-panel"><h3>Brain</h3>
		${loci
			.map(
				(k) => `<div class="gn-trait">
					<div class="gn-trait-row"><span>${k}</span><span>${Math.round((brain[k] ?? 0) * 100)}%${mutSet.has(k) ? ' <span class="gn-mut">⚡mutation</span>' : ''}</span></div>
					<div class="gn-bar"><i style="width:${Math.round((brain[k] ?? 0) * 100)}%"></i></div>
				</div>`,
			)
			.join('')}
		${brain.archetype ? `<div class="gn-chips" style="margin-top:8px"><span class="gn-chip" data-kind="expressed">${escapeHtml(brain.archetype)}</span>${(brain.tone_tags || []).map((t) => `<span class="gn-chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
	</div>`;
}

function voicePanel(voice, data) {
	const canPlay = !!(voice.voice_id);
	return `<div class="gn-panel"><h3>Voice</h3>
		<div class="gn-voice-row">
			<button class="gn-play" id="gnPlay" type="button" ${canPlay ? '' : 'disabled'} aria-label="Play a sample of the inherited voice">▶</button>
			<div class="gn-pick-sub">${canPlay ? 'Hear the blended voice' : 'Browser voice (no sample)'}</div>
		</div>
		${voiceBar('stability', voice.settings.stability)}
		${voiceBar('similarity', voice.settings.similarity_boost)}
		${voiceBar('style', voice.settings.style)}
	</div>`;
}
function voiceBar(label, v) {
	return `<div class="gn-trait"><div class="gn-trait-row"><span>${label}</span><span>${Math.round((v ?? 0) * 100)}%</span></div><div class="gn-bar"><i style="width:${Math.round((v ?? 0) * 100)}%"></i></div></div>`;
}

function skillsPanel(skills) {
	const expressed = skills.filter((s) => s.expressed && s.source !== 'emergent');
	const emergent = skills.filter((s) => s.expressed && s.source === 'emergent');
	const recessive = skills.filter((s) => !s.expressed);
	const chip = (s, kind) => `<span class="gn-chip" data-kind="${kind}" title="${kind}${s.source ? ' · from ' + escapeAttr(s.source) : ''}">${escapeHtml(s.skill)}</span>`;
	const body = [
		...emergent.map((s) => chip(s, 'emergent')),
		...expressed.map((s) => chip(s, 'expressed')),
		...recessive.map((s) => chip(s, 'recessive')),
	].join('');
	return `<div class="gn-panel"><h3>Skills</h3>
		<div class="gn-chips">${body || '<span class="gn-pick-sub">No inherited skills</span>'}</div>
		${emergent.length ? `<p class="gn-pick-sub" style="margin-top:8px">⚡ ${emergent.length} emergent skill${emergent.length > 1 ? 's' : ''} neither parent had.</p>` : ''}
	</div>`;
}

function personaPanel(prompt) {
	return `<div class="gn-panel"><h3>Disposition</h3><div class="gn-persona">${escapeHtml(prompt || '')}</div></div>`;
}

function renderBorn(data) {
	renderOffspring({ ...data, child_name: data.child?.name, seed: data.seed }, true);
	const el = $('gnOffspring');
	const child = data.child || {};
	const banner = document.createElement('div');
	banner.className = 'gn-note';
	banner.dataset.kind = 'success';
	banner.innerHTML = `🧬 <strong>${escapeHtml(child.name || 'Offspring')}</strong> was born — a generation ${child.generation} ${escapeHtml(child.pedigree?.tier || 'common')} agent with its own fresh wallet.
		<a class="gn-hero-link" href="/agents/${escapeAttr(child.id)}">Open agent →</a>
		· <a class="gn-hero-link" href="/agents/${escapeAttr(child.id)}" data-verify="${escapeAttr(child.id)}">Verify lineage</a>`;
	el.prepend(banner);
	banner.querySelector('[data-verify]').addEventListener('click', (e) => { e.preventDefault(); verifyLineage(child.id); });
	// Refresh studs (a notable birth may shift the rarest-first ordering).
	loadStuds();
	note('', null);
}

async function verifyLineage(agentId) {
	try {
		const r = await fetch(`/api/genome/lineage?agentId=${encodeURIComponent(agentId)}&verify=1`);
		const j = await r.json();
		if (j.valid) note(`✓ Lineage verified — this agent's genome re-derives exactly from its recorded parents and seed (hash ${String(j.genome_hash).slice(0, 16)}…).`, 'success');
		else note(`⚠ Verification failed: ${j.reason || 'genome does not match recorded parentage'}.`, 'error');
	} catch { note('Could not verify right now — retry shortly.', 'error'); }
}

// ── Voice sample (real TTS) ──────────────────────────────────────────────────
let currentAudio = null;
function wireVoice(voice) {
	const btn = $('gnPlay');
	if (!btn || btn.disabled) return;
	btn.addEventListener('click', () => playVoice(voice));
}
async function playVoice(voice) {
	const btn = $('gnPlay');
	if (currentAudio) { currentAudio.pause(); currentAudio = null; }
	btn.disabled = true;
	btn.textContent = '…';
	try {
		const r = await fetch('/api/tts/eleven', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({
				voiceId: voice.voice_id,
				text: 'Hello. I am the child of two agents — I carry a little of each of them.',
				voice_settings: voice.settings,
			}),
		});
		if (!r.ok) throw new Error('tts failed');
		const blob = await r.blob();
		const url = URL.createObjectURL(blob);
		currentAudio = new Audio(url);
		currentAudio.addEventListener('ended', () => { btn.textContent = '▶'; btn.disabled = false; URL.revokeObjectURL(url); });
		await currentAudio.play();
		btn.textContent = '‖';
		btn.disabled = false;
		btn.onclick = () => { currentAudio?.pause(); btn.textContent = '▶'; btn.onclick = null; wireVoice(voice); };
	} catch {
		btn.textContent = '▶';
		btn.disabled = false;
		note('Could not synthesize a voice sample right now.', 'error');
	}
}

// ── Studs ────────────────────────────────────────────────────────────────────
function renderStuds(studs) {
	const host = $('gnStuds');
	if (!studs.length) {
		host.innerHTML = `<p class="gn-pick-sub">No agents are open for stud yet. Open one of yours for breeding under <a class="gn-hero-link" href="#gnMyStudsSection">Your stud listings</a> below and it appears here.</p>`;
		return;
	}
	host.innerHTML = studs
		.map(
			(s) => `<div class="gn-stud" tabindex="0" role="button" data-id="${escapeAttr(s.id)}" data-name="${escapeAttr(s.name)}" data-fee="${s.stud_fee_three}" data-gen="${s.generation}">
			<div style="display:flex;justify-content:space-between;align-items:center">
				<span class="gn-stud-name">${escapeHtml(s.name)}</span>${tierBadge(s.pedigree)}
			</div>
			<span class="gn-pick-sub">gen ${s.generation} · ${(s.expressed_skills || []).length} skills</span>
			<span class="gn-stud-fee">${s.stud_fee_three > 0 ? `${s.stud_fee_three} $THREE` : 'free stud'}</span>
		</div>`,
		)
		.join('');
	host.querySelectorAll('.gn-stud').forEach((el) => {
		const pick = () => {
			const agent = { id: el.dataset.id, name: el.dataset.name, thumb: null, owner: 'stud', generation: Number(el.dataset.gen) || 0, fee: Number(el.dataset.fee) || 0, cross_owner: true };
			const slot = state.parents.a ? 'b' : 'a';
			selectAgent(slot, agent);
			window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
		};
		el.addEventListener('click', pick);
		el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
	});
}

// ── Your stud listings (the supply side of the market) ───────────────────────
function renderMyStuds() {
	const section = $('gnMyStudsSection');
	const host = $('gnMyStuds');
	if (!section || !host) return;
	if (!state.signedIn) { section.hidden = true; return; }
	section.hidden = false;
	if (!state.myAgents.length) {
		host.innerHTML = `<p class="gn-pick-sub">You have no agents to list yet. <a href="/create">Create one →</a></p>`;
		return;
	}
	host.innerHTML = state.myAgents.map(myStudCard).join('');
	host.querySelectorAll('.gn-mystud').forEach(wireMyStud);
}

function myStudCard(a) {
	// A private agent can't be a stud: /api/genome/stud only lists public agents,
	// so say that here instead of letting the toggle look broken.
	const blocked = !a.is_public;
	return `<div class="gn-mystud" data-id="${escapeAttr(a.id)}" data-listed="${a.listed}">
		<div class="gn-mystud-head">
			<span class="gn-mystud-name" title="${escapeAttr(a.name)}">${escapeHtml(a.name)}</span>
			<span class="gn-pick-sub">gen ${a.generation}</span>
		</div>
		<label class="gn-switch">
			<input type="checkbox" class="gn-mystud-toggle" ${a.listed ? 'checked' : ''} ${blocked ? 'disabled' : ''}
				aria-label="List ${escapeAttr(a.name)} in the stud market" />
			<span class="gn-switch-track" aria-hidden="true"></span>
			<span>${a.listed ? 'Listed for stud' : 'Not listed'}</span>
		</label>
		<div class="gn-mystud-row">
			<label class="gn-pick-sub" for="fee-${escapeAttr(a.id)}">Fee</label>
			<input class="gn-fee-input" id="fee-${escapeAttr(a.id)}" type="number" min="0" step="1" inputmode="numeric"
				value="${a.listed_fee}" ${blocked ? 'disabled' : ''} aria-label="Stud fee in THREE for ${escapeAttr(a.name)}" />
			<span class="gn-pick-sub">$THREE</span>
		</div>
		<div class="gn-mystud-state"${blocked ? ' data-kind="error"' : ''}>${blocked ? 'Make this agent public to open it for stud.' : ''}</div>
	</div>`;
}

function wireMyStud(card) {
	const toggle = card.querySelector('.gn-mystud-toggle');
	const fee = card.querySelector('.gn-fee-input');
	if (!toggle || toggle.disabled) return;
	toggle.addEventListener('change', () => saveStud(card, { stud: toggle.checked }));
	// Commit the fee on blur and on Enter, never on every keystroke.
	fee.addEventListener('change', () => saveStud(card, { stud_fee_three: Math.max(0, Number(fee.value) || 0) }));
	fee.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fee.blur(); } });
}

async function saveStud(card, patch) {
	const id = card.dataset.id;
	const agent = state.myAgents.find((x) => x.id === id);
	const status = card.querySelector('.gn-mystud-state');
	const toggle = card.querySelector('.gn-mystud-toggle');
	const fee = card.querySelector('.gn-fee-input');
	toggle.disabled = true;
	fee.disabled = true;
	status.removeAttribute('data-kind');
	status.textContent = 'Saving…';
	try {
		const r = await apiFetch('/api/genome/stud', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ agent_id: id, ...patch }),
		});
		const j = await r.json().catch(() => ({}));
		if (!r.ok) {
			status.dataset.kind = 'error';
			status.textContent = j.error_description || 'Could not save that listing. Retry in a moment.';
			// Snap the controls back to the last state the server confirmed.
			toggle.checked = !!agent?.listed;
			fee.value = agent?.listed_fee ?? 0;
			return;
		}
		const policy = j.genome_breeding || {};
		if (agent) {
			agent.listed = policy.stud === true;
			agent.listed_fee = Math.max(0, Number(policy.stud_fee_three) || 0);
		}
		toggle.checked = !!agent?.listed;
		fee.value = agent?.listed_fee ?? 0;
		card.dataset.listed = String(!!agent?.listed);
		card.querySelector('.gn-switch span:last-child').textContent = agent?.listed ? 'Listed for stud' : 'Not listed';
		status.dataset.kind = 'ok';
		status.textContent = agent?.listed
			? `Open for stud at ${agent.listed_fee} $THREE.`
			: 'Unlisted. Nobody can breed with this agent.';
		loadStuds();
	} catch {
		status.dataset.kind = 'error';
		status.textContent = 'Network error. Your listing was not changed.';
		toggle.checked = !!agent?.listed;
		fee.value = agent?.listed_fee ?? 0;
	} finally {
		toggle.disabled = false;
		fee.disabled = false;
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function tierBadge(p) {
	const tier = (p && p.tier) || 'common';
	return `<span class="gn-tier" data-tier="${tier}">${tier}</span>`;
}
function renderError(j) {
	$('gnOffspring').hidden = true;
	const map = {
		parent_ineligible: 'One of the parents can\'t be bred — it\'s private, or not listed as a stud.',
		not_found: 'One of the parents could not be found.',
		validation_error: j.error_description || 'Check your selection and retry.',
	};
	note(map[j.error] || j.error_description || 'Something went wrong — please retry.', 'error');
}
function note(msg, kind) {
	const host = $('gnNotes');
	if (!msg) { host.innerHTML = ''; return; }
	const div = document.createElement('div');
	div.className = 'gn-note';
	if (kind) div.dataset.kind = kind;
	div.innerHTML = msg;
	host.innerHTML = '';
	host.appendChild(div);
}
function clearNotes() { $('gnNotes').innerHTML = ''; }
function setBusy(busy, label) {
	state.busy = busy;
	$('gnBreed').textContent = busy && label ? label : 'Breed';
	refreshActions();
	$('gnPreview').disabled = busy || !(state.parents.a && state.parents.b);
}
function initials(name) { return String(name || '?').trim().slice(0, 2).toUpperCase(); }
function prefersReducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }
