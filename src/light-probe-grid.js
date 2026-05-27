import {
	Box3,
	CubeCamera,
	LightProbe,
	RGBAFormat,
	SphericalHarmonics3,
	Vector3,
	WebGLCubeRenderTarget,
} from 'three';
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js';

// Trilinear blend of eight scalar corner values.
function trilinear(v000, v100, v010, v110, v001, v101, v011, v111, tx, ty, tz) {
	const v00 = v000 + (v100 - v000) * tx;
	const v10 = v010 + (v110 - v010) * tx;
	const v01 = v001 + (v101 - v001) * tx;
	const v11 = v011 + (v111 - v011) * tx;
	const v0  = v00  + (v10  - v00)  * ty;
	const v1  = v01  + (v11  - v01)  * ty;
	return v0 + (v1 - v0) * tz;
}

export class LightProbeGrid {
	constructor(nx, ny, nz, bounds) {
		this.nx = nx;
		this.ny = ny;
		this.nz = nz;
		this.bounds = bounds instanceof Box3 ? bounds.clone() : new Box3();
		this._sh = new Array(nx * ny * nz).fill(null);
		this._activeProbe = new LightProbe(new SphericalHarmonics3(), 1);
		this._inScene = false;
		// Cached scratch vectors — avoids per-frame allocation in update().
		this._tmpSize = new Vector3();
		this._tmpPos  = new Vector3();
	}

	_idx(ix, iy, iz) {
		return iz * this.ny * this.nx + iy * this.nx + ix;
	}

	_cellCenter(ix, iy, iz, out, size) {
		out.set(
			this.bounds.min.x + (ix + 0.5) * (size.x / this.nx),
			this.bounds.min.y + (iy + 0.5) * (size.y / this.ny),
			this.bounds.min.z + (iz + 0.5) * (size.z / this.nz),
		);
	}

	// Trilinearly blend the 8 surrounding cells into _activeProbe.sh.
	_applyTrilinear(worldPos) {
		const s = this.bounds.getSize(this._tmpSize);

		// Fractional grid coordinates; 0.5 offset maps cell centres.
		const gx = ((worldPos.x - this.bounds.min.x) / s.x) * this.nx - 0.5;
		const gy = ((worldPos.y - this.bounds.min.y) / s.y) * this.ny - 0.5;
		const gz = ((worldPos.z - this.bounds.min.z) / s.z) * this.nz - 0.5;

		const ix0 = Math.max(0, Math.min(this.nx - 1, Math.floor(gx)));
		const iy0 = Math.max(0, Math.min(this.ny - 1, Math.floor(gy)));
		const iz0 = Math.max(0, Math.min(this.nz - 1, Math.floor(gz)));
		const ix1 = Math.min(this.nx - 1, ix0 + 1);
		const iy1 = Math.min(this.ny - 1, iy0 + 1);
		const iz1 = Math.min(this.nz - 1, iz0 + 1);

		const tx = Math.max(0, Math.min(1, gx - ix0));
		const ty = Math.max(0, Math.min(1, gy - iy0));
		const tz = Math.max(0, Math.min(1, gz - iz0));

		const s000 = this._sh[this._idx(ix0, iy0, iz0)];
		const s100 = this._sh[this._idx(ix1, iy0, iz0)];
		const s010 = this._sh[this._idx(ix0, iy1, iz0)];
		const s110 = this._sh[this._idx(ix1, iy1, iz0)];
		const s001 = this._sh[this._idx(ix0, iy0, iz1)];
		const s101 = this._sh[this._idx(ix1, iy0, iz1)];
		const s011 = this._sh[this._idx(ix0, iy1, iz1)];
		const s111 = this._sh[this._idx(ix1, iy1, iz1)];

		const out = this._activeProbe.sh.coefficients;

		for (let j = 0; j < 9; j++) {
			const c000 = s000?.coefficients[j];
			const c100 = s100?.coefficients[j];
			const c010 = s010?.coefficients[j];
			const c110 = s110?.coefficients[j];
			const c001 = s001?.coefficients[j];
			const c101 = s101?.coefficients[j];
			const c011 = s011?.coefficients[j];
			const c111 = s111?.coefficients[j];

			out[j].x = trilinear(
				c000?.x ?? 0, c100?.x ?? 0, c010?.x ?? 0, c110?.x ?? 0,
				c001?.x ?? 0, c101?.x ?? 0, c011?.x ?? 0, c111?.x ?? 0,
				tx, ty, tz,
			);
			out[j].y = trilinear(
				c000?.y ?? 0, c100?.y ?? 0, c010?.y ?? 0, c110?.y ?? 0,
				c001?.y ?? 0, c101?.y ?? 0, c011?.y ?? 0, c111?.y ?? 0,
				tx, ty, tz,
			);
			out[j].z = trilinear(
				c000?.z ?? 0, c100?.z ?? 0, c010?.z ?? 0, c110?.z ?? 0,
				c001?.z ?? 0, c101?.z ?? 0, c011?.z ?? 0, c111?.z ?? 0,
				tx, ty, tz,
			);
		}
	}

