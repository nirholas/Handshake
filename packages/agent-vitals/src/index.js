// @ts-check
/**
 * @three-ws/agent-vitals
 *
 * Capability attestation for autonomous agents: not "is it up" but "can it act".
 *
 * The failure this library exists for
 * -----------------------------------
 * An autonomous agent reports perfectly healthy while being structurally
 * incapable of doing the one thing it exists to do. The process is up. The
 * feed is connected. The strategy is armed. Every dashboard is green. And it
 * has not acted in three weeks.
 *
 * That is not a monitoring gap, it is a modelling gap. Liveness checks measure
 * the agent's *process*. Acting requires a whole chain of preconditions the
 * process knows nothing about: it must be permitted to act, be able to pay for
 * the action, be able to decide, be able to see an opportunity, and be able to
 * land the result. Each link fails independently and silently, and the agent
 * keeps looping cheerfully through a decision it can never complete.
 *
 * Why a DAG and not a checklist
 * -----------------------------
 * Preconditions are not independent, and a flat list of failures buries the
 * answer. A stale deployment causes a dead model chain, which causes a
 * saturated decision queue, which causes zero entries. A checklist reports
 * three red rows and makes a human guess which one to chase. This library
 * models `needs` edges between vitals and reports the *root*: the deepest
 * failing node with no failing dependency of its own. Symptoms are recorded
 * but never presented as causes.
 *
 * Three consequences fall out of that model, and each one is a bug this
 * library refuses to reproduce:
 *
 *   1. A vital whose dependency is already down is `blocked`, never probed.
 *      Probing it would spend a timeout to rediscover a known failure. That is
 *      exactly how one dead model chain turned every decision into a ten-rung
 *      walk through ten timeouts.
 *   2. A probe that could not be read is `unknown`, never `down`. An unread
 *      balance is not a balance of zero, and an RPC blip must not page someone
 *      to a healthy fleet.
 *   3. Every vital carries a `remedy`. A verdict that says "cognition: down"
 *      is a status page. A verdict that says "run this command" is a fix.
 *
 * Pure core, injected I/O
 * -----------------------
 * Graph construction, ordering, cycle detection, blocking and root-cause
 * resolution are pure and synchronous over probe results. Every side effect
 * lives in a probe the caller supplies, so the interesting logic is testable
 * without a network, a clock, or a database.
 *
 * @example
 * import { vitals } from '@three-ws/agent-vitals';
 *
 * const chart = vitals()
 *   .vital('deploy-fresh', {
 *     describe: 'the running image is the code we think it is',
 *     probe: async () => ({ ok: deployedSha === headSha, detail: `image ${imageAge} old` }),
 *     remedy: 'gcloud builds submit --config workers/agent-sniper/cloudbuild.yaml',
 *   })
 *   .vital('cognition', {
 *     describe: 'the agent can reach a model and get a decision',
 *     needs: ['deploy-fresh'],
 *     probe: async () => ({ ok: await modelChainReachable() }),
 *     remedy: 'top up the model provider credits',
 *   })
 *   .vital('solvency', {
 *     describe: 'the wallet can fund one action',
 *     probe: async () => ({ ok: balance >= perAction }),
 *     remedy: () => `send ${(perAction - balance).toFixed(4)} SOL to ${wallet}`,
 *   })
 *   .capability('trade', { needs: ['cognition', 'solvency'] });
 *
 * const verdict = await chart.attest();
 * verdict.can.trade;            // false
 * verdict.rootCauses[0].id;     // 'deploy-fresh'  (not 'cognition')
 * verdict.explain();            // 'cannot trade because cognition is blocked, because ...'
 */

/** @typedef {'up'|'down'|'blocked'|'unknown'} VitalStatus */
/** @typedef {'ready'|'unable'|'unknown'} CapabilityStatus */

/**
 * What a probe may return. `true`/`false` are accepted as shorthand for
 * `{ ok }` so a one-line predicate does not have to build an object.
 * @typedef {boolean | { ok?: boolean|null, detail?: string, data?: unknown }} ProbeResult
 */

