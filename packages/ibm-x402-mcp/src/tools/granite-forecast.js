// `ibm_granite_forecast` — paid MCP tool: time-series forecasting via IBM Granite TTM.
//
// Price: $0.05 USDC (exact, Solana). Uses IBM Granite Time Series (TTM) for
// zero-shot forecasting of numeric series — revenue, traffic, sensor readings,
// stock prices, energy consumption — without model training.

import { z } from 'zod';
import { paid, toolError } from '../payments.js';
import { jsonSchemaFromZod, generativeAnnotations } from './_shared.js';
import { WatsonxError } from '../watsonx.js';

const TOOL_NAME = 'ibm_granite_forecast';
const TOOL_DESCRIPTION =
	'Zero-shot time-series forecasting via IBM Granite TTM (Tiny Time Mixer). ' +
	'Provide a numeric series with ISO-8601 timestamps and a cadence, receive the forecast horizon. ' +
	'No training required. Suitable for revenue, traffic, sensor, energy, and financial series. ' +
	'No IBM Cloud account required — pay $0.05 USDC per call via x402.';

const FREQ_EXAMPLES = '1min, 5min, 15min, 30min, 1h, 2h, 4h, 12h, 1D, 1W, 1ME';

const inputZodShape = {
	timestamps: z
		.array(z.string().min(1))
		.min(64)
		.max(1024)
		.describe(
			'ISO-8601 timestamps at a uniform cadence, oldest to newest (e.g. ["2025-01-01T00:00:00Z", ...]).',
		),
	values: z
		.array(z.number())
		.min(64)
		.max(1024)
		.describe(
			'Numeric series aligned to timestamps, oldest to newest. Must be the same length as timestamps.',
		),
	freq: z
		.string()
		.min(1)
		.describe(
			`Cadence of the series as a pandas-style frequency string. Examples: ${FREQ_EXAMPLES}.`,
		),
	prediction_length: z
		.number()
		.int()
		.min(1)
		.max(96)
		.optional()
		.describe(
			'Number of steps to forecast ahead. Defaults to the model horizon (typically 96 for 1h data).',
		),
	label: z
		.string()
		.max(64)
		.optional()
		.describe('Human label for the series (e.g. "daily_revenue_usd"). Returned in output for traceability.'),
};

const inputJsonSchema = jsonSchemaFromZod(inputZodShape);

// The published example has to satisfy the input schema, because it is what the
// x402 discovery payload hands facilitators and agents to copy: a shorter stub
// reads as runnable and comes straight back as a validation error. The schema
// floor is 64 points, so the example is a real 64-day daily series with a
// weekly ripple and a mild uptrend. Kept identical to the hosted transport in
// api/_mcpibm/tools.js.
const FORECAST_EXAMPLE_POINTS = 64;

function forecastExampleSeries() {
	const timestamps = [];
	const values = [];
	const start = Date.UTC(2025, 0, 1);
	for (let i = 0; i < FORECAST_EXAMPLE_POINTS; i++) {
		timestamps.push(new Date(start + i * 86_400_000).toISOString());
		const weekly = 90 * Math.sin((2 * Math.PI * i) / 7);
		values.push(Math.round(1200 + i * 6 + weekly));
	}
	return { timestamps, values };
}

const FORECAST_EXAMPLE = forecastExampleSeries();

export async function buildGraniteForecastTool(client) {
	const handler = await paid(
		{
			toolName: TOOL_NAME,
			description: TOOL_DESCRIPTION,
			priceUsd: '$0.05',
			inputSchema: inputJsonSchema,
			example: {
				timestamps: FORECAST_EXAMPLE.timestamps,
				values: FORECAST_EXAMPLE.values,
				freq: '1D',
				prediction_length: 7,
				label: 'daily_revenue_usd',
			},
			outputExample: {
				ok: true,
				label: 'daily_revenue_usd',
				model: 'ibm/granite-ttm-512-96-r2',
				inputWindow: 512,
				forecastSteps: 7,
				forecast: [
					{ timestamp: '2025-06-07T00:00:00Z', value: 1420 },
					{ timestamp: '2025-06-08T00:00:00Z', value: 1388 },
				],
			},
		},
		async ({ timestamps, values, freq, prediction_length, label }) => {
			if (timestamps.length !== values.length) {
				return toolError(
					'invalid_input',
					`timestamps and values must have equal length (got ${timestamps.length} timestamps, ${values.length} values).`,
				);
			}
			try {
				const result = await client.forecast({
					timestamps,
					values,
					freq,
					predictionLength: prediction_length,
				});

				const forecast = result.timestamps.map((ts, i) => ({
					timestamp: ts,
					value: result.values[i] ?? null,
				}));

				return {
					ok: true,
					...(label ? { label } : {}),
					model: result.model,
					inputWindow: result.inputWindow,
					forecastSteps: forecast.length,
					forecast,
				};
			} catch (err) {
				if (err instanceof WatsonxError) {
					return toolError('watsonx_error', err.message, { status: err.status });
				}
				return toolError('internal_error', err.message);
			}
		},
	);

	return {
		name: TOOL_NAME,
		title: 'IBM Granite Forecast ($0.05)',
		description: TOOL_DESCRIPTION,
		annotations: generativeAnnotations,
		inputSchema: inputZodShape,
		handler,
	};
}
