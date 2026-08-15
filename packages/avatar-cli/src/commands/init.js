import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { assertValid } from '@three-ws/avatar-schema';
import { style, symbols, success, failure, hint } from '../style.js';

const FORMAT_BY_EXT = {
	'.glb': 'glb',
	'.gltf': 'gltf',
	'.vrm': 'vrm',
};

function sha256OfFile(path) {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// Base58 minus the four ambiguous glyphs (0 O I l), the Solana address alphabet.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function inferOwner(ownerSpec) {
	// Accept CAIP-10 (chain:namespace:address), shorthand "0x..." (assumed
	// eip155:1), or a bare Solana address (assumed solana:mainnet-beta).
	if (!ownerSpec) return null;
	if (ownerSpec.startsWith('0x') && ownerSpec.length === 42) {
		return { chain: 'eip155:1', address: ownerSpec };
	}
	if (!ownerSpec.includes(':') && BASE58.test(ownerSpec)) {
		return { chain: 'solana:mainnet-beta', address: ownerSpec };
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
 *   --owner <caip10|sol|0xaddr>   Owner identity (eip155:1:0xabc, a Solana
 *                             address, or shorthand 0x...)
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
		const missing = [
			!ownerSpec && '--owner',
			!name && '--name',
			!meshPath && '--mesh',
		].filter(Boolean);
		failure(`init: missing required ${missing.length === 1 ? 'flag' : 'flags'} ${style.bold(missing.join(', '))}`);
		hint('three-ws-avatar init --owner 0x742d35… --name "Nicholas" --mesh ./michelle.glb');
		return 1;
	}

	const owner = inferOwner(ownerSpec);
	if (!owner) {
		failure(`could not parse --owner ${JSON.stringify(ownerSpec)}`);
		hint('expected CAIP-10 (eip155:1:0x…), a Solana address, or shorthand 0x…');
		return 1;
	}

	const meshFull = resolve(process.cwd(), meshPath);
	let meshStat;
	try {
		meshStat = statSync(meshFull);
	} catch {
		failure(`mesh file not found: ${meshPath}`);
		return 1;
	}
	const ext = extname(meshFull).toLowerCase();
	const format = FORMAT_BY_EXT[ext];
	if (!format) {
		failure(`unsupported mesh extension ${style.bold(ext || '(none)')}`);
		hint('expected .glb, .gltf, or .vrm');
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
		success(`wrote ${style.bold(outPath)}`);
		process.stderr.write(
			`  ${style.dim(`${symbols.bullet} id        ${manifest.id}`)}\n` +
			`  ${style.dim(`${symbols.bullet} skeleton  ${manifest.skeleton}`)}\n` +
			`  ${style.dim(`${symbols.bullet} mesh      ${format} · ${manifest.mesh.kBytes} kB · sha256:${manifest.mesh.sha256.slice(0, 12)}…`)}\n`,
		);
		process.stderr.write(`  ${style.dim(`${symbols.arrow} next: three-ws-avatar preview ${flags.out}`)}\n`);
	} else {
		process.stdout.write(json);
	}
	return 0;
}
