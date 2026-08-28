// Minimal column-major 4x4 / vec3 math. Deliberately not a dependency: this is
// ~15 operations used by the rasterizer's hot loop, and every one of them is
// allocation-free on purpose (see mulPoint/mulDir, which write into an out
// array). A general-purpose matrix library would allocate a vector per vertex
// and dominate the frame budget on a 60k-triangle avatar.
//
// Layout matches glTF: column-major, m[column * 4 + row].

export function mat4Identity(out = new Float64Array(16)) {
	out.fill(0);
	out[0] = out[5] = out[10] = out[15] = 1;
	return out;
}

const mulScratch = new Float64Array(16);

export function mat4Multiply(a, b, out = new Float64Array(16)) {
	// Aliasing guard. `mat4Multiply(m, ibm, m)` reads a[0..3] again while
	// computing column 1, so writing straight into an aliased `out` corrupts the
	// source halfway through and produces a matrix that looks plausible and
	// shears the mesh. That shipped as spikes radiating off every joint until it
	// was caught by rendering a frame to PNG and looking at it.
	const target = (out === a || out === b) ? mulScratch : out;
	for (let c = 0; c < 4; c += 1) {
		const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
		target[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
		target[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
		target[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
		target[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
	}
	if (target !== out) out.set(target);
	return out;
}

export function mat4FromTRS(t, r, s, out = new Float64Array(16)) {
	const [x, y, z, w] = r;
	const x2 = x + x, y2 = y + y, z2 = z + z;
	const xx = x * x2, xy = x * y2, xz = x * z2;
	const yy = y * y2, yz = y * z2, zz = z * z2;
	const wx = w * x2, wy = w * y2, wz = w * z2;
	out[0] = (1 - (yy + zz)) * s[0];
	out[1] = (xy + wz) * s[0];
	out[2] = (xz - wy) * s[0];
	out[3] = 0;
	out[4] = (xy - wz) * s[1];
	out[5] = (1 - (xx + zz)) * s[1];
	out[6] = (yz + wx) * s[1];
	out[7] = 0;
	out[8] = (xz + wy) * s[2];
	out[9] = (yz - wx) * s[2];
	out[10] = (1 - (xx + yy)) * s[2];
	out[11] = 0;
	out[12] = t[0];
	out[13] = t[1];
	out[14] = t[2];
	out[15] = 1;
	return out;
}

export function mat4Invert(m, out = new Float64Array(16)) {
	const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
	const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
	const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
	const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

	const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
	const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
	const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
	const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
	const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
	const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;

	const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
	// A degenerate node matrix (zero scale on an axis is legal glTF and appears
	// in real avatars on hidden helper nodes) has no inverse. Returning identity
	// keeps the joint it belongs to at rest instead of filling the vertex buffer
	// with NaN, which the rasterizer would silently drop as a whole limb.
	if (!det) return mat4Identity(out);
	const d = 1 / det;

	out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
	out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
	out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
	out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
	out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
	out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
	out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
	out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
	out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
	out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
	out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
	out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
	out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
	out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
	out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
	out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
	return out;
}

/** Transpose of the inverse, for normals under non-uniform scale. */
export function mat4NormalMatrix(m, out = new Float64Array(16)) {
	const inv = mat4Invert(m);
	for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) out[c * 4 + r] = inv[r * 4 + c];
	return out;
}

export function mulPoint(m, x, y, z, out) {
	out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
	out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
	out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
	return out;
}

export function mulDir(m, x, y, z, out) {
	out[0] = m[0] * x + m[4] * y + m[8] * z;
	out[1] = m[1] * x + m[5] * y + m[9] * z;
	out[2] = m[2] * x + m[6] * y + m[10] * z;
	return out;
}

export function normalize(v) {
	const len = Math.hypot(v[0], v[1], v[2]);
	if (!len) return v;
	v[0] /= len; v[1] /= len; v[2] /= len;
	return v;
}

/** Right-handed look-at view matrix. */
export function mat4LookAt(eye, target, up, out = new Float64Array(16)) {
	const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
	const x = normalize([
		up[1] * z[2] - up[2] * z[1],
		up[2] * z[0] - up[0] * z[2],
		up[0] * z[1] - up[1] * z[0],
	]);
	const y = [
		z[1] * x[2] - z[2] * x[1],
		z[2] * x[0] - z[0] * x[2],
		z[0] * x[1] - z[1] * x[0],
	];
	out[0] = x[0]; out[1] = y[0]; out[2] = z[0]; out[3] = 0;
	out[4] = x[1]; out[5] = y[1]; out[6] = z[1]; out[7] = 0;
	out[8] = x[2]; out[9] = y[2]; out[10] = z[2]; out[11] = 0;
	out[12] = -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]);
	out[13] = -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]);
	out[14] = -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]);
	out[15] = 1;
	return out;
}

export function mat4Perspective(fovY, aspect, near, far, out = new Float64Array(16)) {
	const f = 1 / Math.tan(fovY / 2);
	out.fill(0);
	out[0] = f / aspect;
	out[5] = f;
	out[10] = (far + near) / (near - far);
	out[11] = -1;
	out[14] = (2 * far * near) / (near - far);
	return out;
}

/** Spherical-linear interpolation between two quaternions, shortest arc. */
export function slerp(a, b, t, out = new Float64Array(4)) {
	let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
	let bx = b[0], by = b[1], bz = b[2], bw = b[3];
	if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
	// Near-parallel quaternions make sin(theta) vanish and the division blow up;
	// linear interpolation is within float noise of the arc there.
	if (cos > 0.9995) {
		out[0] = a[0] + (bx - a[0]) * t;
		out[1] = a[1] + (by - a[1]) * t;
		out[2] = a[2] + (bz - a[2]) * t;
		out[3] = a[3] + (bw - a[3]) * t;
	} else {
		const theta = Math.acos(cos);
		const sin = Math.sin(theta);
		const wa = Math.sin((1 - t) * theta) / sin;
		const wb = Math.sin(t * theta) / sin;
		out[0] = a[0] * wa + bx * wb;
		out[1] = a[1] * wa + by * wb;
		out[2] = a[2] * wa + bz * wb;
		out[3] = a[3] * wa + bw * wb;
	}
	const len = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
	out[0] /= len; out[1] /= len; out[2] /= len; out[3] /= len;
	return out;
}
