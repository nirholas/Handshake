// Library → Brain tab.
// Per-agent LLM brain configurator: pick a model, edit the system prompt,
// and live-test the brain against streaming responses — all from the dashboard.

import { get, put, post, esc } from '../../api.js';
import { emptyStateHTML, errorStateHTML, attachRetry, ensureStateKitStyles } from '../../../shared/state-kit.js';
import { renderMarkdown } from '../../../shared/markdown.js';
ensureStateKitStyles();

// ── Model registry ─────────────────────────────────────────────────────────────
// Mirrors the MODELS table in api/llm/anthropic.js.

const MODELS = [
	{
		model:   'claude-sonnet-4-6',
		label:   'Claude Sonnet 4.6',
		network: 'Anthropic',
		tier:    'Best quality',
		ctx:     '200K',
		color:   '#c8a96e',
		brain_key: 'anthropic',
	},
	{
		model:   'claude-haiku-4-5-20251001',
		label:   'Claude Haiku 4.5',
		network: 'Anthropic',
		tier:    'Fast · cheap',
		ctx:     '200K',
		color:   '#b89050',
		brain_key: 'anthropic',
	},
	{
		model:   'llama-3.3-70b-versatile',
		label:   'Llama 3.3 70B',
		network: 'Groq',
		tier:    'Free · fast',
		ctx:     '128K',
		color:   '#ff9a3c',
		brain_key: 'groq-llama',
	},
	{
		model:   'google/gemma-4-31b-it:free',
		label:   'Llama 3.3 70B',
		network: 'OpenRouter',
		tier:    'Free · open-source',
		ctx:     '128K',
		color:   '#ff7b24',
		brain_key: 'groq-llama',
	},
	{
		model:   'nvidia/nemotron-3-super-120b-a12b:free',
		label:   'GPT-OSS 120B',
		network: 'OpenRouter',
		tier:    'Free · OpenAI open-source',
		ctx:     '128K',
		color:   '#74c0fc',
		brain_key: 'openai',
	},
	{
		model:   'google/gemma-4-31b-it:free',
		label:   'Hermes 3 405B',
		network: 'OpenRouter',
		tier:    'Free · large open-source',
		ctx:     '128K',
		color:   '#69db7c',
		brain_key: 'groq-llama',
	},
];
const MODEL_DEFAULT = 'google/gemma-4-31b-it:free';
const MMAP = new Map(MODELS.map((m) => [m.model, m]));

function friendly(err) {
	if (!err) return 'Something went wrong.';
	const status = err.status || 0;
	const msg = err.message || String(err);
	if (status === 401 || /unauthorized|sign in|bearer/i.test(msg)) return 'Session expired — refresh the page.';
	if (status === 403 || /forbidden/i.test(msg))                   return "You don't have permission for that.";
	if (status === 429 || /rate.?limit/i.test(msg))                 return 'Too many requests — try again in a moment.';
	return msg.replace(/^HTTP\s+\d+\s*/i, '') || 'Unknown error.';
}

// ── Streaming helper ─────────────────────────────────────────────────────────

async function streamBrain(providerKey, messages, system, { onChunk, onDone, onError, signal }) {
	let res;
	try {
		res = await fetch('/api/brain/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			signal,
			body: JSON.stringify({ provider: providerKey, messages, system: system || undefined, maxTokens: 1024 }),
		});
	} catch (err) {
		if (err.name !== 'AbortError') onError?.(err.message || 'Network error');
		return;
	}

	if (!res.ok || !res.body) {
		const txt = await res.text().catch(() => '');
		onError?.(`HTTP ${res.status}: ${txt || res.statusText}`);
		return;
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	const t0 = performance.now();

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx;
			while ((idx = buf.indexOf('\n\n')) !== -1) {
				const event = buf.slice(0, idx);
				buf = buf.slice(idx + 2);
				let evType = 'message', data = '';
				for (const line of event.split('\n')) {
					if (line.startsWith('event:')) evType = line.slice(6).trim();
					else if (line.startsWith('data:')) data += line.slice(5).trim();
				}
				if (evType === 'message' && data && data !== '[DONE]') {
					try { onChunk?.(JSON.parse(data)); } catch {}
				} else if (evType === 'done') {
					try { onDone?.(JSON.parse(data)); } catch {}
				} else if (evType === 'error') {
					try { onError?.(JSON.parse(data).message || 'upstream error'); } catch {}
				}
			}
		}
	} finally {
		onDone?.({ elapsedMs: Math.round(performance.now() - t0), usage: null });
	}
}

