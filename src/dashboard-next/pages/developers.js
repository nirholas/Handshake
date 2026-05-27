// dashboard-next — Developer Hub.
//
// Avatar Render API playground, webhook management, SDK integration guides,
// and usage overview. This is the "Stripe Docs" of three.ws — clean,
// interactive, with live examples.

import { mountShell } from '../shell.js';
import { requireUser, get, post, patch, del, esc, relTime, ApiError } from '../api.js';

const SCENES = ['full-body', 'upper-body', 'portrait', 'headshot'];
const FORMATS = ['png', 'jpeg', 'webp'];
const EVENT_TYPES = [
	'avatar.created', 'avatar.updated', 'avatar.deleted', 'avatar.appearance.changed',
	'agent.created', 'agent.updated', 'agent.deleted',
];

let me = null;
let avatars = [];
let webhooks = [];
let apiKeys = [];
let usageData = null;
let usageDays = 30;
let activeTab = 'render';

(async function boot() {
	const main = await mountShell();
	me = await requireUser();
	injectStyles();

	main.innerHTML = `
		<div class="dev-header">
			<div>
				<h1 class="dn-h1">Developer Hub</h1>
				<p class="dn-h1-sub">Render API, webhooks, SDKs, and integration tools.</p>
			</div>
			<a href="/api/avatar/render" target="_blank" class="dn-btn primary" style="gap:6px">
				<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 5l-4 5 4 5M13 5l4 5-4 5"/></svg>
				API Reference
			</a>
		</div>
		<nav class="dev-tabs" role="tablist"></nav>
		<div data-slot="content" class="dev-content"></div>
	`;

	renderTabs(main.querySelector('.dev-tabs'));
	const content = main.querySelector('[data-slot="content"]');
	renderSkeletons(content);
	await loadData();
	renderActiveTab(content);
})().catch(err => {
	if (err instanceof ApiError && err.status === 401) {
		location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		return;
	}
	const main = document.querySelector('.dn-main-inner') || document.body;
	main.innerHTML = `<h1 class="dn-h1">Developer Hub</h1>
		<div class="dn-panel"><div class="dn-panel-title" style="color:var(--nxt-danger)">Failed to load</div>
		<div class="dn-panel-sub">${esc(err?.message || 'unknown')}</div>
		<button class="dn-btn" onclick="location.reload()">Reload</button></div>`;
});

async function loadData() {
	const [avRes, whRes, keyRes, usageRes] = await Promise.all([
		safe(() => get('/api/avatars?limit=50&visibility=public')),
		safe(() => get('/api/developer/webhooks')),
		safe(() => get('/api/api-keys')),
		safe(() => get(`/api/developer/usage?days=${usageDays}`)),
	]);
	avatars = avRes?.avatars ?? [];
	webhooks = whRes?.webhooks ?? [];
	apiKeys = keyRes?.data ?? [];
	usageData = usageRes;
}

function safe(fn) { return fn().catch(() => null); }

// ── Tabs ─────────────────────────────────────────────────────────────────────

