const VIEWER_TAG = 'three-ws-viewer';
const AGENT_TAG = 'agent-3d';
const SDK_SOURCE_URL = 'https://github.com/nirholas/three.ws/tree/main/avatar-sdk';

// Register <three-ws-viewer> from the package source this page documents, so
// every demo on the page is the shipped SDK rather than a lookalike. Resolves
// to `false` (never rejects) when the module cannot load, and the DOM-ready
// handler below swaps a designed card in for each viewer instead of leaving
// the browser to render an inert unknown tag as an empty box.
const viewerReady = import('../avatar-sdk/src/viewer.js')
	.then(({ ThreeWsViewerElement }) => {
		if (typeof customElements === 'undefined') return false;
		if (!customElements.get(VIEWER_TAG)) customElements.define(VIEWER_TAG, ThreeWsViewerElement);
		return true;
	})
	.catch((err) => {
		console.error(`[avatar-sdk] <${VIEWER_TAG}> failed to register`, err);
		return false;
	});

function renderViewerFallback(host) {
	if (host.dataset.fallbackRendered) return;
	host.dataset.fallbackRendered = '1';
	host.style.display = 'none';

	const card = document.createElement('div');
	card.className = 'sdk-viewer-fallback';

	const title = document.createElement('p');
	title.className = 'sdk-viewer-fallback-title';
	title.textContent = '3D preview unavailable';

	const body = document.createElement('p');
	body.className = 'sdk-viewer-fallback-body';
	body.textContent =
		'This browser could not load the viewer module, so the live demo is off. The package itself installs and runs the same way in your app.';

	const link = document.createElement('a');
	link.className = 'sdk-btn-ghost';
	link.href = SDK_SOURCE_URL;
	link.target = '_blank';
	link.rel = 'noopener';
	link.textContent = 'Read the source';

	card.append(title, body, link);
	host.insertAdjacentElement('afterend', card);
}

