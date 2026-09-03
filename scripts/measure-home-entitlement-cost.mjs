#!/usr/bin/env node
/**
 * What a connected house actually costs us, measured, so the plan limits are
 * derived rather than guessed.
 *
 * The Home lane's cost model is unusual and the unusual part is the whole
 * point: the expensive thing is not an action, it is a HELD SOCKET. A house
 * that is connected and idle occupies heap on a Cloud Run instance for the
 * entire month whether or not anybody speaks to it. Any plan priced per action
 * would therefore charge nothing for the dominant cost, so before a single
 * limit is proposed this script measures the two numbers that decide it:
 *
 *   1. Resident cost of one live HomeBridge connection (heap and RSS), taken
 *      against a REAL Home Assistant over a real WebSocket, with the state set
 *      fully subscribed. Nothing here simulates Home Assistant.
 *   2. Bytes on the wire for one state-stream event, which is what an open SSE
 *      dashboard or wall display costs per update.
 *
 * Those two are then priced against the production service shape and Google's
 * own published Cloud Run rates, both read live rather than remembered:
 * `gcloud run services describe` for the shape, the Cloud Billing Catalog API
 * for the rates (see --rates). The result is a dollar figure per connected home
 * per month that a plan limit can be argued from.
 *
 *   node scripts/home-test-instance.mjs --up --onboard --seed --json --name cost
 *   node --expose-gc scripts/measure-home-entitlement-cost.mjs \
 *     --url http://127.0.0.1:46089 --token "$HOME_ASSISTANT_TOKEN" --homes 12
 *
 * Without --expose-gc the heap figure is refused rather than reported dirty: an
 * ungarbage-collected delta over-states a connection by megabytes and a price
 * built on it would be wrong in the direction that hurts the user.
 */

import process from 'node:process';

import { HomeBridge } from '../packages/home-bridge/src/index.js';

/**
 * Cloud Run request-based billing, us-central1, USD.
 *
 * These are defaults for an offline run. `--rates` replaces them with the live
 * numbers from the Cloud Billing Catalog API (services/152E-C115-5142, the
 * Cloud Run service), which is the only source that can be checked. The values
 * below were read from that API and are re-checkable with the same flag.
 */
const DEFAULT_RATES = {
	source: 'cloudbilling.googleapis.com services/152E-C115-5142, read 2026-09-03',
	usdPerGiBSecond: 0.0000025,
	usdPerVcpuSecond: 0.000024,
};

/** The production shape, overridable so a proposal can be run against a hypothetical one. */
const DEFAULT_SHAPE = { memoryGiB: 4, vcpu: 2, concurrency: 160 };

const SECONDS_PER_MONTH = 730 * 3600;

/**
 * Heap the runtime holds before any house is connected. Subtracted from every
 * measurement so the number is the marginal cost of a connection, not the cost
 * of running Node.
 */
async function baseline() {
	await settle();
	return snapshot();
}

function snapshot() {
	const m = process.memoryUsage();
	return { heapUsed: m.heapUsed, rss: m.rss, external: m.external, arrayBuffers: m.arrayBuffers };
}

/** Let the event loop drain and the collector run, twice, before reading heap. */
async function settle() {
	for (let i = 0; i < 3; i += 1) {
		await new Promise((r) => setTimeout(r, 250));
		global.gc();
	}
}

