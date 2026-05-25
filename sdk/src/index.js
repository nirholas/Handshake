/**
 * @three-ws/sdk
 *
 * Ship a cross-chain 3D AI agent with EVM + Solana identity, a chat panel,
 * and discoverable .well-known endpoints in minutes.
 *
 * Quick start:
 *
 *   import { AgentKit } from '@three-ws/sdk';
 *   import '@three-ws/sdk/styles';
 *
 *   const agent = new AgentKit({
 *     name: 'My Agent',
 *     description: 'Does cool stuff',
 *     endpoint: 'https://myapp.com',
 *     onMessage: async (text) => `You said: ${text}`,
 *   });
 *
 *   agent.mount(document.body);
 *
 *   // Register on-chain (needs MetaMask + IPFS token)
 *   await agent.register({ ipfsToken: 'your-web3storage-token' });
 *
 *   // Get .well-known manifests to serve from your server
 *   const { agentRegistration, agentCard, aiPlugin } = agent.manifests();
 */

export { AgentPanel } from './panel.js';
export { loadAvatar } from './avatar.js';
export { agentRegistration, agentCard, aiPlugin } from './manifests.js';
export {
	connectWallet,
	registerAgent,
	pinToIPFS,
	buildRegistrationJSON,
	getIdentityRegistry,
} from './erc8004/registry.js';
export { IDENTITY_REGISTRY_ABI, REPUTATION_REGISTRY_ABI, VALIDATION_REGISTRY_ABI, REGISTRY_DEPLOYMENTS, agentRegistryId } from './erc8004/abi.js';
export { PermissionsClient, PermissionError } from './permissions.js';

// ─── Solana (SIWS auth, Metaplex identity, Solana Pay) ───────────────────────
export {
	detectSolanaProvider,
	signInWithSolana,
	registerSolanaAgent,
	startSolanaCheckout,
	confirmSolanaPayment,
} from './solana.js';
export {
	attestFeedback,
	attestValidation,
	createTask,
	acceptTask,
	attestRevoke,
	attestDispute,
	listAttestations,
	fetchAttestations,
	fetchReputation,
} from './solana-attestations.js';

import { AgentPanel } from './panel.js';
import { agentRegistration, agentCard, aiPlugin } from './manifests.js';
import { registerAgent } from './erc8004/registry.js';

export class AgentKit {
	/**
	 * @param {object} opts
	 * @param {string}   opts.name         Agent name (shown in panel header + manifests)
	 * @param {string}   opts.description  What the agent does
	 * @param {string}   opts.endpoint     Your agent's public URL (https://...)
	 * @param {string}   [opts.image]      Public URL to your agent's logo/image
	 * @param {string}   [opts.version]    Semver version string
	 * @param {string}   [opts.org]        Organization name for agent-card.json
	 * @param {Array}    [opts.skills]     A2A skill definitions
	 * @param {Array}    [opts.services]   Extra service entries (A2A, MCP endpoints)
	 * @param {Function} [opts.onMessage]  async (text: string) => string
	 * @param {string}   [opts.welcome]    Panel welcome message
	 * @param {boolean}  [opts.voice]      Enable TTS (default: true)
	 */
	constructor({
		name,
		description,
		endpoint,
		image = '',
		version = '1.0.0',
		org = '',
		skills = [],
		services = [],
		onMessage,
		welcome,
		voice = true,
	} = {}) {
		if (!name) throw new Error('AgentKit: name is required');
		if (!endpoint) throw new Error('AgentKit: endpoint is required');

		this.config = { name, description, endpoint, image, version, org, skills, services };

		this._panel = new AgentPanel({
			title: name,
			welcome: welcome || `Hi! I'm ${name}. How can I help?`,
			onMessage,
			voice,
		});
	}

	// ---------------------------------------------------------------------------
	// Panel
	// ---------------------------------------------------------------------------

	/**
	 * Attach the chat panel to a DOM element.
	 * @param {HTMLElement} container
	 * @returns {AgentKit} this (chainable)
	 */
	mount(container = document.body) {
		this._panel.mount(container);
		return this;
	}

	/** Open the chat panel. */
	open() {
		this._panel.open();
		return this;
	}

	/** Close the chat panel. */
	close() {
		this._panel.close();
		return this;
	}

	/** Add a message to the panel. */
	addMessage(role, text) {
		this._panel.addMessage(role, text);
		return this;
	}

	/** Remove the panel from the DOM. */
	dispose() {
		this._panel.dispose();
	}

	// ---------------------------------------------------------------------------
	// Blockchain registration
	// ---------------------------------------------------------------------------

	/**
	 * Register the agent on-chain via ERC-8004.
	 *
	 * @param {object}   [opts]
	 * @param {File}     [opts.imageFile]  Agent image to pin to IPFS (optional)
	 * @param {Array}    [opts.services]   Extra services to include in registration
	 * @param {string}   [opts.ipfsToken]  web3.storage API token
	 * @param {Function} [opts.onStatus]   (message: string) => void progress callback
	 * @returns {Promise<{agentId: number, registrationCID: string, txHash: string}>}
	 */
	register({ imageFile, services, ipfsToken, onStatus } = {}) {
		return registerAgent({
			name: this.config.name,
			description: this.config.description,
			endpoint: this.config.endpoint,
			imageFile,
			services: services ?? this.config.services,
			apiToken: ipfsToken,
			onStatus,
		});
	}

	// ---------------------------------------------------------------------------
	// Manifests
	// ---------------------------------------------------------------------------

	/**
	 * Get the three .well-known manifest objects ready to serve.
	 *
	 * @param {object} [opts]
	 * @param {string} [opts.openapiUrl]    URL to your OpenAPI spec
	 * @param {Array}  [opts.registrations] On-chain registration records
	 * @returns {{ agentRegistration: object, agentCard: object, aiPlugin: object }}
	 */
	manifests({ openapiUrl = '', registrations = [] } = {}) {
		const { name, description, endpoint, image, version, org, skills, services } = this.config;

		const extraServices = [];
		if (openapiUrl) {
			extraServices.push({ name: 'MCP', endpoint: openapiUrl, version: '2025-06-18' });
		}

		return {
			agentRegistration: agentRegistration({
				name,
				description,
				endpoint,
				image,
				services: [...services, ...extraServices],
				registrations,
			}),
			agentCard: agentCard({
				name,
				description,
				url: endpoint,
				version,
				org,
				skills,
			}),
			aiPlugin: aiPlugin({
				name,
				description,
				openapiUrl: openapiUrl || `${endpoint}/.well-known/openapi.yaml`,
				logoUrl: image,
			}),
		};
	}
}