// ── Markdown (lightweight renderer) ─────────────────────────────────────────

// Model output goes through the shared sanitized pipeline (marked + DOMPurify).
// The class map keeps this page's existing bmd-* stylesheet contract.
const MD_CLASSES = {
	pre: 'bmd-pre',
	'code:not(pre code)': 'bmd-ic',
	'h1, h2, h3, h4, h5, h6': 'bmd-h',
	ul: 'bmd-ul',
	p: 'bmd-p',
};

function renderMd(text) {
	return renderMarkdown(text, { classes: MD_CLASSES });
}

// ── Main renderer ─────────────────────────────────────────────────────────────

export async function renderBrain(host) {
	host.innerHTML = `
		<style>
			.br-layout { display: flex; flex-direction: column; gap: 20px; }

			/* Agent picker */
			.br-agent-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
			.br-agent-sel {
				background: #0a0a14;
				border: 1px solid rgba(255,255,255,0.1);
				color: var(--nxt-ink);
				border-radius: 8px;
				padding: 8px 12px;
				font: inherit;
				font-size: 13px;
				min-width: 200px;
				cursor: pointer;
			}
			.br-agent-label { font-size: 12px; color: var(--nxt-ink-dim); font-weight: 500; }

			/* Sections */
			.br-section {
				border: 1px solid rgba(255,255,255,0.08);
				border-radius: 12px;
				overflow: hidden;
			}
			.br-section-head {
				padding: 13px 16px 12px;
				border-bottom: 1px solid rgba(255,255,255,0.06);
				background: rgba(255,255,255,0.02);
				display: flex;
				align-items: baseline;
				gap: 10px;
			}
			.br-section-title { font-size: 14px; font-weight: 600; color: var(--nxt-ink); margin: 0; }
			.br-section-sub { font-size: 12px; color: var(--nxt-ink-dim); margin: 0; }
			.br-section-body { padding: 16px; }

			/* Model grid */
			.br-model-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; margin-bottom: 14px; }
			.br-model-card {
				display: flex; gap: 10px; align-items: flex-start;
				padding: 11px 13px;
				border-radius: 10px;
				border: 1.5px solid rgba(255,255,255,0.07);
				background: rgba(255,255,255,0.01);
				cursor: pointer;
				user-select: none;
				transition: border-color 0.12s, background 0.12s;
			}
			.br-model-card:hover { border-color: rgba(255,255,255,0.14); background: rgba(255,255,255,0.03); }
			.br-model-card.selected { border-color: var(--mc); background: rgba(0,0,0,0.12); }
			.br-model-card input { display: none; }
			.br-model-dot {
				width: 8px; height: 8px; border-radius: 50%;
				background: var(--mc); flex-shrink: 0; margin-top: 5px;
			}
			.br-model-info { flex: 1; min-width: 0; }
			.br-model-name { font-size: 13px; font-weight: 600; color: var(--nxt-ink); }
			.br-model-net { font-size: 11px; color: var(--nxt-ink-dim); margin-top: 1px; }
			.br-model-tier {
				display: inline-block; font-size: 10.5px; padding: 1px 6px;
				border-radius: 999px; background: rgba(255,255,255,0.05);
				color: var(--nxt-ink-fade); margin-top: 4px;
				border: 1px solid rgba(255,255,255,0.08);
			}
			.br-save-row { display: flex; align-items: center; gap: 10px; }
			.br-status { font-size: 12px; color: var(--nxt-ink-dim); }
			.br-status.ok { color: #69db7c; }
			.br-status.err { color: #ff8a8a; }

			/* System prompt */
			.br-prompt-wrap { display: flex; flex-direction: column; gap: 10px; }
			.br-prompt-ta {
				width: 100%;
				background: #0a0a14;
				border: 1px solid rgba(255,255,255,0.1);
				border-radius: 8px;
				color: var(--nxt-ink);
				font: inherit;
				font-size: 13px;
				padding: 10px 12px;
				resize: vertical;
				min-height: 120px;
				outline: none;
				transition: border-color 0.12s;
			}
			.br-prompt-ta:focus { border-color: rgba(255,255,255,0.2); }
			.br-prompt-notice {
				font-size: 11.5px; color: rgba(255,184,77,0.9);
				background: rgba(255,184,77,0.07);
				border: 1px solid rgba(255,184,77,0.2);
				border-radius: 7px; padding: 7px 10px;
			}

			/* Live test */
			.br-test-messages {
				min-height: 120px;
				max-height: 320px;
				overflow-y: auto;
				background: #07080e;
				border: 1px solid rgba(255,255,255,0.06);
				border-radius: 10px;
				padding: 12px 14px;
				display: flex;
				flex-direction: column;
				gap: 12px;
				margin-bottom: 10px;
			}
			.br-test-empty { color: var(--nxt-ink-fade); font-size: 12.5px; font-style: italic; text-align: center; padding: 20px; }
			.br-test-msg { display: flex; flex-direction: column; gap: 3px; }
			.br-test-msg-label { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.07em; }
			.br-test-msg.user .br-test-msg-label { color: rgba(255,255,255,0.35); }
			.br-test-msg.assistant .br-test-msg-label { color: var(--mc, #c8a96e); }
			.br-test-msg-body { font-size: 13px; line-height: 1.6; color: var(--nxt-ink); }
			.br-test-msg.user .br-test-msg-body { color: var(--nxt-ink-dim); }
			.br-test-input-row { display: flex; gap: 8px; align-items: flex-end; }
			.br-test-ta {
				flex: 1;
				background: #0a0a14;
				border: 1px solid rgba(255,255,255,0.1);
				border-radius: 8px;
				color: var(--nxt-ink);
				font: inherit;
				font-size: 13px;
				padding: 8px 11px;
				resize: none;
				min-height: 38px;
				max-height: 120px;
				outline: none;
				field-sizing: content;
			}
			.br-test-ta:focus { border-color: rgba(255,255,255,0.2); }
			.br-spin {
				display: inline-block; width: 7px; height: 7px; border-radius: 50%;
				background: var(--mc, #3dc1ff); animation: brBlink 0.9s ease-in-out infinite;
				vertical-align: middle; margin-left: 3px;
			}
			@keyframes brBlink { 0%,100%{ opacity:0.25 } 50%{ opacity:1 } }

			/* Markdown */
			.bmd-pre { background: #0d0f1e; border: 1px solid rgba(255,255,255,0.08); border-radius: 7px; padding: 9px 12px; overflow-x: auto; font-family: ui-monospace,Menlo,monospace; font-size: 12px; line-height: 1.5; margin: 0.3em 0; color: #c8d3f5; }
			.bmd-ic { background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.1); border-radius: 3px; padding: 0 4px; font-family: ui-monospace,monospace; font-size: 11.5px; }
			.bmd-h { font-size: 13.5px; font-weight: 600; margin: 0.5em 0 0.2em; }
			.bmd-ul { margin: 0.3em 0 0.4em 1.3em; padding: 0; }
			.bmd-p { margin: 0 0 0.5em; }
			.bmd-p:last-child { margin: 0; }

			.br-test-err { color: var(--nxt-danger); }

			@media (prefers-reduced-motion: reduce) {
				.br-spin { animation: none; opacity: 0.7; }
				.br-model-card { transition: none; }
			}
		</style>

		<div class="br-layout">
			<div class="br-agent-row">
				<span class="br-agent-label">Agent</span>
				<select class="br-agent-sel" id="br-agent-sel">
					<option value="">Loading agents…</option>
				</select>
			</div>

			<div id="br-content">
				<div class="dn-skeleton" style="height:200px;border-radius:12px"></div>
			</div>
		</div>
	`;

	const agentSel = host.querySelector('#br-agent-sel');
	const contentEl = host.querySelector('#br-content');

	let agents = [];
	try {
		const res = await get('/api/agents');
		agents = res?.agents || [];
	} catch (err) {
		contentEl.innerHTML = errorStateHTML({ title: "Couldn't load agents", body: esc(friendly(err)) });
		attachRetry(contentEl, () => renderBrain(host));
		return;
	}

	if (!agents.length) {
		agentSel.innerHTML = '<option value="">No agents yet</option>';
		contentEl.innerHTML = emptyStateHTML({
			icon: '🤖',
			title: 'No agents yet',
			body: 'The brain is where you pick an agent\'s LLM, write its system prompt, and live-test how it responds. Create an agent first, then tune its brain here.',
			actions: [
				{ label: '+ Create your first agent', href: '/dashboard/agents', id: 'create-agent', primary: true },
				{ label: "What's an agent?", href: '/docs/agents-vs-avatars', id: 'learn-agents' },
			],
		});
		return;
	}

	agentSel.innerHTML = agents.map((a) =>
		`<option value="${esc(a.id)}">${esc(a.name || a.id)}</option>`
	).join('');

	async function loadAgent(agentId) {
		if (!agentId) { contentEl.innerHTML = ''; return; }
		contentEl.innerHTML = `<div class="dn-skeleton" style="height:220px;border-radius:12px"></div>`;
		let agent;
		try {
			const r = await get(`/api/agents/${encodeURIComponent(agentId)}`);
			agent = r?.agent;
		} catch (err) {
			contentEl.innerHTML = errorStateHTML({ title: "Couldn't load agent", body: esc(friendly(err)) });
			attachRetry(contentEl, () => loadAgent(agentId));
			return;
		}
		if (!agent) {
			contentEl.innerHTML = emptyStateHTML({
				icon: '🔍',
				title: 'Agent not found',
				body: 'This agent may have been deleted. Pick another from the selector above.',
			});
			return;
		}
		renderAgentConfig(agent);
	}

	function renderAgentConfig(agent) {
		const currentModel = agent.meta?.brain?.model || MODEL_DEFAULT;
		const systemPrompt = agent.system_prompt || '';
		const currentInfo = MMAP.get(currentModel) || MMAP.get(MODEL_DEFAULT);

		contentEl.innerHTML = `
			<!-- Brain model -->
			<div class="br-section" style="margin-bottom:16px">
				<div class="br-section-head">
					<h3 class="br-section-title">Brain model</h3>
					<p class="br-section-sub">Which LLM powers this agent's responses.</p>
				</div>
				<div class="br-section-body">
					<div class="br-model-grid" id="br-model-grid">
						${MODELS.map((m) => `
							<label class="br-model-card${m.model === currentModel ? ' selected' : ''}" style="--mc:${m.color}">
								<input type="radio" name="br-model" value="${esc(m.model)}" ${m.model === currentModel ? 'checked' : ''} />
								<span class="br-model-dot"></span>
								<span class="br-model-info">
									<div class="br-model-name">${esc(m.label)}</div>
									<div class="br-model-net">${esc(m.network)} · ${esc(m.ctx)}</div>
									<div class="br-model-tier">${esc(m.tier)}</div>
								</span>
							</label>
						`).join('')}
					</div>
					<div class="br-save-row">
						<button class="dn-btn primary" id="br-save-model" type="button">Save brain</button>
						<span class="br-status" id="br-model-status"></span>
					</div>
				</div>
			</div>

			<!-- System prompt -->
			<div class="br-section" style="margin-bottom:16px">
				<div class="br-section-head">
					<h3 class="br-section-title">System prompt</h3>
					<p class="br-section-sub">How this agent introduces itself and behaves.</p>
				</div>
				<div class="br-section-body">
					<div class="br-prompt-wrap">
						${!agent.category ? `<div class="br-prompt-notice">This agent hasn't been published yet. Saving the system prompt will publish it to the marketplace. Set a category below or <a href="/agent-edit?id=${esc(agent.id)}" style="color:inherit;text-decoration:underline">open the agent editor</a>.</div>` : ''}
						<textarea class="br-prompt-ta" id="br-prompt" placeholder="You are a helpful AI assistant for…">${esc(systemPrompt)}</textarea>
						${!agent.category ? `
							<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
								<label style="font-size:12px;color:var(--nxt-ink-dim)">Category</label>
								<select id="br-category" class="br-agent-sel" style="min-width:160px">
									<option value="">Select category…</option>
									${['assistant','coding','creative','research','data','business','education','entertainment','productivity','other'].map((c) => `<option value="${c}">${c}</option>`).join('')}
								</select>
							</div>
						` : ''}
						<div class="br-save-row">
							<button class="dn-btn primary" id="br-save-prompt" type="button">Save system prompt</button>
							<span class="br-status" id="br-prompt-status"></span>
						</div>
					</div>
				</div>
			</div>

			<!-- Live test -->
			<div class="br-section">
				<div class="br-section-head">
					<h3 class="br-section-title">Live test</h3>
					<p class="br-section-sub" id="br-test-label">Using <strong id="br-test-model-name">${esc(currentInfo?.label || currentModel)}</strong> · system prompt above</p>
				</div>
				<div class="br-section-body">
					<div class="br-test-messages" id="br-test-msgs" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Live test conversation">
						<div class="br-test-empty" id="br-test-empty">Send a message to test your agent's brain.</div>
					</div>
					<div class="br-test-input-row">
						<textarea class="br-test-ta" id="br-test-input" placeholder="Test message… (⌘↵ to send)" rows="1" aria-label="Test message"></textarea>
						<button class="dn-btn primary" id="br-test-send" type="button">Send</button>
					</div>
				</div>
			</div>
		`;

		// ── Model selection ───────────────────────────────────────────────────────

		const modelGrid = contentEl.querySelector('#br-model-grid');
		let selectedModel = currentModel;

		modelGrid.addEventListener('click', (e) => {
			const card = e.target.closest('.br-model-card');
			if (!card) return;
			const input = card.querySelector('input[type="radio"]');
			if (!input) return;
			selectedModel = input.value;
			modelGrid.querySelectorAll('.br-model-card').forEach((c) => {
				c.classList.toggle('selected', c.querySelector('input')?.value === selectedModel);
			});
			// Update live test label
			const m = MMAP.get(selectedModel);
			const nameEl = contentEl.querySelector('#br-test-model-name');
			if (nameEl && m) nameEl.textContent = m.label;
		});

		const saveModelBtn = contentEl.querySelector('#br-save-model');
		const modelStatus = contentEl.querySelector('#br-model-status');

		saveModelBtn.addEventListener('click', async () => {
			saveModelBtn.disabled = true;
			modelStatus.textContent = 'Saving…';
			modelStatus.className = 'br-status';
			try {
				const newMeta = { ...(agent.meta || {}), brain: { ...(agent.meta?.brain || {}), model: selectedModel } };
				await put(`/api/agents/${encodeURIComponent(agent.id)}`, { meta: newMeta });
				agent.meta = newMeta;
				modelStatus.textContent = 'Saved.';
				modelStatus.className = 'br-status ok';
				setTimeout(() => { modelStatus.textContent = ''; }, 2000);
			} catch (err) {
				modelStatus.textContent = friendly(err);
				modelStatus.className = 'br-status err';
			} finally {
				saveModelBtn.disabled = false;
			}
		});

		// ── System prompt ─────────────────────────────────────────────────────────

		const savePromptBtn = contentEl.querySelector('#br-save-prompt');
		const promptStatus = contentEl.querySelector('#br-prompt-status');
		const promptTa = contentEl.querySelector('#br-prompt');

		savePromptBtn.addEventListener('click', async () => {
			const newPrompt = promptTa.value.trim();
			if (!newPrompt) { promptStatus.textContent = 'System prompt is required.'; promptStatus.className = 'br-status err'; return; }
			const categoryEl = contentEl.querySelector('#br-category');
			const category = categoryEl?.value || agent.category;
			if (!category) { promptStatus.textContent = 'Select a category first.'; promptStatus.className = 'br-status err'; return; }

			savePromptBtn.disabled = true;
			promptStatus.textContent = 'Saving…';
			promptStatus.className = 'br-status';
			try {
				// post() attaches the single-use CSRF token this endpoint requires and
				// raises an ApiError that friendly() already knows how to phrase.
				await post(`/api/marketplace/agents/${encodeURIComponent(agent.id)}/publish`, {
					system_prompt: newPrompt,
					category,
				});
				agent.system_prompt = newPrompt;
				agent.category = category;
				promptStatus.textContent = 'Saved.';
				promptStatus.className = 'br-status ok';
				setTimeout(() => { promptStatus.textContent = ''; }, 2000);
			} catch (err) {
				promptStatus.textContent = friendly(err);
				promptStatus.className = 'br-status err';
			} finally {
				savePromptBtn.disabled = false;
			}
		});

		// ── Live test ─────────────────────────────────────────────────────────────

		const msgsEl = contentEl.querySelector('#br-test-msgs');
		const emptyEl = contentEl.querySelector('#br-test-empty');
		const testInput = contentEl.querySelector('#br-test-input');
		const testSend = contentEl.querySelector('#br-test-send');
		const testMessages = []; // { role, content }
		let testStreaming = false;
		let testAbort = null;

		function getTestModel() {
			const m = MMAP.get(selectedModel);
			return m || MMAP.get(MODEL_DEFAULT);
		}

		function appendTestMsg(role, content, streaming = false) {
			if (emptyEl) emptyEl.style.display = 'none';
			const m = getTestModel();
			const el = document.createElement('div');
			el.className = `br-test-msg ${role}`;
			el.style.setProperty('--mc', m?.color || '#c8a96e');
			const label = role === 'user' ? 'You' : (m?.label || 'Assistant');
			el.innerHTML = `
				<div class="br-test-msg-label">${esc(label)}</div>
				<div class="br-test-msg-body">${streaming ? '<span class="br-spin"></span>' : (role === 'user' ? esc(content) : renderMd(content))}</div>
			`;
			msgsEl.appendChild(el);
			msgsEl.scrollTop = msgsEl.scrollHeight;
			return el;
		}

		function setStreamingUi(on) {
			testStreaming = on;
			testSend.textContent = on ? 'Stop' : 'Send';
			testSend.classList.toggle('primary', !on);
		}

		async function sendTestMessage() {
			const text = testInput.value.trim();
			if (!text || testStreaming) return;
			testInput.value = '';

			appendTestMsg('user', text);
			testMessages.push({ role: 'user', content: text });

			setStreamingUi(true);
			testAbort = new AbortController();

			const assistantEl = appendTestMsg('assistant', '', true);
			const bodyEl = assistantEl.querySelector('.br-test-msg-body');
			let accumulated = '';
			let settled = false;
			const m = getTestModel();

			try {
				await streamBrain(m?.brain_key || 'anthropic', [...testMessages], promptTa.value.trim(), {
					signal: testAbort.signal,
					onChunk(delta) {
						accumulated += delta;
						bodyEl.innerHTML = renderMd(accumulated) + '<span class="br-spin"></span>';
						msgsEl.scrollTop = msgsEl.scrollHeight;
					},
					onDone() {
						if (settled) return;
						settled = true;
						const stopped = testAbort?.signal.aborted;
						bodyEl.innerHTML = renderMd(accumulated || (stopped ? '(stopped)' : '(no response)'));
						if (accumulated) testMessages.push({ role: 'assistant', content: accumulated });
						setStreamingUi(false);
						msgsEl.scrollTop = msgsEl.scrollHeight;
					},
					onError(msg) {
						if (settled) return;
						settled = true;
						bodyEl.innerHTML = `<span class="br-test-err">${esc(msg)}</span>`;
						setStreamingUi(false);
					},
				});
			} catch (err) {
				// A user-initiated abort surfaces here; the finally in streamBrain has
				// already run onDone, so just make sure the UI is settled.
				if (err?.name !== 'AbortError' && !settled) {
					settled = true;
					bodyEl.innerHTML = `<span class="br-test-err">${esc(friendly(err))}</span>`;
					setStreamingUi(false);
				}
			}
		}

		testSend.addEventListener('click', () => {
			if (testStreaming) { testAbort?.abort(); return; }
			sendTestMessage();
		});
		testInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendTestMessage(); }
		});
	}

	// Initial load
	await loadAgent(agentSel.value);
	agentSel.addEventListener('change', () => loadAgent(agentSel.value));
}
