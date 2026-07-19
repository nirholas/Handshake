/**
 * React wrapper for @three-ws/concierge.
 * ======================================
 *
 * The concierge docks itself to the viewport corner (it is not rendered into
 * your tree), so the component renders nothing, it just owns the widget's
 * lifecycle: construct on mount, dispose on unmount, and expose an imperative
 * handle (ask / open / setAvatar) via ref.
 *
 *   npm install @three-ws/concierge three
 *
 *   import { Concierge } from './Concierge';
 *
 *   function App() {
 *     const ref = useRef(null);
 *     return (
 *       <>
 *         <button onClick={() => ref.current.ask('What does it cost?')}>Ask</button>
 *         <Concierge
 *           ref={ref}
 *           siteName="Acme"
 *           accent="#f97316"
 *           knowledge={FAQ}
 *           onMessage={(m) => analytics.track('concierge', m)}
 *         />
 *       </>
 *     );
 *   }
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Concierge as ConciergeWidget } from '@three-ws/concierge';

export const Concierge = forwardRef(function Concierge(
	{ onReady, onOpen, onClose, onMessage, onAgentChange, onError, ...config },
	ref,
) {
	const widgetRef = useRef(null);

	// Construct once. We intentionally do NOT reconstruct on config changes;
	// tearing down the WebGL stage on every prop change would be wasteful. For
	// dynamic knowledge/persona, update via the ref instead (see setContext note
	// in the README) or key the component to force a remount.
	useEffect(() => {
		const widget = new ConciergeWidget(config);
		widgetRef.current = widget;

		const offs = [
			onReady && widget.on('ready', onReady),
			onOpen && widget.on('open', onOpen),
			onClose && widget.on('close', onClose),
			onMessage && widget.on('message', onMessage),
			onAgentChange && widget.on('agentchange', onAgentChange),
			onError && widget.on('error', onError),
		].filter(Boolean);

		return () => {
			for (const off of offs) off();
			widget.dispose();
			widgetRef.current = null;
		};
		// Construct-once by design; see the comment above. (Deps intentionally [].)
	}, []);

	useImperativeHandle(
		ref,
		() => ({
			ask: (text) => widgetRef.current?.ask(text),
			open: () => widgetRef.current?.setOpen(true),
			close: () => widgetRef.current?.setOpen(false),
			setAvatar: (id) => widgetRef.current?.setAvatar(id),
			setMuted: (m) => widgetRef.current?.setMuted(m),
			reset: () => widgetRef.current?.reset(),
			get widget() {
				return widgetRef.current;
			},
		}),
		[],
	);

	// The widget mounts itself to <body>; nothing to render here.
	return null;
});
