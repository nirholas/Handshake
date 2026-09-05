// Stand-in for `sharp`, which @gltf-transform/functions reaches through
// ndarray-pixels for texture resizing. The extension never resizes textures (the
// optimize presets are geometry and compression passes), and sharp is a native
// module that cannot ship inside a .vsix, so the bundle aliases it here. Anything
// that does call it gets a plain explanation instead of a missing-binary crash.
export default function sharp() {
	throw new Error('texture resizing is not available inside the editor; run the three.ws asset pipeline for that');
}
