/**
 * FaceMocapOverlay — visual debug layer for the webcam picture-in-picture.
 *
 * Renders, mirrored over the webcam feed:
 *   - 478 face landmark dots (lime accent to match three.ws brand)
 *   - Triangulated mesh wireframe (via MediaPipe's tesselation connector set)
 *   - Iris circles
 *   - Lip + eye + brow contour highlights
 *   - 3-axis head-pose gizmo at the nose tip (red X / green Y / blue Z),
 *     ported from RiggingJs's drawAxis but driven by the proper 4x4
 *     transformation matrix instead of derived landmark vectors.
 *
 * Drawing modes are toggleable so the user can choose a clean view (dots only)
 * or a full diagnostic view (wireframe + axes + contours).
 */

import { FaceLandmarker } from '@mediapipe/tasks-vision';
import { Matrix4, Vector3 } from 'three';

// Three.ws brand palette — the rest of the lab uses these exact values.
const COLORS = {
	dot:      '#d6ff3d',
	wire:     'rgba(214,255,61,0.18)',
	lips:     '#ff5e7e',
	eye:      '#7fc4ff',
	brow:     '#ffd23d',
	iris:     '#ffffff',
	axisX:    '#ff5e7e',
	axisY:    '#d6ff3d',
	axisZ:    '#7fc4ff',
};

export class FaceMocapOverlay {
	constructor(canvas) {
		this.canvas = canvas;
		this.ctx    = canvas.getContext('2d');
		this.modes  = {
			dots:     true,
			wire:     true,
			contours: true,
			iris:     true,
			axis:     true,
		};
		this._mat4 = new Matrix4();
		this._v3   = new Vector3();
	}

	/**
	 * Resize the canvas backing store to match the video element's intrinsic
	 * resolution. Should be called once after the video has dimensions.
	 */
	matchVideo(video) {
		this.canvas.width  = video.videoWidth  || 640;
		this.canvas.height = video.videoHeight || 480;
	}

	clear() {
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
	}

	/**
	 * Draw one frame of overlay graphics from a MediaPipe Face Landmarker result.
	 * Coordinates from MediaPipe are normalized (0..1). We render mirrored so the
	 * overlay aligns with the CSS-mirrored video.
	 */
	draw(result) {
		this.clear();
		if (!result?.faceLandmarks?.length) return;
		const lm = result.faceLandmarks[0];
		const W  = this.canvas.width;
		const H  = this.canvas.height;
		const ctx = this.ctx;

		// Mirror the canvas horizontally so it tracks the CSS-mirrored video.
		ctx.save();
		ctx.translate(W, 0);
		ctx.scale(-1, 1);

		if (this.modes.wire)     this._drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_TESSELATION, COLORS.wire, 0.5);
		if (this.modes.contours) {
			this._drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LIPS,           COLORS.lips, 1.5);
			this._drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,       COLORS.eye,  1.5);
			this._drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,      COLORS.eye,  1.5);
			this._drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,   COLORS.brow, 1.5);
			this._drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,  COLORS.brow, 1.5);
			this._drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,      'rgba(255,255,255,0.4)', 1);
		}
		if (this.modes.iris) {
			this._drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS,  COLORS.iris, 1.5);
			this._drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, COLORS.iris, 1.5);
		}
		if (this.modes.dots) {
			ctx.fillStyle = COLORS.dot;
			for (const p of lm) {
				ctx.fillRect(p.x * W - 1, p.y * H - 1, 2, 2);
			}
		}

		// Head-pose 3-axis gizmo — RiggingJs's signature visual, ported to use
		// the real face transformation matrix.
		if (this.modes.axis && result.facialTransformationMatrixes?.length) {
			const nose = lm[1] || lm[0]; // landmark 1 = nose tip
			this._drawAxis(result.facialTransformationMatrixes[0].data, nose.x * W, nose.y * H);
		}

		ctx.restore();
	}

	_drawConnectors(landmarks, connectors, color, width) {
		if (!connectors) return;
		const W = this.canvas.width, H = this.canvas.height;
		const ctx = this.ctx;
		ctx.strokeStyle = color;
		ctx.lineWidth   = width;
		ctx.beginPath();
		for (const c of connectors) {
			const a = landmarks[c.start];
			const b = landmarks[c.end];
			if (!a || !b) continue;
			ctx.moveTo(a.x * W, a.y * H);
			ctx.lineTo(b.x * W, b.y * H);
		}
		ctx.stroke();
	}

	_drawAxis(matData, originX, originY) {
		// Project unit axes from the face's local frame to 2D screen offsets.
		// We don't need a full camera projection — the matrix's upper-left 3x3
		// rotation, scaled to a pixel length, gives us a believable gizmo.
		this._mat4.fromArray(matData);
		const e = this._mat4.elements;
		const L = 60; // axis length in pixels
		const ctx = this.ctx;

		const axes = [
			{ x: e[0],  y: e[1],  color: COLORS.axisX },
			{ x: e[4],  y: e[5],  color: COLORS.axisY },
			{ x: e[8],  y: e[9],  color: COLORS.axisZ },
		];

		ctx.lineWidth = 3;
		for (const a of axes) {
			ctx.strokeStyle = a.color;
			ctx.beginPath();
			ctx.moveTo(originX, originY);
			// Y flips because canvas Y points down but face-space Y points up
			ctx.lineTo(originX + a.x * L, originY - a.y * L);
			ctx.stroke();
		}
	}
}
