/**
 * /start: onboarding wizard
 *
 * 5-step flow: avatar, name and brain, skills, deploy, earn.
 * State is persisted in sessionStorage so users can navigate away and back,
 * including the round trip to an avatar-producing page and the sign-in hop
 * before deploy. See src/shared/wizard-return.js for the avatar hand-back.
 */

import { formatUsdcEq } from './shared/usd-price.js';
import { TEMPLATES, TEMPLATES_BY_ID } from './templates.js';
import { log } from './shared/log.js';
import { apiFetch, noteSession } from './api.js';
import { saveRemoteGlbToAccount } from './account.js';

const STORAGE_KEY = 'wz:state';
const TOTAL_STEPS = 5;
const START_PATH = '/start';

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

// ── Brain models ──────────────────────────────────────────────────────────
// Every id here is a route the embed brain can actually serve (api/llm/anthropic.js
// MODELS) and an option the dashboard's embed-policy page offers, so the choice
// made here is the same setting the owner later sees under Dashboard.

const MODELS = {
	'claude-sonnet-4-6': { label: 'Claude Sonnet 4.6' },
	'openai/gpt-oss-20b:free': { label: 'GPT-OSS 20B' },
	'llama-3.3-70b-versatile': { label: 'Llama 3.3 70B' },
};
const DEFAULT_MODEL = 'claude-sonnet-4-6';

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

	// Returning from an avatar-producing page (src/shared/wizard-return.js).
	// URLSearchParams already decodes the values; decoding again would throw
	// on a name that legitimately contains a percent sign.
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
		model: DEFAULT_MODEL,
		enabledSkills: ['memory', 'think'],
		cryptoMode: false,
		price: '',
		wallet: '',
		deployed: false,
		modelApplied: null,
		embedCode: '',
		liveUrl: '',
	};
	if (base.cryptoMode === undefined) base.cryptoMode = false;
	// A session saved before the model list changed may hold an id no lane serves.
	if (!MODELS[base.model]) base.model = DEFAULT_MODEL;

	if (avatarId) {
		base.avatarId = avatarId;
		if (avatarName) base.avatarName = avatarName;
		if (avatarThumb) base.avatarThumb = avatarThumb;
		// Advance to step 2 if returning from avatar creation
		if (base.step === 1) base.step = 2;
	}
	for (const key of ['avatarId', 'avatarName', 'avatarThumb', 'from']) url.searchParams.delete(key);
	if (url.href !== location.href) history.replaceState(null, '', url.toString());

	return base;
}

// ── Session ───────────────────────────────────────────────────────────────
// null = not resolved yet, true/false once /api/auth/me answered. The deploy
// step reads this to offer sign-in instead of firing requests that can only 401.

let authed = null;

async function resolveAuth() {
	try {
		const r = await apiFetch('/api/auth/me', { allowAnonymous: true });
		if (r.status === 401) {
			authed = false;
		} else if (r.ok) {
			const j = await r.json();
			authed = Boolean(j && j.user);
		} else {
			throw new Error(`auth/me ${r.status}`);
		}
		noteSession(authed);
	} catch (err) {
		log.warn('[wizard] session probe failed; deploy will find out', err?.message || err);
		authed = null;
	}
	return authed;
}

function loginHref(target = '/login') {
	return `${target}?next=${encodeURIComponent(START_PATH)}`;
}

// ── Templates gallery ─────────────────────────────────────────────────────

const templatesScreen = document.getElementById('templates-screen');
const wizardEl = document.getElementById('wizard');
const startFreshBtn = document.getElementById('btn-start-fresh');

function showWizard({ fromTemplate = false } = {}) {
	// Show "← Templates" only when the gallery was bypassed (saved state or a
	// returning avatar). When a template card was clicked the gallery was just
	// on screen, so there is nothing to offer a way back to.
	if (startFreshBtn) startFreshBtn.style.display = fromTemplate ? 'none' : '';

	if (templatesScreen) {
		templatesScreen.classList.add('tpl-exit');
		setTimeout(() => {
			templatesScreen.classList.add('tpl-hidden');
			templatesScreen.classList.remove('tpl-exit');
			// Reveal the wizard only after the template screen is gone: both are
			// full-height, and body has overflow:hidden, so showing both at once
			// flashes black while the below-fold wizard is clipped.
			if (wizardEl) wizardEl.classList.remove('wz-offstage');
		}, 200);
	} else {
		if (wizardEl) wizardEl.classList.remove('wz-offstage');
	}
}

