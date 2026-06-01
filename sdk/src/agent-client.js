/**
 * AgentClient — programmatic x402 payment support for invoking priced agent skills.
 *
 * The three.ws x402 flow is intent-based and matches the live API
 * (`api/agents/x402/[action].js` + `api/_lib/x402.js`):
 *
 *   1. `POST /api/agents/x402/invoke` with `{ agent_id, skill, args }`. When the
 *      skill is priced and the request is unpaid, the server answers **402**
 *      with a payment manifest body (recipient, amount, currency, `intent_url`,
 *      `verify_url`, `retry_with_header`).
 *   2. The caller settles that manifest's payment intent on-chain — preparing it
 *      at the manifest's `intent_url` and confirming at `verify_url` — and
 *      obtains a paid intent id.
 *   3. Retry the same POST with header `x-payment-intent: <intentId>`; the server
 *      verifies the intent and answers **200** with the skill result.
 *
 * Free / unpriced skills are intentionally NOT served by the x402 endpoint (it
 * answers 409 `no_payments`); call those through the regular agent skill API.
 */

/**
 * @typedef {object} X402Manifest
 * @property {string|number} version
 * @property {'agent-skill'} kind
 * @property {string} agent_id
 * @property {string} skill
 * @property {string} amount
 * @property {string} currency
 * @property {string} recipient
 * @property {string} [recipient_name]
 * @property {number} valid_until
 * @property {string} intent_url
 * @property {string} verify_url
 * @property {string} retry_with_header
 */

export class PaymentRequiredError extends Error {
	/** @param {X402Manifest} manifest */
	constructor(manifest) {
		super(
			`Skill "${manifest?.skill}" requires payment: ${manifest?.amount} ${manifest?.currency}`,
		);
		this.name = 'PaymentRequiredError';
		/** @type {X402Manifest} */
		this.manifest = manifest;
	}
}

export class AgentClient {
	/**
	 * @param {object} [opts]
	 * @param {string} [opts.baseUrl]  Base URL of the three.ws API (e.g. `https://three.ws`). Defaults to same-origin.
	 * @param {string} [opts.apiKey]   Bearer token with `avatars:read` (or a session) — required to invoke (the endpoint is auth-gated).
	 * @param {typeof fetch} [opts.fetch]  Custom fetch (for SSR / tests). Defaults to the global `fetch`.
	 */
	constructor({ baseUrl = '', apiKey = '', fetch: fetchImpl } = {}) {
		this.baseUrl = baseUrl.replace(/\/$/, '');
		this.apiKey = apiKey;
		this._fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
		if (!this._fetch) {
			throw new Error(
				'AgentClient: no fetch implementation available — pass { fetch } in non-browser runtimes',
			);
		}
	}

	/** @param {Record<string,string>} [extra] */
	_headers(extra) {
		const h = { 'content-type': 'application/json', ...extra };
		if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
		return h;
	}

	/**
	 * List prices for every priced skill on an agent.
	 * `GET /api/agents/:id/pricing` → `{ prices: SkillPrice[] }`.
	 *
	 * @param {string} agentId
	 * @returns {Promise<Array<{skill:string, amount:string, currency_mint?:string, chain?:string}>>}
	 */
	async getSkillPrices(agentId) {
		const res = await this._fetch(
			`${this.baseUrl}/api/agents/${encodeURIComponent(agentId)}/pricing`,
		);
		if (!res.ok) throw new Error(`getSkillPrices failed: ${res.status} ${res.statusText}`);
		const body = await res.json();
		// The endpoint wraps the list as `{ prices }`; tolerate a bare array too.
		return Array.isArray(body) ? body : body?.prices || [];
	}

	/**
	 * Fetch the x402 payment manifest for a single skill (discovery / prefetch).
	 * `GET /api/agents/x402/manifest?agent_id=&skill=`.
	 *
	 * @param {string} agentId
	 * @param {string} skill
	 * @returns {Promise<X402Manifest | null>}  `null` when the skill is free/unpriced (409).
	 */
	async getManifest(agentId, skill) {
		const url =
			`${this.baseUrl}/api/agents/x402/manifest` +
			`?agent_id=${encodeURIComponent(agentId)}&skill=${encodeURIComponent(skill)}`;
		const res = await this._fetch(url);
		if (res.status === 409) return null; // not priced → free skill
		if (!res.ok) throw new Error(`getManifest failed: ${res.status} ${res.statusText}`);
		return res.json();
	}

	/**
	 * Invoke a priced skill, settling x402 payment automatically when required.
	 *
	 * Pass a `payIntent` callback (or `signer.payIntent`) that, given the 402
	 * manifest, settles the payment on-chain and resolves to the paid intent id
	 * (either `{ intentId }` or the id string). Omit it to surface a
	 * {@link PaymentRequiredError} carrying the manifest so the caller can pay.
	 *
	 * @param {string} agentId
	 * @param {string} skill
	 * @param {Record<string, unknown>} [args]
	 * @param {{ signer?: { payIntent: (m: X402Manifest) => Promise<{intentId:string}|string> },
	 *           payIntent?: (m: X402Manifest) => Promise<{intentId:string}|string> }} [options]
	 * @returns {Promise<unknown>}  The skill result payload.
	 */
	async invokeSkill(agentId, skill, args = {}, options = {}) {
		const first = await this._invoke(agentId, skill, args, null);

		if (first.status === 402) {
			const manifest = await first.json();
			const payFn =
				options.payIntent ||
				(options.signer && typeof options.signer.payIntent === 'function'
					? (m) => options.signer.payIntent(m)
					: null);
			if (!payFn) throw new PaymentRequiredError(manifest);

			const settled = await payFn(manifest);
			const intentId = typeof settled === 'string' ? settled : settled?.intentId;
			if (!intentId)
				throw new Error(
					'payIntent must resolve to a paid intent id (string or { intentId })',
				);

			const paid = await this._invoke(agentId, skill, args, intentId);
			return this._json(paid, 'invokeSkill');
		}

		if (first.status === 409) {
			throw new Error(
				`Skill "${skill}" is not a paid skill on agent ${agentId} — call it through the standard skill API instead.`,
			);
		}
		return this._json(first, 'invokeSkill');
	}

	/**
	 * @param {string} agentId
	 * @param {string} skill
	 * @param {Record<string, unknown>} args
	 * @param {string | null} intentId
	 */
	_invoke(agentId, skill, args, intentId) {
		const headers = this._headers(intentId ? { 'x-payment-intent': intentId } : undefined);
		return this._fetch(`${this.baseUrl}/api/agents/x402/invoke`, {
			method: 'POST',
			headers,
			body: JSON.stringify({ agent_id: agentId, skill, args }),
		});
	}

	/**
	 * @param {{ ok: boolean, status: number, statusText: string, json: () => Promise<any> }} res
	 * @param {string} label
	 */
	async _json(res, label) {
		if (!res.ok) {
			let detail = '';
			try {
				detail = (await res.json())?.error || '';
			} catch {
				/* non-JSON error body */
			}
			throw new Error(
				`${label} failed: ${res.status} ${res.statusText}${detail ? ` (${detail})` : ''}`,
			);
		}
		return res.json();
	}
}
