// Library → Animations tab.
// Aggregates animation clips from every agent the user owns
// (agent.meta.animations is the canonical store). Upload uses the same
// presign → R2 PUT → PATCH agents/:id/animations flow as the legacy dashboard.

import { get, put, post, esc, relTime } from '../../api.js';

export async function renderAnimations(host) {
	host.innerHTML = `
		<div class="anim-head">
			<div>
				<h2 class="dn-panel-title" style="font-size:17px;margin:0 0 4px">Your animation library</h2>
				<div class="dn-panel-sub" style="margin:0">Clips attached to any of your agents. Uploading adds a clip to the agent you select.</div>
			</div>
			<div class="anim-head-actions">
				<a class="dn-btn ghost" href="/walk">Browse presets →</a>
				<button class="dn-btn primary" id="anim-upload-open" type="button">Upload .glb</button>
			</div>
		</div>

		<div id="anim-grid" class="anim-grid"></div>

		<dialog id="anim-upload" class="anim-dialog">
			<form method="dialog" class="anim-upload-form">
				<h3 style="margin:0 0 4px">Upload animation clip</h3>
				<p class="dn-panel-sub" style="margin:0 0 12px">Drop a Mixamo-rigged .glb. We attach it to the agent you choose.</p>

				<label class="anim-field">
					<span>Attach to agent</span>
					<select id="anim-up-agent" required></select>
				</label>

				<label class="anim-field">
					<span>Clip name</span>
					<input id="anim-up-name" type="text" maxlength="60" placeholder="e.g. my-wave" required />
				</label>

				<label class="anim-field">
					<span>.glb file (max 100 MB)</span>
					<input id="anim-up-file" type="file" accept=".glb,model/gltf-binary" required />
				</label>

				<label class="anim-field-row">
					<input id="anim-up-loop" type="checkbox" checked />
					<span>Loop this clip</span>
				</label>

				<div id="anim-up-status" class="anim-up-status"></div>
				<div id="anim-up-error"  class="anim-up-error"></div>

				<div class="anim-up-actions">
					<button type="button" id="anim-up-cancel" class="dn-btn ghost">Cancel</button>
					<button type="button" id="anim-up-submit" class="dn-btn primary">Upload &amp; attach</button>
				</div>
			</form>
		</dialog>

		<style>
			.anim-head { display:flex; align-items:flex-end; justify-content:space-between; gap:14px; margin-bottom:14px; flex-wrap:wrap; }
			.anim-head-actions { display:flex; gap:8px; flex-wrap:wrap; }
			.anim-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:12px; }
			.anim-card { border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.02); border-radius:12px; padding:14px; display:flex; flex-direction:column; gap:8px; transition:border-color .15s, background .15s; }
			.anim-card:hover { border-color:rgba(255,255,255,0.18); background:rgba(255,255,255,0.04); }
			.anim-card-title { font-size:14px; font-weight:600; color:var(--nxt-ink); word-break:break-word; }
			.anim-card-meta { display:flex; flex-wrap:wrap; gap:6px; }
			.anim-card-agent { font-size:11px; color:var(--nxt-ink-fade); }
			.anim-dialog { border:none; background:#11111a; color:var(--nxt-ink); border-radius:14px; padding:0; max-width:480px; width:90vw; }
			.anim-dialog::backdrop { background:rgba(0,0,0,0.6); }
			.anim-upload-form { padding:22px 22px 20px; display:flex; flex-direction:column; gap:12px; }
			.anim-field { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--nxt-ink-dim); }
			.anim-field input[type="text"], .anim-field input[type="file"], .anim-field select {
				background:#0a0a14; border:1px solid rgba(255,255,255,0.1); color:var(--nxt-ink);
				border-radius:8px; padding:8px 10px; font:inherit;
			}
			.anim-field-row { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--nxt-ink-dim); }
			.anim-up-status { font-size:12px; color:var(--nxt-ink-fade); min-height:16px; }
			.anim-up-error  { font-size:12px; color:#ff9ab1; min-height:16px; }
			.anim-up-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:4px; }
		</style>
	`;

	const grid = host.querySelector('#anim-grid');

	let agents = [];
	try {
		const res = await get('/api/agents');
		agents = res?.agents || [];
	} catch (err) {
		grid.innerHTML = `<div class="dn-empty"><h3>Couldn’t load agents</h3><p>${esc(err.message || 'Failed')}</p></div>`;
		return;
	}

	const allClips = [];
	for (const a of agents) {
		const clips = Array.isArray(a.meta?.animations) ? a.meta.animations : [];
		for (const c of clips) allClips.push({ ...c, _agent: a });
	}

	if (!allClips.length) {
		grid.innerHTML = `
			<div class="dn-empty" style="grid-column:1/-1">
				<h3>No animations yet</h3>
				<p>Upload a .glb or pick from our mocap library.</p>
				<div style="display:flex;gap:8px;justify-content:center;margin-top:12px;flex-wrap:wrap">
					<button class="dn-btn primary" id="anim-empty-upload" type="button">Upload</button>
					<a class="dn-btn ghost" href="/walk">Browse presets →</a>
				</div>
			</div>
		`;
		grid.querySelector('#anim-empty-upload')?.addEventListener('click', () => openUploadDialog(host, agents, refresh));
	} else {
		for (const c of allClips) grid.appendChild(clipCard(c));
	}

	host.querySelector('#anim-upload-open')?.addEventListener('click', () => openUploadDialog(host, agents, refresh));

	async function refresh() {
		await renderAnimations(host);
	}
}

