/**
 * /start — Onboarding wizard
 *
 * 5-step flow: avatar → name/brain → skills → deploy → earn
 * State is persisted in sessionStorage so users can navigate away and back.
 */

import { formatUsdcEq } from './shared/usd-price.js';
import { TEMPLATES, TEMPLATES_BY_ID } from './templates.js';
import { log } from './shared/log.js';

const STORAGE_KEY = 'wz:state';
const TOTAL_STEPS = 5;

// ── Personality presets ────────────────────────────────────────────────────

const PRESETS = {
	researcher: {
		bio: 'A sharp web researcher who digs into any topic, synthesizes sources, and delivers clear, well-organized insights on demand.',
	},
	support: {
		bio: 'A calm, helpful customer support agent who answers questions thoroughly, resolves issues efficiently, and keeps users feeling heard.',
	},
	podcast: {
		bio: 'A conversational podcast host with a knack for storytelling. Brainstorms episode ideas, drafts interview questions, and writes engaging show notes.',
	},
	artist: {
		bio: 'A creative collaborator with a bold visual aesthetic. Helps brainstorm concepts, generate ideas, and develop artistic projects across any medium.',
	},
	assistant: {
		bio: 'A helpful, honest assistant. Clear and concise answers. No filler. Gets things done.',
	},
	crypto: {
		bio: 'A crypto-savvy assistant that monitors Solana token launches, tracks whale movements on pump.fun, and helps users make informed trading decisions in real time.',
	},
	community: {
		bio: 'An engaging community manager who greets members, answers questions, moderates discussions, and keeps the community thriving 24/7.',
	},
	defi: {
		bio: 'A DeFi expert fluent in liquidity pools, yield strategies, blockchain analytics, and protocol mechanics across Solana and EVM networks.',
	},
};

// ── Skill → backend skills mapping ───────────────────────────────────────

const BASE_SKILLS = ['greet', 'present-model', 'validate-model', 'remember', 'think'];

const SKILL_MAP = {
	memory:  ['remember'],
	think:   ['think'],
	pumpfun: ['pump-fun-monitor', 'pump-fun-trade'],
	solana:  ['solana-balance', 'solana-swap'],
	x402:    ['x402-accept', 'x402-pay'],
	web:     ['web-search'],
};

const CRYPTO_SKILLS = new Set(['pumpfun', 'solana', 'x402']);

// ── State ─────────────────────────────────────────────────────────────────

function loadState() {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (raw) return JSON.parse(raw);
	} catch {}
	return null;
}

