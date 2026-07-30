'use client';

// React wrapper around @three-ws/avatar.
//
// Exports:
//   <Avatar src alt />            — wraps <three-ws-viewer> (light viewer)
//   <AgentAvatar avatarId src />  — wraps the heavy <agent-3d> element
//   <AvatarCreator open onExport onClose /> — declarative wrapper around
//                                   the imperative AvatarCreator class
//   useAvatar(id)                 — fetch /api/avatars/:id metadata
//
// Peer dep: react >= 18. No other runtime deps.
// React 19 server components: the file is marked `'use client'` and every
// component touches the DOM, so this module is only valid in client trees.

import {
	useEffect,
	useRef,
	useState,
	useCallback,
	createElement,
	forwardRef,
} from 'react';

// ── <Avatar> ────────────────────────────────────────────────────────────────

/**
 * Pure-visual avatar viewer. Mounts a <three-ws-viewer> web component and
 * keeps its attributes in sync with React props.
 *
 * @param {object} props
 * @param {string} props.src — GLB URL.
 * @param {string} [props.alt] — accessibility label / caption.
 * @param {string} [props.background] — CSS color or 'transparent'.
 * @param {React.CSSProperties} [props.style]
 * @param {string} [props.className]
 * @param {(detail: { url: string }) => void} [props.onLoad]
 * @param {(detail: { url: string, error: Error }) => void} [props.onError]
 */
export const Avatar = forwardRef(function Avatar(props, forwardedRef) {
	const { src, alt, background, style, className, onLoad, onError, ...rest } = props;
	const localRef = useRef(null);

	// Side-effect: register <three-ws-viewer> on first mount.
	useEffect(() => {
		import('./viewer.js').catch((err) => {
			console.error('[@three-ws/avatar/react] failed to load viewer:', err);
		});
	}, []);

	// Sync `src` attribute.
	useEffect(() => {
		const el = localRef.current;
		if (!el) return;
		if (src) el.setAttribute('src', src);
		else el.removeAttribute('src');
	}, [src]);

	// Sync `alt` attribute.
	useEffect(() => {
		const el = localRef.current;
		if (!el) return;
		if (alt) el.setAttribute('alt', alt);
		else el.removeAttribute('alt');
	}, [alt]);

	// Sync `background` attribute.
	useEffect(() => {
		const el = localRef.current;
		if (!el) return;
		if (background) el.setAttribute('background', background);
		else el.removeAttribute('background');
	}, [background]);

	// Bridge custom events → React props.
	useEffect(() => {
		const el = localRef.current;
		if (!el) return;
		const handleLoad = (e) => onLoad?.(e.detail || {});
		const handleError = (e) => onError?.(e.detail || {});
		el.addEventListener('load', handleLoad);
		el.addEventListener('error', handleError);
		return () => {
			el.removeEventListener('load', handleLoad);
			el.removeEventListener('error', handleError);
		};
	}, [onLoad, onError]);

	const setRef = useCallback(
		(node) => {
			localRef.current = node;
			if (typeof forwardedRef === 'function') forwardedRef(node);
			else if (forwardedRef) forwardedRef.current = node;
		},
		[forwardedRef],
	);

	return createElement('three-ws-viewer', {
		ref: setRef,
		style,
		class: className,
		...rest,
	});
});

// ── <AgentAvatar> ───────────────────────────────────────────────────────────

/**
 * Wraps the heavy <agent-3d> element. The SDK monolith is lazy-loaded the
 * first time this component mounts so callers that only use <Avatar> never
 * pay the 3 MB cost.
 *
 * @param {object} props
 * @param {string} [props.avatarId] — three.ws avatar UUID.
 * @param {string} [props.src] — direct GLB URL (alternative to avatarId).
 * @param {string} [props.iosSrc] — USDZ URL for iOS AR Quick Look.
 * @param {boolean} [props.kiosk] — hide the debug GUI.
 * @param {React.CSSProperties} [props.style]
 * @param {string} [props.className]
 */