function clipCard(clip) {
	const div = document.createElement('div');
	div.className = 'anim-card';
	const sourceTag = clip.source === 'preset'
		? '<span class="dn-tag success">preset</span>'
		: clip.source === 'mixamo'
			? '<span class="dn-tag">mocap</span>'
			: '<span class="dn-tag warn">uploaded</span>';
	const loopTag = clip.loop === false ? '' : '<span class="dn-tag">loops</span>';
	const added = clip.addedAt ? `added ${esc(relTime(clip.addedAt))}` : '';
	div.innerHTML = `
		<div class="anim-card-title">${esc(clip.name || 'unnamed')}</div>
		<div class="anim-card-meta">${sourceTag}${loopTag}</div>
		<div class="anim-card-agent">on <strong>${esc(clip._agent?.name || 'agent')}</strong>${added ? ' · ' + added : ''}</div>
	`;
	return div;
}

function openUploadDialog(host, agents, onDone) {
	const dialog = host.querySelector('#anim-upload');
	const agentSel = dialog.querySelector('#anim-up-agent');
	agentSel.innerHTML = agents
		.map((a) => `<option value="${esc(a.id)}">${esc(a.name || a.id)}</option>`)
		.join('');
	if (!agents.length) {
		agentSel.innerHTML = '<option value="" disabled>No agents — create one first</option>';
	}
	dialog.querySelector('#anim-up-name').value = '';
	dialog.querySelector('#anim-up-file').value = '';
	dialog.querySelector('#anim-up-loop').checked = true;
	dialog.querySelector('#anim-up-status').textContent = '';
	dialog.querySelector('#anim-up-error').textContent = '';

	dialog.querySelector('#anim-up-cancel').onclick = () => dialog.close();
	dialog.querySelector('#anim-up-submit').onclick = async () => {
		const agentId = agentSel.value;
		const name    = dialog.querySelector('#anim-up-name').value.trim();
		const file    = dialog.querySelector('#anim-up-file').files?.[0];
		const loop    = dialog.querySelector('#anim-up-loop').checked;
		const statusEl = dialog.querySelector('#anim-up-status');
		const errorEl  = dialog.querySelector('#anim-up-error');
		errorEl.textContent = '';

		if (!agentId) { errorEl.textContent = 'Select an agent.'; return; }
		if (!name)    { errorEl.textContent = 'Clip name is required.'; return; }
		if (!file)    { errorEl.textContent = 'Pick a .glb file.'; return; }

		const agent = agents.find((a) => a.id === agentId);
		const current = Array.isArray(agent?.meta?.animations) ? [...agent.meta.animations] : [];
		if (current.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
			errorEl.textContent = `"${name}" is already attached to this agent.`;
			return;
		}

		statusEl.textContent = 'Requesting upload URL…';
		try {
			const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'anim';
			const presign = await post('/api/animations/presign', {
				size_bytes: file.size,
				content_type: 'model/gltf-binary',
				slug,
			});

			statusEl.textContent = `Uploading ${(file.size / 1024 / 1024).toFixed(1)} MB…`;
			await uploadFile(presign.upload_url, file, (pct) => {
				statusEl.textContent = `Uploading ${pct}%…`;
			});

			const nextClips = [
				...current,
				{ name, url: presign.storage_key, loop, source: 'custom', addedAt: new Date().toISOString() },
			];
			statusEl.textContent = 'Attaching to agent…';
			await put(`/api/agents/${encodeURIComponent(agentId)}/animations`, { animations: nextClips });

			statusEl.textContent = 'Done.';
			dialog.close();
			onDone?.();
		} catch (err) {
			statusEl.textContent = '';
			errorEl.textContent = err.message || 'Upload failed.';
		}
	};

	dialog.showModal();
}

function uploadFile(url, file, onProgress) {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', url);
		xhr.setRequestHeader('content-type', 'model/gltf-binary');
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
		};
		xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
			? resolve()
			: reject(new Error(`Upload failed (${xhr.status})`)));
		xhr.onerror = () => reject(new Error('Network error during upload'));
		xhr.send(file);
	});
}