if (startFreshBtn) {
	startFreshBtn.addEventListener('click', () => {
		try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
		location.href = START_PATH;
	});
}

function applyTemplate(tpl) {
	state.description = tpl.bio;
	state.enabledSkills = [...tpl.skills];
	if (tpl.model && MODELS[tpl.model]) state.model = tpl.model;
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
	// applyTemplate() calls renderStep(), so return true and the caller skips its own call.
	if (tplParam && TEMPLATES_BY_ID[tplParam]) {
		applyTemplate(TEMPLATES_BY_ID[tplParam]);
		return true;
	}

	// An in-progress session, or an avatar that just came back from a creation
	// page, skips the gallery. "← Templates" stays available to reset.
	if (hasSavedState || state.avatarId) {
		showWizard({ fromTemplate: false });
		return false;
	}

	// Show the gallery; renderStep still runs so wizard state is primed behind the overlay.
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

// ── API helper ────────────────────────────────────────────────────────────
// apiFetch carries the CSRF token for mutations. allowAnonymous keeps a 401
// in our hands (the deploy step turns it into a sign-in panel) instead of
// letting the shared client bounce the tab to /login mid-wizard.

async function apiJson(method, url, body) {
	const r = await apiFetch(url, {
		method,
		allowAnonymous: true,
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	const j = await r.json().catch(() => ({}));
	if (!r.ok) {
		const err = new Error(j.error_description || j.error || `Server error ${r.status}`);
		err.status = r.status;
		throw err;
	}
	return j;
}

function isSignedOut(err) {
	return err?.status === 401 || err?.code === 'not_signed_in' || err?.redirected === true;
}

// ── Toast helper ──────────────────────────────────────────────────────────

const toast = document.getElementById('wz-toast');
let _toastTimer = null;

function showError(msg, action) {
	if (_toastTimer) clearTimeout(_toastTimer);
	toast.textContent = msg;
	if (action) {
		const a = document.createElement('a');
		a.className = 'wz-toast-action';
		a.href = action.href;
		a.textContent = action.label;
		toast.append(' ', a);
	}
	toast.classList.add('show');
	_toastTimer = setTimeout(() => toast.classList.remove('show'), action ? 8000 : 4000);
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
		const on = stepNum === state.step;
		s.classList.remove('active', 'exit-left');
		if (on) s.classList.add('active');
		else if (stepNum < state.step) s.classList.add('exit-left');
		// Off-screen steps slide out visually but stayed in the tab order and the
		// accessibility tree, so a keyboard user tabbed through five screens of
		// controls they could not see. inert removes them from both.
		s.inert = !on;
		s.setAttribute('aria-hidden', String(!on));
	});

	dots.forEach((d, i) => {
		const stepNum = i + 1;
		d.classList.remove('active', 'done');
		if (stepNum === state.step) d.classList.add('active');
		else if (stepNum < state.step) d.classList.add('done');
	});

	$('btn-back').hidden = state.step <= 1;

	const nextBtn = $('btn-next');
	nextBtn.disabled = false;
	if (state.step === 5) {
		nextBtn.textContent = hasCryptoSkills() ? 'Save & finish' : 'Go to dashboard';
		nextBtn.hidden = false;
	} else if (state.step === 4) {
		nextBtn.textContent = 'Continue';
		nextBtn.hidden = !state.deployed;
	} else {
		nextBtn.textContent = state.step === 3 ? 'Continue to deploy' : 'Continue';
		nextBtn.hidden = false;
	}

	// Skip button: show on step 1 always; on step 5 only when crypto skills selected (skip wallet setup)
	$('btn-skip-step').hidden = state.step !== 1 && !(state.step === 5 && hasCryptoSkills());

	// Step-specific renders
	if (state.step === 1) renderStep1();
	if (state.step === 2) { renderStep2(); updateCryptoUI(); }
	if (state.step === 3) { renderStep3(); updateCryptoUI(); }
	if (state.step === 4) renderStep4();
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

function setStep4Copy(headline, sub) {
	const h = $('step4-headline');
	const p = $('step4-sub');
	// The i18n pass lands after an async catalog fetch; marking the element as
	// script-owned stops it from reverting this state-specific copy.
	if (h) { h.textContent = headline; h.setAttribute('data-i18n-owned', '1'); }
	if (p) { p.textContent = sub; p.setAttribute('data-i18n-owned', '1'); }
}

function renderStep4() {
	if (state.deployed) {
		showDeploySuccess();
	} else if (authed === false) {
		showDeploySignIn();
	} else {
		startDeploy();
	}
}

function showDeploySignIn() {
	$('deploy-status').style.display = 'none';
	$('deploy-success').classList.remove('show');
	$('deploy-signin').hidden = false;
	$('btn-next').hidden = true;
	setStep4Copy('Publish your agent', 'One more thing before it goes live.');
	$('deploy-signin-login').href = loginHref('/login');
	$('deploy-signin-register').href = loginHref('/register');
}

let _deploying = false;

async function startDeploy() {
	if (_deploying) return;
	_deploying = true;
	const status = $('deploy-status');
	status.style.display = 'block';
	status.querySelectorAll('.wz-deploy-retry').forEach((b) => b.remove());
	const spinner = status.querySelector('.wz-deploy-spinner');
	if (spinner) spinner.style.display = '';
	const label = $('deploy-label');
	label.style.color = '';
	$('deploy-success').classList.remove('show');
	$('deploy-signin').hidden = true;
	$('btn-next').hidden = true;
	setStep4Copy('Publishing your agent', 'Creating the agent, applying its brain, and building the embed widget.');

	try {
		// Build skills list
		const skillSet = new Set(BASE_SKILLS);
		for (const key of state.enabledSkills) {
			(SKILL_MAP[key] || []).forEach((s) => skillSet.add(s));
		}

		// 1. Create agent (idempotent across retries: a created agent is kept)
		let agentId = state.agentId;
		if (!agentId) {
			label.textContent = 'Creating your agent…';
			const agentBody = {
				name: state.name || 'My Agent',
				description: state.description || null,
				skills: [...skillSet],
			};
			if (state.avatarId) agentBody.avatar_id = state.avatarId;

			const agentRes = await apiJson('POST', '/api/agents', agentBody);
			agentId = agentRes.agent?.id;
			if (!agentId) throw new Error('Agent creation failed: no ID returned.');
			state.agentId = agentId;
			saveState(state);
		}

		// 2. Apply the chosen brain. The embed policy is the per-agent model
		// setting every chat lane reads (talk, embed brain, delegate), and the
		// same field the dashboard's embed-policy page edits.
		label.textContent = `Setting the brain to ${MODELS[state.model].label}…`;
		try {
			await apiJson('PUT', `/api/agents/${agentId}/embed-policy`, { brain: { model: state.model } });
			state.modelApplied = true;
		} catch (err) {
			if (isSignedOut(err)) throw err;
			log.warn('[wizard/deploy] embed-policy update failed; agent keeps the platform default model', err);
			state.modelApplied = false;
		}

		// 3. Create widget
		if (!state.widgetId) {
			label.textContent = 'Building your embed widget…';
			const widgetBody = {
				type: 'talking-agent',
				name: `${state.name || 'My Agent'} chat`,
				config: { agent_id: agentId },
				is_public: true,
			};
			if (state.avatarId) widgetBody.avatar_id = state.avatarId;

			const widgetRes = await apiJson('POST', '/api/widgets', widgetBody);
			const widgetId = widgetRes.widget?.id;
			if (!widgetId) throw new Error('Widget creation failed: no ID returned.');
			state.widgetId = widgetId;
		}

		// 4. Build embed code (same snippet the dashboard's Widgets page hands out)
		const origin = location.origin;
		state.embedCode =
			`<script async src="${origin}/embed.js"\n` +
			`        data-widget="${state.widgetId}"\n` +
			`        data-reveal="interaction"\n` +
			`        data-poster="auto"><\/script>`;
		state.liveUrl = `${origin}/agents/${agentId}`;
		state.deployed = true;
		saveState(state);

		try {
			window.__twsGuide?.complete('brain', { silent: true });
			window.__twsGuide?.complete('embed', { silent: true });
		} catch {}

		showDeploySuccess();

	} catch (err) {
		log.error('[wizard/deploy]', err);
		saveState(state);
		if (isSignedOut(err)) {
			authed = false;
			noteSession(false);
			showDeploySignIn();
			return;
		}
		setStep4Copy('Publishing hit a snag', 'Nothing you entered was lost. Retry, or go back and adjust.');
		label.textContent = err.message || 'Deployment failed. Please try again.';
		label.style.color = '#f87171';
		if (spinner) spinner.style.display = 'none';
		const retryBtn = document.createElement('button');
		retryBtn.type = 'button';
		retryBtn.textContent = 'Try again';
		retryBtn.className = 'wz-btn wz-btn-ghost wz-deploy-retry';
		retryBtn.addEventListener('click', () => startDeploy());
		status.appendChild(retryBtn);
		retryBtn.focus();
	} finally {
		_deploying = false;
	}
}

function showDeploySuccess() {
	$('deploy-status').style.display = 'none';
	$('deploy-signin').hidden = true;
	const success = $('deploy-success');
	success.classList.add('show');
	setStep4Copy('Your agent is live', 'We created your agent and generated an embeddable widget.');

	$('deploy-agent-name').textContent = `${state.name || 'Your agent'} is live 🎉`;
	$('deploy-live-url').textContent = state.liveUrl;
	const liveLink = $('deploy-live-link');
	liveLink.href = state.liveUrl;

	const brain = $('deploy-brain');
	if (brain) {
		const label = MODELS[state.model]?.label || state.model;
		brain.textContent = state.modelApplied === false
			? `Brain: platform default. ${label} could not be applied; change it any time under Dashboard → Embed policy.`
			: `Brain: ${label}. Change it any time under Dashboard → Embed policy.`;
	}

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

// Returns a list of human-readable problems; empty when everything saved.
async function saveEarnSettings() {
	const price = parseFloat($('earn-price')?.value || '0') || 0;
	const wallet = ($('earn-wallet')?.value || '').trim();
	const problems = [];

	if (price > 0 && state.agentId) {
		const amountAtomics = Math.round(price * 1_000_000);
		try {
			await apiJson('POST', `/api/agents/${state.agentId}/skills/set-price`, {
				skill: 'chat',
				amount: amountAtomics,
				currency_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
				chain: 'solana',
				mint_decimals: 6,
			});
		} catch (err) {
			if (isSignedOut(err)) throw err;
			problems.push(`the price (${err.message})`);
		}
	}

	if (wallet) {
		const chain = detectChain(wallet) === 'ETH/BASE' ? 'base' : 'solana';
		try {
			await apiJson('POST', '/api/billing/payout-wallets', {
				chain,
				address: wallet,
				agent_id: state.agentId,
				is_default: true,
			});
		} catch (err) {
			if (isSignedOut(err)) throw err;
			problems.push(`the payout wallet (${err.message})`);
		}
	}

	return problems;
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

function finishWizard() {
	try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
	location.href = '/dashboard?welcome=1';
}

async function goNext() {
	if (!validateStep()) return;

	if (state.step === 5) {
		const nextBtn = $('btn-next');
		const originalLabel = nextBtn.textContent;
		nextBtn.disabled = true;
		nextBtn.textContent = 'Saving…';
		if (hasCryptoSkills()) {
			let problems;
			try {
				problems = await saveEarnSettings();
			} catch (err) {
				nextBtn.disabled = false;
				nextBtn.textContent = originalLabel;
				showError('Your session ended. Sign in to save these settings.', { href: loginHref('/login'), label: 'Sign in' });
				return;
			}
			if (problems.length) {
				nextBtn.disabled = false;
				nextBtn.textContent = originalLabel;
				showError(`We could not save ${problems.join(' and ')}. Fix it and try again, or skip this step.`);
				return;
			}
		}
		finishWizard();
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
		finishWizard();
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
// The creation pages capture ?next= (src/shared/wizard-return.js) and bring
// the finished avatar back here as ?avatarId=&avatarName=&avatarThumb=.

function leaveForAvatar(path, from) {
	saveState(state);
	const returnUrl = encodeURIComponent(`${START_PATH}?from=${from}`);
	location.href = `${path}?wizard=1&next=${returnUrl}`;
}

$('btn-selfie').addEventListener('click', () => leaveForAvatar('/create/selfie', 'selfie'));
$('btn-editor').addEventListener('click', () => leaveForAvatar('/create', 'editor'));

$('btn-upload').addEventListener('click', () => {
	$('glb-file-input').click();
});

$('glb-file-input').addEventListener('change', async (e) => {
	const file = e.target.files?.[0];
	if (!file) return;
	if (file.size > 50 * 1024 * 1024) {
		showError('File too large: the maximum is 50 MB.');
		e.target.value = '';
		return;
	}
	if (!/\.(glb|gltf)$/i.test(file.name)) {
		showError('Choose a .glb or .gltf file.');
		e.target.value = '';
		return;
	}

	const btn = $('btn-upload');
	const labelEl = btn.querySelector('.wz-avatar-card-label');
	const origLabel = labelEl.textContent;
	labelEl.textContent = 'Uploading… 0%';
	btn.disabled = true;

	try {
		const name = file.name.replace(/\.(glb|gltf)$/i, '') || 'My Avatar';
		// Presign, upload to storage, then register the record: the same path
		// every other upload surface uses. /api/avatars itself only accepts
		// the registration step, never a multipart body.
		const avatar = await saveRemoteGlbToAccount(
			file,
			{
				name,
				source: 'direct-upload',
				visibility: 'private',
				source_meta: { generator: 'start-wizard' },
			},
			{
				onProgress: (pct) => { labelEl.textContent = `Uploading… ${Math.round(pct)}%`; },
			},
		);

		state.avatarId = avatar.id;
		state.avatarName = avatar.name || name;
		state.avatarThumb = avatar.thumbnail_url || '';
		saveState(state);
		renderStep1();
		try { window.__twsGuide?.complete('create', { silent: true }); } catch {}

	} catch (err) {
		log.error('[wizard/upload]', err);
		if (isSignedOut(err)) {
			showError('Sign in to upload your own model.', { href: loginHref('/login'), label: 'Sign in' });
		} else {
			showError(err.message || 'Upload failed. Please try again.');
		}
	} finally {
		labelEl.textContent = origLabel;
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
		if (!MODELS[btn.dataset.model]) return;
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
// USDC is pegged 1:1 to USD, so the "≈ $0.001 per call" hint tells users exactly what
// they are charging in dollars.

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

// ── Helper-widget clearance ───────────────────────────────────────────────
// The shared corner stack (public/corner-stack.js) lifts itself above the
// sticky footer, but on a phone its pills still float over the bottom of the
// scrolling step. Mirror its live height into a CSS variable the steps use
// as extra bottom padding, so the last control can always scroll clear.

function trackHelperClearance() {
	const root = document.documentElement;
	let observed = null;
	const apply = () => {
		const stack = document.getElementById('tws-corner-stack');
		const h = stack ? stack.getBoundingClientRect().height : 0;
		root.style.setProperty('--wz-helper-clearance', h > 0 ? `${Math.round(h) + 12}px` : '0px');
	};
	const watch = () => {
		const stack = document.getElementById('tws-corner-stack');
		if (!stack || stack === observed) return;
		observed = stack;
		if ('ResizeObserver' in window) new ResizeObserver(apply).observe(stack);
		apply();
	};
	watch();
	// The stack mounts lazily, after the deferred helper scripts run.
	if ('MutationObserver' in window) {
		new MutationObserver(watch).observe(document.body, { childList: true });
	}
	window.addEventListener('tws-corner-stack:ready', watch);
	window.addEventListener('resize', apply);
}

trackHelperClearance();

// ── Initial render ─────────────────────────────────────────────────────────

// Resolve the session first so a signed-out visitor who lands on step 4 (a
// saved session, or the sign-in round trip) sees the sign-in panel instead of
// a request that can only fail. The probe is one fast GET; when it errors the
// deploy step still discovers a 401 on its own.
resolveAuth().finally(() => {
	// initTemplateGallery may call renderStep() itself (template apply or ?template= param).
	const galleryRendered = initTemplateGallery();
	if (!galleryRendered) renderStep();
});