document.addEventListener('DOMContentLoaded', () => {
	viewerReady.then((ok) => {
		if (!ok) document.querySelectorAll(VIEWER_TAG).forEach(renderViewerFallback);
	});

	// ── Scroll reveal ────────────────────────────────────────────────────────
	const revealObserver = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					entry.target.classList.add('revealed');
					revealObserver.unobserve(entry.target);
				}
			}
		},
		{ threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
	);
	document.querySelectorAll('.sdk-reveal').forEach((el) => revealObserver.observe(el));

	// ── Copy-to-clipboard ────────────────────────────────────────────────────
	// Clipboard writes are blocked outright in some embedded browsers and on
	// insecure origins, so the failure path selects the snippet and says so:
	// the reader can still finish the copy with a keystroke.
	function flashCopyLabel(btn, label, restore) {
		btn.textContent = label;
		btn.classList.add('copied');
		setTimeout(() => {
			btn.textContent = restore;
			btn.classList.remove('copied');
		}, 2000);
	}

	function selectNode(node) {
		const sel = window.getSelection();
		if (!sel) return;
		const range = document.createRange();
		range.selectNodeContents(node);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	async function copyText(text, node) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			if (node) selectNode(node);
			return false;
		}
	}

	document.querySelectorAll('.sdk-copy-btn').forEach((btn) => {
		btn.addEventListener('click', async (e) => {
			e.stopPropagation();
			const target = document.getElementById(btn.dataset.target);
			if (!target) return;
			// Read the label per click: runtime i18n swaps this text after load.
			const label = btn.classList.contains('copied') ? btn.dataset.copyLabel : btn.textContent;
			btn.dataset.copyLabel = label;
			const ok = await copyText(target.textContent, target);
			flashCopyLabel(btn, ok ? 'Copied!' : 'Selected, press Ctrl+C', label);
		});
	});

	// Install command click-to-copy
	const installCmd = document.querySelector('.sdk-install-cmd');
	if (installCmd) {
		const handler = () => installCmd.querySelector('.sdk-install-copy')?.click();
		installCmd.addEventListener('click', handler);
		installCmd.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				handler();
			}
		});
	}

	// ── Tab switching ────────────────────────────────────────────────────────
	// Full tablist semantics: aria-controls wiring, roving tabindex and arrow
	// keys, so the framework examples are reachable without a mouse.
	document.querySelectorAll('.sdk-tabs').forEach((tabs, tabsIndex) => {
		const buttons = [...tabs.querySelectorAll('.sdk-tab-btn')];
		const panels = [...tabs.querySelectorAll('.sdk-tab-panel')];
		const copyRow = tabs.querySelector('.sdk-tab-copy-row .sdk-copy-btn');
		if (!buttons.length) return;

		buttons.forEach((btn, i) => {
			const panel = panels[i];
			btn.type = 'button';
			btn.id ||= `sdk-tab-${tabsIndex}-${i}`;
			if (panel) {
				panel.id ||= `sdk-tabpanel-${tabsIndex}-${i}`;
				btn.setAttribute('aria-controls', panel.id);
				panel.setAttribute('aria-labelledby', btn.id);
			}
		});

		function select(i, focus) {
			buttons.forEach((b, j) => {
				b.classList.toggle('active', j === i);
				b.setAttribute('aria-selected', j === i ? 'true' : 'false');
				b.tabIndex = j === i ? 0 : -1;
			});
			panels.forEach((p, j) => {
				p.hidden = j !== i;
			});
			if (copyRow && panels[i]) {
				const pre = panels[i].querySelector('pre');
				if (pre) copyRow.dataset.target = pre.id;
			}
			if (focus) buttons[i].focus();
		}

		buttons.forEach((btn, i) => {
			btn.addEventListener('click', () => select(i, false));
			btn.addEventListener('keydown', (e) => {
				const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
				if (step) {
					e.preventDefault();
					select((i + step + buttons.length) % buttons.length, true);
				} else if (e.key === 'Home') {
					e.preventDefault();
					select(0, true);
				} else if (e.key === 'End') {
					e.preventDefault();
					select(buttons.length - 1, true);
				}
			});
		});

		select(Math.max(0, buttons.findIndex((b) => b.classList.contains('active'))), false);
	});

	// ── Interactive Playground ───────────────────────────────────────────────
	const pgAvatar = document.getElementById('pg-avatar');
	const pgBg = document.getElementById('pg-bg');
	const pgComponent = document.getElementById('pg-component');
	const pgRotate = document.getElementById('pg-rotate');
	const pgNote = document.getElementById('pg-note');
	const pgCodeOutput = document.getElementById('pg-code-output');
	const pgCopyBtn = document.getElementById('pg-copy-btn');

	function escapeHtml(str) {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function setNote(html, isError) {
		if (!pgNote) return;
		pgNote.innerHTML = html;
		pgNote.classList.toggle('is-error', Boolean(isError));
	}

	// `auto-rotate` is a <three-ws-viewer> attribute. The full <agent-3d>
	// runtime drives its camera from the agent's own state and ignores it, so
	// the control is disabled (with a reason) rather than emitting a snippet
	// that silently does nothing.
	const supportsAutoRotate = (tag) => tag === VIEWER_TAG;
	const AUTOROTATE_NOTE =
		'<code>auto-rotate</code> is a <code>&lt;three-ws-viewer&gt;</code> attribute. The full runtime drives its own camera.';
	const restingNote = () => setNote(pgRotate.disabled ? AUTOROTATE_NOTE : '');

	function renderCode(tag, avatarSrc, bg, rotate) {
		if (!pgCodeOutput) return;
		const importPath = tag === VIEWER_TAG ? '@three-ws/avatar/viewer' : '@three-ws/avatar';

		const attrs = [`  <span class="t-attr">src</span>=<span class="t-str">"${escapeHtml(avatarSrc)}"</span>`];
		if (bg !== 'transparent') {
			attrs.push(`  <span class="t-attr">background</span>=<span class="t-str">"${escapeHtml(bg)}"</span>`);
		}
		attrs.push(`  <span class="t-attr">alt</span>=<span class="t-str">"My avatar"</span>`);
		if (rotate && supportsAutoRotate(tag)) {
			attrs.push(`  <span class="t-attr">auto-rotate</span>`);
		}
		attrs.push(`  <span class="t-attr">style</span>=<span class="t-str">"width:400px;height:560px"</span>`);

		pgCodeOutput.innerHTML = [
			`<span class="t-tag">&lt;script</span> <span class="t-attr">type</span>=<span class="t-str">"module"</span><span class="t-tag">&gt;</span>`,
			`  <span class="t-kw">import</span> <span class="t-str">'${importPath}'</span><span class="t-op">;</span>`,
			`<span class="t-tag">&lt;/script&gt;</span>`,
			``,
			`<span class="t-tag">&lt;${tag}</span>`,
			...attrs,
			`<span class="t-tag">&gt;&lt;/${tag}&gt;</span>`,
		].join('\n');
	}

	// Every apply() runs against the latest control values; a stale one that
	// finishes after a newer selection bails instead of overwriting it.
	let applyToken = 0;

	async function applyPlayground() {
		const token = ++applyToken;
		const avatarSrc = pgAvatar.value;
		const bg = pgBg.value;
		const tag = pgComponent.value;
		const rotate = pgRotate.classList.contains('active');

		renderCode(tag, avatarSrc, bg, rotate);

		pgRotate.disabled = !supportsAutoRotate(tag);
		pgRotate.setAttribute('aria-disabled', String(pgRotate.disabled));
		restingNote();

		let host = document.getElementById('pg-viewer');
		if (!host) return;

		if (host.tagName.toLowerCase() !== tag) {
			if (tag === AGENT_TAG) {
				setNote('Loading the full <code>&lt;agent-3d&gt;</code> runtime. This is the heavy bundle the lightweight viewer avoids.');
				try {
					const { ensureAgent3D } = await import('../avatar-sdk/src/agent.js');
					await ensureAgent3D();
				} catch (err) {
					console.error('[avatar-sdk] <agent-3d> runtime failed to load', err);
					if (token !== applyToken) return;
					setNote('The full runtime could not load. Showing the lightweight viewer instead.', true);
					pgComponent.value = VIEWER_TAG;
					applyPlayground();
					return;
				}
			} else {
				await viewerReady;
			}
			if (token !== applyToken) return;

			host = document.getElementById('pg-viewer');
			if (!host) return;
			const next = document.createElement(tag);
			next.id = 'pg-viewer';
			next.setAttribute('alt', 'Playground avatar preview');
			next.style.cssText = 'width:100%;height:100%';
			// Attributes first, insertion second: both elements boot on connect and
			// read their source from the attributes already present. Setting `src`
			// on an <agent-3d> that is already in the document instead starts a
			// second boot on top of the first one's in-flight load, and the loser
			// calls back into a viewer the winner already disposed.
			applyPreviewAttributes(next, tag, avatarSrc, bg, rotate);
			host.replaceWith(next);
			restingNote();
			return;
		}

		applyPreviewAttributes(host, tag, avatarSrc, bg, rotate);
	}

	function applyPreviewAttributes(el, tag, avatarSrc, bg, rotate) {
		el.setAttribute('src', avatarSrc);
		el.setAttribute('background', bg);
		if (rotate && supportsAutoRotate(tag)) el.setAttribute('auto-rotate', '');
		else el.removeAttribute('auto-rotate');
	}

	if (pgAvatar && pgBg && pgComponent && pgRotate) {
		pgAvatar.addEventListener('change', applyPlayground);
		pgBg.addEventListener('change', applyPlayground);
		pgComponent.addEventListener('change', applyPlayground);
		pgRotate.addEventListener('click', () => {
			if (pgRotate.disabled) return;
			pgRotate.classList.toggle('active');
			pgRotate.setAttribute('aria-checked', String(pgRotate.classList.contains('active')));
			applyPlayground();
		});
		applyPlayground();
	}

	if (pgCopyBtn && pgCodeOutput) {
		pgCopyBtn.addEventListener('click', async () => {
			const label = pgCopyBtn.classList.contains('copied') ? pgCopyBtn.dataset.copyLabel : pgCopyBtn.textContent;
			pgCopyBtn.dataset.copyLabel = label;
			const ok = await copyText(pgCodeOutput.textContent, pgCodeOutput);
			flashCopyLabel(pgCopyBtn, ok ? 'Copied!' : 'Selected, press Ctrl+C', label);
		});
	}

	// ── Creator demo ─────────────────────────────────────────────────────────
	const creatorBtn = document.getElementById('sdk-creator-open');
	const creatorStatus = document.getElementById('sdk-creator-status');
	if (creatorBtn && creatorStatus) {
		const setStatus = (text, kind) => {
			creatorStatus.textContent = text;
			creatorStatus.className = `sdk-creator-status ${kind}`;
		};
		let creator = null;

		creatorBtn.addEventListener('click', async () => {
			if (creator) return;
			creatorBtn.disabled = true;
			setStatus('Opening Avatar Studio…', 'info');
			try {
				const mod = await import('../avatar-sdk/src/creator.js');
				creator = new mod.AvatarCreator({
					// Same origin so a codespace/dev host loads its own build, and
					// the index file by name: the bare /avatar-studio path serves the
					// native sculpting page, which does not speak the export protocol.
					studioUrl: new URL('/avatar-studio/index.html', location.origin).toString(),
					onExport: (blob) => {
						setStatus(`Avatar exported: ${(blob.size / 1024).toFixed(0)} KB GLB`, 'ok');
					},
					onClose: () => {
						if (!creatorStatus.classList.contains('ok')) {
							setStatus('Closed without export.', 'muted');
						}
						creator = null;
						creatorBtn.disabled = false;
					},
				});
				await creator.open();
				setStatus('Avatar Studio open. Build an avatar, then export to send it back here.', 'info');
			} catch (err) {
				console.error('[avatar-sdk] Avatar Creator failed to open', err);
				setStatus(`Could not open Avatar Studio: ${err.message}. Reload the page to try again.`, 'err');
				creator = null;
				creatorBtn.disabled = false;
			}
		});
	}
});