function saveState(s) {
	try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

function initState() {
	const url = new URL(location.href);
	const saved = loadState();

	// Check if returning from avatar creation
	const avatarId = url.searchParams.get('avatarId');
	const avatarName = url.searchParams.get('avatarName');
	const avatarThumb = url.searchParams.get('avatarThumb');

	const base = saved || {
		step: 1,
		avatarId: null,
		avatarName: '',
		avatarThumb: '',
		agentId: null,
		widgetId: null,
		name: '',
		description: '',
		model: 'claude-sonnet-4-5',
		enabledSkills: ['memory', 'think'],
		cryptoMode: false,
		price: '',
		wallet: '',
		deployed: false,
		embedCode: '',
		liveUrl: '',
	};
	if (base.cryptoMode === undefined) base.cryptoMode = false;

	if (avatarId) {
		base.avatarId = avatarId;
		if (avatarName) base.avatarName = decodeURIComponent(avatarName);
		if (avatarThumb) base.avatarThumb = decodeURIComponent(avatarThumb);
		// Advance to step 2 if returning from avatar creation
		if (base.step === 1) base.step = 2;
		// Remove avatar params from URL cleanly
		url.searchParams.delete('avatarId');
		url.searchParams.delete('avatarName');
		url.searchParams.delete('avatarThumb');
		history.replaceState(null, '', url.toString());
	}

	return base;
}

// ── Templates gallery ─────────────────────────────────────────────────────

const templatesScreen = document.getElementById('templates-screen');
const wizardEl = document.getElementById('wizard');
const startFreshBtn = document.getElementById('btn-start-fresh');

function showWizard({ fromTemplate = false } = {}) {
	// Show "← Templates" button only when the gallery was bypassed (stale state).
	// When triggered by a template card click, the gallery is already visible so
	// no need to offer a way back.
	if (startFreshBtn) startFreshBtn.style.display = fromTemplate ? 'none' : '';

	if (templatesScreen) {
		templatesScreen.classList.add('tpl-exit');
		setTimeout(() => {
			templatesScreen.classList.add('tpl-hidden');
			templatesScreen.classList.remove('tpl-exit');
			// Reveal wizard only after template screen is gone — avoids a black
			// flash caused by both full-height elements being in the DOM at once
			// with overflow:hidden on body hiding the below-fold wizard.
			if (wizardEl) wizardEl.classList.remove('wz-offstage');
		}, 200);
	} else {
		if (wizardEl) wizardEl.classList.remove('wz-offstage');
	}
}

if (startFreshBtn) {
	startFreshBtn.addEventListener('click', () => {
		try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
		location.reload();
	});
}

function applyTemplate(tpl) {
	state.description = tpl.bio;
	state.enabledSkills = [...tpl.skills];
	if (tpl.model) state.model = tpl.model;
	state.cryptoMode = Boolean(tpl.cryptoMode);
	// Jump to step 2 (Name & Brain) so the user immediately sees the prefilled persona
	state.step = 2;
	saveState(state);
	showWizard({ fromTemplate: true });
	renderStep();
}

function renderTemplateCard(tpl) {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'tpl-card';
	btn.setAttribute('role', 'listitem');
	btn.setAttribute('aria-label', `Use template: ${tpl.name}`);
	btn.dataset.templateId = tpl.id;

	btn.innerHTML = `
		<span class="tpl-card-icon" aria-hidden="true">${tpl.icon}</span>
		<div class="tpl-card-name">${tpl.name}</div>
		<div class="tpl-card-tagline">${tpl.tagline}</div>
		<div class="tpl-card-cta" aria-hidden="true">Use template <span>→</span></div>
		${tpl.cryptoMode ? '<span class="tpl-card-badge">Crypto</span>' : ''}
	`;

	btn.addEventListener('click', () => applyTemplate(tpl));
	return btn;
}

function initTemplateGallery() {
	if (!templatesScreen) return false;

	const url = new URL(location.href);
	const tplParam = url.searchParams.get('template');
	const hasSavedState = Boolean(loadState());

	// If a specific template is requested via ?template=id, apply it immediately.
	// applyTemplate() calls renderStep() — return true so caller skips its own call.
	if (tplParam && TEMPLATES_BY_ID[tplParam]) {
		applyTemplate(TEMPLATES_BY_ID[tplParam]);
		return true;
	}

	// If there's an in-progress wizard session, skip the gallery and let caller renderStep.
	// Show "← Templates" so the user can always reset back to the template gallery.
	if (hasSavedState) {
		showWizard({ fromTemplate: false });
		return false;
	}

	// Show the gallery — renderStep still runs so wizard state is primed behind the overlay.
	templatesScreen.classList.remove('tpl-hidden');

	const grid = document.getElementById('tpl-grid');
	if (grid) {
		TEMPLATES.forEach((tpl) => grid.appendChild(renderTemplateCard(tpl)));
	}

	const blankBtn = document.getElementById('btn-blank-start');
	if (blankBtn) {
		// Gallery is visible; "Start from scratch" comes from within it, so no back-button needed.
		blankBtn.addEventListener('click', () => showWizard({ fromTemplate: true }));
	}

	return false;
}

// ── CSRF helper ───────────────────────────────────────────────────────────

let _csrf = null;

async function getCsrfToken() {
	if (_csrf && _csrf.expiresAt > Date.now() + 5_000) return _csrf.token;
	const r = await fetch('/api/csrf-token', { credentials: 'include' });
	if (!r.ok) throw new Error('Could not get CSRF token. Please sign in again.');
	const j = await r.json();
	_csrf = { token: j.data.token, expiresAt: Date.now() + (j.data.expires_in - 30) * 1000 };
	return _csrf.token;
}

async function apiPost(url, body) {
	const token = await getCsrfToken();
	_csrf = null;
	const r = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
		credentials: 'include',
		body: JSON.stringify(body),
	});
	const j = await r.json();
	if (!r.ok) throw new Error(j.error_description || j.error || `Server error ${r.status}`);
	return j;
}

