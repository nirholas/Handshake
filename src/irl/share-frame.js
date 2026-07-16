// Composite-share for the immersive surfaces (IRL + XR).
//
// Flattens the WebGL canvas over the live camera feed into a single PNG and
// offers it through the native share sheet (navigator.share with files), with a
// desktop download fallback and a final URL-share → clipboard chain when the
// frame can't be captured. One module so /irl and /xr never drift apart.
//
// Requires the renderer to be built with `preserveDrawingBuffer: true`, or the
// canvas reads back blank between frames (set in src/irl.js and src/xr.js).

/**
 * Flatten the camera feed (when in AR) and the 3D canvas into one PNG blob.
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas  The WebGL canvas (drawn on top, alpha).
 * @param {HTMLVideoElement}  [opts.video] The camera passthrough (drawn behind).
 * @param {boolean}           opts.isAR    True when the camera feed is the backdrop.
 * @returns {Promise<Blob|null>} PNG blob, or null if the canvas has no pixels yet.
 */
export async function captureComposite({ canvas, video, isAR }) {
	if (!canvas) return null;
	const w = canvas.width, h = canvas.height; // renderer pixel size, not CSS size
	if (!w || !h) return null;

	const out = document.createElement('canvas');
	out.width = w;
	out.height = h;
	const ctx = out.getContext('2d');
	if (!ctx) return null;

	// Camera feed first (background), then the 3D canvas (alpha) over the top, so
	// the agent sits in the room. videoWidth guards against a not-yet-playing feed.
	if (isAR && video && !video.paused && video.videoWidth) {
		try { ctx.drawImage(video, 0, 0, w, h); } catch { /* tainted/!ready — skip backdrop */ }
	}
	try { ctx.drawImage(canvas, 0, 0); } catch { /* canvas not readable — bail to null below */ }

	return await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
}

/**
 * Upload a captured composite to POST /api/irl/share so it becomes a permanent,
 * unfurlable link (og:image on X/Discord/iMessage) instead of a bare file that
 * dead-ends in the recipient's Photos app. Best-effort: any failure (network,
 * the pin got unpublished mid-share, rate limit) resolves to null so the caller
 * falls straight back to the plain native-file share — minting a share link is
 * a nice-to-have on top of sharing, never a blocker to it.
 *
 * @param {Blob} blob
 * @param {object} opts
 * @param {string} opts.pinId
 * @param {string} [opts.deviceToken]
 * @returns {Promise<string|null>} the permanent https://…/irl/s/<token> URL, or null
 */
export async function mintShareLink(blob, { pinId, deviceToken }) {
	if (!pinId) return null;
	try {
		const headers = { 'content-type': 'application/octet-stream' };
		if (deviceToken) headers['x-irl-device'] = deviceToken;
		const r = await fetch(`/api/irl/share?pinId=${encodeURIComponent(pinId)}`, {
			method: 'POST',
			credentials: 'include',
			headers,
			body: blob,
		});
		if (!r.ok) return null;
		const data = await r.json();
		return typeof data.url === 'string' ? data.url : null;
	} catch {
		return null;
	}
}

/** Share a URL through the native sheet, falling back to clipboard copy. */
async function shareUrlOrCopy(url, { title = 'IRL · three.ws' } = {}) {
	if (navigator.share) {
		try {
			await navigator.share({ title, url });
			return 'shared';
		} catch (err) {
			if (err?.name === 'AbortError') throw err;
		}
	}
	await navigator.clipboard.writeText(url);
	return 'copied';
}

/**
 * Share a blob through the native sheet, falling back to a desktop download.
 *
 * @param {Blob} blob
 * @param {object} [opts]
 * @param {string} [opts.filename]
 * @param {string} [opts.title]
 * @returns {Promise<'shared'|'downloaded'>}
 */
export async function shareOrDownload(blob, { filename = 'three-ws-irl.png', title = 'IRL · three.ws' } = {}) {
	const file = new File([blob], filename, { type: 'image/png' });
	if (navigator.share && navigator.canShare?.({ files: [file] })) {
		await navigator.share({ title, files: [file] });
		return 'shared';
	}
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 4000);
	return 'downloaded';
}

// Swap a button's trailing label without disturbing a leading icon: update the
// last text node in place (icon'd XR button) or fall back to textContent (the
// text-only IRL button).
function setButtonLabel(btn, text) {
	const last = btn.lastChild;
	if (last && last.nodeType === 3 /* TEXT_NODE */) last.textContent = ` ${text}`;
	else btn.textContent = text;
}

/**
 * Wire a share button to the full capture → share/download → URL-share → clipboard
 * flow with designed transient states (… / Shared! / Saved! / Copied!). Returns a
 * disposer that removes the listener.
 *
 * @param {HTMLButtonElement} btn
 * @param {object} opts
 * @param {() => HTMLCanvasElement} opts.getCanvas
 * @param {() => HTMLVideoElement}  [opts.getVideo]
 * @param {() => boolean}           opts.getIsAR
 * @param {() => string|null}       [opts.getPinId] the caller's currently-placed pin id, if any —
 *   when present the capture is minted into a permanent share link (see mintShareLink) instead
 *   of a bare file share.
 * @param {() => string|null}       [opts.getDeviceToken]
 * @param {string}                  [opts.filename]
 * @param {string}                  [opts.title]
 * @returns {() => void} disposer
 */
export function wireShareButton(btn, { getCanvas, getVideo, getIsAR, getPinId, getDeviceToken, filename = 'three-ws-irl.png', title = 'IRL · three.ws' }) {
	if (!btn) return () => {};

	const onClick = async () => {
		const origHTML = btn.innerHTML;
		const restore = (ms = 2000) => setTimeout(() => { btn.innerHTML = origHTML; btn.disabled = false; }, ms);

		btn.disabled = true;
		setButtonLabel(btn, '…');

		try {
			const blob = await captureComposite({
				canvas: getCanvas(),
				video: getVideo?.(),
				isAR: !!getIsAR(),
			});
			if (blob) {
				const pinId = getPinId?.();
				if (pinId) {
					const shareUrl = await mintShareLink(blob, { pinId, deviceToken: getDeviceToken?.() });
					if (shareUrl) {
						const result = await shareUrlOrCopy(shareUrl, { title });
						setButtonLabel(btn, result === 'shared' ? 'Shared!' : 'Copied!');
						restore();
						return;
					}
				}
				const result = await shareOrDownload(blob, { filename, title });
				setButtonLabel(btn, result === 'shared' ? 'Shared!' : 'Saved!');
				restore();
				return;
			}
		} catch (err) {
			// A user-cancelled share sheet (AbortError) is not a failure — restore
			// quietly without dropping to the URL fallback.
			if (err?.name === 'AbortError') { btn.innerHTML = origHTML; btn.disabled = false; return; }
		}

		// Capture failed (blank canvas / unsupported toBlob) — share the page URL,
		// then copy it as a last resort so the action is never a dead end.
		const url = location.href;
		if (navigator.share) {
			try {
				await navigator.share({ title, url });
				setButtonLabel(btn, 'Shared!');
				restore();
				return;
			} catch (err) {
				if (err?.name === 'AbortError') { btn.innerHTML = origHTML; btn.disabled = false; return; }
			}
		}
		try {
			await navigator.clipboard.writeText(url);
			setButtonLabel(btn, 'Copied!');
		} catch {
			btn.innerHTML = origHTML;
		}
		restore(1800);
	};

	btn.addEventListener('click', onClick);
	return () => btn.removeEventListener('click', onClick);
}