export const AgentAvatar = forwardRef(function AgentAvatar(props, forwardedRef) {
	const { avatarId, src, iosSrc, kiosk, style, className, ...rest } = props;
	const localRef = useRef(null);
	const [ready, setReady] = useState(
		typeof customElements !== 'undefined' && !!customElements.get('agent-3d'),
	);

	useEffect(() => {
		let cancelled = false;
		import('./agent.js')
			.then((mod) => mod.ensureAgent3D())
			.then(() => {
				if (!cancelled) setReady(true);
			})
			.catch((err) => {
				console.error('[@three-ws/avatar/react] failed to load <agent-3d>:', err);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		const el = localRef.current;
		if (!el || !ready) return;
		if (avatarId) el.setAttribute('avatar-id', avatarId);
		else el.removeAttribute('avatar-id');
	}, [avatarId, ready]);

	useEffect(() => {
		const el = localRef.current;
		if (!el || !ready) return;
		if (src) el.setAttribute('src', src);
		else el.removeAttribute('src');
	}, [src, ready]);

	useEffect(() => {
		const el = localRef.current;
		if (!el || !ready) return;
		if (iosSrc) el.setAttribute('ios-src', iosSrc);
		else el.removeAttribute('ios-src');
	}, [iosSrc, ready]);

	useEffect(() => {
		const el = localRef.current;
		if (!el || !ready) return;
		if (kiosk) el.setAttribute('kiosk', '');
		else el.removeAttribute('kiosk');
	}, [kiosk, ready]);

	const setRef = useCallback(
		(node) => {
			localRef.current = node;
			if (typeof forwardedRef === 'function') forwardedRef(node);
			else if (forwardedRef) forwardedRef.current = node;
		},
		[forwardedRef],
	);

	if (!ready) {
		return createElement('div', {
			ref: setRef,
			style: { ...style, display: 'flex', alignItems: 'center', justifyContent: 'center' },
			className,
			'data-three-ws-agent-loading': '',
			...rest,
		}, 'Loading three.ws avatar…');
	}

	return createElement('agent-3d', {
		ref: setRef,
		style,
		class: className,
		...rest,
	});
});

// ── <AvatarCreator> ─────────────────────────────────────────────────────────

/**
 * Declarative wrapper around the imperative AvatarCreator class. The modal
 * is opened / closed based on the `open` prop. Exports are bridged through
 * `onExport`; the user dismissing the modal fires `onClose`.
 *
 * @param {object} props
 * @param {boolean} props.open — controls modal visibility.
 * @param {(blob: Blob) => void | Promise<void>} [props.onExport]
 * @param {() => void} [props.onClose]
 * @param {string} [props.studioUrl]
 * @param {string} [props.sessionUrl] — edit-mode session URL for an existing avatar.
 */
export function AvatarCreator(props) {
	const { open, onExport, onClose, studioUrl, sessionUrl } = props;
	const instanceRef = useRef(null);

	// Keep latest callbacks in refs so we don't need to dispose/recreate
	// the modal every time the parent re-renders with a fresh handler.
	const onExportRef = useRef(onExport);
	const onCloseRef = useRef(onClose);
	useEffect(() => {
		onExportRef.current = onExport;
	}, [onExport]);
	useEffect(() => {
		onCloseRef.current = onClose;
	}, [onClose]);

	useEffect(() => {
		let cancelled = false;
		if (!open) return undefined;

		import('./creator.js')
			.then((mod) => {
				if (cancelled) return;
				const creator = new mod.AvatarCreator({
					studioUrl,
					avaturnSessionUrl: sessionUrl,
					onExport: (blob) => onExportRef.current?.(blob),
					onClose: () => onCloseRef.current?.(),
				});
				instanceRef.current = creator;
				return creator.open();
			})
			.catch((err) => {
				console.error('[@three-ws/avatar/react] AvatarCreator open failed:', err);
			});

		return () => {
			cancelled = true;
			if (instanceRef.current) {
				instanceRef.current.dispose();
				instanceRef.current = null;
			}
		};
	}, [open, studioUrl, sessionUrl]);

	return null;
}

// ── useAvatar(id) ───────────────────────────────────────────────────────────

/**
 * Fetch a three.ws avatar record by id. Returns `{ avatar, loading, error }`.
 * Re-fetches when `id` changes; aborts in-flight requests on unmount.
 *
 * @param {string | null | undefined} id
 * @param {object} [opts]
 * @param {string} [opts.apiOrigin] — override the API origin. Defaults to same-origin.
 * @returns {{ avatar: any | null, loading: boolean, error: Error | null }}
 */
export function useAvatar(id, opts) {
	const apiOrigin = opts?.apiOrigin;
	const [state, setState] = useState({ avatar: null, loading: !!id, error: null });

	useEffect(() => {
		if (!id) {
			setState({ avatar: null, loading: false, error: null });
			return undefined;
		}

		const controller = new AbortController();
		setState({ avatar: null, loading: true, error: null });

		const base = apiOrigin ? apiOrigin.replace(/\/$/, '') : '';
		fetch(`${base}/api/avatars/${encodeURIComponent(id)}`, {
			signal: controller.signal,
			headers: { accept: 'application/json' },
		})
			.then(async (res) => {
				if (!res.ok) throw new Error(`avatar fetch failed: ${res.status}`);
				const body = await res.json();
				// API may return { avatar: {...} } or the record directly.
				const avatar = body?.avatar || body;
				setState({ avatar, loading: false, error: null });
			})
			.catch((err) => {
				if (err?.name === 'AbortError') return;
				setState({ avatar: null, loading: false, error: err });
			});

		return () => controller.abort();
	}, [id, apiOrigin]);

	return state;
}