/**
 * @typedef {object} VitalSpec
 * @property {string} [describe]  human sentence: what being `up` means
 * @property {string[]} [needs]   ids of vitals this one depends on
 * @property {() => (ProbeResult | Promise<ProbeResult>)} probe
 * @property {string | ((ctx: { detail: string|null, data: unknown }) => string)} [remedy]
 * @property {number} [timeoutMs] per-probe deadline; overrides the chart default
 */

/**
 * @typedef {object} VitalReport
 * @property {string} id
 * @property {VitalStatus} status
 * @property {string|null} describe
 * @property {string|null} detail
 * @property {unknown} data
 * @property {string|null} remedy
 * @property {string[]} needs
 * @property {string[]} blockedBy   direct dependencies that were not `up`
 * @property {'down'|'unknown'|null} blockedSeverity
 *   For a `blocked` vital: whether the block traces back to a definite failure
 *   (`down`) or merely to an unreadable one (`unknown`). Null when not blocked.
 * @property {number|null} ms       probe duration; null when never probed
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/** Statuses that stop a dependent from being probed at all. */
const NOT_UP = new Set(['down', 'blocked', 'unknown']);

/**
 * How bad a block is, propagated down the graph.
 *
 * Blocking on an unreadable dependency is NOT the same as blocking on a broken
 * one, and collapsing the two inverts the library's own rule one level up: a
 * single unread probe would cascade into "this agent cannot act" for every
 * vital downstream of it. That is how an arm which had traded sixty seconds
 * earlier was reported as definitively unable, purely because a credential for
 * an unrelated probe was missing.
 *
 * A block is definite only when something in its chain is actually `down`.
 *
 * @param {string[]} blockedBy
 * @param {Map<string, VitalReport>} reports
 * @returns {'down'|'unknown'}
 */
function blockSeverity(blockedBy, reports) {
	for (const id of blockedBy) {
		const dep = reports.get(id);
		if (!dep) continue;
		if (dep.status === 'down') return 'down';
		if (dep.status === 'blocked' && dep.blockedSeverity === 'down') return 'down';
	}
	return 'unknown';
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A probe's raw return, normalised. `ok: null` (or a missing `ok`) means the
 * probe ran but could not decide, which is `unknown`, never `down`.
 * @param {ProbeResult} raw
 * @returns {{ ok: boolean|null, detail: string|null, data: unknown }}
 */
function normalizeProbeResult(raw) {
	if (typeof raw === 'boolean') return { ok: raw, detail: null, data: undefined };
	if (!isPlainObject(raw)) return { ok: null, detail: 'probe returned a non-result value', data: raw };
	const ok = raw.ok === true ? true : raw.ok === false ? false : null;
	const detail = typeof raw.detail === 'string' && raw.detail ? raw.detail : null;
	return { ok, detail, data: raw.data };
}

/**
 * Run one probe under a deadline. A probe that throws or overruns is `unknown`
 * with the reason in `detail`: the library never converts "I could not tell"
 * into "it is broken", because that inversion is what makes a health system
 * page someone at 3am for a network blip.
 *
 * The deadline is a race, not a cancellation. A probe that ignores it keeps
 * running in the background; that is the caller's contract to honour with an
 * AbortSignal of their own if they need one.
 *
 * @param {VitalSpec} spec
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean|null, detail: string|null, data: unknown, ms: number }>}
 */
async function runProbe(spec, timeoutMs) {
	const started = Date.now();
	/** @type {ReturnType<typeof setTimeout>|undefined} */
	let timer;
	try {
		const deadline = new Promise((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`probe exceeded ${timeoutMs}ms`)), timeoutMs);
			// Never hold the event loop open on our own deadline.
			if (typeof timer?.unref === 'function') timer.unref();
		});
		const raw = await Promise.race([Promise.resolve().then(() => spec.probe()), deadline]);
		return { ...normalizeProbeResult(/** @type {ProbeResult} */ (raw)), ms: Date.now() - started };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: null, detail: `probe failed: ${message}`, data: undefined, ms: Date.now() - started };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolve a vital's remedy. A function remedy is handed the probe's own detail
 * and data so the fix can name the real number: "send 0.0187 SOL to <address>"
 * beats "fund the wallet" every time an operator reads it at speed.
 *
 * @param {VitalSpec} spec
 * @param {{ detail: string|null, data: unknown }} ctx
 * @returns {string|null}
 */
