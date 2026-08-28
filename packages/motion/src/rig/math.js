// Vector and quaternion primitives, in the exact conventions the reference
// skeleton is measured in: right-handed, Y up, quaternions as [x, y, z, w],
// rotations composed parent-first (`qMul(parent, child)`).
//
// Plain arrays rather than classes on purpose. A pose is thousands of these per
// clip, they are compared in tests, serialized into clip JSON, and passed across
// a worker boundary, and an array is already all three of those things.

/** The rotation that does nothing. */
export const IDENTITY = Object.freeze([0, 0, 0, 1]);

export const v3 = (x, y, z) => [x, y, z];

export function vAdd(a, b) {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vSub(a, b) {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vScale(a, k) {
	return [a[0] * k, a[1] * k, a[2] * k];
}

export function vDot(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vCross(a, b) {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

export function vLen(a) {
	return Math.hypot(a[0], a[1], a[2]);
}

export function vNorm(a) {
	const len = vLen(a);
	return len < 1e-9 ? [0, 0, 0] : [a[0] / len, a[1] / len, a[2] / len];
}

export function vLerp(a, b, t) {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** The component of `a` perpendicular to `axis`. */
export function vReject(a, axis) {
	const n = vNorm(axis);
	return vSub(a, vScale(n, vDot(a, n)));
}

/** Hamilton product: the rotation `a` followed by the rotation `b` in a's frame. */
export function qMul(a, b) {
	const [ax, ay, az, aw] = a;
	const [bx, by, bz, bw] = b;
	return [
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	];
}

export function qConj(q) {
	return [-q[0], -q[1], -q[2], q[3]];
}

export function qNorm(q) {
	const len = Math.hypot(q[0], q[1], q[2], q[3]);
	return len < 1e-9 ? [...IDENTITY] : [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

export function qAxisAngle(axis, deg) {
	const n = vNorm(axis);
	const half = (deg * Math.PI) / 360;
	const s = Math.sin(half);
	return [n[0] * s, n[1] * s, n[2] * s, Math.cos(half)];
}

export function qRotate(q, v) {
	// v' = v + 2w(q⃗ × v) + 2(q⃗ × (q⃗ × v))
	const u = [q[0], q[1], q[2]];
	const t = vScale(vCross(u, v), 2);
	return vAdd(vAdd(v, vScale(t, q[3])), vCross(u, t));
}

/** The shortest rotation carrying direction `from` onto direction `to`. */
export function qBetween(from, to) {
	const a = vNorm(from);
	const b = vNorm(to);
	const dot = vDot(a, b);
	if (dot > 0.999999) return [...IDENTITY];
	if (dot < -0.999999) {
		// Opposed: any perpendicular axis is a valid 180-degree turn.
		let axis = vCross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
		if (vLen(axis) < 1e-6) axis = vCross(a, [0, 0, 1]);
		return qAxisAngle(axis, 180);
	}
	const axis = vCross(a, b);
	return qNorm([axis[0], axis[1], axis[2], 1 + dot]);
}

export function qSlerp(a, b, t) {
	let [bx, by, bz, bw] = b;
	let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
	if (cos < 0) {
		cos = -cos;
		bx = -bx;
		by = -by;
		bz = -bz;
		bw = -bw;
	}
	if (cos > 0.9995) {
		return qNorm([
			a[0] + (bx - a[0]) * t,
			a[1] + (by - a[1]) * t,
			a[2] + (bz - a[2]) * t,
			a[3] + (bw - a[3]) * t,
		]);
	}
	const theta = Math.acos(cos);
	const sin = Math.sin(theta);
	const wa = Math.sin((1 - t) * theta) / sin;
	const wb = Math.sin(t * theta) / sin;
	return qNorm([a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb]);
}

/** Quaternion from an orthonormal basis given as its three column vectors. */
export function qFromBasis(x, y, z) {
	const m00 = x[0], m10 = x[1], m20 = x[2];
	const m01 = y[0], m11 = y[1], m21 = y[2];
	const m02 = z[0], m12 = z[1], m22 = z[2];
	const trace = m00 + m11 + m22;
	if (trace > 0) {
		const s = 0.5 / Math.sqrt(trace + 1);
		return qNorm([(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s]);
	}
	if (m00 > m11 && m00 > m22) {
		const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
		return qNorm([0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
	}
	if (m11 > m22) {
		const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
		return qNorm([(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]);
	}
	const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
	return qNorm([(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]);
}

/**
 * Orthonormal basis from a primary direction and a secondary reference. The
 * primary survives exactly; the reference only resolves the roll about it.
 */
export function basisFrom(primary, reference) {
	const a = vNorm(primary);
	let b = vReject(reference, a);
	if (vLen(b) < 1e-6) {
		// Reference parallel to the primary: any perpendicular keeps the frame
		// well-defined, and the caller's roll was undefined anyway.
		b = vReject(Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], a);
	}
	b = vNorm(b);
	return [a, b, vCross(a, b)];
}

/**
 * The rotation carrying the local frame (`axisLocal`, `refLocal`) onto the world
 * frame (`axisWorld`, `refWorld`). The axis pair maps exactly; the reference
 * pair fixes the twist about it.
 */
export function orientQuat(axisLocal, refLocal, axisWorld, refWorld) {
	const [la, lb, lc] = basisFrom(axisLocal, refLocal);
	const [wa, wb, wc] = basisFrom(axisWorld, refWorld);
	return qNorm(qMul(qFromBasis(wa, wb, wc), qConj(qFromBasis(la, lb, lc))));
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export const DEG = Math.PI / 180;