const TABS = [
	{ id: 'render',    label: 'Render API',  icon: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="3" width="16" height="14" rx="2"/><circle cx="7" cy="8" r="1.5"/><path d="M2 14l4-4 3 3 4-5 5 6"/></svg>' },
	{ id: 'webhooks',  label: 'Webhooks',    icon: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4l6 6M10 4l-6 6"/><path d="M10 10v7"/><circle cx="10" cy="10" r="2"/></svg>' },
	{ id: 'usage',     label: 'Usage',       icon: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 17V7l4 3 3-6 4 4 3-3v12H3z"/><path d="M3 17h14"/></svg>' },
	{ id: 'sdks',      label: 'SDKs',        icon: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M7 7h6M7 10h4M7 13h5"/></svg>' },
	{ id: 'changelog', label: 'Changelog',   icon: '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 4h12M4 8h8M4 12h10M4 16h6"/></svg>' },
];

function renderTabs(nav) {
	nav.innerHTML = TABS.map(t =>
		`<button class="dev-tab${t.id === activeTab ? ' is-active' : ''}" data-tab="${t.id}" role="tab" aria-selected="${t.id === activeTab}">${t.icon}<span>${t.label}</span></button>`
	).join('');

	nav.addEventListener('click', (e) => {
		const btn = e.target.closest('.dev-tab');
		if (!btn) return;
		activeTab = btn.dataset.tab;
		nav.querySelectorAll('.dev-tab').forEach(b => {
			b.classList.toggle('is-active', b.dataset.tab === activeTab);
			b.setAttribute('aria-selected', b.dataset.tab === activeTab);
		});
		const content = document.querySelector('[data-slot="content"]');
		renderActiveTab(content);
	});
}

function renderSkeletons(root) {
	root.innerHTML = `
		<div class="dn-panel" style="min-height:400px">
			<div class="dn-skeleton" style="height:16px;width:140px;margin-bottom:16px"></div>
			<div class="dn-skeleton" style="height:200px;width:100%"></div>
		</div>
	`;
}

function renderActiveTab(root) {
	root.innerHTML = '';
	switch (activeTab) {
		case 'render':    renderRenderTab(root);    break;
		case 'webhooks':  renderWebhooksTab(root);  break;
		case 'usage':     renderUsageTab(root);     break;
		case 'sdks':      renderSDKsTab(root);      break;
		case 'changelog': renderChangelogTab(root); break;
	}
}

// ── Render API Tab ──────────────────────────────────────────────────────────

function renderRenderTab(root) {
	const firstAvatar = avatars[0];
	const defaultId = firstAvatar?.id || '';

	const el = document.createElement('div');
	el.className = 'dev-render-tab';
	el.innerHTML = `
		<div class="dev-render-hero dn-panel">
			<div class="dev-render-hero-text">
				<h2 class="dev-section-title">Avatar Render API</h2>
				<p class="dev-section-desc">Render any public three.ws avatar as an image. Use in &lt;img&gt; tags, social cards, game engines, or anywhere you need a profile picture. One URL — works everywhere.</p>
				<div class="dev-render-stats">
					<div class="dev-stat"><span class="dev-stat-value">4</span><span class="dev-stat-label">Scene presets</span></div>
					<div class="dev-stat"><span class="dev-stat-value">3</span><span class="dev-stat-label">Output formats</span></div>
					<div class="dev-stat"><span class="dev-stat-value">2048px</span><span class="dev-stat-label">Max resolution</span></div>
					<div class="dev-stat"><span class="dev-stat-value">CDN</span><span class="dev-stat-label">Cached globally</span></div>
				</div>
			</div>
		</div>

		<div class="dev-playground dn-panel">
			<h3 class="dev-panel-title">Interactive Playground</h3>
			<p class="dev-panel-desc">Configure your render and preview the result live.</p>

			<div class="dev-playground-grid">
				<div class="dev-playground-controls">
					<label class="dev-field">
						<span class="dev-field-label">Avatar ID</span>
						<div class="dev-field-row">
							<input type="text" id="render-avatar" class="dev-input" value="${esc(defaultId)}" placeholder="Paste an avatar UUID" spellcheck="false" />
							${avatars.length ? `<select id="render-avatar-picker" class="dev-select dev-select-sm"><option value="">Pick yours...</option>${avatars.slice(0, 20).map(a => `<option value="${esc(a.id)}">${esc(a.name || a.slug || a.id.slice(0, 8))}</option>`).join('')}</select>` : ''}
						</div>
					</label>

					<div class="dev-field-grid">
						<label class="dev-field">
							<span class="dev-field-label">Scene</span>
							<div class="dev-scene-grid" id="render-scene">
								${SCENES.map(s => `<button class="dev-scene-btn${s === 'upper-body' ? ' is-active' : ''}" data-scene="${s}"><span class="dev-scene-icon">${sceneIcon(s)}</span><span>${s.replace('-', ' ')}</span></button>`).join('')}
							</div>
						</label>
					</div>

					<div class="dev-field-grid dev-field-grid-3">
						<label class="dev-field">
							<span class="dev-field-label">Size</span>
							<input type="number" id="render-size" class="dev-input" value="512" min="64" max="2048" step="64" />
						</label>
						<label class="dev-field">
							<span class="dev-field-label">Background</span>
							<div class="dev-bg-row">
								<button class="dev-bg-btn is-active" data-bg="transparent" title="Transparent">
									<span class="dev-bg-swatch dev-bg-transparent"></span>
								</button>
								<button class="dev-bg-btn" data-bg="#000000" title="Black">
									<span class="dev-bg-swatch" style="background:#000"></span>
								</button>
								<button class="dev-bg-btn" data-bg="#ffffff" title="White">
									<span class="dev-bg-swatch" style="background:#fff"></span>
								</button>
								<button class="dev-bg-btn" data-bg="#0a0a0a" title="Dark">
									<span class="dev-bg-swatch" style="background:#0a0a0a"></span>
								</button>
								<input type="color" id="render-bg-custom" class="dev-bg-color" value="#1a1a2e" title="Custom color" />
							</div>
						</label>
						<label class="dev-field">
							<span class="dev-field-label">Format</span>
							<select id="render-format" class="dev-select">
								${FORMATS.map(f => `<option value="${f}">${f.toUpperCase()}</option>`).join('')}
							</select>
						</label>
					</div>
				</div>

				<div class="dev-playground-preview">
					<div class="dev-preview-frame" id="render-preview">
						<div class="dev-preview-empty">
							<svg width="48" height="48" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.3"><rect x="2" y="3" width="16" height="14" rx="2"/><circle cx="7" cy="8" r="1.5"/><path d="M2 14l4-4 3 3 4-5 5 6"/></svg>
							<span>Enter an avatar ID and click Render</span>
						</div>
					</div>
					<button class="dn-btn primary dev-render-btn" id="render-go">Render Preview</button>
				</div>
			</div>
		</div>

		<div class="dev-url-builder dn-panel">
			<h3 class="dev-panel-title">Generated URL</h3>
			<p class="dev-panel-desc">Copy this URL and use it anywhere — it returns an image.</p>
			<div class="dev-url-row">
				<code class="dev-url-code" id="render-url">/api/avatar/render?avatar=&lt;ID&gt;&amp;scene=upper-body&amp;size=512&amp;bg=transparent</code>
				<button class="dn-btn ghost dev-copy-btn" id="render-copy">Copy</button>
			</div>
		</div>

		<div class="dev-code-examples dn-panel">
			<h3 class="dev-panel-title">Integration Examples</h3>
			<div class="dev-code-tabs" id="code-tabs">
				<button class="dev-code-tab is-active" data-lang="html">HTML</button>
				<button class="dev-code-tab" data-lang="react">React</button>
				<button class="dev-code-tab" data-lang="unity">Unity C#</button>
				<button class="dev-code-tab" data-lang="unreal">Unreal C++</button>
				<button class="dev-code-tab" data-lang="curl">cURL</button>
			</div>
			<div class="dev-code-block" id="code-block">
				<pre><code id="code-content"></code></pre>
				<button class="dn-btn ghost dev-copy-btn dev-code-copy" id="code-copy">Copy</button>
			</div>
		</div>
	`;

	root.appendChild(el);
	wireRenderPlayground(el);
}

function wireRenderPlayground(el) {
	const avatarInput = el.querySelector('#render-avatar');
	const avatarPicker = el.querySelector('#render-avatar-picker');
	const sceneGrid = el.querySelector('#render-scene');
	const sizeInput = el.querySelector('#render-size');
	const formatSelect = el.querySelector('#render-format');
	const bgRow = el.querySelector('.dev-bg-row');
	const bgCustom = el.querySelector('#render-bg-custom');
	const preview = el.querySelector('#render-preview');
	const urlCode = el.querySelector('#render-url');
	const renderBtn = el.querySelector('#render-go');
	const copyBtn = el.querySelector('#render-copy');
	const codeTabs = el.querySelector('#code-tabs');
	const codeContent = el.querySelector('#code-content');
	const codeCopy = el.querySelector('#code-copy');

	let scene = 'upper-body';
	let bg = 'transparent';
	let codeLang = 'html';

	function buildUrl() {
		const id = avatarInput.value.trim();
		const size = sizeInput.value || '512';
		const format = formatSelect.value;
		const params = new URLSearchParams();
		if (id) params.set('avatar', id);
		params.set('scene', scene);
		params.set('size', size);
		params.set('bg', bg);
		if (format !== 'png') params.set('format', format);
		return `/api/avatar/render?${params.toString()}`;
	}

	function updateUrl() {
		const url = buildUrl();
		urlCode.textContent = url;
		updateCodeExamples();
	}

	function updateCodeExamples() {
		const url = buildUrl();
		const fullUrl = `${location.origin}${url}`;
		const id = avatarInput.value.trim() || 'YOUR_AVATAR_ID';

		const examples = {
			html: `<!-- Drop this anywhere — it just works -->
<img
  src="${fullUrl}"
  alt="3D Avatar"
  width="${sizeInput.value || 512}"
  height="${sizeInput.value || 512}"
  loading="lazy"
/>

<!-- Responsive with srcset for retina displays -->
<img
  src="${location.origin}/api/avatar/render?avatar=${id}&scene=${scene}&size=256&bg=${bg}"
  srcset="${location.origin}/api/avatar/render?avatar=${id}&scene=${scene}&size=512&bg=${bg} 2x"
  alt="3D Avatar"
  width="256"
  height="256"
  loading="lazy"
/>`,
			react: `import { useState, useEffect } from 'react';

function AvatarImage({ avatarId, scene = '${scene}', size = ${sizeInput.value || 512} }) {
  const src = \`${location.origin}/api/avatar/render?\` +
    \`avatar=\${avatarId}&scene=\${scene}&size=\${size}&bg=${bg}\`;

  return (
    <img
      src={src}
      alt="3D Avatar"
      width={size}
      height={size}
      loading="lazy"
      style={{ borderRadius: '50%' }}
    />
  );
}

// Usage
<AvatarImage avatarId="${id}" scene="${scene}" />`,
			unity: `using UnityEngine;
using UnityEngine.Networking;
using System.Collections;

public class AvatarLoader : MonoBehaviour
{
    [SerializeField] private string avatarId = "${id}";
    [SerializeField] private string scene = "${scene}";
    [SerializeField] private int size = ${sizeInput.value || 512};
    [SerializeField] private Renderer targetRenderer;

    IEnumerator Start()
    {
        string url = $"${location.origin}/api/avatar/render" +
            $"?avatar={avatarId}&scene={scene}&size={size}&bg=${bg}";

        using var request = UnityWebRequestTexture.GetTexture(url);
        yield return request.SendWebRequest();

        if (request.result == UnityWebRequest.Result.Success)
        {
            var texture = DownloadHandlerTexture.GetContent(request);
            targetRenderer.material.mainTexture = texture;
        }
    }
}`,
			unreal: `#include "HttpModule.h"
#include "IImageWrapperModule.h"

void UAvatarLoader::LoadAvatar(const FString& AvatarId)
{
    FString URL = FString::Printf(
        TEXT("${location.origin}/api/avatar/render"
             "?avatar=%s&scene=${scene}&size=${sizeInput.value || 512}&bg=${bg}"),
        *AvatarId
    );

    auto Request = FHttpModule::Get().CreateRequest();
    Request->SetVerb("GET");
    Request->SetURL(URL);
    Request->OnProcessRequestComplete().BindLambda(
        [this](FHttpRequestPtr Req, FHttpResponsePtr Res, bool bOk)
    {
        if (!bOk || !Res.IsValid()) return;

        IImageWrapperModule& Mod =
            FModuleManager::LoadModuleChecked<IImageWrapperModule>("ImageWrapper");
        auto Wrapper = Mod.CreateImageWrapper(EImageFormat::PNG);

        const TArray<uint8>& Data = Res->GetContent();
        if (Wrapper->SetCompressed(Data.GetData(), Data.Num()))
        {
            TArray<uint8> Raw;
            Wrapper->GetRaw(ERGBFormat::BGRA, 8, Raw);
            // Create UTexture2D from Raw...
        }
    });
    Request->ProcessRequest();
}`,
			curl: `# Render an avatar as PNG
curl -o avatar.png \\
  "${fullUrl}"

# Portrait with transparent background
curl -o portrait.png \\
  "${location.origin}/api/avatar/render?avatar=${id}&scene=portrait&size=1024&bg=transparent"

# Get the API reference (no avatar param)
curl "${location.origin}/api/avatar/render" | jq .`,
		};

		codeContent.textContent = examples[codeLang] || examples.html;
	}

	if (avatarPicker) {
		avatarPicker.addEventListener('change', () => {
			if (avatarPicker.value) {
				avatarInput.value = avatarPicker.value;
				updateUrl();
			}
		});
	}

	avatarInput.addEventListener('input', updateUrl);
	sizeInput.addEventListener('input', updateUrl);
	formatSelect.addEventListener('change', updateUrl);

	sceneGrid.addEventListener('click', (e) => {
		const btn = e.target.closest('.dev-scene-btn');
		if (!btn) return;
		scene = btn.dataset.scene;
		sceneGrid.querySelectorAll('.dev-scene-btn').forEach(b => b.classList.toggle('is-active', b === btn));
		updateUrl();
	});

	bgRow.addEventListener('click', (e) => {
		const btn = e.target.closest('.dev-bg-btn');
		if (!btn) return;
		bg = btn.dataset.bg;
		bgRow.querySelectorAll('.dev-bg-btn').forEach(b => b.classList.toggle('is-active', b === btn));
		updateUrl();
	});

	bgCustom.addEventListener('input', () => {
		bg = bgCustom.value;
		bgRow.querySelectorAll('.dev-bg-btn').forEach(b => b.classList.remove('is-active'));
		updateUrl();
	});

	renderBtn.addEventListener('click', () => {
		const id = avatarInput.value.trim();
		if (!id) {
			avatarInput.focus();
			avatarInput.classList.add('dev-input-error');
			setTimeout(() => avatarInput.classList.remove('dev-input-error'), 1500);
			return;
		}
		const url = buildUrl();
		preview.innerHTML = `
			<div class="dev-preview-loading">
				<div class="dev-preview-spinner"></div>
				<span>Rendering...</span>
			</div>
		`;
		const img = new Image();
		img.onload = () => {
			preview.innerHTML = '';
			img.className = 'dev-preview-img';
			img.alt = 'Rendered avatar preview';
			preview.appendChild(img);
		};
		img.onerror = () => {
			preview.innerHTML = `
				<div class="dev-preview-error">
					<svg width="32" height="32" viewBox="0 0 20 20" fill="none" stroke="var(--nxt-danger)" stroke-width="1.6"><circle cx="10" cy="10" r="7"/><path d="M7 7l6 6M13 7l-6 6"/></svg>
					<span>Render failed. Check that the avatar ID is valid and public.</span>
				</div>
			`;
		};
		img.src = url;
	});

	copyBtn.addEventListener('click', () => copyText(urlCode.textContent, copyBtn));

	codeTabs.addEventListener('click', (e) => {
		const tab = e.target.closest('.dev-code-tab');
		if (!tab) return;
		codeLang = tab.dataset.lang;
		codeTabs.querySelectorAll('.dev-code-tab').forEach(t => t.classList.toggle('is-active', t === tab));
		updateCodeExamples();
	});

	codeCopy.addEventListener('click', () => copyText(codeContent.textContent, codeCopy));

	updateUrl();
}

function sceneIcon(scene) {
	switch (scene) {
		case 'full-body':  return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="5" r="2.5"/><path d="M8 10h8M12 10v8M9 22l3-4 3 4"/></svg>';
		case 'upper-body': return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="6" r="3"/><path d="M6 22v-3c0-3.3 2.7-6 6-6s6 2.7 6 6v3"/><line x1="4" y1="18" x2="20" y2="18" stroke-dasharray="2 2" opacity="0.4"/></svg>';
		case 'portrait':   return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M7 18c0-2.8 2.2-5 5-5s5 2.2 5 5"/><rect x="3" y="2" width="18" height="20" rx="2" stroke-dasharray="2 2" opacity="0.3"/></svg>';
		case 'headshot':   return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="10" r="5"/><circle cx="10" cy="9" r="0.5" fill="currentColor"/><circle cx="14" cy="9" r="0.5" fill="currentColor"/><path d="M10 12c.5.6 1.3 1 2 1s1.5-.4 2-1"/></svg>';
		default: return '';
	}
}

// ── Webhooks Tab ────────────────────────────────────────────────────────────

function renderWebhooksTab(root) {
	const el = document.createElement('div');
	el.className = 'dev-webhooks-tab';

	el.innerHTML = `
		<div class="dev-webhooks-header">
			<div>
				<h2 class="dev-section-title">Webhooks</h2>
				<p class="dev-section-desc">Get notified when avatars or agents are created, updated, or deleted. We sign every payload with HMAC-SHA256 using the Standard Webhooks format.</p>
			</div>
			<button class="dn-btn primary" id="wh-create-btn">Create Webhook</button>
		</div>

		<div id="wh-create-form" class="dn-panel dev-wh-form" style="display:none">
			<h3 class="dev-panel-title">New Webhook</h3>
			<label class="dev-field">
				<span class="dev-field-label">Endpoint URL</span>
				<input type="url" id="wh-url" class="dev-input" placeholder="https://your-server.com/webhooks/threews" />
			</label>
			<label class="dev-field">
				<span class="dev-field-label">Description <span class="dev-field-opt">(optional)</span></span>
				<input type="text" id="wh-desc" class="dev-input" placeholder="Production server" maxlength="200" />
			</label>
			<fieldset class="dev-field">
				<legend class="dev-field-label">Events</legend>
				<div class="dev-event-grid">
					${EVENT_TYPES.map(e => `<label class="dev-event-check"><input type="checkbox" name="wh-events" value="${e}" checked /><span>${e}</span></label>`).join('')}
				</div>
			</fieldset>
			<div class="dev-form-actions">
				<button class="dn-btn ghost" id="wh-cancel">Cancel</button>
				<button class="dn-btn primary" id="wh-save">Create</button>
			</div>
		</div>

		<div id="wh-list"></div>

		<div class="dn-panel dev-wh-verify">
			<h3 class="dev-panel-title">Verifying Signatures</h3>
			<p class="dev-panel-desc">Every webhook delivery includes three headers for verification:</p>
			<pre class="dev-code-inline"><code>webhook-id:        evt_abc123...         // unique event ID
webhook-timestamp: 1716825600            // unix epoch seconds
webhook-signature: v1,base64signature... // HMAC-SHA256</code></pre>
			<p class="dev-panel-desc" style="margin-top:12px">Verify by computing <code>HMAC-SHA256(secret, "{webhook-id}.{webhook-timestamp}.{body}")</code> and comparing with the signature.</p>
			<div class="dev-code-block"><pre><code>import crypto from 'crypto';

function verify(secret, headers, body) {
  const msg = \`\${headers['webhook-id']}.\${headers['webhook-timestamp']}.\${body}\`;
  const expected = crypto.createHmac('sha256', secret).update(msg).digest('base64');
  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(headers['webhook-signature'].replace('v1,', ''))
  );
}</code></pre></div>
		</div>
	`;

	root.appendChild(el);
	renderWebhookList(el.querySelector('#wh-list'));
	wireWebhookForm(el);
}

function renderWebhookList(container) {
	if (!webhooks.length) {
		container.innerHTML = `
			<div class="dn-panel dev-wh-empty">
				<svg width="40" height="40" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.3"><path d="M4 4l6 6M10 4l-6 6"/><path d="M10 10v7"/><circle cx="10" cy="10" r="2"/></svg>
				<h3>No webhooks yet</h3>
				<p>Create a webhook to get real-time notifications when avatars or agents change.</p>
			</div>
		`;
		return;
	}

	container.innerHTML = webhooks.map(wh => `
		<div class="dn-panel dev-wh-card" data-id="${esc(wh.id)}">
			<div class="dev-wh-card-header">
				<div class="dev-wh-card-info">
					<div class="dev-wh-card-url">
						<span class="dn-tag ${wh.active ? 'success' : ''}" style="font-size:11px">${wh.active ? 'Active' : 'Paused'}</span>
						<code>${esc(wh.url)}</code>
					</div>
					${wh.description ? `<div class="dev-wh-card-desc">${esc(wh.description)}</div>` : ''}
				</div>
				<div class="dev-wh-card-actions">
					<button class="dev-wh-view-btn" data-id="${esc(wh.id)}">View Deliveries</button>
					<button class="dn-btn ghost dev-wh-toggle" data-id="${esc(wh.id)}" data-active="${wh.active}">${wh.active ? 'Pause' : 'Resume'}</button>
					<button class="dn-btn ghost danger dev-wh-delete" data-id="${esc(wh.id)}">Delete</button>
				</div>
			</div>
			<div class="dev-wh-card-meta">
				<span class="dev-wh-meta-item">Events: ${wh.events?.length ? wh.events.map(e => `<span class="dn-tag">${esc(e)}</span>`).join(' ') : '<span class="dev-text-dim">all</span>'}</span>
			</div>
			${wh.stats_7d ? `<div class="dev-wh-card-stats">
				<span class="dev-wh-stat">${wh.stats_7d.total} deliveries</span>
				<span class="dev-wh-stat success">${wh.stats_7d.succeeded} succeeded</span>
				${wh.stats_7d.failed > 0 ? `<span class="dev-wh-stat danger">${wh.stats_7d.failed} failed</span>` : ''}
				${wh.stats_7d.last_delivery_at ? `<span class="dev-wh-stat">Last: ${relTime(wh.stats_7d.last_delivery_at)}</span>` : ''}
			</div>` : ''}
			<div class="dev-wh-deliveries" data-deliveries-for="${esc(wh.id)}"></div>
		</div>
	`).join('');

	container.querySelectorAll('.dev-wh-toggle').forEach(btn => {
		btn.addEventListener('click', async () => {
			const id = btn.dataset.id;
			const newActive = btn.dataset.active !== 'true';
			try {
				await patch(`/api/developer/webhooks/${id}`, { active: newActive });
				const wh = webhooks.find(w => w.id === id);
				if (wh) wh.active = newActive;
				renderWebhookList(container);
			} catch (err) {
				showToast(err?.message || 'Failed to update webhook', 'danger');
			}
		});
	});

	container.querySelectorAll('.dev-wh-delete').forEach(btn => {
		btn.addEventListener('click', async () => {
			const id = btn.dataset.id;
			if (!confirm('Delete this webhook? This cannot be undone.')) return;
			try {
				await del(`/api/developer/webhooks/${id}`);
				webhooks = webhooks.filter(w => w.id !== id);
				renderWebhookList(container);
			} catch (err) {
				showToast(err?.message || 'Failed to delete webhook', 'danger');
			}
		});
	});

	container.querySelectorAll('.dev-wh-view-btn').forEach(btn => {
		btn.addEventListener('click', async () => {
			const id = btn.dataset.id;
			const slot = container.querySelector(`[data-deliveries-for="${id}"]`);
			if (!slot) return;

			if (slot.dataset.loaded === 'true') {
				slot.innerHTML = '';
				slot.dataset.loaded = '';
				btn.textContent = 'View Deliveries';
				return;
			}

			btn.textContent = 'Loading...';
			btn.disabled = true;

			try {
				const res = await get(`/api/developer/webhooks/${id}`);
				const deliveries = res?.deliveries ?? [];
				slot.dataset.loaded = 'true';
				btn.textContent = 'Hide Deliveries';
				btn.disabled = false;

				if (!deliveries.length) {
					slot.innerHTML = `<div class="dev-wh-delivery-list" style="padding:16px 0;color:var(--nxt-ink-dim);font-size:13px;text-align:center">No deliveries yet</div>`;
					return;
				}

				slot.innerHTML = `<div class="dev-wh-delivery-list">
					<div class="dev-wh-delivery-item" style="font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:var(--nxt-ink-dim);border-bottom:1px solid var(--nxt-stroke)">
						<span>Event</span><span>Event ID</span><span>Status</span><span>Time</span>
					</div>
					${deliveries.slice(0, 25).map(d => {
						const ok = d.status_code && d.status_code >= 200 && d.status_code < 300;
						const fail = d.status_code === null || d.status_code >= 400;
						const statusClass = ok ? 'ok' : fail ? 'fail' : 'pending';
						const statusText = d.status_code ? `${d.status_code}` : d.error ? 'Error' : 'Pending';
						return `<div class="dev-wh-delivery-item">
							<span class="dev-wh-delivery-event">${esc(d.event_type)}</span>
							<span class="dev-wh-delivery-event" style="opacity:0.6">${esc((d.event_id || '').slice(0, 16))}</span>
							<span class="dev-wh-delivery-status ${statusClass}">${statusText}</span>
							<span style="color:var(--nxt-ink-dim)">${relTime(d.created_at)}</span>
						</div>`;
					}).join('')}
					${deliveries.length > 25 ? `<div style="padding:8px 12px;font-size:12px;color:var(--nxt-ink-dim)">Showing 25 of ${deliveries.length} deliveries</div>` : ''}
				</div>`;
			} catch (err) {
				btn.textContent = 'View Deliveries';
				btn.disabled = false;
				showToast(err?.message || 'Failed to load deliveries', 'danger');
			}
		});
	});
}

function wireWebhookForm(el) {
	const createBtn = el.querySelector('#wh-create-btn');
	const form = el.querySelector('#wh-create-form');
	const cancelBtn = el.querySelector('#wh-cancel');
	const saveBtn = el.querySelector('#wh-save');
	const urlInput = el.querySelector('#wh-url');

	createBtn.addEventListener('click', () => {
		form.style.display = '';
		createBtn.style.display = 'none';
		urlInput.focus();
	});

	cancelBtn.addEventListener('click', () => {
		form.style.display = 'none';
		createBtn.style.display = '';
	});

	saveBtn.addEventListener('click', async () => {
		const url = urlInput.value.trim();
		if (!url) { urlInput.focus(); return; }
		const desc = el.querySelector('#wh-desc').value.trim();
		const events = [...el.querySelectorAll('input[name="wh-events"]:checked')].map(c => c.value);

		saveBtn.disabled = true;
		saveBtn.textContent = 'Creating...';
		try {
			const res = await post('/api/developer/webhooks', { url, description: desc || undefined, events });
			webhooks.unshift(res.webhook);
			form.style.display = 'none';
			createBtn.style.display = '';
			renderWebhookList(el.querySelector('#wh-list'));

			if (res.webhook.secret) {
				showSecretModal(res.webhook.secret);
			}
			showToast('Webhook created');
		} catch (err) {
			showToast(err?.body?.error_description || err?.message || 'Failed to create webhook', 'danger');
		} finally {
			saveBtn.disabled = false;
			saveBtn.textContent = 'Create';
		}
	});
}

function showSecretModal(secret) {
	const overlay = document.createElement('div');
	overlay.className = 'dev-modal-overlay';
	overlay.innerHTML = `
		<div class="dev-modal">
			<h3 class="dev-modal-title">Webhook Secret</h3>
			<p class="dev-modal-desc">Save this secret now — it won't be shown again. Use it to verify webhook signatures.</p>
			<div class="dev-url-row">
				<code class="dev-url-code dev-secret-code">${esc(secret)}</code>
				<button class="dn-btn ghost dev-copy-btn" id="secret-copy">Copy</button>
			</div>
			<div class="dev-modal-actions">
				<button class="dn-btn primary" id="secret-done">I've saved it</button>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);

	overlay.querySelector('#secret-copy').addEventListener('click', function () {
		copyText(secret, this);
	});
	overlay.querySelector('#secret-done').addEventListener('click', () => overlay.remove());
	overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// ── SDKs Tab ────────────────────────────────────────────────────────────────

function renderSDKsTab(root) {
	const el = document.createElement('div');
	el.className = 'dev-sdks-tab';

	el.innerHTML = `
		<div class="dev-sdks-hero dn-panel">
			<h2 class="dev-section-title">Cross-Platform SDKs</h2>
			<p class="dev-section-desc">Bring three.ws avatars into any app, game, or experience. One avatar, every platform.</p>
		</div>

		<div class="dev-sdk-grid">
			<div class="dn-panel dev-sdk-card">
				<div class="dev-sdk-card-header">
					<div class="dev-sdk-icon dev-sdk-web">&lt;/&gt;</div>
					<div>
						<h3 class="dev-sdk-name">Web SDK</h3>
						<span class="dn-tag success">Available</span>
					</div>
				</div>
				<p class="dev-sdk-desc">Drop-in web component for any website. Works with vanilla JS, React, Vue, Svelte, or any framework.</p>
				<div class="dev-code-block"><pre><code>&lt;!-- NPM --&gt;
npm install @three-ws/sdk

&lt;!-- CDN (zero build step) --&gt;
&lt;script src="https://cdn.three.ws/sdk/latest/viewer.min.js"&gt;&lt;/script&gt;

&lt;!-- Usage --&gt;
&lt;three-ws-viewer
  avatar-id="YOUR_AVATAR_ID"
  width="400"
  height="400"
  controls
&gt;&lt;/three-ws-viewer&gt;</code></pre></div>
				<div class="dev-sdk-links">
					<a href="/dashboard/api" class="dn-btn ghost">Documentation</a>
					<a href="https://www.npmjs.com/package/@three-ws/sdk" target="_blank" class="dn-btn ghost">NPM Package</a>
				</div>
			</div>

			<div class="dn-panel dev-sdk-card">
				<div class="dev-sdk-card-header">
					<div class="dev-sdk-icon dev-sdk-unity">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M10.4 12l-4.8 8.3 2.8.7 2.4-4.3h4.4l2.4 4.3 2.8-.7-4.8-8.3zm1.6-1L7.2 2.7 4.4 3.4l2.4 4.3-2.4 4.3h-4L.4 12l4-7L7.2 2.7h5.6l2.4-4.3L12 2h-1.6zm9.6 1l-4-7-2.8.7 2.4 4.3H13l-2.4-4.3-2.8.7L12.6 15h4.8l2.4 4.3 2.8-.7-4.8-8.3h4l.4-7z" transform="scale(0.7) translate(5,5)"/></svg>
					</div>
					<div>
						<h3 class="dev-sdk-name">Unity SDK</h3>
						<span class="dn-tag warn">Coming Soon</span>
					</div>
				</div>
				<p class="dev-sdk-desc">Load three.ws avatars into any Unity project. Supports runtime loading, Mixamo-compatible rigs, and morph targets.</p>
				<div class="dev-code-block"><pre><code>using ThreeWS;

// Load avatar at runtime
var avatar = await AvatarLoader.Load("YOUR_AVATAR_ID");
avatar.SetScene(AvatarScene.UpperBody);

// Apply expression
avatar.SetExpression("mouthSmile", 0.6f);

// Render API fallback for 2D UIs
var texture = await AvatarRender.GetTexture(
    "YOUR_AVATAR_ID",
    scene: "portrait",
    size: 256
);</code></pre></div>
				<div class="dev-sdk-links">
					<a href="https://github.com/nirholas/three.ws" target="_blank" class="dn-btn ghost">Follow Development</a>
				</div>
			</div>

			<div class="dn-panel dev-sdk-card">
				<div class="dev-sdk-card-header">
					<div class="dev-sdk-icon dev-sdk-unreal">
						<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-2-6l4-2v4l2-1v-6l-2 1-4 2v2z" transform="scale(0.85) translate(2,2)"/></svg>
					</div>
					<div>
						<h3 class="dev-sdk-name">Unreal Engine</h3>
						<span class="dn-tag warn">Coming Soon</span>
					</div>
				</div>
				<p class="dev-sdk-desc">Blueprint and C++ support for loading three.ws avatars as Skeletal Meshes with full morph target and animation support.</p>
				<div class="dev-code-block"><pre><code>// C++ — Load avatar as Skeletal Mesh
#include "ThreeWS/AvatarLoader.h"

void AMyActor::BeginPlay()
{
    Super::BeginPlay();
    UThreeWSLoader::LoadAvatar(
        "YOUR_AVATAR_ID",
        FOnAvatarLoaded::CreateLambda(
            [this](USkeletalMesh* Mesh) {
                GetMesh()->SetSkeletalMesh(Mesh);
            }
        )
    );
}</code></pre></div>
				<div class="dev-sdk-links">
					<a href="https://github.com/nirholas/three.ws" target="_blank" class="dn-btn ghost">Follow Development</a>
				</div>
			</div>

			<div class="dn-panel dev-sdk-card">
				<div class="dev-sdk-card-header">
					<div class="dev-sdk-icon dev-sdk-rest">
						<svg width="24" height="24" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 5h14M3 10h14M3 15h10"/></svg>
					</div>
					<div>
						<h3 class="dev-sdk-name">REST API</h3>
						<span class="dn-tag success">Available</span>
					</div>
				</div>
				<p class="dev-sdk-desc">Full REST API for avatar management, rendering, and agent operations. Works with any language or platform.</p>
				<div class="dev-code-block"><pre><code># List your avatars
curl -H "Authorization: Bearer sk_live_..." \\
  ${location.origin}/api/avatars

# Render an avatar
curl -o avatar.png \\
  "${location.origin}/api/avatar/render?avatar=ID&scene=portrait"

# Create a webhook
curl -X POST -H "Content-Type: application/json" \\
  -d '{"url":"https://...","events":["avatar.updated"]}' \\
  ${location.origin}/api/developer/webhooks</code></pre></div>
				<div class="dev-sdk-links">
					<a href="/dashboard/api" class="dn-btn ghost">API Keys</a>
					<a href="/api/avatar/render" target="_blank" class="dn-btn ghost">API Reference</a>
				</div>
			</div>
		</div>

		<div class="dn-panel dev-interop-callout">
			<div class="dev-interop-content">
				<h3 class="dev-section-title">One Avatar. Every Platform.</h3>
				<p class="dev-section-desc">three.ws avatars use standard glTF 2.0 with Mixamo-compatible rigs. They work with three.js, Babylon.js, Unity, Unreal, Godot, model-viewer, and any engine that supports glTF. Update the avatar once — every integration sees the change.</p>
				<div class="dev-interop-badges">
					<span class="dev-badge">glTF 2.0</span>
					<span class="dev-badge">Mixamo Rig</span>
					<span class="dev-badge">ARKit 52 Morphs</span>
					<span class="dev-badge">CDN Cached</span>
					<span class="dev-badge">USDZ Export</span>
					<span class="dev-badge">On-Chain Ready</span>
				</div>
			</div>
		</div>
	`;

	root.appendChild(el);
}

// ── Usage Tab ──────────────────────────────────────────────────────────

function renderUsageTab(root) {
	const el = document.createElement('div');
	el.className = 'dev-usage-tab';

	const d = usageData || {};
	const req = d.requests || {};
	const keys = d.api_keys || {};
	const wh = d.webhooks || {};
	const x402 = d.x402 || {};
	const timeseries = d.timeseries || [];
	const topActions = d.top_actions || [];

	const successRate = req.total > 0 ? (100 - (req.error_rate || 0)).toFixed(1) : '100.0';
	const whSuccessRate = wh.total_deliveries > 0
		? ((wh.succeeded / wh.total_deliveries) * 100).toFixed(1)
		: '100.0';

	el.innerHTML = `
		<div class="dev-usage-header">
			<div>
				<h2 class="dev-section-title">Usage & Metrics</h2>
				<p class="dev-section-desc">Platform activity, API usage, and delivery stats across your integrations.</p>
			</div>
			<div class="dev-usage-range">
				${[7, 30, 90].map(n => `<button class="dev-usage-range-btn${n === usageDays ? ' is-active' : ''}" data-days="${n}">${n}d</button>`).join('')}
			</div>
		</div>

		<div class="dev-usage-kpis">
			<div class="dn-panel dev-usage-kpi">
				<div class="dev-usage-kpi-icon" style="background:rgba(108,138,255,0.12);color:#6c8aff">
					<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 17V7l4 3 3-6 4 4 3-3v12H3z"/></svg>
				</div>
				<div class="dev-usage-kpi-body">
					<div class="dev-usage-kpi-value">${(req.total || 0).toLocaleString()}</div>
					<div class="dev-usage-kpi-label">API Requests</div>
				</div>
			</div>
			<div class="dn-panel dev-usage-kpi">
				<div class="dev-usage-kpi-icon" style="background:rgba(52,211,153,0.12);color:#34d399">
					<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 10l3 3 7-7"/></svg>
				</div>
				<div class="dev-usage-kpi-body">
					<div class="dev-usage-kpi-value">${successRate}%</div>
					<div class="dev-usage-kpi-label">Success Rate</div>
				</div>
			</div>
			<div class="dn-panel dev-usage-kpi">
				<div class="dev-usage-kpi-icon" style="background:rgba(167,139,250,0.12);color:#a78bfa">
					<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="2" width="10" height="10" rx="2"/><circle cx="8" cy="6.5" r="1"/><circle cx="12" cy="6.5" r="1"/><path d="M3 14l2-2h10l2 2v3a1 1 0 01-1 1H4a1 1 0 01-1-1v-3z"/></svg>
				</div>
				<div class="dev-usage-kpi-body">
					<div class="dev-usage-kpi-value">${keys.active_keys || 0}</div>
					<div class="dev-usage-kpi-label">Active API Keys</div>
				</div>
			</div>
			<div class="dn-panel dev-usage-kpi">
				<div class="dev-usage-kpi-icon" style="background:rgba(251,191,36,0.12);color:#fbbf24">
					<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="6.5"/><path d="M10 6v8M7.5 8h4a1.5 1.5 0 010 3H8.5a1.5 1.5 0 000 3h4"/></svg>
				</div>
				<div class="dev-usage-kpi-body">
					<div class="dev-usage-kpi-value">${x402.payments || 0}</div>
					<div class="dev-usage-kpi-label">x402 Payments</div>
				</div>
			</div>
		</div>

		<div class="dn-panel dev-usage-chart-panel">
			<div class="dev-panel-title">Request Volume</div>
			<p class="dev-panel-desc">API requests per day over the last ${usageDays} days</p>
			<div class="dev-usage-chart" id="usage-chart"></div>
		</div>

		<div class="dev-usage-two-col">
			<div class="dn-panel dev-usage-actions-panel">
				<div class="dev-panel-title">Top Actions</div>
				<p class="dev-panel-desc">Most-called API actions this period</p>
				<div id="usage-actions"></div>
			</div>
			<div class="dn-panel dev-usage-delivery-panel">
				<div class="dev-panel-title">Webhook Health</div>
				<p class="dev-panel-desc">Delivery success rate for your webhooks</p>
				<div class="dev-usage-delivery-stats">
					<div class="dev-usage-delivery-ring" id="delivery-ring"></div>
					<div class="dev-usage-delivery-breakdown">
						<div class="dev-usage-delivery-row">
							<span class="dev-usage-dot" style="background:#34d399"></span>
							<span>Succeeded</span>
							<strong>${(wh.succeeded || 0).toLocaleString()}</strong>
						</div>
						<div class="dev-usage-delivery-row">
							<span class="dev-usage-dot" style="background:#f87171"></span>
							<span>Failed</span>
							<strong>${(wh.failed || 0).toLocaleString()}</strong>
						</div>
						<div class="dev-usage-delivery-row">
							<span class="dev-usage-dot" style="background:var(--nxt-ink-dim)"></span>
							<span>Total</span>
							<strong>${(wh.total_deliveries || 0).toLocaleString()}</strong>
						</div>
					</div>
				</div>
			</div>
		</div>
	`;

	root.appendChild(el);

	renderUsageChart(el.querySelector('#usage-chart'), timeseries);
	renderTopActions(el.querySelector('#usage-actions'), topActions);
	renderDeliveryRing(el.querySelector('#delivery-ring'), wh);

	el.querySelector('.dev-usage-range').addEventListener('click', async (e) => {
		const btn = e.target.closest('.dev-usage-range-btn');
		if (!btn) return;
		usageDays = Number(btn.dataset.days);
		el.querySelector('.dev-usage-range').querySelectorAll('.dev-usage-range-btn').forEach(b =>
			b.classList.toggle('is-active', Number(b.dataset.days) === usageDays)
		);
		try {
			usageData = await get(`/api/developer/usage?days=${usageDays}`);
		} catch { /* keep stale data */ }
		const content = document.querySelector('[data-slot="content"]');
		renderActiveTab(content);
	});
}

function renderUsageChart(container, timeseries) {
	if (!timeseries.length) {
		container.innerHTML = `<div class="dev-usage-chart-empty">
			<svg width="40" height="40" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.25"><path d="M3 17V7l4 3 3-6 4 4 3-3v12H3z"/></svg>
			<span>No API activity in this period. <a href="/dashboard/api">Get your API key</a> to start building.</span>
		</div>`;
		return;
	}

	const data = timeseries.map(p => ({
		label: new Date(p.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
		value: p.requests,
	}));

	const max = Math.max(1, ...data.map(d => d.value));
	const W = 780, H = 180, pad = 48, barGap = 3;
	const barW = Math.max(4, (W - pad * 2) / data.length - barGap);
	const chartH = H - 20;

	let bars = '';
	let labels = '';
	const showEvery = Math.max(1, Math.ceil(data.length / 10));

	data.forEach((d, i) => {
		const x = pad + i * (barW + barGap);
		const h = Math.max(1, (d.value / max) * chartH);
		const y = H - h;
		bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="2" fill="var(--nxt-accent,#6c8aff)" opacity="0.75"><title>${d.label}: ${d.value.toLocaleString()} requests</title></rect>`;
		if (i % showEvery === 0) {
			labels += `<text x="${x + barW / 2}" y="${H + 14}" text-anchor="middle" font-size="10" fill="var(--nxt-ink-dim,#8b8d98)">${d.label}</text>`;
		}
	});

	const gridLines = Array.from({ length: 5 }, (_, i) => {
		const y = Math.round(H - (i / 4) * chartH);
		const val = Math.round((i / 4) * max).toLocaleString();
		return `<line x1="${pad}" x2="${W}" y1="${y}" y2="${y}" stroke="var(--nxt-border,rgba(255,255,255,0.06))" stroke-width="0.5"/><text x="${pad - 6}" y="${y + 3}" text-anchor="end" font-size="10" fill="var(--nxt-ink-dim,#8b8d98)">${val}</text>`;
	}).join('');

	container.innerHTML = `<svg viewBox="0 0 ${W} ${H + 24}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto">${gridLines}${bars}${labels}</svg>`;
}

function renderTopActions(container, actions) {
	if (!actions.length) {
		container.innerHTML = `<div class="dev-usage-chart-empty" style="padding:24px 0"><span>No actions recorded yet</span></div>`;
		return;
	}

	const max = Math.max(1, actions[0].count);
	const colors = ['#6c8aff', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#22d3ee', '#94a3b8', '#818cf8', '#4ade80'];

	container.innerHTML = `<div class="dev-usage-actions-list">
		${actions.map((a, i) => {
			const pct = Math.round((a.count / max) * 100);
			const color = colors[i % colors.length];
			return `<div class="dev-usage-action-row">
				<div class="dev-usage-action-name">${esc(a.action)}</div>
				<div class="dev-usage-action-bar-wrap">
					<div class="dev-usage-action-bar" style="width:${pct}%;background:${color}"></div>
				</div>
				<div class="dev-usage-action-count">${a.count.toLocaleString()}</div>
			</div>`;
		}).join('')}
	</div>`;
}

function renderDeliveryRing(container, wh) {
	const total = wh.total_deliveries || 0;
	const succeeded = wh.succeeded || 0;
	const pct = total > 0 ? (succeeded / total) : 1;
	const radius = 54;
	const circ = 2 * Math.PI * radius;
	const offset = circ * (1 - pct);

	const color = pct >= 0.95 ? '#34d399' : pct >= 0.8 ? '#fbbf24' : '#f87171';
	const label = total > 0 ? `${(pct * 100).toFixed(1)}%` : '—';

	container.innerHTML = `
		<svg width="130" height="130" viewBox="0 0 130 130">
			<circle cx="65" cy="65" r="${radius}" fill="none" stroke="var(--nxt-bg-1,#111)" stroke-width="10"/>
			<circle cx="65" cy="65" r="${radius}" fill="none" stroke="${color}" stroke-width="10"
				stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
				stroke-linecap="round" transform="rotate(-90 65 65)"
				style="transition:stroke-dashoffset 0.6s ease"/>
			<text x="65" y="62" text-anchor="middle" font-size="22" font-weight="700" fill="var(--nxt-ink,#e4e5ea)">${label}</text>
			<text x="65" y="80" text-anchor="middle" font-size="11" fill="var(--nxt-ink-dim,#8b8d98)">success</text>
		</svg>
	`;
}

// ── Changelog Tab ──────────────────────────────────────────────────────────

const CHANGELOG = [
	{
		date: '2026-05-27',
		version: '1.5.1',
		category: 'api',
		title: 'Developer Hub & Webhook API',
		description: 'New Developer Hub with interactive Render API playground, webhook management, delivery logs with retry tracking, and cross-platform SDK guides. Standard Webhooks signature format (HMAC-SHA256).',
		tags: ['Render API', 'Webhooks', 'SDKs'],
	},
	{
		date: '2026-05-25',
		version: '1.5.0',
		category: 'platform',
		title: 'Avatar Render API',
		description: 'Public API to render any avatar as PNG/JPEG/WebP with scene presets (full-body, upper-body, portrait, headshot), custom backgrounds, and CDN caching. Up to 2048px resolution.',
		tags: ['API', 'Avatars', 'CDN'],
	},
	{
		date: '2026-05-22',
		version: '1.4.9',
		category: 'dashboard',
		title: 'Analytics & Conversion Funnel',
		description: 'Revenue charts, per-agent performance tables, skill breakdown, and conversion funnel (views → conversations → payments) with configurable time ranges.',
		tags: ['Analytics', 'Revenue', 'Dashboard'],
	},
	{
		date: '2026-05-19',
		version: '1.4.8',
		category: 'platform',
		title: 'x402 Payment Receipts & SKU Catalog',
		description: 'Stripe-style checkout with x402 USDC micropayments. Receipt ledger, SKU catalog management, and pay-by-name resolution (@username, *.sol, base58).',
		tags: ['x402', 'Payments', 'USDC'],
	},
	{
		date: '2026-05-15',
		version: '1.4.7',
		category: 'sdk',
		title: 'Web Component Embed Update',
		description: 'Updated <agent-3d> web component with 5 widget variants: turntable, animation gallery, talking agent, ERC-8004 passport, and hotspot tour. Widget Studio for WYSIWYG configuration.',
		tags: ['Web Component', 'Embed', 'Studio'],
	},
	{
		date: '2026-05-10',
		version: '1.4.6',
		category: 'platform',
		title: 'Agent Marketplace Enhancements',
		description: 'Infinite scroll with intersection observers, category filtering, search, and rating-based sorting. IndexedDB poster caching for instant thumbnails on repeat visits.',
		tags: ['Marketplace', 'Performance', 'UX'],
	},
	{
		date: '2026-05-05',
		version: '1.4.5',
		category: 'infrastructure',
		title: 'On-Chain Identity (ERC-8004)',
		description: 'Multi-chain agent identity with IdentityRegistry, ReputationRegistry, and ValidationRegistry on Solana. EIP-712 delegated signer wallets, signed action history with cryptographic proof.',
		tags: ['ERC-8004', 'Solana', 'Identity'],
	},
	{
		date: '2026-04-28',
		version: '1.4.4',
		category: 'api',
		title: 'Agent Runtime & Tool Loop',
		description: 'Sophisticated tool-loop architecture with up to 8 iterations per turn, signal aborts, and structured streaming. Claude (Anthropic) integration with ElevenLabs TTS and Web Speech STT.',
		tags: ['Agent Runtime', 'LLM', 'Voice'],
	},
	{
		date: '2026-04-20',
		version: '1.4.3',
		category: 'dashboard',
		title: 'Portfolio & Token Management',
		description: 'Crypto portfolio with real-time balances, token launch via Pump.fun, and DCA strategy configuration. Live price feeds from Solana RPC.',
		tags: ['Portfolio', 'Tokens', 'DeFi'],
	},
	{
		date: '2026-04-12',
		version: '1.4.2',
		category: 'sdk',
		title: 'Character Studio & Pose System',
		description: 'In-browser 3D character builder (MIT fork of m3-org/CharacterStudio) with Pose Studio for authoring exportable avatar poses. GLB export with animations and morph targets.',
		tags: ['Character Studio', 'Poses', 'GLB'],
	},
];

const CATEGORY_META = {
	api:            { label: 'API',            color: '#6c8aff' },
	platform:       { label: 'Platform',       color: '#34d399' },
	dashboard:      { label: 'Dashboard',      color: '#a78bfa' },
	sdk:            { label: 'SDK',            color: '#fbbf24' },
	infrastructure: { label: 'Infrastructure', color: '#f472b6' },
};

function renderChangelogTab(root) {
	const el = document.createElement('div');
	el.className = 'dev-changelog-tab';

	el.innerHTML = `
		<div class="dev-changelog-header">
			<div>
				<h2 class="dev-section-title">Changelog</h2>
				<p class="dev-section-desc">Recent platform updates, API changes, and new features. Follow our development velocity.</p>
			</div>
			<div class="dev-changelog-filters" id="changelog-filters">
				<button class="dev-changelog-filter is-active" data-filter="all">All</button>
				${Object.entries(CATEGORY_META).map(([key, meta]) =>
					`<button class="dev-changelog-filter" data-filter="${key}"><span class="dev-usage-dot" style="background:${meta.color}"></span>${meta.label}</button>`
				).join('')}
			</div>
		</div>
		<div class="dev-changelog-timeline" id="changelog-timeline"></div>
	`;

	root.appendChild(el);

	let filter = 'all';
	renderChangelogTimeline(el.querySelector('#changelog-timeline'), filter);

	el.querySelector('#changelog-filters').addEventListener('click', (e) => {
		const btn = e.target.closest('.dev-changelog-filter');
		if (!btn) return;
		filter = btn.dataset.filter;
		el.querySelectorAll('.dev-changelog-filter').forEach(b => b.classList.toggle('is-active', b === btn));
		renderChangelogTimeline(el.querySelector('#changelog-timeline'), filter);
	});
}

function renderChangelogTimeline(container, filter) {
	const entries = filter === 'all' ? CHANGELOG : CHANGELOG.filter(e => e.category === filter);

	if (!entries.length) {
		container.innerHTML = `<div class="dn-panel dev-changelog-empty">
			<span>No updates in this category yet.</span>
		</div>`;
		return;
	}

	container.innerHTML = entries.map((entry, i) => {
		const meta = CATEGORY_META[entry.category] || CATEGORY_META.platform;
		const dateStr = new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
		return `
			<div class="dev-changelog-entry${i === 0 ? ' is-latest' : ''}" style="--entry-delay:${i * 40}ms">
				<div class="dev-changelog-line">
					<div class="dev-changelog-dot" style="background:${meta.color}"></div>
				</div>
				<div class="dn-panel dev-changelog-card">
					<div class="dev-changelog-card-header">
						<div class="dev-changelog-card-meta">
							<span class="dn-tag" style="background:${meta.color}20;color:${meta.color};border-color:${meta.color}40">${meta.label}</span>
							<span class="dev-changelog-version">v${esc(entry.version)}</span>
							<span class="dev-changelog-date">${dateStr}</span>
						</div>
						${i === 0 ? '<span class="dn-tag success" style="font-size:10px">Latest</span>' : ''}
					</div>
					<h3 class="dev-changelog-title">${esc(entry.title)}</h3>
					<p class="dev-changelog-desc">${esc(entry.description)}</p>
					<div class="dev-changelog-tags">
						${entry.tags.map(t => `<span class="dev-badge">${esc(t)}</span>`).join('')}
					</div>
				</div>
			</div>
		`;
	}).join('');
}

// ── Utilities ───────────────────────────────────────────────────────────────

function copyText(text, btn) {
	navigator.clipboard.writeText(text).then(() => {
		const orig = btn.textContent;
		btn.textContent = 'Copied!';
		btn.classList.add('copied');
		setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 2000);
	}).catch(() => {});
}

function showToast(msg, type = 'success') {
	const toast = document.createElement('div');
	toast.className = `dev-toast dev-toast-${type}`;
	toast.textContent = msg;
	document.body.appendChild(toast);
	requestAnimationFrame(() => toast.classList.add('is-visible'));
	setTimeout(() => {
		toast.classList.remove('is-visible');
		setTimeout(() => toast.remove(), 300);
	}, 3000);
}

// ── Styles ──────────────────────────────────────────────────────────────────

function injectStyles() {
	if (document.getElementById('dev-styles')) return;
	const style = document.createElement('style');
	style.id = 'dev-styles';
	style.textContent = `
/* ── Layout ───────────────────────────────────────────────── */
.dev-header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; flex-wrap:wrap; margin-bottom:8px; }
.dev-header .dn-btn { flex-shrink:0; }

.dev-tabs {
	display:flex; gap:4px; padding:4px; margin-bottom:24px;
	background:var(--nxt-bg-2); border-radius:var(--nxt-radius-sm);
	overflow-x:auto; -webkit-overflow-scrolling:touch;
}
.dev-tab {
	display:inline-flex; align-items:center; gap:8px;
	padding:10px 20px; border:none; background:none;
	color:var(--nxt-ink-dim); font:inherit; font-size:14px; font-weight:500;
	border-radius:calc(var(--nxt-radius-sm) - 2px); cursor:pointer;
	transition:all 0.15s ease; white-space:nowrap;
}
.dev-tab:hover { color:var(--nxt-ink); background:var(--nxt-accent-soft); }
.dev-tab.is-active { color:var(--nxt-ink); background:var(--nxt-bg-3); box-shadow:0 1px 3px rgba(0,0,0,0.2); }
.dev-tab svg { opacity:0.6; flex-shrink:0; }
.dev-tab.is-active svg { opacity:1; }

.dev-content > * + * { margin-top:20px; }

/* ── Section titles ───────────────────────────────────────── */
.dev-section-title { font-size:20px; font-weight:600; margin:0 0 6px; letter-spacing:-0.02em; }
.dev-section-desc { color:var(--nxt-ink-dim); font-size:14px; line-height:1.5; margin:0; max-width:640px; }
.dev-panel-title { font-size:15px; font-weight:600; margin:0 0 4px; }
.dev-panel-desc { color:var(--nxt-ink-dim); font-size:13px; margin:0 0 16px; line-height:1.5; }

/* ── Render hero ──────────────────────────────────────────── */
.dev-render-hero { padding:28px; }
.dev-render-stats {
	display:flex; gap:32px; margin-top:20px; flex-wrap:wrap;
}
.dev-stat { display:flex; flex-direction:column; gap:2px; }
.dev-stat-value { font-size:22px; font-weight:700; letter-spacing:-0.02em; }
.dev-stat-label { font-size:12px; color:var(--nxt-ink-dim); text-transform:uppercase; letter-spacing:0.05em; }

/* ── Playground ───────────────────────────────────────────── */
.dev-playground { padding:24px; }
.dev-playground-grid {
	display:grid; grid-template-columns:1fr 1fr; gap:24px;
	margin-top:16px;
}
@media (max-width:900px) { .dev-playground-grid { grid-template-columns:1fr; } }

.dev-playground-controls { display:flex; flex-direction:column; gap:16px; }

.dev-field { display:flex; flex-direction:column; gap:6px; }
.dev-field-label { font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:var(--nxt-ink-dim); }
.dev-field-opt { font-weight:400; opacity:0.6; }
.dev-field-row { display:flex; gap:8px; }
.dev-field-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
.dev-field-grid-3 { grid-template-columns:1fr 1fr 1fr; }
@media (max-width:600px) { .dev-field-grid, .dev-field-grid-3 { grid-template-columns:1fr; } }

.dev-input {
	background:var(--nxt-bg-1); border:1px solid var(--nxt-stroke);
	border-radius:var(--nxt-radius-sm); padding:10px 14px;
	color:var(--nxt-ink); font:inherit; font-size:14px; font-family:ui-monospace,'SF Mono',monospace;
	transition:border-color 0.15s;
	width:100%; min-width:0;
}
.dev-input:focus { outline:none; border-color:var(--nxt-accent); }
.dev-input-error { border-color:var(--nxt-danger) !important; animation:dev-shake 0.3s ease; }
@keyframes dev-shake { 20%,60%{transform:translateX(-3px)} 40%,80%{transform:translateX(3px)} }

.dev-select {
	background:var(--nxt-bg-1); border:1px solid var(--nxt-stroke);
	border-radius:var(--nxt-radius-sm); padding:10px 14px;
	color:var(--nxt-ink); font:inherit; font-size:14px;
	cursor:pointer; width:100%;
}
.dev-select-sm { max-width:160px; }

/* ── Scene selector ───────────────────────────────────────── */
.dev-scene-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
@media (max-width:600px) { .dev-scene-grid { grid-template-columns:repeat(2,1fr); } }
.dev-scene-btn {
	display:flex; flex-direction:column; align-items:center; gap:4px;
	padding:12px 8px; border:1px solid var(--nxt-stroke); background:var(--nxt-bg-1);
	border-radius:var(--nxt-radius-sm); cursor:pointer;
	color:var(--nxt-ink-dim); font:inherit; font-size:11px; text-transform:capitalize;
	transition:all 0.15s;
}
.dev-scene-btn:hover { border-color:var(--nxt-stroke-strong); color:var(--nxt-ink); }
.dev-scene-btn.is-active {
	border-color:var(--nxt-accent); color:var(--nxt-ink);
	background:var(--nxt-accent-soft);
}
.dev-scene-icon { font-size:0; line-height:0; }

/* ── Background selector ──────────────────────────────────── */
.dev-bg-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dev-bg-btn {
	width:32px; height:32px; border:2px solid var(--nxt-stroke); border-radius:8px;
	cursor:pointer; padding:3px; background:none; transition:border-color 0.15s;
}
.dev-bg-btn:hover { border-color:var(--nxt-stroke-strong); }
.dev-bg-btn.is-active { border-color:var(--nxt-accent); }
.dev-bg-swatch { display:block; width:100%; height:100%; border-radius:4px; }
.dev-bg-transparent {
	background:repeating-conic-gradient(#333 0% 25%, #555 0% 50%) 50%/8px 8px;
}
.dev-bg-color {
	width:32px; height:32px; border:2px solid var(--nxt-stroke); border-radius:8px;
	cursor:pointer; padding:0; background:none;
}
.dev-bg-color::-webkit-color-swatch-wrapper { padding:3px; }
.dev-bg-color::-webkit-color-swatch { border:none; border-radius:4px; }

/* ── Preview ──────────────────────────────────────────────── */
.dev-playground-preview { display:flex; flex-direction:column; gap:12px; }
.dev-preview-frame {
	aspect-ratio:1; background:var(--nxt-bg-1);
	border:1px solid var(--nxt-stroke); border-radius:var(--nxt-radius);
	display:flex; align-items:center; justify-content:center;
	overflow:hidden; position:relative;
	background-image:repeating-conic-gradient(rgba(255,255,255,0.03) 0% 25%, transparent 0% 50%);
	background-size:16px 16px;
}
.dev-preview-empty, .dev-preview-loading, .dev-preview-error {
	display:flex; flex-direction:column; align-items:center; gap:12px;
	color:var(--nxt-ink-dim); font-size:13px; text-align:center; padding:24px;
}
.dev-preview-spinner {
	width:32px; height:32px; border:3px solid var(--nxt-stroke);
	border-top-color:var(--nxt-accent); border-radius:50%;
	animation:dev-spin 0.8s linear infinite;
}
@keyframes dev-spin { to { transform:rotate(360deg); } }
.dev-preview-img {
	width:100%; height:100%; object-fit:contain;
	animation:dev-fadeIn 0.3s ease;
}
@keyframes dev-fadeIn { from { opacity:0; transform:scale(0.96); } to { opacity:1; transform:scale(1); } }

.dev-render-btn { width:100%; }

/* ── URL builder ──────────────────────────────────────────── */
.dev-url-builder { padding:20px 24px; }
.dev-url-row {
	display:flex; gap:8px; align-items:stretch;
	background:var(--nxt-bg-1); border:1px solid var(--nxt-stroke);
	border-radius:var(--nxt-radius-sm); padding:4px; margin-top:8px;
}
.dev-url-code {
	flex:1; padding:10px 12px; font-size:13px; line-height:1.4;
	font-family:ui-monospace,'SF Mono',monospace; color:var(--nxt-ink-dim);
	overflow-x:auto; white-space:nowrap; min-width:0;
}
.dev-copy-btn {
	flex-shrink:0; font-size:12px; padding:6px 14px; border-radius:8px;
	align-self:center;
}
.dev-copy-btn.copied { color:var(--nxt-success); }

/* ── Code examples ────────────────────────────────────────── */
.dev-code-examples { padding:24px; }
.dev-code-tabs {
	display:flex; gap:2px; margin-bottom:12px;
	border-bottom:1px solid var(--nxt-stroke); padding-bottom:0;
}
.dev-code-tab {
	padding:8px 16px; border:none; background:none;
	color:var(--nxt-ink-dim); font:inherit; font-size:13px; font-weight:500;
	cursor:pointer; border-bottom:2px solid transparent;
	transition:all 0.15s; margin-bottom:-1px;
}
.dev-code-tab:hover { color:var(--nxt-ink); }
.dev-code-tab.is-active { color:var(--nxt-ink); border-bottom-color:var(--nxt-accent); }

.dev-code-block {
	position:relative; background:var(--nxt-bg-1);
	border:1px solid var(--nxt-stroke); border-radius:var(--nxt-radius-sm);
	overflow:hidden;
}
.dev-code-block pre {
	margin:0; padding:16px 20px; overflow-x:auto;
	font-size:13px; line-height:1.55; color:var(--nxt-ink-dim);
	font-family:ui-monospace,'SF Mono',monospace;
}
.dev-code-block code { font-family:inherit; }
.dev-code-copy { position:absolute; top:8px; right:8px; }

.dev-code-inline {
	background:var(--nxt-bg-1); border:1px solid var(--nxt-stroke);
	border-radius:var(--nxt-radius-sm); padding:12px 16px;
	font-size:13px; line-height:1.55; color:var(--nxt-ink-dim);
	font-family:ui-monospace,'SF Mono',monospace;
	overflow-x:auto; display:block; margin-top:12px;
}
.dev-code-inline code { font-family:inherit; }

/* ── Webhooks ─────────────────────────────────────────────── */
.dev-webhooks-header {
	display:flex; align-items:flex-start; justify-content:space-between;
	gap:16px; flex-wrap:wrap; margin-bottom:20px;
}
.dev-wh-form { margin-bottom:20px; padding:24px; }
.dev-wh-form .dev-field + .dev-field { margin-top:14px; }
.dev-form-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:20px; }

.dev-event-grid {
	display:grid; grid-template-columns:repeat(auto-fill,minmax(200px,1fr)); gap:6px;
}
.dev-event-check {
	display:flex; align-items:center; gap:8px; padding:8px 12px;
	background:var(--nxt-bg-1); border:1px solid var(--nxt-stroke);
	border-radius:8px; cursor:pointer; font-size:13px;
	font-family:ui-monospace,'SF Mono',monospace; color:var(--nxt-ink-dim);
	transition:border-color 0.15s;
}
.dev-event-check:hover { border-color:var(--nxt-stroke-strong); }
.dev-event-check input { accent-color:var(--nxt-accent); }

.dev-wh-card { padding:18px 24px; }
.dev-wh-card + .dev-wh-card { margin-top:12px; }
.dev-wh-card-header { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.dev-wh-card-info { min-width:0; }
.dev-wh-card-url { display:flex; align-items:center; gap:8px; }
.dev-wh-card-url code {
	font-size:13px; color:var(--nxt-ink);
	overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.dev-wh-card-desc { font-size:13px; color:var(--nxt-ink-dim); margin-top:4px; }
.dev-wh-card-actions { display:flex; gap:6px; flex-shrink:0; }
.dev-wh-card-meta { margin-top:10px; display:flex; flex-wrap:wrap; gap:6px; font-size:12px; color:var(--nxt-ink-dim); }
.dev-wh-card-meta .dn-tag { font-size:10px; padding:2px 6px; }
.dev-wh-card-stats {
	display:flex; gap:16px; margin-top:10px; font-size:12px;
	padding-top:10px; border-top:1px solid var(--nxt-stroke);
}
.dev-wh-stat { color:var(--nxt-ink-dim); }
.dev-wh-stat.success { color:var(--nxt-success); }
.dev-wh-stat.danger { color:var(--nxt-danger); }

.dev-wh-empty {
	display:flex; flex-direction:column; align-items:center; gap:8px;
	padding:48px 24px; text-align:center; border-style:dashed;
}
.dev-wh-empty h3 { font-size:15px; margin:0; }
.dev-wh-empty p { color:var(--nxt-ink-dim); font-size:13px; margin:0; max-width:360px; }

.dev-wh-verify { padding:24px; margin-top:24px; }
.dev-wh-verify code {
	background:rgba(255,255,255,0.05); padding:1px 5px; border-radius:4px;
	font-size:0.9em;
}

.dev-text-dim { color:var(--nxt-ink-fade); }

/* ── SDKs ─────────────────────────────────────────────────── */
.dev-sdks-hero { padding:28px; margin-bottom:4px; }
.dev-sdk-grid {
	display:grid; grid-template-columns:repeat(2,1fr); gap:16px;
}
@media (max-width:900px) { .dev-sdk-grid { grid-template-columns:1fr; } }

.dev-sdk-card { padding:24px; display:flex; flex-direction:column; gap:14px; }
.dev-sdk-card-header { display:flex; align-items:center; gap:14px; }
.dev-sdk-icon {
	width:48px; height:48px; border-radius:12px;
	display:flex; align-items:center; justify-content:center;
	font-size:20px; font-weight:700;
	flex-shrink:0;
}
.dev-sdk-web { background:rgba(99,102,241,0.15); color:#818cf8; }
.dev-sdk-unity { background:rgba(255,255,255,0.08); color:#fff; }
.dev-sdk-unreal { background:rgba(0,0,0,0.3); color:#fff; }
.dev-sdk-rest { background:rgba(74,222,128,0.12); color:#4ade80; }
.dev-sdk-name { font-size:16px; font-weight:600; margin:0; }
.dev-sdk-desc { color:var(--nxt-ink-dim); font-size:13px; line-height:1.5; margin:0; }
.dev-sdk-links { display:flex; gap:8px; margin-top:auto; padding-top:8px; }

/* ── Interop callout ──────────────────────────────────────── */
.dev-interop-callout {
	padding:32px; margin-top:20px;
	background:linear-gradient(135deg, rgba(99,102,241,0.08) 0%, rgba(168,85,247,0.08) 100%);
	border:1px solid rgba(99,102,241,0.15);
}
.dev-interop-badges { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; }
.dev-badge {
	padding:6px 14px; border-radius:var(--nxt-radius-pill);
	background:rgba(255,255,255,0.06); border:1px solid var(--nxt-stroke);
	font-size:12px; font-weight:500; color:var(--nxt-ink-dim);
}

/* ── Modal ────────────────────────────────────────────────── */
.dev-modal-overlay {
	position:fixed; inset:0; z-index:1000;
	background:var(--nxt-glass-strong);
	display:flex; align-items:center; justify-content:center;
	padding:24px; animation:dev-fadeIn 0.2s ease;
}
.dev-modal {
	background:var(--nxt-bg-2); border:1px solid var(--nxt-stroke);
	border-radius:var(--nxt-radius); padding:28px; max-width:520px; width:100%;
}
.dev-modal-title { font-size:18px; font-weight:600; margin:0 0 8px; }
.dev-modal-desc { color:var(--nxt-ink-dim); font-size:14px; margin:0 0 16px; line-height:1.5; }
.dev-modal-actions { display:flex; justify-content:flex-end; margin-top:20px; }
.dev-secret-code { font-size:12px; word-break:break-all; white-space:normal; }

/* ── Toast ────────────────────────────────────────────────── */
.dev-toast {
	position:fixed; bottom:24px; left:50%; transform:translateX(-50%) translateY(16px);
	padding:10px 20px; border-radius:var(--nxt-radius-pill);
	background:var(--nxt-bg-3); border:1px solid var(--nxt-stroke);
	color:var(--nxt-ink); font-size:13px; font-weight:500;
	z-index:2000; opacity:0; transition:all 0.3s ease;
	pointer-events:none;
}
.dev-toast.is-visible { opacity:1; transform:translateX(-50%) translateY(0); }
.dev-toast-danger { border-color:rgba(248,113,113,0.3); color:var(--nxt-danger); }

/* ── Danger button ────────────────────────────────────────── */
.dn-btn.danger,
.dn-btn.ghost.danger {
	color:var(--nxt-danger);
}
.dn-btn.ghost.danger:hover {
	background:rgba(248,113,113,0.1);
}

/* ── Usage Tab ───────────────────────────────────────────── */
.dev-usage-header {
	display:flex; align-items:flex-start; justify-content:space-between;
	gap:16px; flex-wrap:wrap; margin-bottom:20px;
}
.dev-usage-range {
	display:flex; gap:4px; background:var(--nxt-bg-2); border-radius:8px; padding:3px;
}
.dev-usage-range-btn {
	padding:6px 16px; border:none; background:none;
	color:var(--nxt-ink-dim); font:inherit; font-size:12px; font-weight:600;
	border-radius:6px; cursor:pointer; transition:all 0.15s;
}
.dev-usage-range-btn:hover { color:var(--nxt-ink); }
.dev-usage-range-btn.is-active {
	background:rgba(108,138,255,0.15); color:#6c8aff;
}

.dev-usage-kpis {
	display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin-bottom:20px;
}
@media (max-width:900px) { .dev-usage-kpis { grid-template-columns:repeat(2,1fr); } }
@media (max-width:500px) { .dev-usage-kpis { grid-template-columns:1fr; } }

.dev-usage-kpi {
	padding:20px; display:flex; align-items:center; gap:16px;
}
.dev-usage-kpi-icon {
	width:44px; height:44px; border-radius:12px;
	display:flex; align-items:center; justify-content:center; flex-shrink:0;
}
.dev-usage-kpi-value {
	font-size:26px; font-weight:700; letter-spacing:-0.02em;
}
.dev-usage-kpi-label {
	font-size:12px; color:var(--nxt-ink-dim); margin-top:2px;
}

.dev-usage-chart-panel { padding:24px; margin-bottom:20px; }
.dev-usage-chart-empty {
	display:flex; flex-direction:column; align-items:center; gap:12px;
	padding:40px 20px; text-align:center; color:var(--nxt-ink-dim); font-size:13px;
}
.dev-usage-chart-empty a { color:#6c8aff; }

.dev-usage-two-col {
	display:grid; grid-template-columns:1fr 1fr; gap:14px;
}
@media (max-width:900px) { .dev-usage-two-col { grid-template-columns:1fr; } }

.dev-usage-actions-panel { padding:20px; }
.dev-usage-actions-list { display:flex; flex-direction:column; gap:8px; margin-top:12px; }
.dev-usage-action-row {
	display:grid; grid-template-columns:130px 1fr 60px; gap:10px;
	align-items:center; font-size:13px;
}
.dev-usage-action-name {
	font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
	font-family:ui-monospace,'SF Mono',monospace; font-size:12px;
}
.dev-usage-action-bar-wrap {
	height:8px; background:var(--nxt-bg-2); border-radius:4px; overflow:hidden;
}
.dev-usage-action-bar { height:100%; border-radius:4px; transition:width 0.3s ease; }
.dev-usage-action-count { text-align:right; font-weight:600; font-size:13px; }

.dev-usage-delivery-panel { padding:20px; }
.dev-usage-delivery-stats {
	display:flex; align-items:center; gap:24px; margin-top:16px;
}
.dev-usage-delivery-breakdown { display:flex; flex-direction:column; gap:10px; }
.dev-usage-delivery-row {
	display:flex; align-items:center; gap:8px; font-size:13px;
}
.dev-usage-delivery-row strong { margin-left:auto; }
.dev-usage-dot {
	width:8px; height:8px; border-radius:50%; flex-shrink:0;
}

/* ── Webhook Delivery Drill-down ─────────────────────────── */
.dev-wh-deliveries { margin-top:12px; }
.dev-wh-view-btn {
	font-size:12px; padding:4px 12px; border:1px solid var(--nxt-stroke);
	background:none; color:var(--nxt-ink-dim); border-radius:6px;
	cursor:pointer; transition:all 0.15s; font:inherit;
}
.dev-wh-view-btn:hover { color:var(--nxt-ink); border-color:var(--nxt-stroke-strong); }
.dev-wh-delivery-list { margin-top:8px; }
.dev-wh-delivery-item {
	display:grid; grid-template-columns:80px 1fr 60px 100px; gap:10px;
	padding:8px 12px; font-size:12px; align-items:center;
	border-bottom:1px solid var(--nxt-border,rgba(255,255,255,0.04));
}
.dev-wh-delivery-item:first-child { border-top:1px solid var(--nxt-border,rgba(255,255,255,0.04)); }
.dev-wh-delivery-event {
	font-family:ui-monospace,'SF Mono',monospace; font-size:11px;
	white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}
.dev-wh-delivery-status {
	display:inline-flex; align-items:center; gap:4px; font-weight:600;
}
.dev-wh-delivery-status.ok { color:#34d399; }
.dev-wh-delivery-status.fail { color:#f87171; }
.dev-wh-delivery-status.pending { color:#fbbf24; }

/* ── Changelog Tab ───────────────────────────────────────── */
.dev-changelog-header {
	display:flex; align-items:flex-start; justify-content:space-between;
	gap:16px; flex-wrap:wrap; margin-bottom:24px;
}
.dev-changelog-filters {
	display:flex; gap:4px; flex-wrap:wrap;
}
.dev-changelog-filter {
	display:inline-flex; align-items:center; gap:6px;
	padding:6px 14px; border:1px solid var(--nxt-border,rgba(255,255,255,0.07));
	border-radius:8px; background:none; color:var(--nxt-ink-dim);
	font:inherit; font-size:12px; font-weight:500; cursor:pointer;
	transition:all 0.15s;
}
.dev-changelog-filter:hover { color:var(--nxt-ink); background:var(--nxt-bg-2); }
.dev-changelog-filter.is-active {
	background:rgba(108,138,255,0.12); color:#6c8aff;
	border-color:rgba(108,138,255,0.3);
}

.dev-changelog-timeline { position:relative; }
.dev-changelog-entry {
	display:grid; grid-template-columns:20px 1fr; gap:16px;
	animation:dev-fadeIn 0.3s ease backwards;
	animation-delay:var(--entry-delay,0ms);
}
.dev-changelog-line {
	display:flex; flex-direction:column; align-items:center; position:relative;
}
.dev-changelog-line::after {
	content:''; position:absolute; top:16px; bottom:0;
	width:2px; background:var(--nxt-border,rgba(255,255,255,0.07));
}
.dev-changelog-entry:last-child .dev-changelog-line::after { display:none; }
.dev-changelog-dot {
	width:12px; height:12px; border-radius:50%; flex-shrink:0;
	margin-top:20px; z-index:1;
	box-shadow:0 0 0 3px var(--nxt-bg-base,#0e0f14);
}

.dev-changelog-card {
	padding:20px 24px; margin-bottom:16px;
}
.dev-changelog-card-header {
	display:flex; align-items:center; justify-content:space-between; gap:8px;
	margin-bottom:8px;
}
.dev-changelog-card-meta {
	display:flex; align-items:center; gap:8px; flex-wrap:wrap;
}
.dev-changelog-version {
	font-size:12px; font-weight:600; color:var(--nxt-ink-dim);
	font-family:ui-monospace,'SF Mono',monospace;
}
.dev-changelog-date {
	font-size:12px; color:var(--nxt-ink-faint,#5a5c68);
}
.dev-changelog-title {
	font-size:16px; font-weight:600; margin:0 0 6px; letter-spacing:-0.01em;
}
.dev-changelog-desc {
	font-size:13px; color:var(--nxt-ink-dim); line-height:1.6; margin:0 0 12px;
	max-width:640px;
}
.dev-changelog-tags { display:flex; flex-wrap:wrap; gap:6px; }

.dev-changelog-empty {
	display:flex; align-items:center; justify-content:center;
	padding:40px; color:var(--nxt-ink-dim); font-size:13px;
}
	`;
	document.head.appendChild(style);
}