function resolveRemedy(spec, ctx) {
	const { remedy } = spec;
	if (typeof remedy === 'string') return remedy || null;
	if (typeof remedy !== 'function') return null;
	try {
		const out = remedy(ctx);
		return typeof out === 'string' && out ? out : null;
	} catch {
		// A remedy that throws must never take down an attestation: the verdict
		// is the point, the suggested fix is a convenience on top of it.
		return null;
	}
}

/**
 * Kahn layering. Returns vitals grouped into dependency levels so an
 * attestation can probe a whole level concurrently, and throws on a cycle
 * with the members named.
 *
 * Cycles are a construction bug, so this runs at `attest()` time over the
 * assembled graph rather than being deferred into per-probe failures.
 *
 * @param {Map<string, VitalSpec>} vitals
 * @returns {string[][]}
 */
function layer(vitals) {
	/** @type {Map<string, number>} */
	const pending = new Map();
	/** @type {Map<string, string[]>} */
	const dependents = new Map();

	for (const [id, spec] of vitals) {
		const needs = spec.needs || [];
		pending.set(id, needs.length);
		for (const need of needs) {
			if (!dependents.has(need)) dependents.set(need, []);
			/** @type {string[]} */ (dependents.get(need)).push(id);
		}
	}

	/** @type {string[][]} */
	const layers = [];
	let ready = [...pending.entries()].filter(([, n]) => n === 0).map(([id]) => id);
	let placed = 0;

	while (ready.length) {
		// Stable order inside a layer keeps reports and test fixtures readable.
		ready.sort();
		layers.push(ready);
		placed += ready.length;
		/** @type {string[]} */
		const next = [];
		for (const id of ready) {
			for (const dep of dependents.get(id) || []) {
				const left = /** @type {number} */ (pending.get(dep)) - 1;
				pending.set(dep, left);
				if (left === 0) next.push(dep);
			}
		}
		ready = next;
	}

	if (placed !== vitals.size) {
		const cyclic = [...pending.entries()].filter(([, n]) => n > 0).map(([id]) => id).sort();
		throw new Error(`agent-vitals: dependency cycle among [${cyclic.join(', ')}]`);
	}
	return layers;
}

/**
 * Every vital reachable from a set of roots, following `needs` edges.
 * @param {string[]} roots
 * @param {Map<string, VitalSpec>} vitals
 * @returns {Set<string>}
 */
function closure(roots, vitals) {
	const seen = new Set();
	const stack = [...roots];
	while (stack.length) {
		const id = /** @type {string} */ (stack.pop());
		if (seen.has(id)) continue;
		seen.add(id);
		for (const need of vitals.get(id)?.needs || []) stack.push(need);
	}
	return seen;
}

/**
 * The point of the whole library: given a set of failing vitals, return only
 * the ones that are not explained by another failure.
 *
 * A vital is a root cause when it is itself not `up` AND every vital it
 * depends on IS `up`. Anything with a failing dependency is a symptom, and
 * presenting symptoms as causes is what makes an operator chase a dead model
 * chain for an hour when the real answer was a stale deployment.
 *
 * @param {Set<string>} scope         vitals in the failing capability's closure
 * @param {Map<string, VitalReport>} reports
 * @returns {VitalReport[]}
 */
function rootCausesIn(scope, reports) {
	/** @type {VitalReport[]} */
	const roots = [];
	for (const id of scope) {
		const report = reports.get(id);
		if (!report || report.status === 'up') continue;
		const explained = report.needs.some((need) => {
			const dep = reports.get(need);
			return dep ? dep.status !== 'up' : false;
		});
		if (!explained) roots.push(report);
	}
	// `down` before `unknown`: a definite failure outranks an unreadable one
	// when an operator only reads the first line.
	const rank = { down: 0, blocked: 1, unknown: 2, up: 3 };
	return roots.sort((a, b) => (rank[a.status] - rank[b.status]) || a.id.localeCompare(b.id));
}