// ── Toast helper ──────────────────────────────────────────────────────────

const toast = document.getElementById('wz-toast');
let _toastTimer = null;

function showError(msg) {
	if (_toastTimer) clearTimeout(_toastTimer);
	toast.textContent = msg;
	toast.classList.add('show');
	_toastTimer = setTimeout(() => toast.classList.remove('show'), 4000);
}

// ── DOM helpers ───────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const steps = Array.from(document.querySelectorAll('.wz-step'));
const dots = Array.from(document.querySelectorAll('.wz-dot'));

// ── State instance ────────────────────────────────────────────────────────

let state = initState();

// ── Crypto mode helpers ───────────────────────────────────────────────────

function hasCryptoSkills() {
	return state.enabledSkills.some(s => CRYPTO_SKILLS.has(s));
}

function updateCryptoUI() {
	const on = state.cryptoMode;

	const toggleBtn = $('crypto-toggle');
	if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(on));

	const personalitySection = $('crypto-personality-section');
	if (personalitySection) personalitySection.hidden = !on;

	const skillsSection = $('crypto-skills-section');
	if (skillsSection) skillsSection.hidden = !on;

	const revealBtn = $('crypto-skills-reveal');
	if (revealBtn) revealBtn.hidden = on;
}

function setCryptoMode(on) {
	state.cryptoMode = on;
	if (!on) {
		state.enabledSkills = state.enabledSkills.filter(s => !CRYPTO_SKILLS.has(s));
		document.querySelectorAll('[data-skill]').forEach((card) => {
			if (CRYPTO_SKILLS.has(card.dataset.skill)) {
				card.classList.remove('active');
				card.setAttribute('aria-pressed', 'false');
				const check = card.querySelector('.wz-skill-check');
				if (check) check.textContent = '';
			}
		});
	}
	updateCryptoUI();
	if (state.step === 5) renderStep5();
	saveState(state);
}

// ── Render current step ───────────────────────────────────────────────────

function renderStep() {
	steps.forEach((s, i) => {
		const stepNum = i + 1;
		s.classList.remove('active', 'exit-left');
		if (stepNum === state.step) s.classList.add('active');
		else if (stepNum < state.step) s.classList.add('exit-left');
	});

	dots.forEach((d, i) => {
		const stepNum = i + 1;
		d.classList.remove('active', 'done');
		if (stepNum === state.step) d.classList.add('active');
		else if (stepNum < state.step) d.classList.add('done');
	});

	$('btn-back').hidden = state.step <= 1;
	$('btn-next').hidden = state.step === 4 && !state.deployed;

	const nextBtn = $('btn-next');
	if (state.step === 5) {
		nextBtn.textContent = hasCryptoSkills() ? 'Save & finish' : 'Go to dashboard';
	} else if (state.step === 4) {
		nextBtn.textContent = 'Continue';
		nextBtn.hidden = !state.deployed;
	} else {
		nextBtn.textContent = state.step === 3 ? 'Continue to deploy' : 'Continue';
	}

	// Skip button: show on step 1 always; on step 5 only when crypto skills selected (skip wallet setup)
	$('btn-skip-step').hidden = state.step !== 1 && !(state.step === 5 && hasCryptoSkills());

	// Step-specific renders
	if (state.step === 1) renderStep1();
	if (state.step === 2) { renderStep2(); updateCryptoUI(); }
	if (state.step === 3) { renderStep3(); updateCryptoUI(); }
	if (state.step === 4 && !state.deployed) startDeploy();
	if (state.step === 4 && state.deployed) showDeploySuccess();
	if (state.step === 5) renderStep5();

	// Announce progress to screen readers
	const aria = $('wz-progress');
	if (aria) {
		aria.setAttribute('aria-valuenow', state.step);
		aria.setAttribute('aria-valuetext', `Step ${state.step} of ${TOTAL_STEPS}`);
	}

	saveState(state);
}

