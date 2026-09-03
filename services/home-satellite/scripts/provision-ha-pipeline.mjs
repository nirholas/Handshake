#!/usr/bin/env node
/**
 * Point a Home Assistant instance at a local voice stack and this satellite, so
 * an end-to-end run can be proved against real software instead of described.
 *
 * It adds four Wyoming services through Home Assistant's own config-flow API
 * (speech to text, text to speech, wake word, and this satellite), builds an
 * Assist pipeline out of them, makes it the preferred one, and points the
 * satellite's pipeline selector at it.
 *
 * Everything it talks to is real: Home Assistant, rhasspy's whisper, piper and
 * openWakeWord containers, and the satellite in this directory. Nothing here is
 * a fixture.
 *
 *   docker network create wyoming
 *   docker run -d --name whisper --network wyoming rhasspy/wyoming-whisper:latest \
 *     --model tiny-int8 --language en --uri tcp://0.0.0.0:10300 --data-dir /data --download-dir /data
 *   docker run -d --name piper --network wyoming rhasspy/wyoming-piper:latest \
 *     --voice en_US-lessac-low --uri tcp://0.0.0.0:10200 --data-dir /data --download-dir /data
 *   docker run -d --name openwakeword --network wyoming rhasspy/wyoming-openwakeword:latest \
 *     --preload-model ok_nabu --uri tcp://0.0.0.0:10400
 *   docker run -d --name ha --network wyoming -p 8123:8123 \
 *     --add-host=host.docker.internal:host-gateway ghcr.io/home-assistant/home-assistant:stable
 *
 *   node scripts/provision-ha-pipeline.mjs \
 *     --url http://localhost:8123 --token <long-lived token> \
 *     --satellite host.docker.internal:10700 \
 *     --stt whisper:10300 --tts piper:10200 --wake openwakeword:10400
 */

import { WebSocket } from 'ws';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const HA = String(arg('url', process.env.HOME_ASSISTANT_URL || 'http://localhost:8123')).replace(/\/+$/, '');
const TOKEN = arg('token', process.env.HOME_ASSISTANT_TOKEN || '');
const SERVICES = {
	stt: arg('stt', 'whisper:10300'),
	tts: arg('tts', 'piper:10200'),
	wake: arg('wake', 'openwakeword:10400'),
	satellite: arg('satellite', 'host.docker.internal:10700'),
};
const PIPELINE_NAME = arg('pipeline-name', 'three.ws satellite');

if (!TOKEN) {
	console.error('a long-lived access token is required: --token <token>, or HOME_ASSISTANT_TOKEN');
	process.exit(2);
}

const log = (...a) => console.error('[provision]', ...a);

async function rest(path, { method = 'GET', body } = {}) {
	const res = await fetch(`${HA}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${TOKEN}`,
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* a non-JSON body is reported as text below */
	}
	if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
	return json;
}

/** Add one Wyoming service through the config flow, or report it already there. */
async function addWyoming(hostPort) {
	const [host, portRaw] = hostPort.split(':');
	const port = Number(portRaw);
	const flow = await rest('/api/config/config_entries/flow', {
		method: 'POST',
		body: { handler: 'wyoming', show_advanced_options: false },
	});
	const result = await rest(`/api/config/config_entries/flow/${flow.flow_id}`, {
		method: 'POST',
		body: { host, port },
	});
	if (result.type === 'create_entry') return { added: true, title: result.title, entryId: result.result?.entry_id };
	if (result.type === 'abort') return { added: false, reason: result.reason };
	throw new Error(`unexpected flow result for ${hostPort}: ${JSON.stringify(result).slice(0, 300)}`);
}