	// Bake SH at each cell; probe is removed during capture so it doesn't
	// corrupt the captured radiance with its own contribution.
	async bake(renderer, scene, cubeFaceSize = 64, onProgress) {
		if (this._inScene) scene.remove(this._activeProbe);

		const cubeRT = new WebGLCubeRenderTarget(cubeFaceSize);
		cubeRT.texture.format = RGBAFormat;
		const cubeCamera = new CubeCamera(0.01, 10000, cubeRT);
		scene.add(cubeCamera);

		const total = this.nx * this.ny * this.nz;
		let done = 0;
		const pos  = new Vector3();
		const size = this.bounds.getSize(new Vector3());

		try {
			for (let iz = 0; iz < this.nz; iz++) {
				for (let iy = 0; iy < this.ny; iy++) {
					for (let ix = 0; ix < this.nx; ix++) {
						this._cellCenter(ix, iy, iz, pos, size);
						cubeCamera.position.copy(pos);
						cubeCamera.update(renderer, scene);

						const probe = await LightProbeGenerator.fromCubeRenderTarget(renderer, cubeRT);
						this._sh[this._idx(ix, iy, iz)] = probe.sh.clone();

						onProgress?.(++done / total);
					}
				}
			}
		} finally {
			scene.remove(cubeCamera);
			cubeRT.dispose();
			if (this._inScene) scene.add(this._activeProbe);
		}

		// Prime the active probe at the volume centre.
		this._applyTrilinear(this.bounds.getCenter(this._tmpPos));
	}

	addToScene(scene) {
		if (!this._inScene) {
			scene.add(this._activeProbe);
			this._inScene = true;
		}
	}

	removeFromScene(scene) {
		if (this._inScene) {
			scene.remove(this._activeProbe);
			this._inScene = false;
		}
	}

	// Clamps worldPos to the grid volume so the probe is always valid even
	// when the camera orbits outside the baked bounds.
	update(worldPos) {
		this._tmpPos.copy(worldPos).clamp(this.bounds.min, this.bounds.max);
		this._applyTrilinear(this._tmpPos);
	}

	toJSON() {
		const coefficients = this._sh.map((sh) => {
			if (!sh) return null;
			const packed = [];
			for (let j = 0; j < 9; j++) {
				const c = sh.coefficients[j];
				packed.push(
					Math.round(c.x * 4096),
					Math.round(c.y * 4096),
					Math.round(c.z * 4096),
				);
			}
			return packed;
		});

		return {
			type: 'LightProbeGrid',
			nx: this.nx,
			ny: this.ny,
			nz: this.nz,
			bounds: {
				min: this.bounds.min.toArray(),
				max: this.bounds.max.toArray(),
			},
			coefficients,
		};
	}

	static fromJSON(json) {
		if (json.type !== 'LightProbeGrid') throw new Error('Invalid LightProbeGrid JSON');

		const bounds = new Box3();
		bounds.min.fromArray(json.bounds.min);
		bounds.max.fromArray(json.bounds.max);

		const grid = new LightProbeGrid(json.nx, json.ny, json.nz, bounds);

		grid._sh = json.coefficients.map((packed) => {
			if (!packed) return null;
			const sh = new SphericalHarmonics3();
			for (let j = 0; j < 9; j++) {
				sh.coefficients[j].set(
					packed[j * 3]     / 4096,
					packed[j * 3 + 1] / 4096,
					packed[j * 3 + 2] / 4096,
				);
			}
			return sh;
		});

		grid._applyTrilinear(bounds.getCenter(grid._tmpPos));

		return grid;
	}

	dispose() {
		this._sh = [];
	}
}
