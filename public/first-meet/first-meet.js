// First meet onboarding flow for newly created avatars

// apiFetch, not raw fetch, for mutations: cookie sessions need the single-use
// CSRF token it attaches. Loaded as a module script, so /src/api.js resolves.
import { apiFetch } from '/src/api.js';

const STEPS = ['name', 'bio', 'voice', 'greet', 'done'];
let currentStep = 0;
let state = {
	avatarId: null,
	avatar: null,
	agent: null,
	name: 'My Agent',
	bio: '',
	voice: 'en-US-female',
	bodyType: 'neutral',
};

// ── Init ───────────────────────────────────────────────────────────────────

async function boot() {
	const avatarId = new URL(window.location).searchParams.get('avatar');
	if (!avatarId) {
		window.location.href = '/login';
		return;
	}

	// Auth check
	const authRes = await fetch('/api/auth/me', { credentials: 'include' });
	const authUser = authRes.ok ? (await authRes.json()).user : null;
	if (!authUser) {
		window.location.href =
			'/login?next=' + encodeURIComponent(window.location.pathname + window.location.search);
		return;
	}

	state.avatarId = avatarId;

	// Load avatar
	try {
		const res = await fetch(`/api/avatars/${avatarId}`, { credentials: 'include' });
		if (!res.ok) throw new Error('Avatar not found');
		const data = await res.json();
		state.avatar = data.avatar;
		renderPreview();
	} catch (err) {
		showPreviewError('Failed to load avatar: ' + err.message);
		return;
	}

	// Load existing agent if any
	try {
		const res = await fetch('/api/agents/me', { credentials: 'include' });
		if (res.ok) {
			const data = await res.json();
			if (data.agent) {
				state.agent = data.agent;
				if (data.agent.name) state.name = data.agent.name;
				if (data.agent.description) state.bio = data.agent.description;
			}
		}
	} catch {
		// Ignore agent load errors, proceed
	}

	wireStepButtons();
	updateProgress();
	goToStep(0);
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderPreview() {
	const container = document.getElementById('preview-content');
	if (!state.avatar || !state.avatar.model_url) {
		container.innerHTML = '<div class="error-msg">Avatar URL not available</div>';
		return;
	}

	const viewer = document.createElement('agent-3d');
	viewer.setAttribute('body', state.avatar.model_url);
	viewer.setAttribute('eager', '');
	viewer.style.cssText = 'width:100%;height:100%;display:block';

	container.innerHTML = '';
	container.appendChild(viewer);
}

function showPreviewError(msg) {
	const container = document.getElementById('preview-content');
	container.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`;
}

function updateProgress() {
	const pct = ((currentStep + 1) / STEPS.length) * 100;
	document.getElementById('progress-bar').style.width = pct + '%';
}

function goToStep(n) {
	STEPS.forEach((s) => {
		document.getElementById(`step-${s}`).classList.remove('active');
	});
	currentStep = n;
	document.getElementById(`step-${STEPS[currentStep]}`).classList.add('active');
	updateProgress();

	if (currentStep === 0) {
		const input = document.getElementById('name-input');
		input.value = state.name;
		input.focus();
		updateCharCount('name');
	} else if (currentStep === 1) {
		const textarea = document.getElementById('bio-input');
		textarea.value = state.bio;
		textarea.focus();
		updateCharCount('bio');
	} else if (currentStep === 2) {
		document.getElementById('voice-select').value = state.voice;
		document.getElementById('body-type-select').value = state.bodyType;
	} else if (currentStep === 3) {
		renderGreeting();
	}
}

function updateCharCount(field) {
	const input = document.getElementById(`${field}-input`);
	const count = document.getElementById(`${field}-count`);
	count.textContent = input.value.length;
}

// ── Wire buttons ─────────────────────────────────────────────────────────────

function wireStepButtons() {
	// Step 1: Name
	document.getElementById('name-input').addEventListener('input', (e) => {
		state.name = e.target.value || 'My Agent';
		updateCharCount('name');
	});
	document.getElementById('name-next').addEventListener('click', () => goToStep(1));
	document.getElementById('name-skip').addEventListener('click', () => goToStep(1));

	// Step 2: Bio
	document.getElementById('bio-input').addEventListener('input', (e) => {
		state.bio = e.target.value;
		updateCharCount('bio');
	});
	document.getElementById('bio-next').addEventListener('click', () => goToStep(2));
	document.getElementById('bio-back').addEventListener('click', () => goToStep(0));

	// Step 3: Voice
	document.getElementById('voice-select').addEventListener('change', (e) => {
		state.voice = e.target.value;
	});
	document.getElementById('body-type-select').addEventListener('change', (e) => {
		state.bodyType = e.target.value;
	});
	document.getElementById('voice-next').addEventListener('click', () => goToStep(3));
	document.getElementById('voice-back').addEventListener('click', () => goToStep(1));

	// Step 4: Greet
	document.getElementById('greet-next').addEventListener('click', () => goToStep(4));

	// Step 5: Done
	document.getElementById('done-agent').addEventListener('click', async () => {
		// Persist final state
		try {
			await persistState();
		} catch (err) {
			alert('Failed to save: ' + err.message);
			return;
		}
		if (state.agent) {
			window.location.href = `/agents/${state.agent.id}`;
		}
	});
	document.getElementById('done-dashboard').addEventListener('click', () => {
		window.location.href = '/dashboard';
	});
}

// ── Greeting (Step 4) ───────────────────────────────────────────────────────

async function renderGreeting() {
	const container = document.getElementById('preview-content');
	const textDiv = document.getElementById('greeting-text');

	try {
		// Try to load agent-3d element
		if (window.customElements && customElements.get('agent-3d')) {
			const agent3d = document.createElement('agent-3d');
			agent3d.setAttribute('model', state.avatar.model_url);
			agent3d.setAttribute('voice', state.voice);
			agent3d.setAttribute('eager', '');

			container.innerHTML = '';
			container.appendChild(agent3d);

			textDiv.textContent = 'Greeting…';

			// Wait for element to be ready, then emit speak event
			setTimeout(() => {
				try {
					const greetingText = buildGreetingText();
					const event = new CustomEvent('speak', {
						detail: { text: greetingText, sentiment: 0.8 },
					});
					agent3d.dispatchEvent(event);
					textDiv.textContent = `"${greetingText}"`;
				} catch (e) {
					console.error('Greeting failed:', e);
					textDiv.textContent = buildGreetingText();
				}
			}, 500);
		} else {
			// Fallback: agent-3d (no voice/agent-id) + browser TTS
			const viewer = document.createElement('agent-3d');
			viewer.setAttribute('body', state.avatar.model_url);
			viewer.setAttribute('eager', '');
			viewer.style.cssText = 'width:100%;height:100%;display:block';

			container.innerHTML = '';
			container.appendChild(viewer);

			const greetingText = buildGreetingText();
			textDiv.textContent = `"${greetingText}"`;

			// Try browser TTS
			if (window.SpeechSynthesis || window.webkitSpeechSynthesis) {
				const synth = window.speechSynthesis || window.webkitSpeechSynthesis;
				const utterance = new SpeechSynthesisUtterance(greetingText);
				utterance.voice = findVoice(state.voice);
				utterance.rate = 0.95;
				synth.speak(utterance);
			}
		}
	} catch (err) {
		console.error('Greeting render error:', err);
		textDiv.textContent = buildGreetingText();
	}
}

function buildGreetingText() {
	const bioSuffix = state.bio ? ' ' + state.bio : '';
	return `Hi — I'm ${state.name}.${bioSuffix}`;
}

function findVoice(voiceId) {
	if (!(window.SpeechSynthesis || window.webkitSpeechSynthesis)) return null;
	const synth = window.speechSynthesis || window.webkitSpeechSynthesis;
	const voices = synth.getVoices();

	const langMap = {
		'en-US-female': ['en-US', 'female'],
		'en-US-male': ['en-US', 'male'],
		'en-GB-female': ['en-GB', 'female'],
		'en-GB-male': ['en-GB', 'male'],
	};

	const [lang, gender] = langMap[voiceId] || ['en-US', 'female'];

	return (
		voices.find((v) => v.lang.startsWith(lang) && (v.name.includes(gender) || true)) ||
		voices[0] ||
		null
	);
}

// ── Persistence ────────────────────────────────────────────────────────────

async function persistState() {
	// 1. PATCH avatar name + description
	await apiFetch(`/api/avatars/${state.avatarId}`, {
		method: 'PATCH',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			name: state.name,
			description: state.bio,
		}),
	}).then((r) => {
		if (!r.ok) throw new Error(`Avatar update failed: ${r.status}`);
		return r.json();
	});

	// 2. Create or update agent
	const agentMeta = { voice: state.voice, bodyType: state.bodyType };
	if (!state.agent) {
		// POST new agent
		const res = await apiFetch('/api/agents', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				name: state.name,
				description: state.bio,
				avatar_id: state.avatarId,
				meta: agentMeta,
			}),
		});
		if (!res.ok) throw new Error(`Agent creation failed: ${res.status}`);
		const data = await res.json();
		state.agent = data.agent;
	} else {
		// PATCH existing agent
		const res = await apiFetch(`/api/agents/${state.agent.id}`, {
			method: 'PATCH',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				name: state.name,
				description: state.bio,
				avatar_id: state.avatarId,
				meta: agentMeta,
			}),
		});
		if (!res.ok) throw new Error(`Agent update failed: ${res.status}`);
		const data = await res.json();
		state.agent = data.agent;
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

boot();
