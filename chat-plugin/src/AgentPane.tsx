import React, { useRef, useEffect, useState } from 'react';
import { AgentBridge } from './bridge.js';
import { PluginSettings, DEFAULT_API_ORIGIN } from './config-schema.js';

export interface AgentPaneProps {
	settings: PluginSettings;
}

/**
 * Sidebar plugin component that renders a three.ws avatar and forwards
 * host tool-call payloads to the agent via the bridge.
 *
 * The host (LobeChat or SperaxOS — a LobeChat-lineage platform) delivers a
 * standalone plugin's triggering function call by postMessage:
 *   { type: '<ns>:init-standalone-plugin', payload: { apiName, arguments }, settings }
 * where `<ns>` is 'lobe-chat' or 'speraxos' and `arguments` is a JSON string.
 * Channel names are verified against @lobehub/chat-plugin-sdk and the Sperax
 * AI-Plugin-Marketplace-SDK.
 */
export const AgentPane: React.FC<AgentPaneProps> = ({ settings }) => {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const bridgeRef = useRef<AgentBridge | null>(null);
	const [isReady, setIsReady] = useState(false);
	const [frameHeight, setFrameHeight] = useState(480);

	const apiOrigin = settings.apiOrigin || DEFAULT_API_ORIGIN;
	// Pass agent id via query param; boot.js reads ?agent=
	const embedUrl = `${apiOrigin}/lobehub/iframe/?agent=${encodeURIComponent(settings.agentId)}&bg=transparent`;

	// Mount bridge once per agentId.
	useEffect(() => {
		setIsReady(false);
		const bridge = new AgentBridge({
			agentId: settings.agentId,
			iframeRef,
			onReady: () => setIsReady(true),
			onResize: (h: number) => setFrameHeight(Math.min(Math.max(h, 200), 640)),
		});
		bridge.mount();
		bridgeRef.current = bridge;
		return () => {
			bridge.unmount();
			bridgeRef.current = null;
		};
	}, [settings.agentId]);

	// Observe tool calls the host (LobeChat / SperaxOS) delivers by postMessage.
	//
	// Both platforms share an identical contract, differing only in the channel
	// prefix: 'lobe-chat:' vs 'speraxos:'. A standalone plugin receives its
	// triggering function call on the init-standalone-plugin (or render-plugin)
	// channel: { type, payload: { apiName, arguments }, settings }. `arguments` is
	// a JSON string; older builds nest the payload under `props`. We accept both.
	useEffect(() => {
		const isPluginCall = (type?: string) =>
			!!type &&
			(type.startsWith('lobe-chat:') || type.startsWith('speraxos:')) &&
			(type.endsWith('init-standalone-plugin') || type.endsWith('render-plugin'));

		const handleMessage = (ev: MessageEvent) => {
			const data = ev.data as Record<string, unknown> | null;
			if (!data || typeof data !== 'object') return;
			if (!isPluginCall(data['type'] as string)) return;

			const payload = (data['payload'] || data['props'] || {}) as Record<string, unknown>;
			const apiName = (payload['apiName'] || payload['name']) as string | undefined;

			let args: Record<string, unknown> = {};
			const raw = payload['arguments'];
			if (typeof raw === 'string') {
				try {
					args = JSON.parse(raw || '{}');
				} catch {
					args = {};
				}
			} else if (raw && typeof raw === 'object') {
				args = raw as Record<string, unknown>;
			}

			const bridge = bridgeRef.current;
			if (!bridge) return;

			// Re-bind if the host pushed an updated agentId in settings.
			const settings = data['settings'] as Record<string, unknown> | undefined;
			if (settings && typeof settings['agentId'] === 'string') {
				bridge.setAgent(settings['agentId']).catch(() => undefined);
			}

			switch (apiName) {
				case 'speak':
					if (typeof args['text'] === 'string') {
						bridge
							.speak(args['text'], {
								sentiment:
									typeof args['sentiment'] === 'number' ? args['sentiment'] : 0,
							})
							.catch(() => undefined);
					}
					break;
				case 'gesture':
					if (typeof args['name'] === 'string') {
						bridge.gesture(args['name']).catch(() => undefined);
					}
					break;
				case 'emote':
					if (typeof args['trigger'] === 'string') {
						bridge
							.emote({
								trigger: args['trigger'],
								weight: typeof args['weight'] === 'number' ? args['weight'] : 1,
							})
							.catch(() => undefined);
					}
					break;
				case 'render_agent':
				case 'render-agent':
					if (typeof args['agentId'] === 'string') {
						bridge.setAgent(args['agentId']).catch(() => undefined);
					}
					break;
			}
		};

		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				width: '100%',
				height: frameHeight,
				backgroundColor: 'transparent',
				borderRadius: '8px',
				overflow: 'hidden',
				position: 'relative',
			}}
		>
			{!isReady && (
				<div
					style={{
						position: 'absolute',
						inset: 0,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						color: 'rgba(128, 128, 128, 0.6)',
						fontSize: '12px',
						fontFamily: 'system-ui, sans-serif',
					}}
				>
					Loading agent…
				</div>
			)}
			<iframe
				ref={iframeRef}
				src={embedUrl}
				title={`three.ws ${settings.agentId}`}
				style={{
					width: '100%',
					height: '100%',
					border: 'none',
					opacity: isReady ? 1 : 0,
					transition: 'opacity 0.3s ease',
				}}
				sandbox="allow-same-origin allow-scripts allow-presentation"
			/>
		</div>
	);
};

export default AgentPane;
