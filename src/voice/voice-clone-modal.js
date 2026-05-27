/**
 * Voice-clone modal opened from inside Talk mode.
 *
 * Wraps the existing VoiceRecorder editor component in a modal shell so the
 * avatar's owner can clone their voice in-place without leaving talk mode.
 * On close, the caller is responsible for refreshing whichever cached voice
 * lookup it has — typically TalkController.refreshVoice().
 *
 * The recorder POSTs to /api/agents/:id/voice/clone (existing endpoint, real
 * ElevenLabs cloning, R2-cached, rate-limited 3/day). We don't reimplement
 * the recording logic — only the modal chrome.
 */

import { VoiceRecorder } from '../editor/voice-recorder.js';

let active = null;

/**
 * @param {object} opts
 * @param {string} opts.agentId   Required — voice is cloned against an agent.
 * @param {string} [opts.agentName='Avatar']
 * @param {() => void} [opts.onClose]  Fires after the modal closes (clone or cancel).
 */
export function openVoiceCloneModal({ agentId, agentName = 'Avatar', onClose } = {}) {
	if (!agentId) {
		console.warn('[voice-clone] no agentId — owner has no linked agent yet');
		return null;
	}
	if (active) return active; // single instance

	injectStylesOnce();

	const root = document.createElement('div');
	root.className = 'tws-vcm-root';
	root.innerHTML = `
		<div class="tws-vcm-backdrop" data-ref="backdrop"></div>
		<div class="tws-vcm-card" role="dialog" aria-modal="true" aria-labelledby="tws-vcm-title">
			<div class="tws-vcm-head">
				<div>
					<div class="tws-vcm-eyebrow">three.ws</div>
					<h2 class="tws-vcm-title" id="tws-vcm-title">Clone your voice</h2>
				</div>
				<button class="tws-vcm-close" data-ref="close" aria-label="Close">✕</button>
			</div>
			<p class="tws-vcm-help">
				Read the line below at a natural pace for 30–60 seconds. Once cloned,
				this avatar speaks in your voice everywhere on three.ws.
			</p>
			<div class="tws-vcm-script">
				<em>"Hello, I'm building this avatar on three.ws. I want it to speak with my own voice
				so it can hold a real conversation. I'll keep going for half a minute or so to give the
				model enough material to learn from — the more natural intonation I use, the better the
				clone will sound when it talks back."</em>
			</div>
			<div data-ref="recorder-host"></div>
		</div>
	`;
	document.body.appendChild(root);
	document.body.classList.add('tws-vcm-open');

	const host = root.querySelector('[data-ref="recorder-host"]');
	const recorder = new VoiceRecorder(host, { agentId, agentName });
	recorder.mount();

	const close = () => {
		if (!active) return;
		try {
			recorder.destroy();
		} catch {}
		window.removeEventListener('keydown', onKey);
		document.body.classList.remove('tws-vcm-open');
		root.remove();
		active = null;
		try {
			onClose?.();
		} catch (err) {
			console.warn('[voice-clone] onClose threw', err?.message);
		}
	};

	const onKey = (e) => {
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
		}
	};
	window.addEventListener('keydown', onKey);

	root.querySelector('[data-ref="backdrop"]').addEventListener('click', close);
	root.querySelector('[data-ref="close"]').addEventListener('click', close);

	active = { close };
	return active;
}

export function closeVoiceCloneModal() {
	active?.close();
}

// ── styles ─────────────────────────────────────────────────────────────────

function injectStylesOnce() {
	if (document.getElementById('tws-vcm-css')) return;
	const s = document.createElement('style');
	s.id = 'tws-vcm-css';
	s.textContent = `
.tws-vcm-open { overflow: hidden; }
.tws-vcm-root {
	position: fixed; inset: 0; z-index: 10001;
	display: grid; place-items: center;
	padding: 24px;
	animation: tws-vcm-in 180ms ease-out;
}
@keyframes tws-vcm-in { from { opacity: 0; } to { opacity: 1; } }
.tws-vcm-backdrop {
	position: absolute; inset: 0;
	background: rgba(5, 5, 5, 0.78);
	backdrop-filter: blur(6px);
}
.tws-vcm-card {
	position: relative;
	width: 100%;
	max-width: 520px;
	max-height: calc(100vh - 48px);
	overflow-y: auto;
	background: #0d0d0d;
	border: 1px solid rgba(255, 255, 255, 0.08);
	border-radius: 16px;
	padding: 22px 24px 20px;
	color: #fafafa;
	font-family: 'Inter', system-ui, sans-serif;
	box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
}
.tws-vcm-head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 12px;
	margin-bottom: 10px;
}
.tws-vcm-eyebrow {
	font-family: 'Space Grotesk', sans-serif;
	font-size: 10px;
	letter-spacing: 0.18em;
	text-transform: uppercase;
	color: #ffffff;
	margin-bottom: 4px;
}
.tws-vcm-title {
	margin: 0;
	font-size: 22px;
	font-weight: 700;
	letter-spacing: -0.01em;
	font-family: 'Space Grotesk', sans-serif;
}
.tws-vcm-close {
	background: rgba(255, 255, 255, 0.06);
	border: 1px solid rgba(255, 255, 255, 0.12);
	color: #fafafa;
	width: 32px;
	height: 32px;
	border-radius: 999px;
	cursor: pointer;
	font-size: 13px;
	font-family: inherit;
	flex-shrink: 0;
}
.tws-vcm-close:hover {
	background: rgba(255, 255, 255, 0.12);
	border-color: rgba(255, 255, 255, 0.25);
}
.tws-vcm-help {
	margin: 0 0 14px;
	font-size: 13px;
	line-height: 1.5;
	color: #a1a1aa;
}
.tws-vcm-script {
	background: rgba(125, 211, 252, 0.06);
	border: 1px solid rgba(125, 211, 252, 0.18);
	border-radius: 10px;
	padding: 12px 14px;
	font-size: 13px;
	line-height: 1.55;
	color: #d4d4d8;
	margin-bottom: 16px;
}
.tws-vcm-script em { color: #fafafa; font-style: normal; }
`;
	document.head.appendChild(s);
}
