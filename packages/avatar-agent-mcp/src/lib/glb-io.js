// glTF / GLB I/O helpers — load a GLB from a URL or a base64 data URL into
// a @gltf-transform/core Document, and serialize back to bytes when needed.
//
// The @gltf-transform NodeIO reader does the binary parsing (BIN chunk +
// JSON chunk per the glTF 2.0 spec). We attach the Draco AND meshopt codecs on
// both reader + writer so an already-compressed mesh round-trips correctly.
// Registering the extensions is not enough on its own: glTF-Transform needs the
// codec injected too, and without the meshopt one every EXT_meshopt_compression
// asset (the format most three.ws avatars ship as) failed to parse here.

import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3dgltf from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

let _io = null;

async function buildIo() {
	const [encoder, decoder] = await Promise.all([
		draco3dgltf.createEncoderModule(),
		draco3dgltf.createDecoderModule(),
		MeshoptDecoder.ready,
		MeshoptEncoder.ready,
	]);
	return new NodeIO()
		.registerExtensions(ALL_EXTENSIONS)
		.registerDependencies({
			'draco3d.encoder': encoder,
			'draco3d.decoder': decoder,
			'meshopt.encoder': MeshoptEncoder,
			'meshopt.decoder': MeshoptDecoder,
		});
}

export async function getIo() {
	if (!_io) _io = await buildIo();
	return _io;
}

export async function fetchGlbBytes(url) {
	if (url.startsWith('data:')) {
		const comma = url.indexOf(',');
		if (comma === -1) throw new Error('Invalid data URL');
		const meta = url.slice(5, comma);
		const data = url.slice(comma + 1);
		if (meta.includes(';base64')) {
			return Buffer.from(data, 'base64');
		}
		return Buffer.from(decodeURIComponent(data), 'utf8');
	}
	const r = await fetch(url);
	if (!r.ok) throw new Error(`Failed to fetch ${url}: HTTP ${r.status}`);
	return Buffer.from(await r.arrayBuffer());
}

export async function readDocument(url) {
	const io = await getIo();
	const bytes = await fetchGlbBytes(url);
	const doc = await io.readBinary(bytes);
	return { doc, bytes };
}

export async function writeBinary(doc) {
	const io = await getIo();
	return io.writeBinary(doc);
}
