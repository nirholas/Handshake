/**
 * /start — Onboarding wizard
 *
 * 5-step flow: avatar → name/brain → skills → deploy → earn
 * State is persisted in sessionStorage so users can navigate away and back.
 */

const STORAGE_KEY = 'wz:state';
const TOTAL_STEPS = 5;

// ── Personality presets ────────────────────────────────────────────────────

const PRESETS = {
	crypto: {
		bio: 'A crypto-savvy assistant that monitors Solana token launches, tracks whale movements on pump.fun, and helps users make informed trading decisions in real time.',
	},
	artist: {
		bio: 'A creative collaborator with a bold visual aesthetic. Helps brainstorm concepts, generate ideas, and develop artistic projects across any medium.',
	},
	community: {
		bio: 'An engaging community manager who greets members, answers questions, moderates discussions, and keeps the community thriving 24/7.',
	},
	defi: {
		bio: 'A DeFi expert fluent in liquidity pools, yield strategies, on-chain analytics, and protocol mechanics across Solana and EVM chains.',
	},
	assistant: {
		bio: 'A helpful, honest assistant. Clear and concise answers. No filler. Gets things done.',
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
		price: '',
		wallet: '',
		deployed: false,
		embedCode: '',
		liveUrl: '',
	};

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
	$('btn-skip-step').hidden = state.step !== 1 && state.step !== 5;
	$('btn-next').hidden = state.step === 4 && !state.deployed;

	const nextBtn = $('btn-next');
	if (state.step === 5) {
		nextBtn.textContent = 'Go to dashboard';
	} else if (state.step === 4) {
		nextBtn.textContent = 'Continue';
		nextBtn.hidden = !state.deployed;
	} else {
		nextBtn.textContent = state.step === 3 ? 'Continue to deploy' : 'Continue';
	}

	// Step-specific renders
	if (state.step === 1) renderStep1();
	if (state.step === 2) renderStep2();
	if (state.step === 3) renderStep3();
	if (state.step === 4 && !state.deployed) startDeploy();
	if (state.step === 4 && state.deployed) showDeploySuccess();

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
		btn.classList.toggle('active', btn.dataset.model === state.model);
	});

	document.querySelectorAll('[data-preset]').forEach((btn) => {
		const preset = PRESETS[btn.dataset.preset];
		btn.classList.toggle('active', preset && preset.bio === state.description);
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
		const liveUrl = `${origin}/agent/${agentId}`;

		state.liveUrl = liveUrl;
		state.embedCode = embedCode;
		state.deployed = true;
		saveState(state);

		// Small pause so the "Building…" label is visible
		await new Promise((r) => setTimeout(r, 400));

		showDeploySuccess();

	} catch (err) {
		console.error('[wizard/deploy]', err);
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
		// Save earn settings and go to dashboard
		$('btn-next').disabled = true;
		$('btn-next').textContent = 'Saving…';
		await saveEarnSettings().catch(() => {});
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
		console.error('[wizard/upload]', err);
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
	// Deselect preset chips if manually edited
	document.querySelectorAll('[data-preset]').forEach((btn) => btn.classList.remove('active'));
	saveState(state);
});

document.querySelectorAll('[data-preset]').forEach((btn) => {
	btn.addEventListener('click', () => {
		const preset = PRESETS[btn.dataset.preset];
		if (!preset) return;
		$('agent-bio').value = preset.bio;
		state.description = preset.bio;
		document.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('active'));
		btn.classList.add('active');
		saveState(state);
	});
});

document.querySelectorAll('[data-model]').forEach((btn) => {
	btn.addEventListener('click', () => {
		document.querySelectorAll('[data-model]').forEach((b) => b.classList.remove('active'));
		btn.classList.add('active');
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

// ── Step 5: Wallet chain detection ────────────────────────────────────────

$('earn-wallet').addEventListener('input', () => {
	const addr = $('earn-wallet').value.trim();
	$('earn-chain').textContent = detectChain(addr);
});

// ── Initial render ─────────────────────────────────────────────────────────

renderStep();
