// glTF / GLB I/O helpers — load a GLB from a URL or a base64 data URL into
// a @gltf-transform/core Document, and serialize back to bytes when needed.
//
// The @gltf-transform NodeIO reader does the binary parsing (BIN chunk +
// JSON chunk per the glTF 2.0 spec). We attach the Draco extension on
// both reader + writer so already-Draco-compressed meshes round-trip
// correctly.

import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3dgltf from 'draco3dgltf';

let _io = null;

async function buildIo() {
	const [encoder, decoder] = await Promise.all([
		draco3dgltf.createEncoderModule(),
		draco3dgltf.createDecoderModule(),
	]);
	return new NodeIO()
		.registerExtensions(ALL_EXTENSIONS)
		.registerDependencies({
			'draco3d.encoder': encoder,
			'draco3d.decoder': decoder,
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