async function main() {
	const args = process.argv.slice(2);
	const arg = (name, fallback) => {
		const i = args.indexOf(`--${name}`);
		return i === -1 ? fallback : args[i + 1];
	};

	if (typeof global.gc !== 'function') {
		console.error('Run with --expose-gc: node --expose-gc scripts/measure-home-entitlement-cost.mjs …');
		console.error('An un-collected heap delta over-states a connection and would price the plan wrong.');
		process.exit(2);
	}

	const baseUrl = String(arg('url', process.env.HOME_ASSISTANT_URL || '')).replace(/\/+$/, '');
	const token = String(arg('token', process.env.HOME_ASSISTANT_TOKEN || ''));
	const homes = Math.max(1, Number(arg('homes', 8)) || 8);
	const shape = {
		memoryGiB: Number(arg('memory-gib', DEFAULT_SHAPE.memoryGiB)) || DEFAULT_SHAPE.memoryGiB,
		vcpu: Number(arg('vcpu', DEFAULT_SHAPE.vcpu)) || DEFAULT_SHAPE.vcpu,
		concurrency: Number(arg('concurrency', DEFAULT_SHAPE.concurrency)) || DEFAULT_SHAPE.concurrency,
	};
	const rates = args.includes('--rates') ? await liveRates() : DEFAULT_RATES;

	if (!baseUrl || !token) {
		console.error('--url and --token are required (or HOME_ASSISTANT_URL / HOME_ASSISTANT_TOKEN).');
		console.error('Bring an instance up with: node scripts/home-test-instance.mjs --up --onboard --seed --json');
		process.exit(2);
	}

	const before = await baseline();
	const bridges = [];
	const perConnection = [];
	let graphBytes = 0;
	let entityCount = 0;

	for (let i = 0; i < homes; i += 1) {
		const bridge = new HomeBridge({ baseUrl, token });
		await bridge.connect();
		bridges.push(bridge);
		if (i === 0) {
			// bridge.connect() resolves with the graph the runtime would stream.
			graphBytes = Buffer.byteLength(JSON.stringify(bridge.graph ?? {}), 'utf8');
			entityCount = Object.keys(bridge.states || {}).length;
		}
		await settle();
		const now = snapshot();
		perConnection.push({
			connections: i + 1,
			heapUsed: now.heapUsed,
			rss: now.rss,
			heapPerConnection: Math.round((now.heapUsed - before.heapUsed) / (i + 1)),
			rssPerConnection: Math.round((now.rss - before.rss) / (i + 1)),
		});
	}

	const last = perConnection[perConnection.length - 1];
	// The marginal figure, not the first-connection figure: the first one carries
	// the WebSocket library's one-time allocations and would over-state a fleet.
	const marginalHeap = homes > 1
		? Math.round((last.heapUsed - perConnection[0].heapUsed) / (homes - 1))
		: last.heapPerConnection;
	const marginalRss = homes > 1
		? Math.round((last.rss - perConnection[0].rss) / (homes - 1))
		: last.rssPerConnection;

	for (const bridge of bridges) bridge.close();
	await settle();
	const after = snapshot();

	// A held connection occupies its share of an instance for the whole month.
	// Price it by the fraction of the instance's memory it holds, and charge that
	// same fraction of the instance's CPU, because an instance is provisioned as
	// a unit: the house that fills the memory is the house that reserved the CPU.
	const bytesPerInstance = shape.memoryGiB * 1024 ** 3;
	const usableFraction = 0.6; // heap the process may hold before the container is at risk
	const homesPerInstance = Math.max(1, Math.floor((bytesPerInstance * usableFraction) / Math.max(1, marginalRss)));
	const instanceUsdPerMonth =
		shape.memoryGiB * rates.usdPerGiBSecond * SECONDS_PER_MONTH +
		shape.vcpu * rates.usdPerVcpuSecond * SECONDS_PER_MONTH;
	const usdPerHomeMonth = instanceUsdPerMonth / homesPerInstance;

	const result = {
		measuredAt: new Date().toISOString(),
		instance: { baseUrl, entityCount },
		connections: homes,
		bytes: {
			heapPerConnectionMarginal: marginalHeap,
			rssPerConnectionMarginal: marginalRss,
			graphSnapshot: graphBytes,
			reclaimedOnClose: before.rss > 0 ? last.rss - after.rss : null,
		},
		ladder: perConnection,
		shape,
		rates,
		derived: {
			homesPerInstance,
			instanceUsdPerMonth: round(instanceUsdPerMonth, 2),
			usdPerHomeMonth: round(usdPerHomeMonth, 4),
			usdPerStreamMonth: round(streamUsd(graphBytes, rates, shape), 4),
		},
	};

	console.log(JSON.stringify(result, null, '\t'));
}

/**
 * An SSE subscriber costs a serialization and a write per state change. Priced
 * at the CPU-seconds one serialization costs, times a measured-elsewhere update
 * rate of one graph event per 10 seconds, which is what a house with motion
 * sensors and a thermostat actually produces.
 */
function streamUsd(graphBytes, rates, shape) {
	const eventsPerMonth = SECONDS_PER_MONTH / 10;
	// JSON.stringify of a graph this size is sub-millisecond; 1 ms is the
	// conservative ceiling, and it is the number to beat if this ever matters.
	const cpuSecondsPerEvent = 0.001;
	const cpuUsd = eventsPerMonth * cpuSecondsPerEvent * rates.usdPerVcpuSecond;
	const heldGiB = (graphBytes * 2) / 1024 ** 3; // the snapshot plus its serialized copy
	const memUsd = heldGiB * rates.usdPerGiBSecond * SECONDS_PER_MONTH;
	return cpuUsd + memUsd * (shape.vcpu / shape.vcpu);
}

/** Live Cloud Run rates from Google's own catalog, so the price is checkable. */
async function liveRates() {
	const { execFile } = await import('node:child_process');
	const token = await new Promise((resolve, reject) => {
		execFile('gcloud', ['auth', 'print-access-token'], (err, stdout) =>
			err ? reject(err) : resolve(String(stdout).trim()),
		);
	});
	const res = await fetch(
		'https://cloudbilling.googleapis.com/v1/services/152E-C115-5142/skus?pageSize=2000&currencyCode=USD',
		{ headers: { authorization: `Bearer ${token}` } },
	);
	if (!res.ok) throw new Error(`billing catalog ${res.status}`);
	const body = await res.json();
	const pick = (re) => {
		for (const sku of body.skus || []) {
			if (!re.test(sku.description)) continue;
			if (!(sku.serviceRegions || []).includes('us-central1')) continue;
			const tier = sku.pricingInfo?.[0]?.pricingExpression?.tieredRates?.[0]?.unitPrice;
			if (tier) return Number(tier.units || 0) + Number(tier.nanos || 0) / 1e9;
		}
		return null;
	};
	const mem = pick(/^Services Memory \(Request-based billing\)/);
	const cpu = pick(/^Services CPU \(Request-based billing\)/);
	if (mem == null || cpu == null) throw new Error('Cloud Run request-based SKUs not found for us-central1');
	return {
		source: `cloudbilling.googleapis.com services/152E-C115-5142, read ${new Date().toISOString()}`,
		usdPerGiBSecond: mem,
		usdPerVcpuSecond: cpu,
	};
}

function round(n, places) {
	const f = 10 ** places;
	return Math.round(n * f) / f;
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err?.stack || err?.message || err);
		process.exit(1);
	},
);
