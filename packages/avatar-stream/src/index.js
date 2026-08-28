/**
 * @three-ws/avatar-stream - progressive 3D over plain HTTP.
 *
 * This entry is isomorphic and dependency-free: the container format and the
 * streaming reader, nothing that assumes Node or a GPU. Import `./three` for the
 * renderer binding, or `./node` for the packer.
 */

export {
	MAGIC_STRING,
	PREAMBLE_BYTES,
	FORMAT_VERSION,
	VERSION_TAG,
	RECOMMENDED_PREFIX_BYTES,
	align4,
	decodePreamble,
	encodePreamble,
	decodeHeader,
	encodeContainer,
	rangeForLayer,
	rangeHeaderForLayer,
} from './format.js';

export { A3SStream, bytesSource, httpSource } from './reader.js';
