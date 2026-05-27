// Avatar SDK page — registers <three-ws-viewer>, copy buttons, tab switching, creator demo
import { ThreeWsViewerElement } from '../avatar-sdk/src/viewer.js';

if (typeof customElements !== 'undefined' && !customElements.get('three-ws-viewer')) {
	customElements.define('three-ws-viewer', ThreeWsViewerElement);
}

// ── Copy-to-clipboard ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
	document.querySelectorAll('.sdk-copy-btn').forEach((btn) => {
		btn.addEventListener('click', async () => {
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
				// Fallback for environments that block clipboard
				const sel = window.getSelection();
				const range = document.createRange();
				range.selectNodeContents(target);
				sel.removeAllRanges();
				sel.addRange(range);
			}
		});
	});

	// ── Tab switching ────────────────────────────────────────────────────────
	document.querySelectorAll('.sdk-tabs').forEach((tabs) => {
		const buttons = tabs.querySelectorAll('.sdk-tab-btn');
		const panels = tabs.querySelectorAll('.sdk-tab-panel');
		buttons.forEach((btn, i) => {
			btn.addEventListener('click', () => {
				buttons.forEach((b, j) => {
					b.classList.toggle('active', j === i);
					b.setAttribute('aria-selected', j === i ? 'true' : 'false');
				});
				panels.forEach((p, j) => {
					p.hidden = j !== i;
				});
			});
		});
	});

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

	// ── Hero viewer fallback message ─────────────────────────────────────────
	const heroViewer = document.querySelector('.sdk-hero-viewer three-ws-viewer');
	if (heroViewer) {
		heroViewer.addEventListener('error', () => {
			const wrap = document.querySelector('.sdk-hero-viewer');
			if (wrap) {
				const msg = document.createElement('p');
				msg.className = 'sdk-viewer-err';
				msg.textContent = 'Avatar preview unavailable in this environment.';
				wrap.appendChild(msg);
			}
		});
	}
});
