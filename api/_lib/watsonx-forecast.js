// IBM watsonx.ai Granite TimeSeries forecasting for the Granite Oracle.
//
// Sits alongside the shared chat/embed client in ./watsonx.js but lives in its
// own module (with model-context helpers the Oracle and its tests depend on). It
// reuses the stable IAM-token cache from ./watsonx.js and speaks the same
// version-stamped, project-scoped REST contract. Governance is handled by the
// canonical Granite Guardian helper in ./granite-guardian.js.
//
// There is no mock path: any IAM or upstream failure throws with the real
// upstream status + message so the caller reports the true cause.

import { watsonxToken } from './watsonx.js';
import { fetchUpstream } from './upstream-fetch.js';

const INFERENCE_TIMEOUT_MS = 45_000;

// Granite TimeSeries (TinyTimeMixer) zero-shot forecasting models, keyed by the
// minimum history (context) length each requires. All forecast 96 steps ahead.
export const FORECAST_MODELS = {
	512: 'ibm/granite-ttm-512-96-r2',
	1024: 'ibm/granite-ttm-1024-96-r2',
	1536: 'ibm/granite-ttm-1536-96-r2',
};

// Pick the largest forecasting model whose context window the history can fill.
export function forecastModelFor(historyLength) {
	if (historyLength >= 1536) return FORECAST_MODELS[1536];
	if (historyLength >= 1024) return FORECAST_MODELS[1024];
	return FORECAST_MODELS[512];
}

// The project/space scoping object every inference body requires.
function scope(cfg) {
	return cfg.projectId ? { project_id: cfg.projectId } : { space_id: cfg.spaceId };
}

// POST a body to a watsonx ml endpoint and return parsed JSON, surfacing the
// real upstream status + message on failure.
async function post(cfg, path, body, version) {
	const token = await watsonxToken(cfg);
	const res = await fetchUpstream(`${cfg.url}${path}?version=${version}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		},
		body: JSON.stringify({ ...body, ...scope(cfg) }),
	}, { name: 'watsonx', timeoutMs: INFERENCE_TIMEOUT_MS, attempts: 1, okWhen: () => true });
	const text = await res.text();
	if (!res.ok) {
		let detail = text.slice(0, 300);
		try {
			const j = JSON.parse(text);
			detail = j.errors?.[0]?.message || j.message || detail;
		} catch {
			// non-JSON error body — keep the raw slice
		}
		throw new Error(`watsonx ${res.status}: ${detail}`);
	}
	return text ? JSON.parse(text) : {};
}

// Granite TimeSeries zero-shot forecast.
//   timestamps: ISO-8601 strings at a uniform cadence (oldest → newest)
//   values:     numeric series, same length, length ≥ the model's context window
//   freq:       pandas-style cadence string ('1h', '15min', '1D', …)
// Returns { model, timestamps: [...future ISO], values: [...forecast], inputWindow }.
export async function watsonxForecast(
	cfg,
	{ model, timestamps, values, freq, targetColumn = 'value', predictionLength } = {},
) {
	if (
		!Array.isArray(timestamps) ||
		!Array.isArray(values) ||
		timestamps.length !== values.length ||
		values.length === 0
	) {
		throw new Error(
			'watsonxForecast: timestamps and values must be equal-length, non-empty arrays',
		);
	}
	const modelId = model || cfg.forecastModel || forecastModelFor(values.length);
	const data = await post(
		cfg,
		'/ml/v1/time_series/forecast',
		{
			model_id: modelId,
			schema: { timestamp_column: 'date', freq, target_columns: [targetColumn] },
			data: { date: timestamps, [targetColumn]: values },
			...(predictionLength ? { parameters: { prediction_length: predictionLength } } : {}),
		},
		cfg.tsApiVersion || '2025-02-11',
	);
	const r = data.results?.[0] || {};
	return {
		model: data.model_id || modelId,
		timestamps: r.date || [],
		values: r[targetColumn] || [],
		inputWindow: values.length,
	};
}