/** One authenticated WebSocket to Home Assistant, with request/response ids. */
async function connectWs() {
	const url = `${HA.replace(/^http/, 'ws')}/api/websocket`;
	const socket = new WebSocket(url);
	let id = 1;
	const pending = new Map();

	await new Promise((resolve, reject) => {
		socket.on('error', reject);
		socket.on('message', (raw) => {
			const message = JSON.parse(raw.toString('utf8'));
			if (message.type === 'auth_required') {
				socket.send(JSON.stringify({ type: 'auth', access_token: TOKEN }));
				return;
			}
			if (message.type === 'auth_ok') {
				resolve();
				return;
			}
			if (message.type === 'auth_invalid') {
				reject(new Error('the access token was refused'));
				return;
			}
			const waiter = pending.get(message.id);
			if (!waiter) return;
			pending.delete(message.id);
			if (message.success === false) waiter.reject(new Error(JSON.stringify(message.error)));
			else waiter.resolve(message.result);
		});
	});

	return {
		call: (payload) => new Promise((resolve, reject) => {
			const messageId = id++;
			pending.set(messageId, { resolve, reject });
			socket.send(JSON.stringify({ ...payload, id: messageId }));
		}),
		close: () => socket.close(),
	};
}

const main = async () => {
	for (const [role, hostPort] of Object.entries(SERVICES)) {
		const result = await addWyoming(hostPort);
		log(`${role} ${hostPort}: ${result.added ? `added as "${result.title}"` : `already configured (${result.reason})`}`);
	}

	const ws = await connectWs();
	try {
		const states = await ws.call({ type: 'get_states' });
		const pick = (domain, hint) => {
			const match = states.find((s) => s.entity_id.startsWith(`${domain}.`) && s.entity_id.includes(hint));
			return match?.entity_id || states.find((s) => s.entity_id.startsWith(`${domain}.`))?.entity_id || null;
		};

		const sttEntity = pick('stt', 'whisper');
		const ttsEntity = pick('tts', 'piper');
		const wakeEntity = states.find((s) => s.entity_id.startsWith('wake_word.'))?.entity_id || null;
		const satelliteEntity = states.find((s) => s.entity_id.startsWith('assist_satellite.'))?.entity_id || null;
		log(`stt=${sttEntity} tts=${ttsEntity} wake=${wakeEntity} satellite=${satelliteEntity}`);
		if (!sttEntity || !ttsEntity) throw new Error('speech to text or text to speech did not appear; check those two containers');

		const pipelines = await ws.call({ type: 'assist_pipeline/pipeline/list' });
		const existing = (pipelines.pipelines || []).find((p) => p.name === PIPELINE_NAME);
		const spec = {
			name: PIPELINE_NAME,
			language: 'en',
			conversation_engine: 'conversation.home_assistant',
			conversation_language: 'en',
			stt_engine: sttEntity,
			stt_language: 'en',
			tts_engine: ttsEntity,
			tts_language: 'en-us',
			tts_voice: null,
			wake_word_entity: wakeEntity,
			wake_word_id: wakeEntity ? 'ok_nabu_v0.1' : null,
		};
		const pipeline = existing
			? await ws.call({ type: 'assist_pipeline/pipeline/update', pipeline_id: existing.id, ...spec })
			: await ws.call({ type: 'assist_pipeline/pipeline/create', ...spec });
		const pipelineId = pipeline?.id || existing?.id;
		await ws.call({ type: 'assist_pipeline/pipeline/set_preferred', pipeline_id: pipelineId });
		log(`pipeline "${PIPELINE_NAME}" ${existing ? 'updated' : 'created'} (${pipelineId}) and set as preferred`);

		// Point the satellite's own pipeline selector at it. Its default is
		// "preferred", which is now this pipeline, but setting it explicitly means
		// the run does not silently depend on what happens to be preferred later.
		const selects = states.filter((s) => s.entity_id.startsWith('select.') && s.attributes?.options?.includes('preferred'));
		for (const select of selects) {
			await ws.call({
				type: 'call_service',
				domain: 'select',
				service: 'select_option',
				service_data: { entity_id: select.entity_id, option: PIPELINE_NAME },
			}).catch(() => log(`could not set ${select.entity_id}; leaving it on its default`));
		}

		console.log(JSON.stringify({
			pipeline_id: pipelineId,
			stt: sttEntity,
			tts: ttsEntity,
			wake_word: wakeEntity,
			satellite: satelliteEntity,
		}, null, '\t'));
	} finally {
		ws.close();
	}
};

main().catch((err) => {
	console.error(`[provision] failed: ${err.message}`);
	process.exit(1);
});