/**
 * A capability's verdict over its dependency closure.
 *
 * `unable` outranks `unknown` deliberately. If one precondition is definitively
 * broken, the agent cannot act, and an unreadable second precondition does not
 * make that any less true. Only when nothing is definitively broken does an
 * unreadable input downgrade the answer to "cannot say".
 *
 * @param {Set<string>} scope
 * @param {Map<string, VitalReport>} reports
 * @returns {CapabilityStatus}
 */
function capabilityStatus(scope, reports) {
	let sawUnknown = false;
	for (const id of scope) {
		const report = reports.get(id);
		if (!report) { sawUnknown = true; continue; }
		if (report.status === 'down') return 'unable';
		// A block only makes the capability definitively unable when the block
		// traces to something actually broken. A block behind an unread probe
		// leaves the answer unknown, exactly like the unread probe itself.
		if (report.status === 'blocked') {
			if (report.blockedSeverity === 'down') return 'unable';
			sawUnknown = true;
			continue;
		}
		if (report.status === 'unknown') sawUnknown = true;
	}
	return sawUnknown ? 'unknown' : 'ready';
}

/**
 * Build the causal sentence for one capability: the chain from the capability
 * down to its root cause, in the order a human would say it out loud.
 *
 * @param {string} capabilityId
 * @param {CapabilityStatus} status
 * @param {VitalReport[]} roots
 * @param {Map<string, VitalReport>} reports
 * @returns {string}
 */
function explainCapability(capabilityId, status, roots, reports) {
	if (status === 'ready') return `can ${capabilityId}`;
	if (!roots.length) return `cannot say whether it can ${capabilityId}`;

	const verb = status === 'unable' ? 'cannot' : 'may not be able to';
	const clauses = roots.map((root) => {
		// Walk UP from the root through whatever it blocked, so the sentence reads
		// outermost symptom first and lands on the cause: an operator scanning one
		// line gets "cognition is blocked, because deploy-fresh is down", which is
		// the order they would say it out loud.
		/** @type {VitalReport[]} */
		const chain = [root];
		const seen = new Set([root.id]);
		for (;;) {
			const head = chain[0];
			const symptom = [...reports.values()].find((r) => r.status === 'blocked' && !seen.has(r.id) && r.blockedBy.includes(head.id));
			if (!symptom) break;
			seen.add(symptom.id);
			chain.unshift(symptom);
		}
		const because = chain.map((r) => `${r.id} is ${r.status}`).join(', because ');
		return root.detail ? `${because} (${root.detail})` : because;
	});
	return `${verb} ${capabilityId} because ${clauses.join('; and ')}`;
}

/**
 * A vitals chart: the graph of preconditions plus the capabilities defined over
 * them. Build with {@link vitals}, then call {@link VitalsChart#attest}.
 */
class VitalsChart {
	/** @param {{ agent?: string, timeoutMs?: number }} [opts] */
	constructor(opts = {}) {
		/** @type {string|null} */
		this.agent = opts.agent ?? null;
		this.timeoutMs = Number.isFinite(opts.timeoutMs) && Number(opts.timeoutMs) > 0
			? Number(opts.timeoutMs)
			: DEFAULT_TIMEOUT_MS;
		/** @type {Map<string, VitalSpec>} */
		this._vitals = new Map();
		/** @type {Map<string, { describe: string|null, needs: string[] }>} */
		this._capabilities = new Map();
	}

	/**
	 * Declare a precondition.
	 * @param {string} id
	 * @param {VitalSpec} spec
	 * @returns {this}
	 */
	vital(id, spec) {
		if (!id || typeof id !== 'string') throw new TypeError('agent-vitals: a vital needs a string id');
		if (this._vitals.has(id)) throw new Error(`agent-vitals: duplicate vital "${id}"`);
		if (typeof spec?.probe !== 'function') throw new TypeError(`agent-vitals: vital "${id}" needs a probe function`);
		this._vitals.set(id, { ...spec, needs: [...(spec.needs || [])] });
		return this;
	}

