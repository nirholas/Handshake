import { ThreeWsViewerElement } from '../avatar-sdk/src/viewer.js';

if (typeof customElements !== 'undefined' && !customElements.get('three-ws-viewer')) {
	customElements.define('three-ws-viewer', ThreeWsViewerElement);
}

document.addEventListener('DOMContentLoaded', () => {
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
	document.querySelectorAll('.sdk-copy-btn').forEach((btn) => {
		btn.addEventListener('click', async (e) => {
			e.stopPropagation();
			const target = document.getElementById(btn.dataset.target);
			if (!target) return;
			const text = target.textContent;
			try {
				await navigator.clipboard.writeText(text);
				btn.textContent = 'Copied!';
				btn.classList.add('copied');
				setTimeout(() => {
					btn.textContent = 'Copy';
					btn.classList.remove('copied');
				}, 2000);
			} catch {
				const sel = window.getSelection();
				const range = document.createRange();
				range.selectNodeContents(target);
				sel.removeAllRanges();
				sel.addRange(range);
			}
		});
	});

	// Install command click-to-copy
	const installCmd = document.querySelector('.sdk-install-cmd');
	if (installCmd) {
		const handler = () => installCmd.querySelector('.sdk-install-copy')?.click();
		installCmd.addEventListener('click', handler);
		installCmd.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') handler();
		});
	}

	// ── Tab switching ────────────────────────────────────────────────────────
	document.querySelectorAll('.sdk-tabs').forEach((tabs) => {
		const buttons = tabs.querySelectorAll('.sdk-tab-btn');
		const panels = tabs.querySelectorAll('.sdk-tab-panel');
		const copyRow = tabs.querySelector('.sdk-tab-copy-row .sdk-copy-btn');
		buttons.forEach((btn, i) => {
			btn.addEventListener('click', () => {
				buttons.forEach((b, j) => {
					b.classList.toggle('active', j === i);
					b.setAttribute('aria-selected', j === i ? 'true' : 'false');
				});
				panels.forEach((p, j) => {
					p.hidden = j !== i;
				});
				if (copyRow && panels[i]) {
					const pre = panels[i].querySelector('pre');
					if (pre) copyRow.dataset.target = pre.id;
				}
			});
		});
	});

	// ── Interactive Playground ───────────────────────────────────────────────
	const pgViewer = document.getElementById('pg-viewer');
	const pgAvatar = document.getElementById('pg-avatar');
	const pgBg = document.getElementById('pg-bg');
	const pgComponent = document.getElementById('pg-component');
	const pgRotate = document.getElementById('pg-rotate');
	const pgCodeOutput = document.getElementById('pg-code-output');
	const pgCopyBtn = document.getElementById('pg-copy-btn');

	function escapeHtml(str) {
		return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function updatePlayground() {
		if (!pgViewer || !pgCodeOutput) return;

		const avatarSrc = pgAvatar.value;
		const bg = pgBg.value;
		const component = pgComponent.value;
		const rotate = pgRotate.classList.contains('active');

		pgViewer.setAttribute('src', avatarSrc);
		pgViewer.setAttribute('background', bg);

		const isViewer = component === 'three-ws-viewer';
		const importPath = isViewer ? '@three-ws/avatar/viewer' : '@three-ws/avatar';
		const tagName = component;

		const attrs = [];
		attrs.push(`  <span class="t-attr">src</span>=<span class="t-str">"${escapeHtml(avatarSrc)}"</span>`);
		if (bg !== 'transparent') {
			attrs.push(`  <span class="t-attr">background</span>=<span class="t-str">"${escapeHtml(bg)}"</span>`);
		}
		attrs.push(`  <span class="t-attr">alt</span>=<span class="t-str">"My avatar"</span>`);
		if (rotate) {
			attrs.push(`  <span class="t-attr">auto-rotate</span>`);
		}
		attrs.push(`  <span class="t-attr">style</span>=<span class="t-str">"width:400px;height:560px"</span>`);

		const code = [
			`<span class="t-tag">&lt;script</span> <span class="t-attr">type</span>=<span class="t-str">"module"</span><span class="t-tag">&gt;</span>`,
			`  <span class="t-kw">import</span> <span class="t-str">'${importPath}'</span><span class="t-op">;</span>`,
			`<span class="t-tag">&lt;/script&gt;</span>`,
			``,
			`<span class="t-tag">&lt;${tagName}</span>`,
			...attrs,
			`<span class="t-tag">&gt;&lt;/${tagName}&gt;</span>`,
		].join('\n');

		pgCodeOutput.innerHTML = code;
	}

	if (pgAvatar) {
		pgAvatar.addEventListener('change', updatePlayground);
		pgBg.addEventListener('change', updatePlayground);
		pgComponent.addEventListener('change', updatePlayground);
		pgRotate.addEventListener('click', () => {
			pgRotate.classList.toggle('active');
			pgRotate.setAttribute('aria-checked', pgRotate.classList.contains('active'));
			updatePlayground();
		});
		updatePlayground();
	}

	if (pgCopyBtn) {
		pgCopyBtn.addEventListener('click', async () => {
			const text = pgCodeOutput.textContent;
			try {
				await navigator.clipboard.writeText(text);
				pgCopyBtn.textContent = 'Copied!';
				pgCopyBtn.classList.add('copied');
				setTimeout(() => {
					pgCopyBtn.textContent = 'Copy code';
					pgCopyBtn.classList.remove('copied');
				}, 2000);
			} catch {}
		});
	}

	// ── Creator demo ─────────────────────────────────────────────────────────
	const creatorBtn = document.getElementById('sdk-creator-open');
	const creatorStatus = document.getElementById('sdk-creator-status');
	if (creatorBtn) {
		creatorBtn.addEventListener('click', async () => {
			try {
				const mod = await import('../avatar-sdk/src/creator.js');
				creatorStatus.textContent = 'Opening Avatar Studio…';
				creatorStatus.className = 'sdk-creator-status info';
				const creator = new mod.AvatarCreator({
					studioUrl: new URL('/avatar-studio/', location.origin).toString(),
					onExport: (blob) => {
						creatorStatus.textContent = `Avatar exported — ${(blob.size / 1024).toFixed(0)} KB GLB`;
						creatorStatus.className = 'sdk-creator-status ok';
					},
					onClose: () => {
						if (!creatorStatus.classList.contains('ok')) {
							creatorStatus.textContent = 'Closed without export.';
							creatorStatus.className = 'sdk-creator-status muted';
						}
					},
				});
				await creator.open();
			} catch (err) {
				creatorStatus.textContent = 'Error: ' + err.message;
				creatorStatus.className = 'sdk-creator-status err';
			}
		});
	}

	// ── Hero viewer fallback ─────────────────────────────────────────────────
	const heroViewer = document.querySelector('.sdk-hero-viewer three-ws-viewer');
	if (heroViewer) {
		heroViewer.addEventListener('error', () => {
			const wrap = document.querySelector('.sdk-hero-viewer');
			if (wrap) {
				const msg = document.createElement('p');
				msg.style.cssText = 'text-align:center;color:var(--sdk-dim);font-size:13px;padding:24px';
				msg.textContent = 'Avatar preview unavailable in this environment.';
				wrap.appendChild(msg);
			}
		});
	}
});
