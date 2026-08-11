// Shard-index resolution for the GCE spot MIG runner.
//
// A Cloud Run Job hands every task its ordinal in CLOUD_RUN_TASK_INDEX, so
// sharding there is free. A managed instance group hands out NOTHING of the sort:
// MIG members are named `<base>-<4 random chars>`, there is no ordinal in the
// environment, and a template's container-env is identical on every VM. Without
// this module every VM in the group read SHARD_INDEX=0 and ground the SAME shard
// of the target list, so a 20-VM group did one VM's worth of useful work.
//
// The fix uses the two real Google APIs already available to the VM:
//   1. The metadata server (no credentials needed) for this VM's own name and the
//      instance-group-manager that created it (`instance/attributes/created-by`).
//   2. The Compute Engine API's listManagedInstances on that group, authenticated
//      with the VM's attached service account, for the group's full membership.
// Sorting the membership by name gives every VM the same total order, so each one
// takes its own position in it. The order is stable while the group is stable, and
// a preemption/replacement only reshuffles which VM grinds which shard, never
// leaves a shard uncovered (the grinder is resumable and idempotent per address).
//
// Requires roles/compute.viewer on the grinder service account. When the listing
// is unavailable the resolver degrades to a stable hash of the instance name,
// which spreads VMs across shards without coordination (some shards may collide),
// and never to the silent all-VMs-on-shard-0 behaviour this replaces.

const METADATA_ROOT = 'http://metadata.google.internal/computeMetadata/v1';
const METADATA_TIMEOUT_MS = 2_000;
const API_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url, init, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Read one key from the GCE metadata server.
 * @param {string} path - path under computeMetadata/v1, e.g. 'instance/name'.
 * @returns {Promise<string>} the raw value.
 */
async function metadata(path) {
	const res = await fetchWithTimeout(
		`${METADATA_ROOT}/${path}`,
		{ headers: { 'Metadata-Flavor': 'Google' } },
		METADATA_TIMEOUT_MS,
	);
	if (!res.ok) throw new Error(`metadata ${path} → ${res.status}`);
	return (await res.text()).trim();
}

/** True when this process is running on a Google Compute Engine instance. */
export async function onGce() {
	try {
		await metadata('instance/id');
		return true;
	} catch {
		return false;
	}
}

/**
 * Deterministic fallback index: FNV-1a over the instance name, modulo shardCount.
 * Coordination-free, so two VMs can land on the same shard, but every VM does
 * useful work instead of all of them duplicating shard 0.
 * @param {string} name
 * @param {number} shardCount
 * @returns {number}
 */
export function hashShardIndex(name, shardCount) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		hash ^= name.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % Math.max(1, shardCount);
}

/**
 * This VM's position in its managed instance group's name-sorted membership.
 * @param {string} createdBy - `projects/<n>/zones/<z>/instanceGroupManagers/<g>`.
 * @param {string} selfName - this VM's instance name.
 * @returns {Promise<number>} the zero-based position, or -1 when not found.
 */
async function positionInGroup(createdBy, selfName) {
	const token = await metadata('instance/service-accounts/default/token')
		.then((raw) => JSON.parse(raw).access_token);
	const res = await fetchWithTimeout(
		`https://compute.googleapis.com/compute/v1/${createdBy}/listManagedInstances`,
		{ method: 'POST', headers: { authorization: `Bearer ${token}` } },
		API_TIMEOUT_MS,
	);
	if (!res.ok) {
		const detail = await res.text().catch(() => String(res.status));
		throw new Error(`listManagedInstances → ${res.status}: ${detail.slice(0, 200)}`);
	}
	const data = await res.json();
	const names = (data.managedInstances || [])
		.map((m) => String(m.instance || '').split('/').pop())
		.filter(Boolean)
		.sort();
	return names.indexOf(selfName);
}

/**
 * Resolve this VM's SHARD_INDEX from GCE. Callers use it only when the runner is
 * a MIG and no explicit SHARD_INDEX / CLOUD_RUN_TASK_INDEX was supplied.
 *
 * @param {number} shardCount - total shards (the group's intended size).
 * @param {(msg:string)=>void} [log] - progress sink; defaults to console.log.
 * @returns {Promise<{index:number, source:'mig-listing'|'name-hash'|'unavailable', instance:string}>}
 */
export async function resolveGceShardIndex(shardCount, log = console.log) {
	const count = Math.max(1, Number(shardCount) || 1);
	let name = '';
	try {
		name = await metadata('instance/name');
	} catch (err) {
		log(`[grind] not on GCE (${err.message}), using shard index 0`);
		return { index: 0, source: 'unavailable', instance: '' };
	}
	try {
		const createdBy = await metadata('instance/attributes/created-by');
		const position = await positionInGroup(createdBy, name);
		if (position >= 0) {
			return { index: position % count, source: 'mig-listing', instance: name };
		}
		log(`[grind] ${name} not yet listed in its instance group, falling back to a name hash`);
	} catch (err) {
		log(`[grind] instance-group listing unavailable (${err.message}), falling back to a name hash`);
	}
	return { index: hashShardIndex(name, count), source: 'name-hash', instance: name };
}
