// IBM watsonx.ai REST client.
//
// A small, dependency-free wrapper over the watsonx.ai as-a-Service REST API.
// It owns the two things every call needs: a fresh IAM bearer token (minted
// from an IBM Cloud API key and cached until just before expiry) and the
// project/space scoping that watsonx requires on every inference request.
//
// Every method hits a real IBM endpoint. There is no mock or sample path — a
// missing credential or an upstream failure surfaces as a thrown WatsonxError
// so the MCP layer can report the true cause to the caller.

const IAM_TOKEN_URL = 'https://iam.cloud.ibm.com/identity/token';

// Refresh the IAM token this many ms before its stated expiry, so an in-flight
// request never races the hard expiry boundary.
const TOKEN_SKEW_MS = 5 * 60 * 1000;

export class WatsonxError extends Error {
	constructor(message, { status, detail } = {}) {
		super(message);
		this.name = 'WatsonxError';
		this.status = status;
		this.detail = detail;
	}
}

// Read and validate configuration from the environment exactly once. Throws a
// WatsonxError with an actionable message if a required credential is absent,
// so the server fails loudly at startup rather than on the first tool call.
export function loadConfig(env = process.env) {
	const apiKey = env.WATSONX_API_KEY?.trim();
	if (!apiKey) {
		throw new WatsonxError(
			'WATSONX_API_KEY is not set. Create an IBM Cloud API key at ' +
				'https://cloud.ibm.com/iam/apikeys and export it as WATSONX_API_KEY.',
		);
	}

	const projectId = env.WATSONX_PROJECT_ID?.trim();
	const spaceId = env.WATSONX_SPACE_ID?.trim();
	if (!projectId && !spaceId) {
		throw new WatsonxError(
			'Set WATSONX_PROJECT_ID (or WATSONX_SPACE_ID). Find your project id under ' +
				'the watsonx.ai project → Manage → General → Project ID.',
		);
	}

	return {
		apiKey,
		projectId,
		spaceId,
		// Region inference host. us-south is the default deployment region.
		url: (env.WATSONX_URL?.trim() || 'https://us-south.ml.cloud.ibm.com').replace(/\/$/, ''),
		iamUrl: env.WATSONX_IAM_URL?.trim() || IAM_TOKEN_URL,
		apiVersion: env.WATSONX_API_VERSION?.trim() || '2024-05-31',
		chatModel: env.WATSONX_MODEL_ID?.trim() || 'ibm/granite-3-8b-instruct',
		embedModel: env.WATSONX_EMBED_MODEL_ID?.trim() || 'ibm/granite-embedding-278m-multilingual',
		timeoutMs: Number(env.WATSONX_TIMEOUT_MS) || 60_000,
	};
}

export class WatsonxClient {
	constructor(config) {
		this.config = config;
		// Cached IAM token: { token, expiresAt } where expiresAt is epoch ms.
		this._token = null;
		// In-flight token request, so concurrent calls share one IAM round-trip.
		this._tokenPromise = null;
	}

	// Return the project/space scoping object that every inference body needs.
	_scope() {
		return this.config.projectId
			? { project_id: this.config.projectId }
			: { space_id: this.config.spaceId };
	}

	// Mint (or reuse) an IAM bearer token. The IBM Cloud IAM service exchanges a
	// long-lived API key for a ~1h bearer token; we cache it and refresh a few
	// minutes early. Concurrent callers coalesce onto a single in-flight request.
	async _getToken() {
		const now = Date.now();
		if (this._token && this._token.expiresAt - TOKEN_SKEW_MS > now) {
			return this._token.token;
		}
		if (this._tokenPromise) return this._tokenPromise;

		this._tokenPromise = (async () => {
			const body = new URLSearchParams({
				grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
				apikey: this.config.apiKey,
			});
			const res = await this._fetch(this.config.iamUrl, {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					accept: 'application/json',
				},
				body,
			});
			const data = await this._json(res);
			if (!res.ok || !data.access_token) {
				throw new WatsonxError('IAM authentication failed — check WATSONX_API_KEY.', {
					status: res.status,
					detail: data.errorMessage || data.errorCode || data,
				});
			}
			const expiresAt = now + (Number(data.expires_in) || 3600) * 1000;
			this._token = { token: data.access_token, expiresAt };
			return this._token.token;
		})();