	/**
	 * Declare something the agent should be able to do, as an AND over vitals.
	 * @param {string} id
	 * @param {{ describe?: string, needs: string[] }} spec
	 * @returns {this}
	 */
	capability(id, spec) {
		if (!id || typeof id !== 'string') throw new TypeError('agent-vitals: a capability needs a string id');
		if (this._capabilities.has(id)) throw new Error(`agent-vitals: duplicate capability "${id}"`);
		if (!Array.isArray(spec?.needs) || !spec.needs.length) {
			throw new TypeError(`agent-vitals: capability "${id}" needs a non-empty needs array`);
		}
		this._capabilities.set(id, { describe: spec.describe ?? null, needs: [...spec.needs] });
		return this;
	}

	/**
	 * Every edge must land on a declared vital. Checked once, up front, so a
	 * typo in `needs` is a build error with a name in it rather than a silently
	 * ignored dependency that makes a broken agent look healthy.
	 */
	_assertEdges() {
		for (const [id, spec] of this._vitals) {
			for (const need of spec.needs || []) {
				if (!this._vitals.has(need)) throw new Error(`agent-vitals: vital "${id}" needs unknown vital "${need}"`);
			}
		}
		for (const [id, spec] of this._capabilities) {
			for (const need of spec.needs) {
				if (!this._vitals.has(need)) throw new Error(`agent-vitals: capability "${id}" needs unknown vital "${need}"`);
			}
		}
	}

	/**
	 * Probe the graph and return the verdict.
	 *
	 * Vitals are probed layer by layer: everything at one dependency depth runs
	 * concurrently, and a vital whose dependency is not `up` is marked `blocked`
	 * without ever being probed.
	 *
	 * @param {{ signal?: AbortSignal }} [opts]
	 * @returns {Promise<Verdict>}
	 */
	async attest(opts = {}) {
		this._assertEdges();
		const layers = layer(this._vitals);

		/** @type {Map<string, VitalReport>} */
		const reports = new Map();
		const startedAt = new Date();

		for (const level of layers) {
			await Promise.all(level.map(async (id) => {
				const spec = /** @type {VitalSpec} */ (this._vitals.get(id));
				const needs = spec.needs || [];
				const blockedBy = needs.filter((need) => NOT_UP.has(/** @type {VitalStatus} */ (reports.get(need)?.status)));

				if (blockedBy.length) {
					reports.set(id, {
						id,
						status: 'blocked',
						describe: spec.describe ?? null,
						detail: `not probed: ${blockedBy.join(', ')} ${blockedBy.length > 1 ? 'are' : 'is'} not up`,
						data: undefined,
						remedy: null,
						needs,
						blockedBy,
						blockedSeverity: blockSeverity(blockedBy, reports),
						ms: null,
					});
					return;
				}

				if (opts.signal?.aborted) {
					reports.set(id, {
						id,
						status: 'unknown',
						describe: spec.describe ?? null,
						detail: 'attestation aborted before this probe ran',
						data: undefined,
						remedy: null,
						needs,
						blockedBy: [],
						blockedSeverity: null,
						ms: null,
					});
					return;
				}

				const result = await runProbe(spec, spec.timeoutMs ?? this.timeoutMs);
				/** @type {VitalStatus} */
				const status = result.ok === true ? 'up' : result.ok === false ? 'down' : 'unknown';
				reports.set(id, {
					id,
					status,
					describe: spec.describe ?? null,
					detail: result.detail,
					data: result.data,
					remedy: status === 'up' ? null : resolveRemedy(spec, { detail: result.detail, data: result.data }),
					needs,
					blockedBy: [],
					blockedSeverity: null,
					ms: result.ms,
				});
			}));
		}

		/** @type {Record<string, boolean|null>} */
		const can = {};
		/** @type {CapabilityReport[]} */
		const capabilities = [];
		for (const [id, spec] of this._capabilities) {
			const scope = closure(spec.needs, this._vitals);
			const status = capabilityStatus(scope, reports);
			const roots = status === 'ready' ? [] : rootCausesIn(scope, reports);
			can[id] = status === 'ready' ? true : status === 'unable' ? false : null;
			capabilities.push({
				id,
				describe: spec.describe,
				status,
				needs: spec.needs,
				rootCauses: roots,
				remedies: roots.map((r) => r.remedy).filter((r) => typeof r === 'string'),
				explain: explainCapability(id, status, roots, reports),
			});
		}

		return new Verdict({
			agent: this.agent,
			at: startedAt,
			ms: Date.now() - startedAt.getTime(),
			vitals: [...reports.values()],
			capabilities,
		});
	}
}

