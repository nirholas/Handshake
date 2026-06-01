import { writable, get } from 'svelte/store';
import { persisted } from './localstorage.js';
import { v4 as uuidv4 } from 'uuid';
import { syncHostedAddress } from './sync.js';

export const brandConfig = writable({
	name: 'three.ws chat',
	logo_url: null,
	accent_color: '#6366f1',
	tagline: 'Chat with any AI model',
	default_model: 'openai/gpt-oss-120b:free',
	agent_id: null,
	system_prompt: '',
});

export const controller = writable(null);

export const params = persisted('params', {
	temperature: 0.3,
	maxTokens: 0,
	messagesContextLimit: 0,
	reasoningEffort: {
		'low-medium-high': 'high',
		range: 64000,
	},
});

export const config = persisted('config', {
	explicitToolView: false,
	messageAnimation: 'smooth',
});

export const openaiAPIKey = persisted('openaiAPIKey', '');
export const openrouterAPIKey = persisted('openrouterkey', '');
export const anthropicAPIKey = persisted('anthropicAPIKey', '');
export const groqAPIKey = persisted('groqAPIKey', '');
export const mistralAPIKey = persisted('mistralAPIKey', '');

export function getAPIKeysAsObject() {
	return {
		openai: get(openaiAPIKey),
		openrouter: get(openrouterAPIKey),
		anthropic: get(anthropicAPIKey),
		groq: get(groqAPIKey),
		mistral: get(mistralAPIKey),
	};
}

export function setAPIKeysFromObject(obj) {
	openaiAPIKey.set(obj.openai || '');
	openrouterAPIKey.set(obj.openrouter || '');
	anthropicAPIKey.set(obj.anthropic || '');
	groqAPIKey.set(obj.groq || '');
	mistralAPIKey.set(obj.mistral || '');
}

export const remoteServer = persisted('remoteServer', { address: '', password: '' });
export const localProvidersEnabled = persisted('localProvidersEnabled', false);
export const syncServer = persisted('syncServer', {
	address: syncHostedAddress,
	token: uuidv4(),
	password: '',
});
export const toolSchema = persisted('toolSchemaGroups', []);

// Installed content skills: [{ id, name, slug, content }]
export const knowledgeSkills = persisted('knowledgeSkills', []);

export const ttsEnabled = persisted('ttsEnabled', false);
export const localAgentId = persisted('localAgentId', '');
export const activeAgent = persisted('activeAgentDetail', null);
export const agentLibraryUrl = persisted('agentLibraryUrl', 'https://agents-ai-library.vercel.app');
export const pluginLibraryUrl = persisted('pluginLibraryUrl', 'https://ai-agent-plugins.vercel.app');
export const talkingHeadEnabled = persisted('talkingHeadEnabled', false);
export const talkingHeadAvatarUrl = persisted('talkingHeadAvatarUrl', '');

// True while the assistant is generating a response — drives the chat avatar
// walk animation so the agent visibly "moves with the chat".
export const generating = writable(false);

export const route = writable(
	typeof window !== 'undefined' ? (window.location.hash.slice(1) || 'chat') : 'chat'
);
if (typeof window !== 'undefined') {
	window.addEventListener('hashchange', () => {
		route.set(window.location.hash.slice(1) || 'chat');
	});
	route.subscribe((r) => {
		const h = r === 'chat' ? '' : r;
		if (window.location.hash.slice(1) !== h) window.location.hash = h;
	});
}

export const mode = writable(null);
export const websiteCategory = writable(null);
export const composerFill = writable(null);
export const flowSecondary = persisted('flowSecondary', {});
export const appPlatforms = writable(new Set(['macOS']));
export const designModel = writable('gpt-image-2');

export const notifications = writable([]);

export function notify(message, type = 'error') {
	const id = Math.random().toString(36).slice(2);
	notifications.update(n => [...n, { id, message, type }]);
	setTimeout(() => notifications.update(n => n.filter(x => x.id !== id)), 5000);
}

export const locale = persisted('locale', 'en');

export const currentUser = writable(null);

// Which wallet is currently connected, for tool bodies and components that need
// the live provider without re-parsing `currentUser` or polling window.solana /
// window.ethereum. Shape: { type: 'solana'|'evm', address: string, chainId?: number } | null
export const walletProvider = writable(null);

// Read the connected wallet imperatively (e.g. from eval'd tool bodies).
export function getConnectedWallet() {
	return get(walletProvider);
}

// Selected agent id whose Solana wallet pays for x402 paid-tool calls.
// Null means "use the shared demo wallet" served by /api/x402-pay.
export const payAgentId = persisted('payAgentId', null);

// Snapshot of {address, usdc, sol} for the currently selected payer (agent
// wallet or shared demo wallet). Refreshed by PayWalletPicker so the topbar
// pill ticks down after each paid tool call.
export const payWallet = writable({ address: null, usdc: null, sol: null, name: null, agentId: null });

export async function loadCurrentUser() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (!res.ok) { currentUser.set(null); return null; }
    const { user } = await res.json();
    currentUser.set(user ?? null);
    return user ?? null;
  } catch {
    currentUser.set(null);
    return null;
  }
}

// Mirror the connected wallet onto a window global so eval'd tool bodies (which
// run without module imports) can read it as `window.__wallet`.
if (typeof window !== 'undefined') {
  walletProvider.subscribe((w) => { window.__wallet = w; });
}
