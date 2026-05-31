// Account integration for the Animation Studio: save the current animation to
// the signed-in user's account, and a "My animations" library to reopen, edit,
// rename, delete, and export saved clips.
//
// Talks to /api/animations/clips (Task 3 CRUD) and /api/animations/thumbnail.
// The studio passes a small API surface (the timeline document, serialize, and
// avatar helpers) so this module never reaches into the scene directly.

import { Quaternion } from 'three';

const SESSION_KEY = 'pose:pendingDoc';

const el = (tag, attrs = {}, children = []) => {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') node.className = v;
		else if (k === 'html') node.innerHTML = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
		else if (v !== false && v != null) node.setAttribute(k, v);
	}
	for (const c of [].concat(children)) {
		if (c == null || c === false) continue;
		node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return node;
};

async function apiFetch(url, opts = {}) {
	const res = await fetch(url, { credentials: 'include', ...opts });
	let body = null;
	try { body = await res.json(); } catch {}
	if (!res.ok) {
		const msg = body?.error_description || body?.error || `request failed (${res.status})`;
		const err = new Error(msg);
		err.status = res.status;
		throw err;
	}
	return body;
}

function fmtDuration(ms) {
	const s = (Number(ms) || 0) / 1000;
	return s >= 1 ? `${s.toFixed(s % 1 ? 1 : 0)}s` : `${Math.round(s * 1000)}ms`;
}
function fmtDate(iso) {
	if (!iso) return '';
	try {
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	} catch { return ''; }
}

export class PoseLibrary {
	constructor(api) {
		this.api = api;
		this.user = undefined;       // undefined = unknown, null = signed out, object = signed in
		this.savedClip = null;       // { id, slug, name, visibility } when editing a saved clip
		this.tab = 'mine';
		this.onSell = null;          // Task 6 sets this to wire the Sell action
	}

	mount() {
		const saveBtn = document.querySelector('#pose-save');
		const libBtn = document.querySelector('#pose-library');
		saveBtn?.addEventListener('click', () => this.openSaveDialog());
		libBtn?.addEventListener('click', () => this.openLibrary());

		// Ctrl/Cmd+S → save (don't trigger the browser's save-page dialog).
		window.addEventListener('keydown', (ev) => {
			if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
				ev.preventDefault();
				this.openSaveDialog();
			}
		});

