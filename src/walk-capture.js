// src/walk-capture.js — screenshot + clip capture and share for /walk.
//
// One module owns the whole capture loop so the page stays readable:
//   • screenshot()        — full-resolution PNG of the current scene, watermarked
//   • toggleRecording()   — start/stop a clip (auto-stops at 10s), watermarked
//
// Both feed a share sheet (download · Share to X · Share to Farcaster · native
// share). Clips are recorded from the live canvas via MediaRecorder; when the
// browser can only emit WebM (Firefox) we transmux to MP4 with the vendored
// ffmpeg.wasm core in /vendor/ffmpeg-wasm/ so every platform shares real MP4.
//
// The capture canvas composites the AR camera feed (when AR is on) behind the
// transparent WebGL canvas, so an AR walk shares exactly what the user sees.

import { log } from './shared/log.js';

const RECORD_MAX_SECONDS = 10;
const CAPTURE_FPS = 60;
const VIDEO_BITRATE = 12_000_000; // 12 Mbps — crisp 1080p clips
const X_TWEET_TEXT = (shareUrl) => `I walked my avatar around three.ws — try yours: ${shareUrl}`;

// Preferred recorder container/codec, MP4 first so most browsers skip transmux.
function pickRecorderMime() {
	if (typeof MediaRecorder === 'undefined') return null;
	const candidates = [
		'video/mp4;codecs=avc1',
		'video/mp4',
		'video/webm;codecs=vp9',
		'video/webm;codecs=vp8',
		'video/webm',
	];
	for (const t of candidates) {
		try {
			if (MediaRecorder.isTypeSupported(t)) return t;
		} catch {}
	}
	return '';
}