/**
 * @typedef {object} CapabilityReport
 * @property {string} id
 * @property {string|null} describe
 * @property {CapabilityStatus} status
 * @property {string[]} needs
 * @property {VitalReport[]} rootCauses
 * @property {string[]} remedies
 * @property {string} explain
 */

/**
 * The result of an attestation. Carries the raw reports plus the two things a
 * caller actually wants: whether the agent can act, and what to do about it.
 */
class Verdict {
	/**
	 * @param {{ agent: string|null, at: Date, ms: number, vitals: VitalReport[], capabilities: CapabilityReport[] }} p
	 */
	constructor(p) {
		this.agent = p.agent;
		this.at = p.at;
		this.ms = p.ms;
		/** @type {VitalReport[]} */
		this.vitals = p.vitals;
		/** @type {CapabilityReport[]} */
		this.capabilities = p.capabilities;
		/** @type {Record<string, boolean|null>} true = ready, false = unable, null = cannot say */
		this.can = Object.fromEntries(
			p.capabilities.map((c) => [c.id, c.status === 'ready' ? true : c.status === 'unable' ? false : null]),
		);
	}

	/** Every capability is ready. */
	get healthy() {
		return this.capabilities.every((c) => c.status === 'ready');
	}

	/**
	 * The distinct root causes across every failing capability, most severe
	 * first. This is the operator's work queue, deduplicated: one stale
	 * deployment blocking four capabilities is one item, not four.
	 * @returns {VitalReport[]}
	 */
	get rootCauses() {
		/** @type {Map<string, VitalReport>} */
		const byId = new Map();
		for (const capability of this.capabilities) {
			for (const root of capability.rootCauses) if (!byId.has(root.id)) byId.set(root.id, root);
		}
		const rank = { down: 0, blocked: 1, unknown: 2, up: 3 };
		return [...byId.values()].sort((a, b) => (rank[a.status] - rank[b.status]) || a.id.localeCompare(b.id));
	}

	/**
	 * Distinct remedies for every root cause, in the same order. Deduplicated,
	 * because one fix that unblocks three capabilities should be read once.
	 * @returns {string[]}
	 */
	get remedies() {
		const out = [];
		for (const root of this.rootCauses) if (root.remedy && !out.includes(root.remedy)) out.push(root.remedy);
		return out;
	}

	/** One vital by id. @param {string} id @returns {VitalReport|null} */
	vital(id) {
		return this.vitals.find((v) => v.id === id) ?? null;
	}

	/**
	 * The whole verdict as a human paragraph: one line per capability, then the
	 * remedies. Written to be pasted into an incident channel as-is.
	 * @returns {string}
	 */
	explain() {
		const who = this.agent ? `${this.agent}: ` : '';
		if (this.healthy) return `${who}${this.capabilities.map((c) => `can ${c.id}`).join(', ')}`;
		const lines = this.capabilities.filter((c) => c.status !== 'ready').map((c) => `${who}${c.explain}`);
		for (const remedy of this.remedies) lines.push(`fix: ${remedy}`);
		return lines.join('\n');
	}

	/** Plain JSON, safe to log or serve. @returns {object} */
	toJSON() {
		return {
			agent: this.agent,
			at: this.at.toISOString(),
			ms: this.ms,
			healthy: this.healthy,
			can: this.can,
			capabilities: this.capabilities,
			vitals: this.vitals,
			root_causes: this.rootCauses.map((r) => r.id),
			remedies: this.remedies,
		};
	}
}

/**
 * Start a vitals chart.
 * @param {{ agent?: string, timeoutMs?: number }} [opts]
 * @returns {VitalsChart}
 */
export function vitals(opts) {
	return new VitalsChart(opts);
}

export { VitalsChart, Verdict, DEFAULT_TIMEOUT_MS };