		this._restorePending();
	}

	// ── Auth ────────────────────────────────────────────────────────────────
	async getUser(force = false) {
		if (this.user !== undefined && !force) return this.user;
		try {
			const body = await apiFetch('/api/auth/me');
			this.user = body?.user || null;
		} catch (err) {
			this.user = err.status === 401 ? null : undefined;
		}
		return this.user;
	}

	// Preserve the in-progress document across a sign-in round-trip.
	_restorePending() {
		let pending;
		try { pending = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch {}
		if (!pending?.doc) return;
		sessionStorage.removeItem(SESSION_KEY);
		this.api.loadDocument(pending.doc);
		this.api.setStatus('Restored your in-progress animation. Sign-in complete — saving…');
		// Reopen the save dialog now that they're (hopefully) signed in.
		this.getUser(true).then((user) => {
			if (user) this.openSaveDialog();
			else this.api.setStatus('Restored your work. Sign in to save it.', 'error');
		});
	}

	promptSignIn() {
		const overlay = this._overlay();
		const card = el('div', { class: 'pl-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sign in to save' }, [
			el('h2', { class: 'pl-dialog-title' }, ['Sign in to save']),
			el('p', { class: 'pl-dialog-sub' }, ['Saving an animation to your account requires an account. Your work is preserved — you’ll return right here after signing in.']),
			el('div', { class: 'pl-dialog-actions' }, [
				el('button', { class: 'pose-btn', type: 'button', onclick: () => overlay.remove() }, ['Cancel']),
				el('button', {
					class: 'pose-btn pose-btn-primary', type: 'button',
					onclick: () => {
						try {
							sessionStorage.setItem(SESSION_KEY, JSON.stringify({ doc: this.api.getDocument(), openSave: true }));
							sessionStorage.setItem('login_redirect', '/pose');
						} catch {}
						window.location.href = '/login?next=/pose';
					},
				}, ['Sign in →']),
			]),
		]);
		overlay.appendChild(card);
		document.body.appendChild(overlay);
	}

	// ── Save ──────────────────────────────────────────────────────────────────
	async openSaveDialog() {
		if (this.api.keyframeCount() === 0) {
			this.api.setStatus('Add at least one keyframe before saving.', 'error');
			return;
		}
		const user = await this.getUser();
		if (!user) return this.promptSignIn();

		const doc = this.api.getDocument();
		const existing = this.savedClip;
		const overlay = this._overlay();

		const nameInput = el('input', { class: 'pl-input', id: 'pl-name', type: 'text', maxlength: '120', value: existing?.name || doc.name || 'My animation', 'aria-label': 'Animation name', required: true });
		const descInput = el('textarea', { class: 'pl-input pl-textarea', id: 'pl-desc', maxlength: '2000', rows: '2', placeholder: 'Optional description', 'aria-label': 'Description' }, [existing?.description || '']);
		const tagsInput = el('input', { class: 'pl-input', id: 'pl-tags', type: 'text', placeholder: 'walk, loop, dance (comma-separated)', value: (existing?.tags || []).join(', '), 'aria-label': 'Tags' });
		const visSelect = el('select', { class: 'pl-input', id: 'pl-vis', 'aria-label': 'Visibility' }, [
			el('option', { value: 'private' }, ['Private — only you']),
			el('option', { value: 'unlisted' }, ['Unlisted — anyone with the link']),
			el('option', { value: 'public' }, ['Public — listed in the gallery']),
		]);
		visSelect.value = existing?.visibility || 'private';

		const avatarId = this.api.currentAvatarId();
		const avatarName = this.api.currentAvatarName();
		const linkLabel = avatarId ? `Linked to: ${avatarName || 'loaded avatar'}` : 'Authored on the mannequin (no avatar link)';

		const errLine = el('div', { class: 'pl-dialog-err', role: 'alert', hidden: true });
		const primaryLabel = existing ? 'Update' : 'Save';
		const primaryBtn = el('button', { class: 'pose-btn pose-btn-primary', type: 'submit' }, [primaryLabel]);
		const copyBtn = existing ? el('button', { class: 'pose-btn', type: 'button' }, ['Save as copy']) : null;

		const form = el('form', { class: 'pl-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Save animation' }, [
			el('h2', { class: 'pl-dialog-title' }, [existing ? 'Update animation' : 'Save animation']),
			el('label', { class: 'pl-field' }, [el('span', {}, ['Name']), nameInput]),
			el('label', { class: 'pl-field' }, [el('span', {}, ['Description']), descInput]),
			el('label', { class: 'pl-field' }, [el('span', {}, ['Tags']), tagsInput]),
			el('label', { class: 'pl-field' }, [el('span', {}, ['Visibility']), visSelect]),
			el('p', { class: 'pl-link-note' }, [linkLabel]),
			errLine,
			el('div', { class: 'pl-dialog-actions' }, [
				el('button', { class: 'pose-btn', type: 'button', onclick: () => overlay.remove() }, ['Cancel']),
				copyBtn,
				primaryBtn,
			]),
		]);

		const submit = async (asCopy) => {
			const name = nameInput.value.trim();
			if (!name) { errLine.hidden = false; errLine.textContent = 'Name is required.'; nameInput.focus(); return; }
			const busyBtn = asCopy ? copyBtn : primaryBtn;
			const original = busyBtn.textContent;
			busyBtn.disabled = true;
			if (copyBtn) copyBtn.disabled = true;
			primaryBtn.disabled = true;
			busyBtn.textContent = 'Saving…';
			errLine.hidden = true;
			try {
				const meta = {
					name,
					description: descInput.value.trim() || undefined,
					tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20),
					visibility: visSelect.value,
					avatar_id: avatarId || undefined,
				};
				const saved = await this._persist(meta, { asCopy });
				overlay.remove();
				this.api.setStatus(`Saved “${saved.name}” to your account.`);
			} catch (err) {
				errLine.hidden = false;
				errLine.textContent = err.message;
				busyBtn.disabled = false;
				if (copyBtn) copyBtn.disabled = false;
				primaryBtn.disabled = false;
				busyBtn.textContent = original;
			}
		};
		form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(false); });
		copyBtn?.addEventListener('click', () => submit(true));

		overlay.appendChild(form);
		document.body.appendChild(overlay);
		nameInput.focus();
		nameInput.select();
	}

	// Create or update the clip row, then upload the thumbnail. Returns the saved row.
	async _persist(meta, { asCopy } = {}) {
		const clip = this.api.serializeClip();
		const editor_doc = this.api.getDocument();
		const fps = editor_doc.fps;
		const loop = editor_doc.loop;
		const updating = this.savedClip && !asCopy;

		let saved;
		if (updating) {
			const body = await apiFetch(`/api/animations/clips/${this.savedClip.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...meta, loop, clip, editor_doc }),
			});
			saved = body.clip;
		} else {
			const body = await apiFetch('/api/animations/clips', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...meta, fps, loop, clip, editor_doc }),
			});
			saved = body.clip;
		}

		this.savedClip = {
			id: saved.id, slug: saved.slug, name: saved.name,
			description: meta.description || '', tags: meta.tags || [], visibility: meta.visibility,
		};
		this._reflectSavedState();

		// Best-effort thumbnail upload — a save shouldn't fail if the poster does.
		try {
			const png = this.api.captureThumbnail();
			if (png) {
				await apiFetch('/api/animations/thumbnail', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ id: saved.id, png_base64: png }),
				});
			}
		} catch (err) {
			console.warn('[pose-library] thumbnail upload failed:', err.message);
		}
		return saved;
	}

	_reflectSavedState() {
		const saveBtn = document.querySelector('#pose-save');
		if (saveBtn && this.savedClip) {
			saveBtn.textContent = 'Update';
			saveBtn.title = `Update “${this.savedClip.name}” (Ctrl/Cmd+S)`;
		}
	}

	// ── Library drawer ────────────────────────────────────────────────────────
	async openLibrary() {
		const overlay = this._overlay('pl-drawer-overlay');
		const list = el('div', { class: 'pl-grid', id: 'pl-grid' });
		const tabMine = el('button', { class: 'pl-tab', type: 'button', 'aria-selected': 'true' }, ['My animations']);
		const tabPublic = el('button', { class: 'pl-tab', type: 'button', 'aria-selected': 'false' }, ['Community']);

		const drawer = el('aside', { class: 'pl-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Animation library' }, [
			el('header', { class: 'pl-drawer-head' }, [
				el('div', { class: 'pl-tabs', role: 'tablist' }, [tabMine, tabPublic]),
				el('button', { class: 'pl-close', type: 'button', 'aria-label': 'Close library', onclick: () => overlay.remove() }, ['✕']),
			]),
			list,
		]);

		const select = (tab) => {
			this.tab = tab;
			tabMine.setAttribute('aria-selected', String(tab === 'mine'));
			tabPublic.setAttribute('aria-selected', String(tab === 'public'));
			this._loadList(list, tab);
		};
		tabMine.addEventListener('click', () => select('mine'));
		tabPublic.addEventListener('click', () => select('public'));

		overlay.appendChild(drawer);
		document.body.appendChild(overlay);
		requestAnimationFrame(() => drawer.classList.add('pl-open'));
		select('mine');
	}

	async _loadList(list, tab) {
		list.innerHTML = '';
		for (let i = 0; i < 4; i++) list.appendChild(el('div', { class: 'pl-card pl-skeleton' }));

		const url = tab === 'public'
			? '/api/animations/clips?include_public=true&visibility=public&limit=60'
			: '/api/animations/clips?limit=60';
		let items;
		try {
			if (tab === 'mine') {
				const user = await this.getUser();
				if (!user) {
					list.innerHTML = '';
					list.appendChild(this._emptyState(
						'Sign in to see your animations',
						'Your saved animations live in your account.',
						el('a', { class: 'pose-btn pose-btn-primary', href: '/login?next=/pose' }, ['Sign in']),
					));
					return;
				}
			}
			const body = await apiFetch(url);
			items = body.items || [];
		} catch (err) {
			list.innerHTML = '';
			list.appendChild(this._emptyState(
				'Could not load animations',
				err.message,
				el('button', { class: 'pose-btn', type: 'button', onclick: () => this._loadList(list, tab) }, ['Retry']),
			));
			return;
		}

		list.innerHTML = '';
		if (!items.length) {
			list.appendChild(tab === 'mine'
				? this._emptyState('No animations yet', 'Pose the figure, drop keyframes, then press Save to keep your work here.', null)
				: this._emptyState('No public animations yet', 'Be the first — set an animation to Public when you save it.', null));
			return;
		}
		for (const clip of items) list.appendChild(this._card(clip, tab));
	}

	_card(clip, tab) {
		const thumb = clip.thumbnail_url
			? el('img', { class: 'pl-card-thumb', src: clip.thumbnail_url, alt: '', loading: 'lazy' })
			: el('div', { class: 'pl-card-thumb pl-card-thumb-empty' }, ['◷']);

		const badges = el('div', { class: 'pl-card-badges' }, [
			el('span', { class: `pl-badge pl-badge-${clip.visibility}` }, [clip.visibility]),
			clip.price ? el('span', { class: 'pl-badge pl-badge-price' }, [`${clip.price.amount} ${clip.price.currency || 'USDC'}`]) : null,
		]);

		const actions = el('div', { class: 'pl-card-actions' }, [
			el('button', { class: 'pose-btn', type: 'button', onclick: () => this._open(clip) }, ['Open']),
			tab === 'mine' ? el('button', { class: 'pose-btn', type: 'button', onclick: (e) => this._editMeta(clip, e) }, ['Edit']) : null,
			el('button', { class: 'pose-btn', type: 'button', onclick: () => this._export(clip) }, ['Export']),
			tab === 'mine' && this.onSell ? el('button', { class: 'pose-btn', type: 'button', onclick: () => this.onSell(clip) }, [clip.listed ? 'Manage sale' : 'Sell']) : null,
			tab === 'mine' ? el('button', { class: 'pose-btn pl-danger', type: 'button', onclick: (e) => this._delete(clip, e) }, ['Delete']) : null,
		]);

		return el('div', { class: 'pl-card', 'data-id': clip.id }, [
			thumb,
			badges,
			el('div', { class: 'pl-card-name' }, [clip.name]),
			el('div', { class: 'pl-card-meta' }, [
				`${fmtDuration(clip.duration_ms)} · ${clip.frame_count || 0} keys`,
				tab === 'public' && clip.owner === 'other' ? ' · community' : '',
				clip.updated_at ? ` · ${fmtDate(clip.updated_at)}` : '',
			]),
			(clip.tags?.length ? el('div', { class: 'pl-card-tags' }, clip.tags.slice(0, 4).map((t) => el('span', { class: 'pl-tag' }, [t]))) : null),
			actions,
		]);
	}

	_emptyState(title, sub, action) {
		return el('div', { class: 'pl-empty' }, [
			el('div', { class: 'pl-empty-icon', 'aria-hidden': 'true' }, ['🎬']),
			el('h3', {}, [title]),
			el('p', {}, [sub]),
			action,
		]);
	}

	// ── Card actions ────────────────────────────────────────────────────────
	async _open(clip) {
		this.api.setStatus(`Opening “${clip.name}”…`);
		let full;
		try {
			const body = await apiFetch(`/api/animations/clips/${clip.id}`);
			full = body.clip;
		} catch (err) {
			this.api.setStatus(`Could not open: ${err.message}`, 'error');
			return;
		}

		// Load the linked avatar first (so the document applies onto the right rig).
		if (full.avatar_id) {
			try { await this.api.loadAvatarById(full.avatar_id); }
			catch { this.api.switchToMannequin(); this.api.setStatus('Linked avatar unavailable — opened on the mannequin.', 'error'); }
		} else {
			this.api.switchToMannequin();
		}

		const doc = full.editor_doc || reconstructDocFromClip(full.clip, full);
		if (!doc) { this.api.setStatus('This animation has no editable data.', 'error'); return; }
		this.api.loadDocument(doc);

		this.savedClip = {
			id: full.id, slug: full.slug, name: full.name,
			description: full.description || '', tags: full.tags || [], visibility: full.visibility,
		};
		this._reflectSavedState();
		document.querySelector('.pl-drawer-overlay')?.remove();
		this.api.setStatus(`Opened “${full.name}” — ${full.editor_doc ? 'keyframes restored' : 'rebuilt from clip'}.`);
	}

	_editMeta(clip, ev) {
		const overlay = this._overlay();
		const nameInput = el('input', { class: 'pl-input', type: 'text', maxlength: '120', value: clip.name, 'aria-label': 'Name' });
		const descInput = el('textarea', { class: 'pl-input pl-textarea', maxlength: '2000', rows: '2', 'aria-label': 'Description' }, [clip.description || '']);
		const tagsInput = el('input', { class: 'pl-input', type: 'text', value: (clip.tags || []).join(', '), 'aria-label': 'Tags' });
		const visSelect = el('select', { class: 'pl-input', 'aria-label': 'Visibility' }, [
			el('option', { value: 'private' }, ['Private']),
			el('option', { value: 'unlisted' }, ['Unlisted']),
			el('option', { value: 'public' }, ['Public']),
		]);
		visSelect.value = clip.visibility;
		const err = el('div', { class: 'pl-dialog-err', role: 'alert', hidden: true });
		const saveBtn = el('button', { class: 'pose-btn pose-btn-primary', type: 'submit' }, ['Save changes']);

		const form = el('form', { class: 'pl-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Edit animation' }, [
			el('h2', { class: 'pl-dialog-title' }, ['Edit details']),
			el('label', { class: 'pl-field' }, [el('span', {}, ['Name']), nameInput]),
			el('label', { class: 'pl-field' }, [el('span', {}, ['Description']), descInput]),
			el('label', { class: 'pl-field' }, [el('span', {}, ['Tags']), tagsInput]),
			el('label', { class: 'pl-field' }, [el('span', {}, ['Visibility']), visSelect]),
			err,
			el('div', { class: 'pl-dialog-actions' }, [
				el('button', { class: 'pose-btn', type: 'button', onclick: () => overlay.remove() }, ['Cancel']),
				saveBtn,
			]),
		]);
		form.addEventListener('submit', async (e) => {
			e.preventDefault();
			saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; err.hidden = true;
			try {
				const body = await apiFetch(`/api/animations/clips/${clip.id}`, {
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						name: nameInput.value.trim(),
						description: descInput.value.trim() || undefined,
						tags: tagsInput.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20),
						visibility: visSelect.value,
					}),
				});
				Object.assign(clip, {
					name: body.clip.name, description: body.clip.description,
					tags: body.clip.tags, visibility: body.clip.visibility,
				});
				if (this.savedClip?.id === clip.id) this.savedClip.name = body.clip.name;
				overlay.remove();
				// Refresh the visible card in place.
				const card = document.querySelector(`.pl-card[data-id="${clip.id}"]`);
				if (card) card.replaceWith(this._card(clip, this.tab));
				this.api.setStatus('Animation details updated.');
			} catch (e2) {
				err.hidden = false; err.textContent = e2.message;
				saveBtn.disabled = false; saveBtn.textContent = 'Save changes';
			}
		});
		overlay.appendChild(form);
		document.body.appendChild(overlay);
		nameInput.focus();
	}

	_delete(clip, ev) {
		const overlay = this._overlay();
		const delBtn = el('button', { class: 'pose-btn pl-danger', type: 'button' }, ['Delete']);
		const card = el('div', { class: 'pl-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Delete animation' }, [
			el('h2', { class: 'pl-dialog-title' }, ['Delete this animation?']),
			el('p', { class: 'pl-dialog-sub' }, [`“${clip.name}” will be removed from your library. This cannot be undone.`]),
			el('div', { class: 'pl-dialog-actions' }, [
				el('button', { class: 'pose-btn', type: 'button', onclick: () => overlay.remove() }, ['Cancel']),
				delBtn,
			]),
		]);
		delBtn.addEventListener('click', async () => {
			delBtn.disabled = true; delBtn.textContent = 'Deleting…';
			try {
				await apiFetch(`/api/animations/clips/${clip.id}`, { method: 'DELETE' });
				overlay.remove();
				document.querySelector(`.pl-card[data-id="${clip.id}"]`)?.remove();
				if (this.savedClip?.id === clip.id) { this.savedClip = null; this._resetSaveBtn(); }
				this.api.setStatus('Animation deleted.');
			} catch (err) {
				delBtn.disabled = false; delBtn.textContent = 'Delete';
				this.api.setStatus(`Delete failed: ${err.message}`, 'error');
			}
		});
		overlay.appendChild(card);
		document.body.appendChild(overlay);
	}

	async _export(clip) {
		try {
			let clipJson;
			if (this.savedClip?.id === clip.id) {
				clipJson = this.api.serializeClip();
			} else {
				const body = await apiFetch(`/api/animations/clips/${clip.id}`);
				clipJson = body.clip.clip;
			}
			const blob = new Blob([JSON.stringify(clipJson, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = el('a', { href: url, download: `${clip.slug || 'animation'}.json` });
			document.body.appendChild(a); a.click(); a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1500);
			this.api.setStatus('Clip JSON downloaded.');
		} catch (err) {
			this.api.setStatus(`Export failed: ${err.message}`, 'error');
		}
	}

	_resetSaveBtn() {
		const saveBtn = document.querySelector('#pose-save');
		if (saveBtn) { saveBtn.textContent = 'Save'; saveBtn.title = 'Save this animation to your account (Ctrl/Cmd+S)'; }
	}

	// ── Overlay helper ────────────────────────────────────────────────────────
	_overlay(extraClass = '') {
		const overlay = el('div', { class: `pl-overlay ${extraClass}`.trim() });
		overlay.addEventListener('pointerdown', (ev) => { if (ev.target === overlay) overlay.remove(); });
		overlay.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') overlay.remove(); });
		return overlay;
	}
}

// Rebuild an editable keyframe document from a baked AnimationClip.toJSON() when
// no editor_doc was stored (e.g. an imported clip). Samples each quaternion
// track at the union of all track keyframe times.
const _q = new Quaternion();
function reconstructDocFromClip(clipJson, meta = {}) {
	if (!clipJson || !Array.isArray(clipJson.tracks)) return null;
	const quatTracks = clipJson.tracks.filter((t) => t.name.endsWith('.quaternion'));
	const posTrack = clipJson.tracks.find((t) => t.name.endsWith('.position'));
	if (!quatTracks.length) return null;

	const timeSet = new Set();
	for (const t of clipJson.tracks) for (const v of t.times || []) timeSet.add(Number(v.toFixed(4)));
	let times = [...timeSet].sort((a, b) => a - b);
	if (times.length > 240) {
		// Downsample to keep the editing doc manageable.
		const step = Math.ceil(times.length / 240);
		times = times.filter((_, i) => i % step === 0);
	}
	if (!times.length) times = [0];

	const sampleQuat = (track, t) => {
		const ts = track.times, vs = track.values;
		if (!ts?.length) return [0, 0, 0, 1];
		let i = ts.findIndex((x) => x >= t);
		if (i < 0) i = ts.length - 1;
		const j = Math.max(0, i - 1);
		const o = i * 4, p = j * 4;
		if (i === j || ts[i] === ts[j]) return [vs[o], vs[o + 1], vs[o + 2], vs[o + 3]];
		const a = (t - ts[j]) / (ts[i] - ts[j]);
		_q.set(vs[p], vs[p + 1], vs[p + 2], vs[p + 3]).slerp(new Quaternion(vs[o], vs[o + 1], vs[o + 2], vs[o + 3]), a);
		return [_q.x, _q.y, _q.z, _q.w];
	};
	const samplePos = (t) => {
		if (!posTrack?.times?.length) return { x: 0, y: 0, z: 0 };
		let i = posTrack.times.findIndex((x) => x >= t);
		if (i < 0) i = posTrack.times.length - 1;
		const o = i * 3;
		return { x: posTrack.values[o] || 0, y: posTrack.values[o + 1] || 0, z: posTrack.values[o + 2] || 0 };
	};

	const keyframes = times.map((t, i) => {
		const bones = {};
		for (const track of quatTracks) bones[track.name.replace('.quaternion', '')] = sampleQuat(track, t);
		return { id: `kf_rebuilt_${i}`, time: t, easing: 'linear', pose: { bones, rootPosition: samplePos(t) } };
	});

	return {
		name: clipJson.name || meta.name || 'animation',
		duration: clipJson.duration || times[times.length - 1] || 1,
		fps: meta.fps || 30,
		loop: meta.loop !== false,
		keyframes,
	};
}

export const __test__ = { reconstructDocFromClip, fmtDuration };