// ── Step 1 ─────────────────────────────────────────────────────────────────

function renderStep1() {
	const preview = $('avatar-preview');
	const grid = $('avatar-method-grid');

	if (state.avatarId) {
		preview.hidden = false;
		grid.style.display = 'none';
		const thumb = $('ap-thumb');
		const nameEl = $('ap-name');
		if (state.avatarThumb) {
			thumb.style.backgroundImage = `url('${state.avatarThumb}')`;
			thumb.textContent = '';
		} else {
			thumb.textContent = '🤖';
		}
		nameEl.textContent = state.avatarName || 'Avatar ready';
	} else {
		preview.hidden = true;
		grid.style.display = '';
	}
}

// ── Step 2 ─────────────────────────────────────────────────────────────────

function renderStep2() {
	const nameEl = $('agent-name');
	const bioEl = $('agent-bio');
	if (nameEl && state.name) nameEl.value = state.name;
	if (bioEl && state.description) bioEl.value = state.description;

	document.querySelectorAll('[data-model]').forEach((btn) => {
		const on = btn.dataset.model === state.model;
		btn.classList.toggle('active', on);
		btn.setAttribute('aria-pressed', String(on));
	});

	document.querySelectorAll('[data-preset]').forEach((btn) => {
		const preset = PRESETS[btn.dataset.preset];
		const on = Boolean(preset && preset.bio === state.description);
		btn.classList.toggle('active', on);
		btn.setAttribute('aria-pressed', String(on));
	});
}

// ── Step 3 ─────────────────────────────────────────────────────────────────

function renderStep3() {
	document.querySelectorAll('[data-skill]').forEach((card) => {
		const enabled = state.enabledSkills.includes(card.dataset.skill);
		card.classList.toggle('active', enabled);
		card.setAttribute('aria-pressed', String(enabled));
		const check = card.querySelector('.wz-skill-check');
		if (check) check.textContent = enabled ? '✓' : '';
	});
}

// ── Step 5: Conditional earn/skip ─────────────────────────────────────────

function renderStep5() {
	const hasCrypto = hasCryptoSkills();
	const skipPanel = $('step5-skip');
	const earnPanel = $('step5-earn');
	if (skipPanel) skipPanel.hidden = hasCrypto;
	if (earnPanel) earnPanel.hidden = !hasCrypto;

	const skipBtn = $('btn-skip-step');
	if (skipBtn) skipBtn.hidden = !hasCrypto;

	const nextBtn = $('btn-next');
	if (nextBtn) nextBtn.textContent = hasCrypto ? 'Save & finish' : 'Go to dashboard';
}

// ── Step 4: Deploy ─────────────────────────────────────────────────────────