// Monotonic-ish stamp for filenames without leaning on Date in hot paths.
function stamp() {
	return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

export function createWalkCapture({
	renderer,
	scene,
	camera,
	video = null,
	isArActive = () => false,
	getAvatarId = () => null,
	setStatus = () => {},
	haptics = { buzz() {} },
	recordBtn = null,
	recordStatus = null,
	recordStatusLabel = null,
}) {
	injectStyles();

	function avatarShareUrl() {
		const id = getAvatarId();
		return id ? `three.ws/walk?avatar=${id}` : 'three.ws/walk';
	}

	// ── Compositing ─────────────────────────────────────────────────────────
	// Draws one frame of "what the user sees" into a 2D context at the renderer's
	// full (retina) drawing-buffer resolution: AR feed first (cover-fit) when AR
	// is on, then the WebGL canvas, then the watermark.
	function composite(ctx, w, h) {
		if (isArActive() && video && video.readyState >= 2 && video.videoWidth > 0) {
			const vw = video.videoWidth;
			const vh = video.videoHeight;
			const scale = Math.max(w / vw, h / vh);
			const dw = vw * scale;
			const dh = vh * scale;
			ctx.drawImage(video, (w - dw) / 2, (h - dh) / 2, dw, dh);
		} else {
			ctx.fillStyle = '#0a0a0a';
			ctx.fillRect(0, 0, w, h);
		}
		ctx.drawImage(renderer.domElement, 0, 0, w, h);
		drawWatermark(ctx, w, h);
	}

	function drawWatermark(ctx, w, h) {
		const label = avatarShareUrl();
		const fontSize = Math.max(13, Math.round(w * 0.016));
		const padX = Math.round(fontSize * 0.85);
		const padY = Math.round(fontSize * 0.5);
		const margin = Math.round(fontSize * 1.1);
		ctx.save();
		ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
		ctx.textBaseline = 'middle';
		const textW = ctx.measureText(label).width;
		const boxW = textW + padX * 2;
		const boxH = fontSize + padY * 2;
		const x = w - boxW - margin;
		const y = h - boxH - margin;
		// Pill background.
		ctx.fillStyle = 'rgba(10,10,12,0.55)';
		roundRect(ctx, x, y, boxW, boxH, boxH / 2);
		ctx.fill();
		// Subtle accent dot + text.
		ctx.fillStyle = '#7c5cff';
		ctx.beginPath();
		ctx.arc(x + padX + fontSize * 0.28, y + boxH / 2, fontSize * 0.28, 0, Math.PI * 2);
		ctx.fill();
		ctx.fillStyle = 'rgba(255,255,255,0.95)';
		ctx.shadowColor = 'rgba(0,0,0,0.45)';
		ctx.shadowBlur = Math.round(fontSize * 0.4);
		ctx.fillText(label, x + padX + fontSize * 0.78, y + boxH / 2 + 1);
		ctx.restore();
	}

	function roundRect(ctx, x, y, w, h, r) {
		const rr = Math.min(r, w / 2, h / 2);
		ctx.beginPath();
		ctx.moveTo(x + rr, y);
		ctx.arcTo(x + w, y, x + w, y + h, rr);
		ctx.arcTo(x + w, y + h, x, y + h, rr);
		ctx.arcTo(x, y + h, x, y, rr);
		ctx.arcTo(x, y, x + w, y, rr);
		ctx.closePath();
	}

	// ── Screenshot ────────────────────────────────────────────────────────────
	function screenshot() {
		try {
			renderer.render(scene, camera); // guarantee the latest frame is in the buffer
		} catch (err) {
			log.error('[walk-capture] render before screenshot failed:', err);
		}
		const src = renderer.domElement;
		const w = src.width;
		const h = src.height;
		const canvas = document.createElement('canvas');
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext('2d');
		if (!ctx) {
			setStatus('Screenshot unavailable in this browser', { error: true });
			return;
		}
		composite(ctx, w, h);
		canvas.toBlob((blob) => {
			if (!blob) {
				setStatus('Screenshot failed', { error: true });
				return;
			}
			haptics.buzz(8);
			openShareSheet({ blob, kind: 'image', mime: 'image/png', filename: `three-ws-walk-${stamp()}.png` });
		}, 'image/png');
		setStatus('Screenshot captured');
	}

	// ── Recording ──────────────────────────────────────────────────────────────
	let recording = false;
	let recorder = null;
	let rafId = 0;
	let startMs = 0;
	let chunks = [];
	let stream = null;
	let composeCanvas = null;
	let cctx = null;
	let bufW = 0;
	let bufH = 0;

	const indicator = buildIndicator();

	function isRecording() {
		return recording;
	}

	function startRecording() {
		if (recording) return;
		if (typeof MediaRecorder === 'undefined') {
			setStatus('Recording not supported on this browser', { error: true });
			return;
		}
		const mime = pickRecorderMime();
		const src = renderer.domElement;
		bufW = src.width;
		bufH = src.height;
		composeCanvas = document.createElement('canvas');
		composeCanvas.width = bufW;
		composeCanvas.height = bufH;
		cctx = composeCanvas.getContext('2d');
		if (!cctx) {
			setStatus('Recording context unavailable', { error: true });
			return;
		}
		stream = composeCanvas.captureStream(CAPTURE_FPS);
		try {
			recorder = mime
				? new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VIDEO_BITRATE })
				: new MediaRecorder(stream);
		} catch (err) {
			setStatus(`Recorder error: ${err?.message ?? err}`, { error: true });
			cleanupStream();
			return;
		}
		chunks = [];
		recorder.ondataavailable = (e) => {
			if (e.data?.size) chunks.push(e.data);
		};
		recorder.onstop = onRecordingStop;
		recorder.onerror = (e) => {
			log.error('[walk-capture] recorder error:', e);
			recording = false;
			cancelAnimationFrame(rafId);
			showIndicator(false);
			cleanupStream();
			setStatus('Recording failed', { error: true });
		};

		recording = true;
		showIndicator(true);
		haptics.buzz(12);
		setStatus('Recording — press R or tap to stop');
		startMs = performance.now();
		recorder.start();
		rafId = requestAnimationFrame(paint);
	}

	function paint() {
		if (!recording) return;
		composite(cctx, bufW, bufH);
		const elapsed = (performance.now() - startMs) / 1000;
		const remaining = Math.max(0, Math.ceil(RECORD_MAX_SECONDS - elapsed));
		updateIndicator(remaining);
		if (elapsed >= RECORD_MAX_SECONDS) {
			stopRecording();
			return;
		}
		rafId = requestAnimationFrame(paint);
	}

	function stopRecording() {
		if (!recording) return;
		recording = false;
		cancelAnimationFrame(rafId);
		showIndicator(false);
		try {
			recorder.stop();
		} catch {}
	}

	function toggleRecording() {
		if (recording) stopRecording();
		else startRecording();
	}

	function cleanupStream() {
		try {
			stream?.getTracks().forEach((t) => t.stop());
		} catch {}
		stream = null;
	}

	async function onRecordingStop() {
		const recordedMime = recorder?.mimeType || pickRecorderMime() || '';
		cleanupStream();

		if (!chunks.length) {
			setStatus('No clip captured', { error: true });
			return;
		}

		let blob = new Blob(chunks, { type: recordedMime.includes('mp4') ? 'video/mp4' : 'video/webm' });

		if (!blob.type.includes('mp4')) {
			setStatus('Encoding MP4…', { sticky: true });
			try {
				const mp4 = await transmuxToMp4(blob);
				if (mp4) blob = mp4;
			} catch (err) {
				log.warn('[walk-capture] mp4 transmux failed, sharing WebM:', err);
			}
		}

		const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
		haptics.buzz(10);
		setStatus('Clip ready');
		openShareSheet({ blob, kind: 'video', mime: blob.type, filename: `three-ws-walk-${stamp()}.${ext}` });
	}

	// ── ffmpeg.wasm transmux (lazy) ────────────────────────────────────────────
	let _ffmpeg = null;
	let _ffmpegLoading = null;

	async function getFFmpeg() {
		if (_ffmpeg) return _ffmpeg;
		if (_ffmpegLoading) return _ffmpegLoading;
		_ffmpegLoading = (async () => {
			const { FFmpeg } = await import('@ffmpeg/ffmpeg');
			const ff = new FFmpeg();
			await ff.load({
				coreURL: '/vendor/ffmpeg-wasm/ffmpeg-core.js',
				wasmURL: '/vendor/ffmpeg-wasm/ffmpeg-core.wasm',
			});
			_ffmpeg = ff;
			return ff;
		})();
		return _ffmpegLoading;
	}

	async function transmuxToMp4(webmBlob) {
		const ff = await getFFmpeg();
		const { fetchFile } = await import('@ffmpeg/util');
		await ff.writeFile('in.webm', await fetchFile(webmBlob));
		// WebM from MediaRecorder is VP8/VP9 — a real re-encode to H.264 is required
		// (not a stream copy). veryfast + yuv420p + faststart = broadly playable MP4.
		await ff.exec([
			'-i', 'in.webm',
			'-c:v', 'libx264',
			'-preset', 'veryfast',
			'-pix_fmt', 'yuv420p',
			'-movflags', '+faststart',
			'out.mp4',
		]);
		const data = await ff.readFile('out.mp4');
		ff.deleteFile('in.webm').catch(() => {});
		ff.deleteFile('out.mp4').catch(() => {});
		const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
		return new Blob([bytes], { type: 'video/mp4' });
	}

	// ── Recording indicator (red dot + countdown) ──────────────────────────────
	function buildIndicator() {
		const el = document.createElement('div');
		el.className = 'walk-cap-rec';
		el.setAttribute('role', 'status');
		el.setAttribute('aria-live', 'polite');
		const dot = document.createElement('span');
		dot.className = 'walk-cap-rec-dot';
		const label = document.createElement('span');
		label.className = 'walk-cap-rec-label';
		label.textContent = `REC ${RECORD_MAX_SECONDS}s`;
		el.append(dot, label);
		el._label = label;
		document.body.appendChild(el);
		return el;
	}

	function showIndicator(on) {
		indicator.classList.toggle('is-visible', on);
		if (on && indicator._label) indicator._label.textContent = `REC ${RECORD_MAX_SECONDS}s`;
		recordBtn?.setAttribute('data-recording', String(on));
		if (recordStatus) recordStatus.classList.toggle('is-visible', on);
		if (on && recordStatusLabel) recordStatusLabel.textContent = `REC ${RECORD_MAX_SECONDS}s`;
	}

	function updateIndicator(remaining) {
		if (indicator._label) indicator._label.textContent = `REC ${remaining}s`;
		if (recordStatusLabel) recordStatusLabel.textContent = `REC ${remaining}s`;
	}

	// ── Share sheet ─────────────────────────────────────────────────────────────
	function openShareSheet({ blob, kind, mime, filename }) {
		const objectUrl = URL.createObjectURL(blob);

		const overlay = document.createElement('div');
		overlay.className = 'walk-cap-overlay';
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.setAttribute('aria-label', kind === 'video' ? 'Share your clip' : 'Share your screenshot');

		const card = document.createElement('div');
		card.className = 'walk-cap-card';

		const preview =
			kind === 'video'
				? Object.assign(document.createElement('video'), {
						src: objectUrl,
						autoplay: true,
						loop: true,
						muted: true,
						playsInline: true,
						controls: true,
					})
				: Object.assign(document.createElement('img'), { src: objectUrl, alt: 'Capture preview' });
		preview.className = 'walk-cap-preview';
		if (kind === 'video') preview.setAttribute('playsinline', '');

		const title = document.createElement('h2');
		title.className = 'walk-cap-title';
		title.textContent = kind === 'video' ? 'Your walk clip' : 'Your screenshot';

		const msg = document.createElement('p');
		msg.className = 'walk-cap-msg';
		msg.textContent = 'Share it or save it — drives people to walk their own.';

		const actions = document.createElement('div');
		actions.className = 'walk-cap-actions';

		const closeBtn = document.createElement('button');
		closeBtn.type = 'button';
		closeBtn.className = 'walk-cap-close';
		closeBtn.setAttribute('aria-label', 'Close');
		closeBtn.innerHTML = '&times;';

		function close() {
			overlay.classList.remove('is-open');
			document.removeEventListener('keydown', onKey);
			const done = () => {
				overlay.remove();
				URL.revokeObjectURL(objectUrl);
			};
			overlay.addEventListener('transitionend', done, { once: true });
			setTimeout(done, 300); // belt-and-braces if transitionend doesn't fire
		}
		function onKey(e) {
			if (e.key === 'Escape') close();
		}

		// Download
		const dl = makeButton('Download', 'primary', () => {
			downloadBlob(blob, filename);
			haptics.buzz(6);
		});

		// Share to X
		const xBtn = makeButton(svgX() + ' Share to X', 'x', async () => {
			await shareToX({ blob, mime, button: xBtn, msg });
		});

		// Share to Farcaster
		const fcBtn = makeButton(svgFarcaster() + ' Farcaster', 'fc', () => {
			shareToFarcaster();
			setModalMessage(msg, 'Opened the Warpcast composer in a new tab.');
		});

		actions.append(dl, xBtn, fcBtn);

		// Native share (mobile) — share the actual file.
		const file = new File([blob], filename, { type: mime });
		if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [file] })) {
			const nativeBtn = makeButton('Share…', 'ghost', async () => {
				try {
					await navigator.share({
						files: [file],
						title: 'My 3D agent on three.ws',
						text: X_TWEET_TEXT(avatarShareUrl()),
					});
				} catch (err) {
					if (err?.name !== 'AbortError') downloadBlob(blob, filename);
				}
			});
			actions.append(nativeBtn);
		}

		card.append(closeBtn, title, preview, msg, actions);
		overlay.append(card);
		document.body.appendChild(overlay);

		overlay.addEventListener('pointerdown', (e) => {
			if (e.target === overlay) close();
		});
		closeBtn.addEventListener('click', close);
		document.addEventListener('keydown', onKey);

		requestAnimationFrame(() => overlay.classList.add('is-open'));
	}

	async function shareToX({ blob, mime, button, msg }) {
		const original = button.innerHTML;
		button.disabled = true;
		button.innerHTML = 'Posting to X…';
		setModalMessage(msg, '');
		try {
			const id = getAvatarId();
			const qs = new URLSearchParams();
			if (id) qs.set('avatar', id);
			const res = await fetch(`/api/share/x${qs.toString() ? `?${qs}` : ''}`, {
				method: 'POST',
				headers: { 'content-type': mime },
				body: blob,
				credentials: 'same-origin',
			});
			const data = await res.json().catch(() => ({}));
			if (res.ok && data.ok) {
				setModalMessage(msg, 'Posted to X 🎉', data.url, 'View post');
				button.innerHTML = 'Posted ✓';
				haptics.buzz(14);
				return;
			}
			if (res.status === 401 || data.error === 'auth_required') {
				setModalMessage(msg, 'Sign in to three.ws to post to X.', data.login_url || '/login', 'Sign in');
			} else if (data.error === 'not_connected') {
				setModalMessage(msg, 'Connect your X account to post.', data.connect_url || '/api/auth/x/connect', 'Connect X');
			} else if (data.error === 'reauth_required') {
				// The account is still linked but its token can no longer be refreshed.
				// Same recovery as a missing connection, so route the user back through
				// the connect flow instead of the three.ws login page.
				setModalMessage(msg, 'Your X connection expired. Reconnect to post.', data.connect_url || '/api/auth/x/connect', 'Reconnect X');
			} else if (data.error === 'rate_limited') {
				setModalMessage(msg, data.error_description || 'Posting too fast — try again shortly.');
			} else if (data.error === 'quota_exceeded') {
				setModalMessage(msg, data.error_description || 'Monthly X post limit reached.', data.upgrade_url || '/pricing', 'Upgrade');
			} else {
				setModalMessage(msg, data.error_description || 'Could not post to X. You can still download and share manually.');
			}
		} catch (err) {
			log.warn('[walk-capture] share to X failed:', err);
			setModalMessage(msg, 'Network error posting to X. Download and share manually instead.');
		} finally {
			if (!button.innerHTML.includes('Posted')) {
				button.disabled = false;
				button.innerHTML = original;
			}
		}
	}

	function shareToFarcaster() {
		const id = getAvatarId();
		const origin = typeof location !== 'undefined' ? location.origin : 'https://three.ws';
		const frameUrl = `${origin}/api/frames/walk${id ? `?avatar=${encodeURIComponent(id)}` : ''}`;
		const text = X_TWEET_TEXT(avatarShareUrl());
		const composer = `https://warpcast.com/~/compose?text=${encodeURIComponent(text)}&embeds[]=${encodeURIComponent(frameUrl)}`;
		window.open(composer, '_blank', 'noopener,noreferrer');
		haptics.buzz(6);
	}

	function makeButton(html, variant, onClick) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = `walk-cap-btn walk-cap-btn--${variant}`;
		b.innerHTML = html;
		b.addEventListener('click', onClick);
		return b;
	}

	return { screenshot, toggleRecording, startRecording, stopRecording, isRecording };
}

