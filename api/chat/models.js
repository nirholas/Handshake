import { cors, json, method, wrap } from '../_lib/http.js';
import { listFreeModels } from '../_lib/openrouter-free.js';
import { AGENT_MODEL_ID } from '../agent/run.js';

// The live free-model list (fetch, cache, ranking) lives in _lib/openrouter-free.js
// so this endpoint and the completion proxy agree on what is actually serving —
// a picker offering a model the proxy would reject is how /chat broke before.
export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	// Ranked best-first, so a client can take data[0] as the default without
	// knowing anything about which ids exist today.
	//
	// COPY, never mutate: listFreeModels() hands back its own module-level cache
	// array by reference, and that same array is what isLiveFreeModel() and
	// pickDefaultFreeModel() read. Pushing onto it appended one more agent row per
	// request (the picker grew a duplicate on every call until the 5-minute TTL
	// refetched) and seeded a non-`:free` id into a cache whose whole contract is
	// "free models only".
	const models = [
		...(await listFreeModels()),
		// The server-side agent loop rides the same picker as a virtual model. It is
		// appended, never first, so it can never become the silent default: it runs
		// multiple LLM rounds per message and answers slower than a plain model.
		{ id: AGENT_MODEL_ID, name: 'three.ws Agent · server tools' },
	];
	res.setHeader('cache-control', 'public, max-age=60');
	return json(res, 200, { data: models });
});