async function startDeploy() {
	$('deploy-status').style.display = 'block';
	$('deploy-success').classList.remove('show');
	$('btn-next').hidden = true;

	try {
		// Build skills list
		const skillSet = new Set(BASE_SKILLS);
		for (const key of state.enabledSkills) {
			(SKILL_MAP[key] || []).forEach((s) => skillSet.add(s));
		}

		// 1. Create agent
		$('deploy-label').textContent = 'Creating your agent…';
		const agentBody = {
			name: state.name || 'My Agent',
			description: state.description || null,
			skills: [...skillSet],
		};
		if (state.avatarId) agentBody.avatar_id = state.avatarId;

		const agentRes = await apiPost('/api/agents', agentBody);
		const agentId = agentRes.agent?.id;
		if (!agentId) throw new Error('Agent creation failed — no ID returned.');
		state.agentId = agentId;
		saveState(state);

		// 2. Create widget
		$('deploy-label').textContent = 'Building your embed widget…';
		const widgetBody = {
			type: 'talking-agent',
			name: (state.name || 'My Agent') + ' — Chat',
			config: { agent_id: agentId },
			is_public: true,
		};
		if (state.avatarId) widgetBody.avatar_id = state.avatarId;

		const widgetRes = await apiPost('/api/widgets', widgetBody);
		const widgetId = widgetRes.widget?.id;
		if (!widgetId) throw new Error('Widget creation failed — no ID returned.');
		state.widgetId = widgetId;

		// 3. Build embed code
		const origin = location.origin;
		const embedCode = `<script src="${origin}/widget.js" data-widget="${widgetId}" async><\/script>`;
		const liveUrl = `${origin}/agents/${agentId}`;

		state.liveUrl = liveUrl;
		state.embedCode = embedCode;
		state.deployed = true;
		saveState(state);

		showDeploySuccess();

	} catch (err) {
		log.error('[wizard/deploy]', err);
		$('deploy-label').textContent = err.message || 'Deployment failed. Please try again.';
		$('deploy-label').style.color = '#f87171';
		const spinner = document.querySelector('.wz-deploy-spinner');
		if (spinner) spinner.style.display = 'none';
		// Show a retry button
		const retryBtn = document.createElement('button');
		retryBtn.type = 'button';
		retryBtn.textContent = 'Try again';
		retryBtn.className = 'wz-btn wz-btn-ghost';
		retryBtn.style.margin = '16px auto 0';
		retryBtn.style.display = 'block';
		retryBtn.onclick = () => {
			retryBtn.remove();
			$('deploy-label').style.color = '';
			if (spinner) spinner.style.display = '';
			startDeploy();
		};
		$('deploy-status').appendChild(retryBtn);
	}
}

function showDeploySuccess() {
	$('deploy-status').style.display = 'none';
	const success = $('deploy-success');
	success.classList.add('show');

	$('deploy-agent-name').textContent = `${state.name || 'Your agent'} is live 🎉`;
	$('deploy-live-url').textContent = state.liveUrl;
	const liveLink = $('deploy-live-link');
	liveLink.href = state.liveUrl;

	const codeEl = $('embed-code');
	if (codeEl) codeEl.textContent = state.embedCode;

	$('btn-next').hidden = false;
}

// ── Step 5: Earn ───────────────────────────────────────────────────────────

function detectChain(addr) {
	if (!addr) return 'SOL';
	if (/^0x[0-9a-fA-F]{40}$/.test(addr)) return 'ETH/BASE';
	return 'SOL';
}

async function saveEarnSettings() {
	const price = parseFloat($('earn-price')?.value || '0') || 0;
	const wallet = ($('earn-wallet')?.value || '').trim();

	const promises = [];

	if (price > 0 && state.agentId) {
		const amountAtomics = Math.round(price * 1_000_000);
		promises.push(
			apiPost(`/api/agents/${state.agentId}/skills/set-price`, {
				skill: 'chat',
				amount: amountAtomics,
				currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
				chain: 'solana',
				mint_decimals: 6,
			}).catch(() => {}),
		);
	}

	if (wallet) {
		const chain = detectChain(wallet).toLowerCase().includes('eth') ? 'base' : 'solana';
		promises.push(
			apiPost('/api/billing/payout-wallets', {
				chain,
				address: wallet,
				label: 'Wizard setup',
			}).catch(() => {}),
		);
	}

	await Promise.allSettled(promises);
}

// ── Navigation logic ───────────────────────────────────────────────────────

function validateStep() {
	if (state.step === 2) {
		const name = ($('agent-name')?.value || '').trim();
		if (!name) {
			showError('Please give your agent a name.');
			$('agent-name')?.focus();
			return false;
		}
		state.name = name;
		state.description = ($('agent-bio')?.value || '').trim();
	}
	return true;
}