// ── DOM helpers (module scope) ────────────────────────────────────────────────
function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function setModalMessage(el, text, linkHref = null, linkLabel = null) {
	if (!el) return;
	el.textContent = text;
	if (linkHref && linkLabel) {
		const a = document.createElement('a');
		a.href = linkHref;
		a.textContent = ` ${linkLabel} →`;
		a.target = '_blank';
		a.rel = 'noopener noreferrer';
		a.className = 'walk-cap-msg-link';
		el.appendChild(a);
	}
}

function svgX() {
	return '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
}

function svgFarcaster() {
	return '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="currentColor"><path d="M5 3h14v3h-2v12h2v3h-6v-3h1v-5H6v5h1v3H1v-3h2V6H1V3h4zm0 0"/></svg>';
}

// One-time stylesheet for the indicator + share sheet. Scoped to walk-cap-*.
let _stylesInjected = false;
function injectStyles() {
	if (_stylesInjected || typeof document === 'undefined') return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.textContent = `
	@keyframes walk-cap-rec-pulse { 0%,100% { opacity:1 } 50% { opacity:0.35 } }
	.walk-cap-rec {
		position:fixed; z-index:30; right:16px; top:calc(env(safe-area-inset-top,0) + 60px);
		display:none; align-items:center; gap:8px;
		background:rgba(248,113,113,0.92); color:#fff;
		border:1px solid rgba(255,255,255,0.25); border-radius:999px;
		padding:6px 14px; font:600 12px/1 system-ui,sans-serif;
		pointer-events:none; backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
	}
	.walk-cap-rec.is-visible { display:inline-flex; }
	.walk-cap-rec-dot { width:8px; height:8px; border-radius:50%; background:#fff; animation:walk-cap-rec-pulse 0.9s infinite; }
	body.is-zen .walk-cap-rec { display:none !important; }

	.walk-cap-overlay {
		position:fixed; inset:0; z-index:10000; display:flex; align-items:center; justify-content:center;
		padding:20px; background:rgba(0,0,0,0.72); backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
		opacity:0; transition:opacity 0.2s ease;
	}
	.walk-cap-overlay.is-open { opacity:1; }
	.walk-cap-card {
		position:relative; width:min(460px,94vw); max-height:92vh; overflow:auto;
		background:#141417; border:1px solid rgba(255,255,255,0.1); border-radius:18px;
		padding:22px; color:#fff; font-family:system-ui,-apple-system,sans-serif;
		transform:translateY(8px) scale(0.98); transition:transform 0.2s ease;
		box-shadow:0 24px 80px rgba(0,0,0,0.5);
	}
	.walk-cap-overlay.is-open .walk-cap-card { transform:translateY(0) scale(1); }
	.walk-cap-close {
		position:absolute; top:12px; right:14px; width:30px; height:30px; line-height:1;
		font-size:22px; color:rgba(255,255,255,0.6); background:rgba(255,255,255,0.06);
		border:1px solid rgba(255,255,255,0.1); border-radius:8px; cursor:pointer; transition:all 0.15s ease;
	}
	.walk-cap-close:hover { color:#fff; background:rgba(255,255,255,0.12); }
	.walk-cap-close:focus-visible { outline:2px solid #7c5cff; outline-offset:2px; }
	.walk-cap-title { margin:0 0 4px; font-size:17px; font-weight:600; letter-spacing:-0.3px; padding-right:34px; }
	.walk-cap-msg { margin:0 0 16px; font-size:13px; color:rgba(255,255,255,0.55); line-height:1.5; }
	.walk-cap-msg-link { color:#9d86ff; font-weight:600; text-decoration:none; }
	.walk-cap-msg-link:hover { text-decoration:underline; }
	.walk-cap-preview {
		display:block; width:100%; border-radius:12px; margin:0 0 16px;
		background:#0a0a0a; border:1px solid rgba(255,255,255,0.08); max-height:46vh; object-fit:contain;
	}
	.walk-cap-actions { display:flex; flex-wrap:wrap; gap:10px; }
	.walk-cap-btn {
		flex:1 1 auto; min-width:120px; display:inline-flex; align-items:center; justify-content:center; gap:7px;
		padding:11px 14px; border-radius:11px; font:600 14px/1 system-ui,sans-serif; cursor:pointer;
		border:1px solid transparent; transition:transform 0.12s ease, background 0.15s ease, opacity 0.15s ease;
	}
	.walk-cap-btn:active { transform:translateY(1px); }
	.walk-cap-btn:focus-visible { outline:2px solid #7c5cff; outline-offset:2px; }
	.walk-cap-btn:disabled { opacity:0.6; cursor:default; }
	.walk-cap-btn--primary { background:#7c5cff; color:#fff; }
	.walk-cap-btn--primary:hover { background:#8d70ff; }
	.walk-cap-btn--x { background:#000; color:#fff; border-color:rgba(255,255,255,0.2); }
	.walk-cap-btn--x:hover { background:#191919; }
	.walk-cap-btn--fc { background:#7c65c1; color:#fff; }
	.walk-cap-btn--fc:hover { background:#8a73d0; }
	.walk-cap-btn--ghost { background:rgba(255,255,255,0.08); color:#fff; border-color:rgba(255,255,255,0.12); }
	.walk-cap-btn--ghost:hover { background:rgba(255,255,255,0.14); }
	@media (prefers-reduced-motion: reduce) {
		.walk-cap-overlay, .walk-cap-card, .walk-cap-btn { transition:none; }
		.walk-cap-rec-dot { animation:none; }
	}
	`;
	document.head.appendChild(style);
}
