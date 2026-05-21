import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { assertValid } from '@three-ws/avatar-schema';

const FORMAT_BY_EXT = {
	'.glb': 'glb',
	'.gltf': 'gltf',
	'.vrm': 'vrm',
};

function sha256OfFile(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function inferOwner(ownerSpec) {
	// Accept CAIP-10 (chain:namespace:address) or shorthand "0x..." (assumed eip155:1).
	if (!ownerSpec) return null;
	if (ownerSpec.startsWith('0x') && ownerSpec.length === 42) {
		return { chain: 'eip155:1', address: ownerSpec };
	}
	const parts = ownerSpec.split(':');
	if (parts.length === 3) {
		return { chain: `${parts[0]}:${parts[1]}`, address: parts[2] };
	}
	if (parts.length === 2) {
		return { chain: parts[0], address: parts[1] };
	}
	return null;
}

function inferIdFromOwner(name, owner) {
	if (name && /^[a-z0-9][a-z0-9-]{0,62}\.(eth|ws|sol)$/i.test(name)) {
		return name.toLowerCase();
	}
	return `${owner.chain}:${owner.address}`;
}

/**
 * `three-ws-avatar init` — scaffold a fresh avatar manifest from flags.
 *
 * Required flags:
 *   --owner <caip10|0xaddr>   Owner identity (eip155:1:0xabc, or shorthand 0x...)
 *   --name <string>           Avatar display name
 *   --mesh <path>             Path to GLB/GLTF/VRM file (sha256 computed automatically)
 *
 * Optional flags:
 *   --skeleton <name>         avaturn | mixamo | rpm | vrm-humanoid | custom (default: avaturn)
 *   --mesh-uri <url>          Public URI for the mesh (default: file:// path)
 *   --id <string>             Override id (default: derived from owner or name)
 *   --out <path>              Write manifest to file instead of stdout
 *   --pretty                  Pretty-print JSON (default: pretty)
 */
export async function init({ flags }) {
	const ownerSpec = flags.owner;
	const name = flags.name;
	const meshPath = flags.mesh;

	if (!ownerSpec || !name || !meshPath) {
		process.stderr.write(
			'init: requires --owner, --name, and --mesh.\n' +
				'  e.g. three-ws-avatar init --owner 0x742d35... --name "Nicholas" --mesh ./avatar.glb\n',
		);
		return 1;
	}

	const owner = inferOwner(ownerSpec);
	if (!owner) {
		process.stderr.write(`init: could not parse --owner ${JSON.stringify(ownerSpec)}\n`);
		return 1;
	}

	const meshFull = resolve(process.cwd(), meshPath);
	const meshStat = statSync(meshFull);
	const ext = extname(meshFull).toLowerCase();
	const format = FORMAT_BY_EXT[ext];
	if (!format) {
		process.stderr.write(`init: unsupported mesh extension ${ext} (expected .glb/.gltf/.vrm)\n`);
		return 1;
	}

	const manifest = {
		schemaVersion: 1,
		id: flags.id || inferIdFromOwner(name, owner),
		name,
		mesh: {
			uri: flags['mesh-uri'] || `file://${meshFull}`,
			sha256: sha256OfFile(meshFull),
			format,
			kBytes: Math.ceil(meshStat.size / 1024),
		},
		skeleton: flags.skeleton || 'avaturn',
		owner,
		createdAt: new Date().toISOString(),
	};

	assertValid(manifest);

	const json = JSON.stringify(manifest, null, 2) + '\n';
	if (flags.out) {
		const outPath = resolve(process.cwd(), flags.out);
		writeFileSync(outPath, json);
		process.stderr.write(`wrote ${outPath}\n`);
	} else {
		process.stdout.write(json);
	}
	return 0;
}