async function goNext() {
	if (!validateStep()) return;

	if (state.step === 5) {
		$('btn-next').disabled = true;
		$('btn-next').textContent = 'Saving…';
		if (hasCryptoSkills()) {
			await saveEarnSettings().catch(() => {});
		}
		sessionStorage.removeItem(STORAGE_KEY);
		location.href = '/dashboard?welcome=1';
		return;
	}

	state.step = Math.min(state.step + 1, TOTAL_STEPS);
	saveState(state);
	renderStep();
}

function goBack() {
	state.step = Math.max(state.step - 1, 1);
	saveState(state);
	renderStep();
}

function skipStep() {
	if (state.step === 1) {
		// Skip avatar, go to name
		state.step = 2;
		saveState(state);
		renderStep();
	} else if (state.step === 5) {
		// Skip earning setup, go to dashboard
		sessionStorage.removeItem(STORAGE_KEY);
		location.href = '/dashboard?welcome=1';
	}
}

// ── Event bindings ─────────────────────────────────────────────────────────

$('btn-next').addEventListener('click', goNext);
$('btn-back').addEventListener('click', goBack);
$('btn-skip-step').addEventListener('click', skipStep);

// Keyboard navigation
document.addEventListener('keydown', (e) => {
	if (e.key === 'Enter' && e.target === $('agent-name')) {
		e.preventDefault();
		goNext();
	}
});

// ── Step 1: Avatar method selection ───────────────────────────────────────

$('btn-selfie').addEventListener('click', () => {
	saveState(state);
	// Navigate to selfie flow, expect return with ?avatarId=
	const returnUrl = encodeURIComponent(location.origin + '/start?from=selfie');
	location.href = `/create/selfie?wizard=1&next=${returnUrl}`;
});

$('btn-editor').addEventListener('click', () => {
	saveState(state);
	const returnUrl = encodeURIComponent(location.origin + '/start?from=editor');
	location.href = `/create?wizard=1&next=${returnUrl}`;
});

$('btn-upload').addEventListener('click', () => {
	$('glb-file-input').click();
});

$('glb-file-input').addEventListener('change', async (e) => {
	const file = e.target.files?.[0];
	if (!file) return;
	if (file.size > 50 * 1024 * 1024) {
		showError('File too large — maximum 50 MB.');
		return;
	}

	const btn = $('btn-upload');
	const origLabel = btn.querySelector('.wz-avatar-card-label').textContent;
	btn.querySelector('.wz-avatar-card-label').textContent = 'Uploading…';
	btn.disabled = true;

	try {
		// Get CSRF token first
		const token = await getCsrfToken();
		_csrf = null;

		const fd = new FormData();
		fd.append('file', file);
		fd.append('name', file.name.replace(/\.(glb|gltf)$/i, '') || 'My Avatar');
		fd.append('visibility', 'private');

		const r = await fetch('/api/avatars', {
			method: 'POST',
			headers: { 'X-CSRF-Token': token },
			credentials: 'include',
			body: fd,
		});
		const j = await r.json();
		if (!r.ok) throw new Error(j.error_description || j.error || `Upload failed ${r.status}`);

		const av = j.avatar || j;
		state.avatarId = av.id;
		state.avatarName = av.name || file.name;
		state.avatarThumb = av.thumbnail_url || '';
		saveState(state);
		renderStep1();

	} catch (err) {
		log.error('[wizard/upload]', err);
		showError(err.message || 'Upload failed. Please try again.');
	} finally {
		btn.querySelector('.wz-avatar-card-label').textContent = origLabel;
		btn.disabled = false;
		e.target.value = '';
	}
});

// ── Step 2: Brain controls ─────────────────────────────────────────────────

$('agent-name').addEventListener('input', () => {
	state.name = $('agent-name').value;
	saveState(state);
});

$('agent-bio').addEventListener('input', () => {
	state.description = $('agent-bio').value;
	document.querySelectorAll('[data-preset]').forEach((btn) => {
		btn.classList.remove('active');
		btn.setAttribute('aria-pressed', 'false');
	});
	saveState(state);
});