		try {
			return await this._tokenPromise;
		} finally {
			this._tokenPromise = null;
		}
	}

	// fetch with an AbortController-backed timeout. Network/timeout failures
	// become WatsonxError so callers never see a bare undefined.
	async _fetch(url, init) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
		try {
			return await fetch(url, { ...init, signal: controller.signal });
		} catch (err) {
			if (err.name === 'AbortError') {
				throw new WatsonxError(`Request to ${url} timed out after ${this.config.timeoutMs}ms.`);
			}
			throw new WatsonxError(`Network error calling ${url}: ${err.message}`);
		} finally {
			clearTimeout(timer);
		}
	}

	async _json(res) {
		const text = await res.text();
		if (!text) return {};
		try {
			return JSON.parse(text);
		} catch {
			return { _raw: text };
		}
	}

	// Authenticated POST to a watsonx ml endpoint. Adds the version query param,
	// bearer token, and scoping; raises a WatsonxError carrying the upstream
	// status and IBM error payload on any non-2xx response.
	async _post(path, payload) {
		const token = await this._getToken();
		const url = `${this.config.url}${path}?version=${this.config.apiVersion}`;
		const res = await this._fetch(url, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
				accept: 'application/json',
			},
			body: JSON.stringify({ ...payload, ...this._scope() }),
		});
		const data = await this._json(res);
		if (!res.ok) throw this._upstreamError(res.status, data);
		return data;
	}

	async _get(path, params = {}) {
		const token = await this._getToken();
		const query = new URLSearchParams({ version: this.config.apiVersion, ...params });
		const res = await this._fetch(`${this.config.url}${path}?${query}`, {
			method: 'GET',
			headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
		});
		const data = await this._json(res);
		if (!res.ok) throw this._upstreamError(res.status, data);
		return data;
	}

	_upstreamError(status, data) {
		const first = Array.isArray(data?.errors) ? data.errors[0] : null;
		const message = first?.message || data?.message || data?._raw || 'watsonx.ai request failed';
		return new WatsonxError(`watsonx.ai error (${status}): ${message}`, {
			status,
			detail: first?.code || data?.trace || undefined,
		});
	}

	// --- Inference surface ---------------------------------------------------

	// Chat completion. messages is an array of { role, content }. Returns the
	// assistant text plus token usage and the model that served the request.
	async chat(messages, { model, parameters } = {}) {
		const data = await this._post('/ml/v1/text/chat', {
			model_id: model || this.config.chatModel,
			messages,
			...(parameters ? { parameters } : {}),
		});
		const choice = data.choices?.[0];
		return {
			text: choice?.message?.content ?? '',
			finishReason: choice?.finish_reason,
			usage: data.usage,
			model: data.model_id || model || this.config.chatModel,
		};
	}

	// Raw text generation (prompt in, completion out) for non-chat models and
	// fine-grained decoding control (greedy/sampling, stop sequences, etc.).
	async generate(input, { model, parameters } = {}) {
		const data = await this._post('/ml/v1/text/generation', {
			model_id: model || this.config.chatModel,
			input,
			...(parameters ? { parameters } : {}),
		});
		const result = data.results?.[0];
		return {
			text: result?.generated_text ?? '',
			generatedTokenCount: result?.generated_token_count,
			inputTokenCount: result?.input_token_count,
			stopReason: result?.stop_reason,
			model: model || this.config.chatModel,
		};
	}

	// Embeddings for one or more input strings. Returns a vector per input.
	async embed(inputs, { model } = {}) {
		const data = await this._post('/ml/v1/text/embeddings', {
			model_id: model || this.config.embedModel,
			inputs,
		});
		return {
			model: model || this.config.embedModel,
			vectors: (data.results || []).map((r) => r.embedding),
			inputCount: inputs.length,
			dimensions: data.results?.[0]?.embedding?.length ?? 0,
		};
	}

	// Tokenize an input against a model's tokenizer — useful for cost/context
	// budgeting before a generation call.
	async tokenize(input, { model, returnTokens = false } = {}) {
		const data = await this._post('/ml/v1/text/tokenization', {
			model_id: model || this.config.chatModel,
			input,
			parameters: { return_tokens: returnTokens },
		});
		return {
			model: model || this.config.chatModel,
			tokenCount: data.result?.token_count ?? 0,
			tokens: data.result?.tokens,
		};
	}

	// List the foundation models available to this account/region. Optionally
	// filter by supported function (e.g. text_generation, embedding).
	async listModels({ filter, limit = 100 } = {}) {
		const params = { limit: String(Math.min(limit, 200)) };
		if (filter) params.filters = filter;
		const data = await this._get('/ml/v1/foundation_model_specs', params);
		return (data.resources || []).map((m) => ({
			model_id: m.model_id,
			label: m.label,
			provider: m.provider,
			functions: (m.functions || []).map((f) => f.id),
			short_description: m.short_description,
		}));
	}
}
