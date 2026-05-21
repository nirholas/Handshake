// Manifest builder UI — shadow-DOM form that produces a valid agent manifest bundle.
// Usage: mountManifestBuilder(rootEl, options)
// Feature-flagged behind ?editor=v2 — do not remove register-ui.js until this ships.

import { z } from 'zod';
import '../element.js';
import { PersonaInterview } from './persona-interview.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// Free models routed via the we-pay proxy (/api/llm/anthropic). Listed
// first so they're the default. The proxy translates request/response
// shapes server-side, so the browser provider stays Anthropic-shape.
const FREE_MODELS = [
	{ id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (OpenRouter · free)' },
	{ id: 'openai/gpt-oss-120b:free', label: 'GPT-OSS 120B (OpenRouter · free)' },
	{ id: 'nousresearch/hermes-3-llama-3.1-405b:free', label: 'Hermes 3 405B (OpenRouter · free)' },
	{ id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Groq · free, sub-second)' },
	{ id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (Groq · free, fastest)' },
];
const ANTHROPIC_MODELS = [
	{ id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
	{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
	{ id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
	{ id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
];
const OPENAI_MODELS = [
	{ id: 'gpt-4o-2024-11-20', label: 'GPT-4o (Nov 2024)' },
	{ id: 'gpt-4o-mini', label: 'GPT-4o mini' },
	{ id: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
];
const BRAIN_PROVIDERS = ['anthropic', 'openai', 'local', 'none'];
const TTS_PROVIDERS = ['browser', 'elevenlabs', 'openai', 'none'];
const STT_PROVIDERS = ['browser', 'whisper', 'none'];
const MEMORY_MODES = ['local', 'ipfs', 'encrypted-ipfs', 'none'];
const RIG_TYPES = ['mixamo', 'vrm', 'custom'];
const BODY_FORMATS = ['gltf-binary', 'gltf', 'vrm'];
const THINKING_OPTS = ['auto', 'always', 'never'];

const DRAFT_KEY = 'manifest-builder-draft';

// ─── Zod schema ───────────────────────────────────────────────────────────────

const ManifestSchema = z.object({
	spec: z.literal('agent-manifest/0.1'),
	name: z.string().min(1, 'Name is required').max(100, 'Max 100 chars'),
	description: z.string().max(1000).optional(),
	image: z.string().optional(),
	tags: z.array(z.string()).optional(),
	body: z.object({
		uri: z.string().min(1, 'Body URI is required'),
		format: z.enum(['gltf-binary', 'gltf', 'vrm']),
		rig: z.enum(['mixamo', 'vrm', 'custom']).optional(),
		boundingBoxHeight: z.number().positive().optional(),
	}),
	brain: z
		.object({
			provider: z.enum(['anthropic', 'openai', 'local', 'none']),
			model: z.string().optional(),
			instructions: z.string().optional(),
			temperature: z.number().min(0).max(2).optional(),
			maxTokens: z.number().int().positive().optional(),
			thinking: z.enum(['auto', 'always', 'never']).optional(),
		})
		.optional(),
	voice: z
		.object({
			tts: z
				.object({
					provider: z.enum(['browser', 'elevenlabs', 'openai', 'none']),
					voiceId: z.string().optional(),
					rate: z.number().min(0.5).max(2).optional(),
					pitch: z.number().min(0).max(2).optional(),
				})
				.optional(),
			stt: z
				.object({
					provider: z.enum(['browser', 'whisper', 'none']),
					language: z.string().optional(),
					continuous: z.boolean().optional(),
				})
				.optional(),
		})
		.optional(),
	skills: z
		.array(
			z.object({
				uri: z.string(),
				version: z.string().optional(),
			}),
		)
		.optional(),
	memory: z
		.object({
			mode: z.enum(['local', 'ipfs', 'encrypted-ipfs', 'none']),
			index: z.string().optional(),
			maxTokens: z.number().int().positive().optional(),
		})
		.optional(),
	tools: z.array(z.string()).optional(),
	version: z.string().optional(),
});

// ─── Default state ────────────────────────────────────────────────────────────

function defaultState() {
	return {
		name: '',
		description: '',
		tags: '',
		image: '',
		glbFile: null,
		glbUri: '',
		bodyFormat: 'gltf-binary',
		rig: 'mixamo',
		boundingBoxHeight: 1.78,
		brainProvider: 'anthropic',
		brainModel: 'meta-llama/llama-3.3-70b-instruct:free',
		temperature: 0.7,
		maxTokens: 4096,
		thinking: 'auto',
		ttsProvider: 'browser',
		voiceId: '',
		ttsRate: 1.0,
		ttsPitch: 1.0,
		sttProvider: 'browser',
		sttLanguage: 'en-US',
		sttContinuous: false,
		installedSkills: {},
		customSkills: [],
		memoryMode: 'local',
		memoryMaxTokens: 8192,
		memoryRetentionDays: 90,
		instructions: '',
		version: '0.1.0',
	};
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const STYLE = `
	:host { display: block; }
	* { box-sizing: border-box; margin: 0; padding: 0; }
	.root {
		position: fixed; inset: 0;
		display: grid; grid-template-columns: 1fr 400px;
		background: #0b0d10; color: #f4f4f5;
		font: 14px/1.4 system-ui, -apple-system, sans-serif;
		z-index: 1; overflow: hidden;
	}
	.preview-col { position: relative; background: #1a1d21; display: flex; flex-direction: column; }
	.preview-header {
		padding: 11px 16px; border-bottom: 1px solid #1f2937;
		font: 600 11px system-ui; letter-spacing: .08em; text-transform: uppercase; color: #6b7280;
		display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
	}
	.preview-body { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
	.preview-agent-wrap { width: 320px; height: 440px; }
	.preview-agent-wrap agent-3d { width: 100%; height: 100%; }
	.preview-empty { text-align: center; color: #374151; }
	.preview-empty p { font-size: 12px; color: #4b5563; margin-top: 12px; }

	.panel { background: #0f1216; border-left: 1px solid #1f2937; display: flex; flex-direction: column; min-height: 0; position: relative; }
	.panel-header { padding: 13px 18px; border-bottom: 1px solid #1f2937; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }
	.panel-header h2 { font: 600 15px system-ui; }
	.v2-badge { font: 700 10px system-ui; color: #3b82f6; letter-spacing: .05em; }

	.tab-bar { display: flex; border-bottom: 1px solid #1f2937; flex-shrink: 0; }
	.tab-btn { padding: 8px 14px; background: transparent; border: 0; border-bottom: 2px solid transparent; color: #6b7280; font: 13px system-ui; cursor: pointer; margin-bottom: -1px; }
	.tab-btn[aria-selected="true"] { color: #f4f4f5; border-bottom-color: #3b82f6; }
	.tab-panel { display: none; flex-direction: column; flex: 1; min-height: 0; }
	.tab-panel.active { display: flex; }

	.form-scroll { overflow-y: auto; flex: 1; padding-bottom: 70px; }

	details { border-bottom: 1px solid #1f2937; }
	details > summary {
		padding: 10px 18px; font: 600 11px system-ui; letter-spacing: .08em; text-transform: uppercase;
		color: #9ca3af; cursor: pointer; user-select: none; list-style: none;
		display: flex; align-items: center; justify-content: space-between;
	}
	details > summary::after { content: '›'; font-size: 16px; transition: transform .15s; color: #4b5563; }
	details[open] > summary::after { transform: rotate(90deg); }
	details > summary::-webkit-details-marker { display: none; }
	.section-body { padding: 4px 18px 14px; }

	.field { margin: 8px 0; }
	.field label { display: block; font-size: 11px; color: #9ca3af; margin-bottom: 4px; }
	.field input, .field select, .field textarea {
		width: 100%; background: #111827; color: #f4f4f5; border: 1px solid #1f2937;
		border-radius: 6px; padding: 6px 8px; font: 13px system-ui;
	}
	.field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: #3b82f6; }
	.field textarea { font-family: ui-monospace, Menlo, monospace; resize: vertical; min-height: 100px; }
	.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
	.field-error { color: #f87171; font-size: 11px; margin-top: 3px; display: none; }
	.field-error.show { display: block; }
	.field-hint { color: #4b5563; font-size: 11px; margin-top: 3px; }

	input[type="range"] { padding: 0; accent-color: #3b82f6; }
	.slider-row { display: grid; grid-template-columns: 1fr 44px; gap: 8px; align-items: center; }
	.slider-val { text-align: right; font: 12px ui-monospace, monospace; color: #9ca3af; }

	.drop-zone {
		border: 1px dashed #374151; border-radius: 8px; padding: 16px;
		text-align: center; cursor: pointer; transition: border-color .15s, background .15s;
		font-size: 12px; color: #6b7280;
	}
	.drop-zone:hover, .drop-zone.drag { border-color: #3b82f6; background: rgba(59,130,246,.05); }
	.drop-zone.filled { border-style: solid; border-color: #374151; color: #9ca3af; }
	.drop-zone input[type="file"] { display: none; }

	.skill-item { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 8px 10px; background: #111827; border: 1px solid #1f2937; border-radius: 8px; margin: 6px 0; font-size: 12px; transition: border-color .15s, transform .15s; }
	.skill-item:hover { border-color: #374151; }
	.skill-item.installed { border-color: #2563eb; background: linear-gradient(180deg, rgba(37,99,235,.08), #111827); }
	.skill-item-info { flex: 1; min-width: 0; }
	.skill-item-info .skill-item-name { font-weight: 600; color: #e5e7eb; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
	.skill-item-info .skill-item-desc { color: #9ca3af; font-size: 11px; margin-top: 3px; line-height: 1.4; }
	.skill-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
	.skill-tag { font: 600 9px/1 system-ui; letter-spacing: .04em; text-transform: uppercase; color: #93c5fd; background: rgba(59,130,246,.12); border: 1px solid rgba(59,130,246,.25); padding: 3px 6px; border-radius: 4px; }
	.skill-tag[data-chain="solana"] { color: #c4b5fd; background: rgba(139,92,246,.14); border-color: rgba(139,92,246,.28); }
	.skill-tag[data-chain="evm"] { color: #93c5fd; background: rgba(59,130,246,.14); border-color: rgba(59,130,246,.28); }
	.skill-tag[data-kind="readonly"] { color: #6ee7b7; background: rgba(16,185,129,.12); border-color: rgba(16,185,129,.28); }
	.skill-tag[data-kind="payments"] { color: #fbbf24; background: rgba(234,179,8,.12); border-color: rgba(234,179,8,.28); }
	.skill-actions { display: flex; flex-direction: column; gap: 4px; flex-shrink: 0; align-items: flex-end; }
	.skill-toggle { background: transparent; border: 1px solid #374151; color: #9ca3af; border-radius: 5px; padding: 4px 10px; font: 600 11px system-ui; cursor: pointer; flex-shrink: 0; transition: all .12s; }
	.skill-toggle:hover { border-color: #6b7280; color: #d1d5db; }
	.skill-toggle.on { background: #1e3a5f; border-color: #3b82f6; color: #93c5fd; }
	.skill-toggle.on:hover { background: #1e40af; }
	.skill-preview-btn { font: 10px system-ui; color: #6b7280; background: none; border: 0; cursor: pointer; padding: 0; }
	.skill-preview-btn:hover { color: #9ca3af; }
	.skill-tools-preview { margin-top: 8px; padding: 8px; background: #0b1220; border: 1px solid #1f2937; border-radius: 6px; display: none; }
	.skill-tools-preview.open { display: block; }
	.skill-tools-preview h5 { font: 600 9px/1 system-ui; letter-spacing: .08em; text-transform: uppercase; color: #6b7280; margin: 0 0 6px; }
	.skill-tools-preview ul { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 4px; }
	.skill-tools-preview li { font: 11px ui-monospace, SFMono-Regular, monospace; color: #cbd5e1; background: #1f2937; padding: 2px 6px; border-radius: 4px; }
	.skill-tools-preview .example { margin-top: 6px; font-size: 11px; color: #9ca3af; font-style: italic; }
	.skill-filters { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
	.skill-chip { font: 600 10px/1 system-ui; letter-spacing: .04em; text-transform: uppercase; color: #9ca3af; background: #1f2937; border: 1px solid #1f2937; padding: 5px 9px; border-radius: 999px; cursor: pointer; transition: all .12s; }
	.skill-chip:hover { color: #d1d5db; border-color: #374151; }
	.skill-chip.active { color: #93c5fd; background: rgba(59,130,246,.18); border-color: rgba(59,130,246,.38); }
	.skill-empty { font-size: 12px; color: #4b5563; padding: 12px; text-align: center; border: 1px dashed #1f2937; border-radius: 6px; }
	.skill-custom-row { display: flex; gap: 6px; margin-top: 8px; }
	.skill-custom-row input { flex: 1; background: #111827; color: #f4f4f5; border: 1px solid #1f2937; border-radius: 6px; padding: 6px 8px; font: 12px system-ui; }
	.skill-custom-row input:focus { outline: none; border-color: #3b82f6; }

	.validator-idle { color: #4b5563; font-size: 12px; }
	.badge { padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; }
	.badge-err { background: rgba(239,68,68,.15); color: #f87171; }
	.badge-warn { background: rgba(234,179,8,.15); color: #fbbf24; }
	.badge-ok { background: rgba(34,197,94,.15); color: #4ade80; }
	.validator-detail { font-size: 11px; color: #6b7280; margin-top: 6px; padding: 8px; background: #111827; border-radius: 6px; display: none; white-space: pre-wrap; max-height: 160px; overflow-y: auto; }
	.validator-detail.open { display: block; }
	.validator-toggle { font-size: 11px; color: #4b5563; cursor: pointer; background: none; border: 0; padding: 0; margin-top: 4px; }
	.validator-toggle:hover { color: #9ca3af; }

	.char-counter { text-align: right; font-size: 11px; color: #4b5563; margin-top: 3px; }
	.md-preview { font-size: 12px; color: #9ca3af; line-height: 1.6; margin-top: 8px; border-top: 1px solid #1f2937; padding-top: 8px; min-height: 40px; }
	.md-preview h1, .md-preview h2, .md-preview h3 { color: #e5e7eb; margin: 6px 0 3px; }
	.md-preview code { background: #111827; padding: 1px 4px; border-radius: 3px; font-size: 11px; font-family: ui-monospace, monospace; }
	.md-preview pre { background: #111827; padding: 8px; border-radius: 6px; overflow-x: auto; }
	.md-preview blockquote { border-left: 2px solid #374151; padding-left: 8px; color: #6b7280; }

	.raw-scroll { flex: 1; overflow-y: auto; padding: 12px 18px 70px; }
	.raw-textarea {
		width: 100%; min-height: 360px; background: #0a0d12; color: #a7f3d0;
		border: 1px solid #1f2937; border-radius: 8px; padding: 12px;
		font: 11px/1.5 ui-monospace, Menlo, monospace; resize: vertical;
	}
	.raw-textarea:focus { outline: none; border-color: #3b82f6; }
	.raw-error { color: #f87171; font-size: 11px; margin-top: 6px; min-height: 16px; }
	.raw-apply { margin-top: 6px; background: #1e3a5f; border: 1px solid #3b82f6; color: #93c5fd; border-radius: 6px; padding: 5px 12px; font: 12px system-ui; cursor: pointer; display: none; }
	.raw-apply.show { display: inline-block; }
	.raw-apply:hover { background: #1d4ed8; color: #fff; }

	.actions-bar { position: absolute; bottom: 0; left: 0; right: 0; padding: 10px 18px; background: #0f1216; border-top: 1px solid #1f2937; display: flex; gap: 6px; }
	.btn { background: #3b82f6; color: #fff; border: 0; border-radius: 7px; padding: 9px 12px; font: 600 12px system-ui; cursor: pointer; }
	.btn:hover { filter: brightness(1.1); }
	.btn:disabled { opacity: .4; cursor: not-allowed; filter: none; }
	.btn.secondary { background: transparent; border: 1px solid #1f2937; color: #e5e7eb; }
	.btn.success { background: #22c55e; }
	.btn-icon { font-size: 13px; }

	.ipfs-result { background: #0a2818; border: 1px solid #166534; border-radius: 6px; padding: 8px 10px; font: 11px ui-monospace, monospace; color: #4ade80; word-break: break-all; margin-top: 8px; display: none; }
	.ipfs-result.show { display: block; }
	.ipfs-copy { display: inline-block; margin-left: 8px; background: none; border: 1px solid #166534; color: #4ade80; border-radius: 4px; padding: 1px 7px; font: 10px system-ui; cursor: pointer; }
	.ipfs-copy:hover { background: rgba(34,197,94,.1); }
`;

// ─── Main export ──────────────────────────────────────────────────────────────

export function mountManifestBuilder(rootEl, options = {}) {
	let state = defaultState();
	try {
		const saved = localStorage.getItem(DRAFT_KEY);
		if (saved) {
			const parsed = JSON.parse(saved);
			// glbFile can't be serialized; omit it
			delete parsed.glbFile;
			Object.assign(state, parsed);
		}
	} catch {}

	const host = document.createElement('div');
	const shadow = host.attachShadow({ mode: 'open' });
	rootEl.appendChild(host);

	let glbBlobUrl = null;
	let allSkills = [];
	let validReport = null;
	let ipfsCid = null;
	let _draftTimer = null;
	let _prevTimer = null;

	shadow.innerHTML = `
		<style>${STYLE}</style>
		<div class="root">
			<div class="preview-col">
				<div class="preview-header">
					<span>Live Preview</span>
					<span id="prev-label" style="color:#4b5563;font-weight:400">—</span>
				</div>
				<div class="preview-body">
					<div class="preview-empty" id="prev-empty">
						<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
						<p>Drop a GLB in Body to preview</p>
					</div>
					<div class="preview-agent-wrap" id="prev-wrap" style="display:none">
						<agent-3d eager kiosk id="prev-agent"></agent-3d>
					</div>
				</div>
			</div>
			<aside class="panel">
				<div class="panel-header">
					<h2>Manifest Builder</h2>
					<span class="v2-badge">v2</span>
				</div>
				<div class="tab-bar">
					<button class="tab-btn" aria-selected="true" data-tab="form">Form</button>
					<button class="tab-btn" aria-selected="false" data-tab="raw">Raw JSON</button>
				</div>
				<div class="tab-panel active" data-panel="form">
					<div class="form-scroll" id="form-scroll"></div>
				</div>
				<div class="tab-panel" data-panel="raw">
					<div class="raw-scroll">
						<textarea class="raw-textarea" id="raw-ta" spellcheck="false"></textarea>
						<div class="raw-error" id="raw-err"></div>
						<button class="raw-apply" id="raw-apply">Apply to form ↑</button>
					</div>
				</div>
				<div class="actions-bar">
					<button class="btn secondary" id="btn-zip" title="Download ZIP">ZIP</button>
					<button class="btn secondary" id="btn-ipfs" title="Pin to IPFS">IPFS</button>
					<button class="btn" id="btn-chain">Register →</button>
				</div>
			</aside>
		</div>
	`;

	const $ = (s) => shadow.querySelector(s);

	// Build form once and bind events
	buildForm();

	// Tab switching
	shadow.querySelectorAll('.tab-btn').forEach((btn) => {
		btn.addEventListener('click', () => {
			const tab = btn.dataset.tab;
			shadow
				.querySelectorAll('.tab-btn')
				.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
			shadow
				.querySelectorAll('.tab-panel')
				.forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
			if (tab === 'raw') syncRawJson();
		});
	});

	// Raw JSON tab
	const rawTa = $('#raw-ta');
	const rawErr = $('#raw-err');
	const rawApply = $('#raw-apply');

	rawTa.addEventListener('input', () => {
		rawErr.textContent = '';
		rawApply.classList.remove('show');
		try {
			JSON.parse(rawTa.value); // just validate syntax first
			rawApply.classList.add('show');
		} catch (e) {
			rawErr.textContent = 'JSON error: ' + e.message;
		}
	});

	rawApply.addEventListener('click', () => {
		try {
			const parsed = JSON.parse(rawTa.value);
			hydrateFromManifest(parsed);
			hydrateForm();
			scheduleDraft();
			schedulePreview();
			rawErr.textContent = '';
			rawApply.classList.remove('show');
		} catch (e) {
			rawErr.textContent = 'Parse error: ' + e.message;
		}
	});

	// Action buttons
	$('#btn-zip').addEventListener('click', downloadZip);
	$('#btn-ipfs').addEventListener('click', pinIpfs);
	$('#btn-chain').addEventListener('click', () => {
		const hash = ipfsCid ? `register=1&manifest=ipfs://${ipfsCid}` : 'register=1';
		window.location.hash = hash;
	});

	// Fetch skills index
	fetch('/skills-index.json')
		.then((r) => r.json())
		.then((data) => {
			allSkills = data;
			refreshSkillsList();
		})
		.catch(() => {});

	schedulePreview();

	return { state, host };

	// ── Form building ──────────────────────────────────────────────────────────

	const agentId = options.agentId || null;

	function buildForm() {
		const scroll = $('#form-scroll');
		scroll.innerHTML = [
			identityHtml(),
			bodyHtml(),
			brainHtml(),
			voiceHtml(),
			personaHtml(),
			skillsHtml(),
			memoryHtml(),
			instructionsHtml(),
			provenanceHtml(),
		].join('');
		bindEvents();
		hydrateForm();
	}

	function identityHtml() {
		return `<details open>
			<summary>Identity</summary>
			<div class="section-body">
				<div class="field">
					<label>Name *</label>
					<input id="f-name" type="text" maxlength="100" placeholder="Coach Leo">
					<div class="field-error" id="err-name"></div>
				</div>
				<div class="field">
					<label>Description</label>
					<textarea id="f-desc" rows="3" maxlength="1000" placeholder="What does this agent do?"></textarea>
				</div>
				<div class="field">
					<label>Tags (comma-separated)</label>
					<input id="f-tags" type="text" placeholder="coach, sports, argentina">
				</div>
				<div class="field">
					<label>Image URL</label>
					<input id="f-image" type="text" placeholder="ipfs://... or https://...">
					<div class="field-hint">Leave blank to use GLB thumbnail</div>
				</div>
			</div>
		</details>`;
	}

	function bodyHtml() {
		return `<details open>
			<summary>Body</summary>
			<div class="section-body">
				<div class="field">
					<label>GLB File</label>
					<div class="drop-zone" id="glb-drop" role="button" tabindex="0" aria-label="Drop GLB file">
						<input type="file" id="glb-input" accept=".glb,.gltf">
						<span id="glb-label">Drop .glb / .gltf or click to browse</span>
					</div>
				</div>
				<div class="field">
					<label>Body URI (if already hosted)</label>
					<input id="f-body-uri" type="text" placeholder="ipfs://... or https://...">
					<div class="field-hint">Leave blank when using file drop above</div>
				</div>
				<div class="field-row">
					<div class="field">
						<label>Format</label>
						<select id="f-body-format">
							${BODY_FORMATS.map((f) => `<option value="${f}">${f}</option>`).join('')}
						</select>
					</div>
					<div class="field">
						<label>Rig</label>
						<select id="f-body-rig">
							${RIG_TYPES.map((r) => `<option value="${r}">${r}</option>`).join('')}
						</select>
					</div>
				</div>
				<div class="field">
					<label>Bounding Box Height (m)</label>
					<div class="slider-row">
						<input type="range" id="f-body-height" min="0.5" max="3.0" step="0.01" value="1.78">
						<span class="slider-val" id="f-body-height-val">1.78</span>
					</div>
				</div>
			</div>
		</details>`;
	}

	function brainHtml() {
		const modelOpts = (models) =>
			models.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
		const groupedModelOpts = `
			<optgroup label="Free — host-paid (recommended)">${modelOpts(FREE_MODELS)}</optgroup>
			<optgroup label="Paid Claude (host's Anthropic key)">${modelOpts(ANTHROPIC_MODELS)}</optgroup>
		`;
		return `<details>
			<summary>Brain</summary>
			<div class="section-body">
				<div class="field">
					<label>Provider</label>
					<select id="f-brain-provider">
						${BRAIN_PROVIDERS.map((p) => `<option value="${p}">${p}</option>`).join('')}
					</select>
				</div>
				<div class="field" id="brain-model-wrap">
					<label>Model</label>
					<select id="f-brain-model">
						${groupedModelOpts}
					</select>
				</div>
				<div class="field">
					<label>Temperature</label>
					<div class="slider-row">
						<input type="range" id="f-brain-temp" min="0" max="2" step="0.01" value="0.7">
						<span class="slider-val" id="f-brain-temp-val">0.70</span>
					</div>
				</div>
				<div class="field-row">
					<div class="field">
						<label>Max Tokens</label>
						<input type="number" id="f-brain-maxtokens" min="256" max="32768" step="256" value="4096">
					</div>
					<div class="field">
						<label>Thinking</label>
						<select id="f-brain-thinking">
							${THINKING_OPTS.map((t) => `<option value="${t}">${t}</option>`).join('')}
						</select>
					</div>
				</div>
			</div>
		</details>`;
	}

	function voiceHtml() {
		return `<details>
			<summary>Voice</summary>
			<div class="section-body">
				<div class="field">
					<label>TTS Provider</label>
					<select id="f-tts-provider">
						${TTS_PROVIDERS.map((p) => `<option value="${p}">${p}</option>`).join('')}
					</select>
				</div>
				<div id="tts-secondary">
					<div class="field" id="tts-voiceid-wrap" style="display:none">
						<label>Voice ID (ElevenLabs)</label>
						<input id="f-tts-voiceid" type="text" placeholder="21m00Tcm4TlvDq8ikWAM">
					</div>
					<div class="field-row">
						<div class="field">
							<label>Rate</label>
							<div class="slider-row">
								<input type="range" id="f-tts-rate" min="0.5" max="2" step="0.1" value="1.0">
								<span class="slider-val" id="f-tts-rate-val">1.0</span>
							</div>
						</div>
						<div class="field">
							<label>Pitch</label>
							<div class="slider-row">
								<input type="range" id="f-tts-pitch" min="0" max="2" step="0.1" value="1.0">
								<span class="slider-val" id="f-tts-pitch-val">1.0</span>
							</div>
						</div>
					</div>
				</div>
				<div class="field" style="margin-top:10px">
					<label>STT Provider</label>
					<select id="f-stt-provider">
						${STT_PROVIDERS.map((p) => `<option value="${p}">${p}</option>`).join('')}
					</select>
				</div>
				<div id="stt-secondary">
					<div class="field">
						<label>Language</label>
						<input id="f-stt-lang" type="text" placeholder="en-US">
					</div>
					<div class="field">
						<label style="display:flex;align-items:center;gap:6px">
							<input type="checkbox" id="f-stt-continuous" style="width:auto">
							Continuous listening
						</label>
					</div>
				</div>
			</div>
		</details>`;
	}

	function personaHtml() {
		if (!agentId) {
			return `<details>
				<summary>Persona</summary>
				<div class="section-body">
					<p style="color:#6b7280;font-size:13px">Save the agent first to enable persona extraction.</p>
				</div>
			</details>`;
		}
		return `<details>
			<summary>Persona</summary>
			<div class="section-body">
				<div id="persona-status"></div>
				<div id="persona-interview-mount"></div>
				<button class="btn secondary" id="btn-persona-start" style="margin-top:10px">Run interview</button>
			</div>
		</details>`;
	}

	function skillsHtml() {
		return `<details>
			<summary>Skills</summary>
			<div class="section-body">
				<input id="skill-search" type="text" placeholder="Search skills…" style="width:100%;background:#111827;color:#f4f4f5;border:1px solid #1f2937;border-radius:6px;padding:6px 8px;font:13px system-ui;margin-bottom:8px">
				<div id="skill-filters" class="skill-filters"></div>
				<div id="skills-list"></div>
				<div style="font:600 11px system-ui;letter-spacing:.06em;text-transform:uppercase;color:#4b5563;margin:10px 0 4px">Custom skill URI</div>
				<div class="skill-custom-row">
					<input id="f-skill-uri" type="text" placeholder="https://... or ipfs://...">
					<button class="btn" id="btn-skill-add" style="flex-shrink:0;padding:6px 10px;font-size:12px">Add</button>
				</div>
				<div id="custom-skills-list"></div>
			</div>
		</details>`;
	}

	function memoryHtml() {
		return `<details>
			<summary>Memory</summary>
			<div class="section-body">
				<div class="field">
					<label>Mode</label>
					<select id="f-mem-mode">
						${MEMORY_MODES.map((m) => `<option value="${m}">${m}</option>`).join('')}
					</select>
				</div>
				<div class="field">
					<label>Max Tokens</label>
					<input type="number" id="f-mem-maxtokens" min="256" max="65536" step="256" value="8192">
				</div>
				<details style="border:none;border-top:1px solid #1f2937;margin-top:8px">
					<summary style="font-size:11px;color:#4b5563;padding:8px 0;letter-spacing:.04em">Advanced</summary>
					<div class="field" style="margin-top:4px">
						<label>Timeline retention (days)</label>
						<input type="number" id="f-mem-retention" min="1" max="3650" value="90">
					</div>
				</details>
			</div>
		</details>`;
	}

	function instructionsHtml() {
		return `<details>
			<summary>Instructions</summary>
			<div class="section-body">
				<div class="field">
					<label>System prompt (markdown)</label>
					<textarea id="f-instructions" rows="8" placeholder="You are a helpful agent. When greeted, wave() at the user."></textarea>
					<div class="char-counter" id="instructions-counter">0 chars</div>
					<div class="field-hint">Frontmatter (name/model/temperature) is auto-prepended on export.</div>
				</div>
				<div class="md-preview" id="md-preview"></div>
			</div>
		</details>`;
	}

	function provenanceHtml() {
		return `<details>
			<summary>Provenance</summary>
			<div class="section-body">
				<div id="validator-content">
					<div class="validator-idle">Drop a GLB to run the validator.</div>
				</div>
			</div>
		</details>`;
	}

	// ── Event binding ──────────────────────────────────────────────────────────

	function bindEvents() {
		const on = (id, ev, fn) => {
			const el = $(id);
			if (el) el.addEventListener(ev, fn);
		};

		on('#f-name', 'input', (e) => {
			state.name = e.target.value;
			showFieldError('#err-name', '');
			scheduleDraft();
			schedulePreview();
		});
		on('#f-desc', 'input', (e) => {
			state.description = e.target.value;
			scheduleDraft();
		});
		on('#f-tags', 'input', (e) => {
			state.tags = e.target.value;
			scheduleDraft();
		});
		on('#f-image', 'input', (e) => {
			state.image = e.target.value;
			scheduleDraft();
		});

		// Body drop zone
		const drop = $('#glb-drop');
		const input = $('#glb-input');
		drop.addEventListener('click', () => input.click());
		drop.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') input.click();
		});
		drop.addEventListener('dragover', (e) => {
			e.preventDefault();
			drop.classList.add('drag');
		});
		drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
		drop.addEventListener('drop', (e) => {
			e.preventDefault();
			drop.classList.remove('drag');
			handleGlbFile(e.dataTransfer.files[0]);
		});
		input.addEventListener('change', (e) => handleGlbFile(e.target.files[0]));

		on('#f-body-uri', 'input', (e) => {
			state.glbUri = e.target.value;
			scheduleDraft();
			schedulePreview();
		});
		on('#f-body-format', 'change', (e) => {
			state.bodyFormat = e.target.value;
			scheduleDraft();
		});
		on('#f-body-rig', 'change', (e) => {
			state.rig = e.target.value;
			scheduleDraft();
		});
		on('#f-body-height', 'input', (e) => {
			state.boundingBoxHeight = parseFloat(e.target.value) || 1.78;
			const v = $('#f-body-height-val');
			if (v) v.textContent = state.boundingBoxHeight.toFixed(2);
			scheduleDraft();
		});

		on('#f-brain-provider', 'change', (e) => {
			state.brainProvider = e.target.value;
			refreshModelDropdown();
			scheduleDraft();
		});
		on('#f-brain-model', 'change', (e) => {
			state.brainModel = e.target.value;
			scheduleDraft();
		});
		on('#f-brain-temp', 'input', (e) => {
			state.temperature = parseFloat(e.target.value);
			const v = $('#f-brain-temp-val');
			if (v) v.textContent = state.temperature.toFixed(2);
			scheduleDraft();
		});
		on('#f-brain-maxtokens', 'change', (e) => {
			state.maxTokens = parseInt(e.target.value) || 4096;
			scheduleDraft();
		});
		on('#f-brain-thinking', 'change', (e) => {
			state.thinking = e.target.value;
			scheduleDraft();
		});

		on('#f-tts-provider', 'change', (e) => {
			state.ttsProvider = e.target.value;
			refreshTtsSecondary();
			scheduleDraft();
		});
		on('#f-tts-voiceid', 'input', (e) => {
			state.voiceId = e.target.value;
			scheduleDraft();
		});
		on('#f-tts-rate', 'input', (e) => {
			state.ttsRate = parseFloat(e.target.value);
			const v = $('#f-tts-rate-val');
			if (v) v.textContent = state.ttsRate.toFixed(1);
			scheduleDraft();
		});
		on('#f-tts-pitch', 'input', (e) => {
			state.ttsPitch = parseFloat(e.target.value);
			const v = $('#f-tts-pitch-val');
			if (v) v.textContent = state.ttsPitch.toFixed(1);
			scheduleDraft();
		});

		on('#f-stt-provider', 'change', (e) => {
			state.sttProvider = e.target.value;
			refreshSttSecondary();
			scheduleDraft();
		});
		on('#f-stt-lang', 'input', (e) => {
			state.sttLanguage = e.target.value;
			scheduleDraft();
		});
		on('#f-stt-continuous', 'change', (e) => {
			state.sttContinuous = e.target.checked;
			scheduleDraft();
		});

		if (agentId) {
			let _interview = null;
			on('#btn-persona-start', 'click', () => {
				const mount = $('#persona-interview-mount');
				const btn = $('#btn-persona-start');
				if (!mount) return;
				if (_interview) { _interview.destroy(); _interview = null; }
				btn.style.display = 'none';
				_interview = new PersonaInterview(mount, {
					agentId,
					onComplete: ({ tone_tags, extracted_at }) => {
						const status = $('#persona-status');
						if (status) {
							const chips = (tone_tags || [])
								.map((t) => `<span style="display:inline-block;background:#1f2937;border-radius:4px;padding:2px 8px;margin:2px;font-size:12px">${t}</span>`)
								.join('');
							status.innerHTML = `<p style="color:#10b981;margin-bottom:6px">Persona extracted ✓</p><div>${chips}</div>`;
						}
						btn.textContent = 'Re-run interview';
						btn.style.display = '';
					},
				});
				_interview.mount();
			});

			// Load existing persona status on open
			fetch(`/api/agents/${agentId}/persona`, { credentials: 'include' })
				.then((r) => r.ok ? r.json() : null)
				.then((data) => {
					if (!data?.has_persona) return;
					const status = $('#persona-status');
					if (!status) return;
					const chips = (data.tone_tags || [])
						.map((t) => `<span style="display:inline-block;background:#1f2937;border-radius:4px;padding:2px 8px;margin:2px;font-size:12px">${t}</span>`)
						.join('');
					status.innerHTML = `<p style="color:#10b981;margin-bottom:6px">Persona extracted ✓</p><div>${chips}</div>`;
					const btn = $('#btn-persona-start');
					if (btn) btn.textContent = 'Re-run interview';
				})
				.catch(() => {});
		}

		on('#f-mem-mode', 'change', (e) => {
			state.memoryMode = e.target.value;
			scheduleDraft();
		});
		on('#f-mem-maxtokens', 'change', (e) => {
			state.memoryMaxTokens = parseInt(e.target.value) || 8192;
			scheduleDraft();
		});
		on('#f-mem-retention', 'change', (e) => {
			state.memoryRetentionDays = parseInt(e.target.value) || 90;
			scheduleDraft();
		});

		on('#f-instructions', 'input', (e) => {
			state.instructions = e.target.value;
			const c = $('#instructions-counter');
			if (c) c.textContent = `${e.target.value.length} chars`;
			refreshMdPreview();
			scheduleDraft();
		});

		on('#skill-search', 'input', (e) => refreshSkillsList(e.target.value));

		on('#btn-skill-add', 'click', () => {
			const el = $('#f-skill-uri');
			const uri = el?.value?.trim();
			if (!uri) return;
			state.customSkills.push({ uri, version: '' });
			el.value = '';
			refreshCustomSkillsList();
			scheduleDraft();
		});
	}

	function hydrateForm() {
		const set = (id, val) => {
			const el = $(id);
			if (el && val != null) el.value = String(val);
		};
		const setChk = (id, val) => {
			const el = $(id);
			if (el) el.checked = !!val;
		};

		set('#f-name', state.name);
		set('#f-desc', state.description);
		set('#f-tags', state.tags);
		set('#f-image', state.image);
		set('#f-body-uri', state.glbUri);
		set('#f-body-format', state.bodyFormat);
		set('#f-body-rig', state.rig);
		set('#f-body-height', state.boundingBoxHeight);
		const hv = $('#f-body-height-val');
		if (hv) hv.textContent = Number(state.boundingBoxHeight).toFixed(2);

		set('#f-brain-provider', state.brainProvider);
		refreshModelDropdown();
		set('#f-brain-model', state.brainModel);
		set('#f-brain-temp', state.temperature);
		const tv = $('#f-brain-temp-val');
		if (tv) tv.textContent = Number(state.temperature).toFixed(2);
		set('#f-brain-maxtokens', state.maxTokens);
		set('#f-brain-thinking', state.thinking);

		set('#f-tts-provider', state.ttsProvider);
		set('#f-tts-voiceid', state.voiceId);
		set('#f-tts-rate', state.ttsRate);
		const rv = $('#f-tts-rate-val');
		if (rv) rv.textContent = Number(state.ttsRate).toFixed(1);
		set('#f-tts-pitch', state.ttsPitch);
		const pv = $('#f-tts-pitch-val');
		if (pv) pv.textContent = Number(state.ttsPitch).toFixed(1);
		refreshTtsSecondary();

		set('#f-stt-provider', state.sttProvider);
		set('#f-stt-lang', state.sttLanguage);
		setChk('#f-stt-continuous', state.sttContinuous);
		refreshSttSecondary();

		set('#f-mem-mode', state.memoryMode);
		set('#f-mem-maxtokens', state.memoryMaxTokens);
		set('#f-mem-retention', state.memoryRetentionDays);

		set('#f-instructions', state.instructions);
		const cnt = $('#instructions-counter');
		if (cnt) cnt.textContent = `${(state.instructions || '').length} chars`;
		refreshMdPreview();
		refreshCustomSkillsList();
	}

	// ── Dynamic section updates ────────────────────────────────────────────────

	function refreshModelDropdown() {
		const sel = $('#f-brain-model');
		const wrap = $('#brain-model-wrap');
		if (!sel) return;
		const provider = state.brainProvider;
		if (provider === 'none' || provider === 'local') {
			if (wrap) wrap.style.display = 'none';
			return;
		}
		if (wrap) wrap.style.display = '';
		const optHtml = (m) => `<option value="${m.id}">${m.label}</option>`;
		// 'anthropic' is the proxy-routed provider — surface free models alongside
		// Claude so users default to free unless they explicitly pick paid.
		let models;
		if (provider === 'openai') {
			models = OPENAI_MODELS;
			sel.innerHTML = models.map(optHtml).join('');
		} else {
			models = [...FREE_MODELS, ...ANTHROPIC_MODELS];
			sel.innerHTML = `
				<optgroup label="Free — host-paid (recommended)">${FREE_MODELS.map(optHtml).join('')}</optgroup>
				<optgroup label="Paid Claude (host's Anthropic key)">${ANTHROPIC_MODELS.map(optHtml).join('')}</optgroup>
			`;
		}
		if (models.find((m) => m.id === state.brainModel)) {
			sel.value = state.brainModel;
		} else {
			state.brainModel = models[0].id;
			sel.value = state.brainModel;
		}
	}

	function refreshTtsSecondary() {
		const wrap = $('#tts-voiceid-wrap');
		if (wrap) wrap.style.display = state.ttsProvider === 'elevenlabs' ? '' : 'none';
	}

	function refreshSttSecondary() {
		const sec = $('#stt-secondary');
		if (sec) sec.style.display = state.sttProvider === 'none' ? 'none' : '';
	}

	// Active tag filter (only one at a time keeps the UI simple).
	let activeSkillFilter = null;
	// Memoized tool previews keyed by skill id (lazy-loaded on first expand).
	const _skillPreviews = new Map();

	function _skillTagKind(tag) {
		const t = String(tag || '').toLowerCase();
		if (t === 'solana' || t.includes('pump.fun')) return { chain: 'solana' };
		if (t === 'evm' || t === 'uniswap' || t === 'metamask' || t === 'erc7710') return { chain: 'evm' };
		if (t === 'read-only' || t === 'readonly') return { kind: 'readonly' };
		if (t === 'payments' || t === 'tip' || t === 'usdc') return { kind: 'payments' };
		return {};
	}

	function _collectFilterTags() {
		const seen = new Set();
		for (const s of allSkills) for (const t of s.tags || []) seen.add(String(t).toLowerCase());
		// Surface the curated set first if present, then alphabetical extras.
		const curated = ['solana', 'evm', 'defi', 'payments', 'read-only', 'mcp', 'pump.fun'];
		const ordered = [
			...curated.filter((t) => seen.has(t)),
			...[...seen].filter((t) => !curated.includes(t)).sort(),
		];
		return ordered;
	}

	function refreshSkillFilters() {
		const wrap = $('#skill-filters');
		if (!wrap) return;
		const tags = _collectFilterTags();
		if (tags.length === 0) { wrap.innerHTML = ''; return; }
		wrap.innerHTML = ['all', ...tags]
			.map((t) => {
				const active = (t === 'all' && !activeSkillFilter) || t === activeSkillFilter;
				return `<button class="skill-chip${active ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`;
			})
			.join('');
		wrap.querySelectorAll('.skill-chip').forEach((btn) =>
			btn.addEventListener('click', () => {
				const tag = btn.dataset.tag;
				activeSkillFilter = tag === 'all' ? null : tag;
				refreshSkillFilters();
				const q = $('#skill-search')?.value || '';
				refreshSkillsList(q);
			}),
		);
	}

	async function _loadSkillPreview(sk) {
		if (_skillPreviews.has(sk.id)) return _skillPreviews.get(sk.id);
		// Resolve relative bundle URIs against the site origin.
		const base = sk.uri.endsWith('/') ? sk.uri : `${sk.uri}/`;
		try {
			const res = await fetch(`${base}tools.json`);
			if (!res.ok) throw new Error(String(res.status));
			const json = await res.json();
			const preview = { tools: (json.tools || []).map((t) => t.name).filter(Boolean) };
			_skillPreviews.set(sk.id, preview);
			return preview;
		} catch {
			const preview = { tools: [], error: true };
			_skillPreviews.set(sk.id, preview);
			return preview;
		}
	}

	function refreshSkillsList(query = '') {
		const list = $('#skills-list');
		if (!list) return;
		refreshSkillFilters();
		const q = query.toLowerCase();
		let filtered = q
			? allSkills.filter(
					(s) =>
						s.name.toLowerCase().includes(q) ||
						s.description.toLowerCase().includes(q) ||
						(s.tags || []).some((t) => t.toLowerCase().includes(q)),
				)
			: allSkills.slice();
		if (activeSkillFilter) {
			filtered = filtered.filter((s) =>
				(s.tags || []).map((t) => t.toLowerCase()).includes(activeSkillFilter),
			);
		}
		if (filtered.length === 0) {
			list.innerHTML = `<div class="skill-empty">No skills match this filter.</div>`;
			return;
		}
		list.innerHTML = '';
		for (const sk of filtered) {
			const installed = !!state.installedSkills[sk.id];
			const tags = sk.tags || [];
			const tagsHtml = tags
				.map((t) => {
					const kind = _skillTagKind(t);
					const attrs = Object.entries(kind).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
					return `<span class="skill-tag"${attrs}>${esc(t)}</span>`;
				})
				.join('');
			const item = document.createElement('div');
			item.className = `skill-item${installed ? ' installed' : ''}`;
			item.innerHTML = `
				<div class="skill-item-info">
					<div class="skill-item-name">${esc(sk.name)} <span style="color:#4b5563;font-weight:400;font-size:10px">v${esc(sk.version)}</span></div>
					<div class="skill-item-desc">${esc(sk.description)}</div>
					${tagsHtml ? `<div class="skill-tags">${tagsHtml}</div>` : ''}
					<div class="skill-tools-preview" data-preview-for="${esc(sk.id)}"></div>
				</div>
				<div class="skill-actions">
					<button class="skill-toggle ${installed ? 'on' : ''}" data-skill-id="${esc(sk.id)}">${installed ? 'Installed' : 'Install'}</button>
					<button class="skill-preview-btn" data-preview-toggle="${esc(sk.id)}">What can it do?</button>
				</div>
			`;
			item.querySelector('.skill-toggle').addEventListener('click', () => {
				if (state.installedSkills[sk.id]) {
					delete state.installedSkills[sk.id];
				} else {
					state.installedSkills[sk.id] = { version: sk.version };
				}
				refreshSkillsList(query);
				scheduleDraft();
			});
			const previewEl = item.querySelector(`[data-preview-for="${sk.id}"]`);
			item.querySelector('[data-preview-toggle]').addEventListener('click', async () => {
				if (previewEl.classList.contains('open')) {
					previewEl.classList.remove('open');
					return;
				}
				if (!previewEl.dataset.loaded) {
					previewEl.innerHTML = `<div class="example">Loading…</div>`;
					const preview = await _loadSkillPreview(sk);
					if (preview.error) {
						previewEl.innerHTML = `<div class="example">Tool list unavailable for this bundle.</div>`;
					} else if (preview.tools.length === 0) {
						previewEl.innerHTML = `<div class="example">This skill exposes UI actions, not LLM tools.</div>`;
					} else {
						const example = _exampleForSkill(sk);
						previewEl.innerHTML = `
							<h5>Tools (${preview.tools.length})</h5>
							<ul>${preview.tools.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
							${example ? `<div class="example">Try: <em>${esc(example)}</em></div>` : ''}
						`;
					}
					previewEl.dataset.loaded = '1';
				}
				previewEl.classList.add('open');
			});
			list.appendChild(item);
		}
	}

	// Curated example prompts keyed by skill id. Falls back to nothing.
	function _exampleForSkill(sk) {
		const examples = {
			'pump-fun': "what's the king of the hill on pump.fun right now?",
			wave: 'wave at me!',
			dance: 'dance for me',
			'explain-gltf': "tell me about this model's animations",
			dca: 'set up a weekly $50 USDC → WETH DCA',
		};
		return examples[sk.id] || '';
	}

	function refreshCustomSkillsList() {
		const list = $('#custom-skills-list');
		if (!list) return;
		list.innerHTML = '';
		state.customSkills.forEach((sk, i) => {
			const row = document.createElement('div');
			row.className = 'skill-item';
			row.style.marginTop = '4px';
			row.innerHTML = `
				<div class="skill-item-info">
					<div class="skill-item-name" style="font-size:11px;word-break:break-all">${esc(sk.uri)}</div>
				</div>
				<button class="skill-toggle" style="color:#f87171;border-color:#7f1d1d" data-i="${i}">Remove</button>
			`;
			row.querySelector('button').addEventListener('click', () => {
				state.customSkills.splice(i, 1);
				refreshCustomSkillsList();
				scheduleDraft();
			});
			list.appendChild(row);
		});
	}

	function refreshMdPreview() {
		const el = $('#md-preview');
		if (el) el.innerHTML = renderMarkdown(state.instructions || '');
	}

	function showFieldError(id, msg) {
		const el = $(id);
		if (!el) return;
		el.textContent = msg;
		el.classList.toggle('show', !!msg);
	}

	// ── GLB handling ───────────────────────────────────────────────────────────

	function handleGlbFile(file) {
		if (!file) return;
		if (!/\.(glb|gltf)$/i.test(file.name)) {
			alert('Must be a .glb or .gltf file');
			return;
		}
		state.glbFile = file;
		if (glbBlobUrl) URL.revokeObjectURL(glbBlobUrl);
		glbBlobUrl = URL.createObjectURL(file);

		const lbl = $('#glb-label');
		const drop = $('#glb-drop');
		if (lbl) lbl.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
		if (drop) drop.classList.add('filled');

		schedulePreview();
		runValidator(file);
	}

	async function runValidator(file) {
		const vc = $('#validator-content');
		if (!vc) return;
		vc.innerHTML = `<div class="validator-idle">Running validator…</div>`;
		try {
			const { validateBytes } = await import('gltf-validator');
			const bytes = new Uint8Array(await file.arrayBuffer());
			const result = await validateBytes(bytes);
			validReport = result;
			const { numErrors: ne, numWarnings: nw } = result.issues;
			const errBadge =
				ne > 0
					? `<span class="badge badge-err">${ne} error${ne !== 1 ? 's' : ''}</span>`
					: '';
			const warnBadge =
				nw > 0
					? `<span class="badge badge-warn">${nw} warning${nw !== 1 ? 's' : ''}</span>`
					: '';
			const okBadge = ne === 0 && nw === 0 ? `<span class="badge badge-ok">Clean</span>` : '';
			vc.innerHTML = `
				<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
					${errBadge}${warnBadge}${okBadge}
					<button class="validator-toggle" id="val-toggle">Details ▾</button>
				</div>
				<div class="validator-detail" id="val-detail">${buildValidatorDetail(result)}</div>
			`;
			vc.querySelector('#val-toggle').addEventListener('click', () => {
				const d = vc.querySelector('#val-detail');
				d.classList.toggle('open');
			});
		} catch (e) {
			vc.innerHTML = `<div class="validator-idle">Validator unavailable: ${esc(e.message)}</div>`;
		}
	}

	function buildValidatorDetail(result) {
		const msgs = result.issues.messages.slice(0, 50);
		if (msgs.length === 0) return 'No issues found.';
		return msgs
			.map((m) => `[${m.severity === 0 ? 'ERR' : 'WARN'}] ${esc(m.message)}`)
			.join('\n');
	}

	// ── Preview ────────────────────────────────────────────────────────────────

	function schedulePreview() {
		clearTimeout(_prevTimer);
		_prevTimer = setTimeout(updatePreview, 500);
	}

	function updatePreview() {
		const wrap = $('#prev-wrap');
		const empty = $('#prev-empty');
		const label = $('#prev-label');
		const agent = $('#prev-agent');
		if (!wrap || !empty || !agent) return;

		const src = glbBlobUrl || state.glbUri;
		if (!src) {
			wrap.style.display = 'none';
			empty.style.display = '';
			return;
		}
		wrap.style.display = '';
		empty.style.display = 'none';
		if (label) label.textContent = state.name || 'Preview';
		agent.setAttribute('src', src);
	}

	// ── Manifest builder ───────────────────────────────────────────────────────

	function buildManifest(forExport = false) {
		const tags = state.tags
			? state.tags
					.split(',')
					.map((t) => t.trim())
					.filter(Boolean)
			: undefined;
		const bodyUri = forExport
			? state.glbFile
				? 'body.glb'
				: state.glbUri || 'body.glb'
			: glbBlobUrl || state.glbUri || 'body.glb';

		const m = {
			$schema: 'https://3d-agent.io/schemas/manifest/0.1.json',
			spec: 'agent-manifest/0.1',
			name: state.name || 'Unnamed Agent',
		};
		if (state.description) m.description = state.description;
		if (state.image) m.image = state.image;
		if (tags?.length) m.tags = tags;

		m.body = {
			uri: bodyUri,
			format: state.bodyFormat,
			rig: state.rig,
			boundingBoxHeight: state.boundingBoxHeight,
		};

		if (state.brainProvider !== 'none') {
			m.brain = {
				provider: state.brainProvider,
				model: state.brainModel,
				instructions: 'instructions.md',
				temperature: state.temperature,
				maxTokens: state.maxTokens,
				thinking: state.thinking,
			};
		}

		const tts = { provider: state.ttsProvider };
		if (state.ttsProvider === 'elevenlabs' && state.voiceId) tts.voiceId = state.voiceId;
		if (state.ttsRate !== 1.0) tts.rate = state.ttsRate;
		if (state.ttsPitch !== 1.0) tts.pitch = state.ttsPitch;
		const stt = { provider: state.sttProvider, language: state.sttLanguage };
		if (state.sttContinuous) stt.continuous = true;
		m.voice = { tts, stt };

		const skills = [
			...Object.entries(state.installedSkills)
				.map(([id, cfg]) => {
					const sk = allSkills.find((s) => s.id === id);
					if (!sk) return null;
					return { uri: sk.uri, ...(cfg.version ? { version: cfg.version } : {}) };
				})
				.filter(Boolean),
			...state.customSkills,
		];
		if (skills.length) m.skills = skills;

		if (state.memoryMode !== 'none') {
			m.memory = {
				mode: state.memoryMode,
				index: 'memory/MEMORY.md',
				maxTokens: state.memoryMaxTokens,
			};
		}

		m.version = state.version || '0.1.0';
		m.created = new Date().toISOString();
		return m;
	}

	function validateManifest() {
		const m = buildManifest();
		const result = ManifestSchema.safeParse(m);
		if (!result.success) {
			const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
			// Show first error on the relevant field
			const first = result.error.errors[0];
			if (first.path[0] === 'name') showFieldError('#err-name', first.message);
			return { valid: false, errors };
		}
		showFieldError('#err-name', '');
		return { valid: true, errors: [] };
	}

	function hydrateFromManifest(m) {
		if (typeof m.name === 'string') state.name = m.name;
		if (typeof m.description === 'string') state.description = m.description;
		if (Array.isArray(m.tags)) state.tags = m.tags.join(', ');
		if (typeof m.image === 'string') state.image = m.image;
		if (m.body) {
			if (!glbBlobUrl && m.body.uri) state.glbUri = m.body.uri;
			if (m.body.format) state.bodyFormat = m.body.format;
			if (m.body.rig) state.rig = m.body.rig;
			if (m.body.boundingBoxHeight != null)
				state.boundingBoxHeight = m.body.boundingBoxHeight;
		}
		if (m.brain) {
			if (m.brain.provider) state.brainProvider = m.brain.provider;
			if (m.brain.model) state.brainModel = m.brain.model;
			if (typeof m.brain.temperature === 'number') state.temperature = m.brain.temperature;
			if (typeof m.brain.maxTokens === 'number') state.maxTokens = m.brain.maxTokens;
			if (m.brain.thinking) state.thinking = m.brain.thinking;
		}
		if (m.voice?.tts) {
			if (m.voice.tts.provider) state.ttsProvider = m.voice.tts.provider;
			if (m.voice.tts.voiceId) state.voiceId = m.voice.tts.voiceId;
			if (typeof m.voice.tts.rate === 'number') state.ttsRate = m.voice.tts.rate;
			if (typeof m.voice.tts.pitch === 'number') state.ttsPitch = m.voice.tts.pitch;
		}
		if (m.voice?.stt) {
			if (m.voice.stt.provider) state.sttProvider = m.voice.stt.provider;
			if (m.voice.stt.language) state.sttLanguage = m.voice.stt.language;
			if (typeof m.voice.stt.continuous === 'boolean')
				state.sttContinuous = m.voice.stt.continuous;
		}
		if (m.memory) {
			if (m.memory.mode) state.memoryMode = m.memory.mode;
			if (m.memory.maxTokens) state.memoryMaxTokens = m.memory.maxTokens;
		}
		if (typeof m.version === 'string') state.version = m.version;
	}

	// ── Draft save ─────────────────────────────────────────────────────────────

	function scheduleDraft() {
		clearTimeout(_draftTimer);
		_draftTimer = setTimeout(saveDraft, 800);
	}

	function saveDraft() {
		const toSave = { ...state, glbFile: null };
		try {
			localStorage.setItem(DRAFT_KEY, JSON.stringify(toSave));
		} catch {}
	}

	// ── Raw JSON sync ──────────────────────────────────────────────────────────

	function syncRawJson() {
		rawTa.value = JSON.stringify(buildManifest(false), null, 2);
		rawErr.textContent = '';
		rawApply.classList.remove('show');
	}

	// ── ZIP export ─────────────────────────────────────────────────────────────

	async function downloadZip() {
		const { valid, errors } = validateManifest();
		if (!valid) {
			alert('Validation errors:\n' + errors.join('\n'));
			return;
		}
		const btn = $('#btn-zip');
		btn.disabled = true;
		btn.textContent = '…';
		try {
			const manifest = buildManifest(true);
			const enc = new TextEncoder();
			const files = [
				{ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 2)) },
				{ name: 'instructions.md', data: enc.encode(buildInstructionsMd()) },
				{
					name: 'memory/MEMORY.md',
					data: enc.encode('# Memory\n\n<!-- Auto-generated memory seed -->\n'),
				},
			];
			if (state.glbFile) {
				files.push({
					name: 'body.glb',
					data: new Uint8Array(await state.glbFile.arrayBuffer()),
				});
			}
			const zip = buildZip(files);
			const blob = new Blob([zip], { type: 'application/zip' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${(state.name || 'agent').toLowerCase().replace(/\s+/g, '-')}-manifest.zip`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			setTimeout(() => URL.revokeObjectURL(url), 5000);
		} finally {
			btn.disabled = false;
			btn.textContent = 'ZIP';
		}
	}

	function buildInstructionsMd() {
		const lines = [
			'---',
			state.name ? `name: ${state.name}` : null,
			state.brainModel ? `model: ${state.brainModel}` : null,
			`temperature: ${state.temperature}`,
			'---',
			'',
			state.instructions || '',
		].filter((l) => l !== null);
		return lines.join('\n');
	}

	// ── IPFS pinning ───────────────────────────────────────────────────────────

	async function pinIpfs() {
		const btn = $('#btn-ipfs');
		btn.disabled = true;
		btn.textContent = 'Pinning…';
		try {
			const pinner = window.__agent3dPinner;
			if (!pinner) throw new Error('No IPFS pinner (window.__agent3dPinner not configured)');

			const manifest = buildManifest(true);
			const jsonBlob = new Blob([JSON.stringify(manifest, null, 2)], {
				type: 'application/json',
			});
			const cid = await pinner.pin(jsonBlob, 'manifest.json');
			ipfsCid = cid;

			// Show result in preview area
			$('#prev-label').textContent = `ipfs://${cid.slice(0, 12)}…`;
			btn.textContent = 'Pinned ✓';
			btn.classList.add('success');

			// Copy-to-clipboard prompt below Raw JSON tab
			const rawScroll = shadow.querySelector('.raw-scroll');
			if (rawScroll) {
				let existing = rawScroll.querySelector('.ipfs-result');
				if (!existing) {
					existing = document.createElement('div');
					existing.className = 'ipfs-result';
					rawScroll.appendChild(existing);
				}
				existing.classList.add('show');
				existing.innerHTML = `ipfs://${esc(cid)} <button class="ipfs-copy" id="ipfs-copy-btn">copy</button>`;
				existing.querySelector('#ipfs-copy-btn').addEventListener('click', async () => {
					await navigator.clipboard.writeText(`ipfs://${cid}`).catch(() => {});
					existing.querySelector('#ipfs-copy-btn').textContent = 'copied';
				});
			}
		} catch (e) {
			alert('Pin failed: ' + e.message);
			btn.textContent = 'IPFS';
		} finally {
			btn.disabled = false;
		}
	}
}

// ─── Markdown renderer (no deps) ─────────────────────────────────────────────

function renderMarkdown(src) {
	if (!src) return '';
	// Strip frontmatter
	const fmStripped = src.replace(/^---[\s\S]*?---\n?/, '');
	const lines = fmStripped.split('\n');
	let html = '';
	let inPre = false;
	for (let i = 0; i < lines.length; i++) {
		let l = lines[i];
		if (l.startsWith('```')) {
			inPre = !inPre;
			html += inPre ? '<pre>' : '</pre>';
			continue;
		}
		if (inPre) {
			html += esc(l) + '\n';
			continue;
		}
		if (/^### /.test(l)) {
			html += `<h3>${inlineHtml(l.slice(4))}</h3>`;
			continue;
		}
		if (/^## /.test(l)) {
			html += `<h2>${inlineHtml(l.slice(3))}</h2>`;
			continue;
		}
		if (/^# /.test(l)) {
			html += `<h1>${inlineHtml(l.slice(2))}</h1>`;
			continue;
		}
		if (/^> /.test(l)) {
			html += `<blockquote>${inlineHtml(l.slice(2))}</blockquote>`;
			continue;
		}
		if (l.trim() === '') {
			html += '<br>';
			continue;
		}
		html += `<p>${inlineHtml(l)}</p>`;
	}
	return html;
}

function inlineHtml(s) {
	return esc(s)
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

// ─── Minimal store-only ZIP encoder ──────────────────────────────────────────

function buildZip(files) {
	const tbl = makeCrcTable();
	const enc = new TextEncoder();

	const localParts = [];
	const centralParts = [];
	let offset = 0;

	for (const { name, data } of files) {
		const nameBytes = enc.encode(name);
		const crc = crc32(tbl, data);
		const local = localHeader(nameBytes, data.length, crc);
		localParts.push({ local, data, nameBytes, crc, offset });
		offset += local.length + data.length;
	}

	for (const f of localParts) {
		centralParts.push(centralHeader(f.nameBytes, f.data.length, f.crc, f.offset));
	}

	const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
	const centralOffset = offset;
	const eocd = endRecord(localParts.length, centralSize, centralOffset);

	const chunks = [...localParts.flatMap((f) => [f.local, f.data]), ...centralParts, eocd];
	const total = chunks.reduce((s, c) => s + c.length, 0);
	const out = new Uint8Array(total);
	let pos = 0;
	for (const c of chunks) {
		out.set(c, pos);
		pos += c.length;
	}
	return out;
}

function localHeader(nameBytes, size, crc) {
	const h = new Uint8Array(30 + nameBytes.length);
	const v = new DataView(h.buffer);
	v.setUint32(0, 0x04034b50, true); // signature
	v.setUint16(4, 20, true); // version needed
	v.setUint16(6, 0, true); // flags
	v.setUint16(8, 0, true); // compression = stored
	v.setUint16(10, 0, true); // mod time
	v.setUint16(12, 0, true); // mod date
	v.setUint32(14, crc, true); // crc-32
	v.setUint32(18, size, true); // compressed size
	v.setUint32(22, size, true); // uncompressed size
	v.setUint16(26, nameBytes.length, true);
	v.setUint16(28, 0, true); // extra length
	h.set(nameBytes, 30);
	return h;
}

function centralHeader(nameBytes, size, crc, localOffset) {
	const h = new Uint8Array(46 + nameBytes.length);
	const v = new DataView(h.buffer);
	v.setUint32(0, 0x02014b50, true);
	v.setUint16(4, 0x031e, true); // version made by
	v.setUint16(6, 20, true); // version needed
	v.setUint16(8, 0, true); // flags
	v.setUint16(10, 0, true); // compression
	v.setUint16(12, 0, true); // mod time
	v.setUint16(14, 0, true); // mod date
	v.setUint32(16, crc, true);
	v.setUint32(20, size, true); // compressed
	v.setUint32(24, size, true); // uncompressed
	v.setUint16(28, nameBytes.length, true);
	v.setUint16(30, 0, true); // extra
	v.setUint16(32, 0, true); // comment
	v.setUint16(34, 0, true); // disk start
	v.setUint16(36, 0, true); // internal attr
	v.setUint32(38, 0, true); // external attr
	v.setUint32(42, localOffset, true); // local header offset
	h.set(nameBytes, 46);
	return h;
}

function endRecord(count, centralSize, centralOffset) {
	const h = new Uint8Array(22);
	const v = new DataView(h.buffer);
	v.setUint32(0, 0x06054b50, true);
	v.setUint16(4, 0, true); // disk number
	v.setUint16(6, 0, true); // disk with central dir
	v.setUint16(8, count, true);
	v.setUint16(10, count, true);
	v.setUint32(12, centralSize, true);
	v.setUint32(16, centralOffset, true);
	v.setUint16(20, 0, true); // comment length
	return h;
}

function makeCrcTable() {
	const t = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[i] = c;
	}
	return t;
}

function crc32(tbl, data) {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = tbl[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

// ─── Escape helper ────────────────────────────────────────────────────────────

function esc(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}