document.querySelectorAll('[data-preset]').forEach((btn) => {
	btn.addEventListener('click', () => {
		const preset = PRESETS[btn.dataset.preset];
		if (!preset) return;
		$('agent-bio').value = preset.bio;
		state.description = preset.bio;
		document.querySelectorAll('[data-preset]').forEach((b) => {
			b.classList.remove('active');
			b.setAttribute('aria-pressed', 'false');
		});
		btn.classList.add('active');
		btn.setAttribute('aria-pressed', 'true');
		saveState(state);
	});
});

document.querySelectorAll('[data-model]').forEach((btn) => {
	btn.addEventListener('click', () => {
		document.querySelectorAll('[data-model]').forEach((b) => {
			b.classList.remove('active');
			b.setAttribute('aria-pressed', 'false');
		});
		btn.classList.add('active');
		btn.setAttribute('aria-pressed', 'true');
		state.model = btn.dataset.model;
		saveState(state);
	});
});

// ── Step 3: Skill toggles ──────────────────────────────────────────────────

document.querySelectorAll('[data-skill]').forEach((card) => {
	card.addEventListener('click', () => {
		const skill = card.dataset.skill;
		const idx = state.enabledSkills.indexOf(skill);
		if (idx === -1) {
			state.enabledSkills.push(skill);
		} else {
			state.enabledSkills.splice(idx, 1);
		}
		const enabled = state.enabledSkills.includes(skill);
		card.classList.toggle('active', enabled);
		card.setAttribute('aria-pressed', String(enabled));
		const check = card.querySelector('.wz-skill-check');
		if (check) check.textContent = enabled ? '✓' : '';
		saveState(state);
	});
});

// ── Step 4: Copy embed code ────────────────────────────────────────────────

$('copy-embed').addEventListener('click', () => {
	const code = state.embedCode;
	if (!code) return;
	navigator.clipboard.writeText(code).then(() => {
		const btn = $('copy-embed');
		btn.textContent = 'Copied!';
		setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
	}).catch(() => {
		// fallback: select the text
		const range = document.createRange();
		range.selectNode($('embed-code'));
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);
	});
});

// ── Crypto toggle event bindings ──────────────────────────────────────────

const cryptoToggleBtn = $('crypto-toggle');
if (cryptoToggleBtn) {
	cryptoToggleBtn.addEventListener('click', () => setCryptoMode(!state.cryptoMode));
}

const cryptoSkillsRevealBtn = $('crypto-skills-reveal');
if (cryptoSkillsRevealBtn) {
	cryptoSkillsRevealBtn.addEventListener('click', () => setCryptoMode(true));
}

const cryptoSkillsHideBtn = $('crypto-skills-hide');
if (cryptoSkillsHideBtn) {
	cryptoSkillsHideBtn.addEventListener('click', () => setCryptoMode(false));
}

// ── Step 5: Wallet chain detection ────────────────────────────────────────

$('earn-wallet').addEventListener('input', () => {
	const addr = $('earn-wallet').value.trim();
	$('earn-chain').textContent = detectChain(addr);
});

// ── Step 5: Earn price USD equivalent ────────────────────────────────────
// USDC is pegged 1:1 to USD — show "≈ $X.XXX per call" so users know
// exactly what they're charging in dollars.

function updateEarnPriceHint() {
	const hint = $('earn-price-usd-hint');
	if (!hint) return;
	const raw = parseFloat($('earn-price')?.value);
	if (!raw || raw <= 0) { hint.textContent = ''; return; }
	const eq = formatUsdcEq(raw);
	hint.textContent = eq ? `${eq} per call` : '';
}

$('earn-price').addEventListener('input', updateEarnPriceHint);
updateEarnPriceHint();

// ── Initial render ─────────────────────────────────────────────────────────

// initTemplateGallery may call renderStep() itself (template apply or ?template= param).
// Only call renderStep() here if the gallery didn't already do it.
const _galleryRendered = initTemplateGallery();
if (!_galleryRendered) renderStep();
