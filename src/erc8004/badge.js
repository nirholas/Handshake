/**
 * <three-d-agent-badge> — embeddable trust badge for an ERC-8004 / three.ws Card v1 agent.
 *
 * Usage:
 *   <script type="module" src="https://three.ws/erc8004/badge.js"></script>
 *   <three-d-agent-badge agent="eip155:8453:0x8004A818BFB912233c491871b3d84c89A494BD9e/1"></three-d-agent-badge>
 *
 * Attributes:
 *   - agent     CAIP-style ref: "eip155:<chainId>:<registry>/<tokenId>"
 *   - card-url  Direct URL to a three.ws Card v1 JSON (alternative to `agent`)
 *   - resolver  Resolver base URL (default: https://three.ws/)
 *
 * Verification performed (client-side):
 *   1. Card JSON fetched and parsed.
 *   2. sha256(model bytes) === card.model.sha256.
 *   3. Validation report present and reportType matches (if card has `validation`).
 *
 * Renders a pill: verified / partial / unverified / error.
 */

const DEFAULT_RESOLVER = 'https://three.ws/';

const STYLES = `
:host { display: inline-block; font: 500 12px/1.4 system-ui, sans-serif; }
.pill {
	display: inline-flex; align-items: center; gap: 6px;
	padding: 4px 10px; border-radius: 999px;
	border: 1px solid currentColor;
	cursor: pointer; user-select: none;
	transition: opacity .15s;
}
.pill:hover { opacity: .8; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.verified  { color: #0a7d2c; background: #e6f5ec; }
.partial   { color: #8a5a00; background: #fff3d6; }
.unverified{ color: #8a1f1f; background: #fdebeb; }
.loading   { color: #555;    background: #eee; }
.error     { color: #8a1f1f; background: #fdebeb; }
`;

async function sha256Hex(bytes) {
	const buf = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ipfsToHttp(uri) {
	if (uri.startsWith('ipfs://')) return `https://w3s.link/ipfs/${uri.slice(7)}`;
	return uri;
}

async function fetchCard({ agent, cardUrl, resolver }) {
	if (cardUrl) {
		const r = await fetch(cardUrl, { mode: 'cors' });
		if (!r.ok) throw new Error(`card HTTP ${r.status}`);
		return await r.json();
	}
	if (!agent) throw new Error('no agent ref or card-url provided');
	// The resolver takes the CAIP ref's "/" as a real path separator, so encode
	// each segment and rejoin. A whole-ref encodeURIComponent turns it into
	// "%2F", which the API dispatcher rejects as a smuggled separator (404).
	const ref = String(agent).split('/').map(encodeURIComponent).join('/');
	const url = `${resolver.replace(/\/$/, '')}/api/v1/agents/${ref}`;
	const r = await fetch(url, { mode: 'cors' });
	if (!r.ok) throw new Error(`resolver HTTP ${r.status}`);
	const body = await r.json();
	return body.card || body;
}

async function verify(card) {
	const checks = { model: null, validation: null };
	if (card?.model?.uri && card?.model?.sha256) {
		try {
			const r = await fetch(ipfsToHttp(card.model.uri), { mode: 'cors' });
			if (!r.ok) throw new Error(`model HTTP ${r.status}`);
			const bytes = new Uint8Array(await r.arrayBuffer());
			const hash = await sha256Hex(bytes);
			checks.model = hash.toLowerCase() === card.model.sha256.toLowerCase();
		} catch {
			checks.model = false;
		}
	}
	if (card?.validation?.reportUri) {
		try {
			const r = await fetch(ipfsToHttp(card.validation.reportUri), { mode: 'cors' });
			checks.validation = r.ok;
		} catch {
			checks.validation = false;
		}
	}
	return checks;
}

function statusFor(checks) {
	if (checks.model === false || checks.validation === false) return 'unverified';
	if (checks.model === true && (checks.validation === true || checks.validation === null)) {
		return checks.validation === true ? 'verified' : 'partial';
	}
	return 'partial';
}

const LABELS = {
	loading: 'Verifying…',
	verified: 'three.ws · Verified',
	partial: 'three.ws · Partial',
	unverified: 'three.ws · Unverified',
	error: 'three.ws · Error',
};

class ThreeDAgentBadge extends HTMLElement {
	static get observedAttributes() {
		return ['agent', 'card-url', 'resolver'];
	}
	constructor() {
		super();
		this.attachShadow({ mode: 'open' });
	}
	connectedCallback() {
		this.render('loading');
		this.refresh();
	}
	attributeChangedCallback() {
		if (this.isConnected) this.refresh();
	}
	render(status, detail) {
		this.shadowRoot.innerHTML = `<style>${STYLES}</style>
			<a class="pill ${status}" part="pill" title="${detail || ''}"
				href="${this.detailUrl()}" target="_blank" rel="noopener">
				<span class="dot"></span>${LABELS[status]}
			</a>`;
	}
	detailUrl() {
		const agent = this.getAttribute('agent');
		const resolver = this.getAttribute('resolver') || DEFAULT_RESOLVER;
		return agent ? `${resolver.replace(/\/$/, '')}/agent/${encodeURIComponent(agent)}` : '#';
	}
	async refresh() {
		try {
			const card = await fetchCard({
				agent: this.getAttribute('agent'),
				cardUrl: this.getAttribute('card-url'),
				resolver: this.getAttribute('resolver') || DEFAULT_RESOLVER,
			});
			const checks = await verify(card);
			const status = statusFor(checks);
			const detail = `model=${checks.model} validation=${checks.validation}`;
			this.render(status, detail);
			this.dispatchEvent(
				new CustomEvent('verified', { detail: { status, checks, card }, bubbles: true }),
			);
		} catch (err) {
			this.render('error', String(err.message || err));
		}
	}
}

if (!customElements.get('three-d-agent-badge')) {
	customElements.define('three-d-agent-badge', ThreeDAgentBadge);
}

export { ThreeDAgentBadge };
