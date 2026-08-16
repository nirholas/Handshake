/**
 * SceneExplorer — side panel with a collapsible scene tree, node inspector,
 * click-to-select raycasting, and a TransformControls gizmo.
 *
 * All structural changes (position/rotation/scale/visibility) are written
 * to the EditorSession so they can be re-applied at GLB export time.
 */
import { Box3, Raycaster, Vector3 } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const ICONS = {
	Mesh: '📦',
	SkinnedMesh: '🧍',
	Group: '🎯',
	Object3D: '▫',
	Bone: '🦴',
	DirectionalLight: '💡',
	PointLight: '💡',
	SpotLight: '💡',
	AmbientLight: '💡',
	HemisphereLight: '💡',
	PerspectiveCamera: '📷',
	OrthographicCamera: '📷',
	Scene: '🌳',
};

function escapeHTML(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function iconFor(node) {
	return ICONS[node.type] || (node.isMesh ? '📦' : '▫');
}

export class SceneExplorer {
	constructor(viewer, session) {
		this.viewer = viewer;
		this.session = session;
		this.panel = null;
		this.treeEl = null;
		this.inspectorEl = null;
		this.searchEl = null;
		this.selectedNode = null;
		this.transformControls = null;
		this.raycaster = new Raycaster();
		this._onKeyDown = this._onKeyDown.bind(this);
		this._onPointerDown = this._onPointerDown.bind(this);
		this._attached = false;
	}

	attach() {
		if (this._attached) return;
		this._attached = true;
		this._buildPanel();
		this._setupTransformControls();
		this.viewer.renderer.domElement.addEventListener('pointerdown', this._onPointerDown);
		window.addEventListener('keydown', this._onKeyDown);
	}

	detach() {
		if (!this._attached) return;
		this._attached = false;
		if (this.panel) {
			this.panel.remove();
			this.panel = null;
		}
		if (this.transformControls) {
			this.transformControls.detach();
			const helper = this.transformControls.getHelper
				? this.transformControls.getHelper()
				: this.transformControls;
			this.viewer.scene.remove(helper);
			this.transformControls.dispose?.();
			this.transformControls = null;
		}
		if (this.viewer.renderer?.domElement) {
			this.viewer.renderer.domElement.removeEventListener('pointerdown', this._onPointerDown);
		}
		window.removeEventListener('keydown', this._onKeyDown);
	}

	toggle(show) {
		if (!this.panel) return;
		const willShow = show === undefined ? this.panel.classList.contains('hidden') : show;
		this.panel.classList.toggle('hidden', !willShow);
	}

	rebuild() {
		if (!this.treeEl) return;
		this.selectedNode = null;
		this.transformControls?.detach();
		this.treeEl.innerHTML = '';
		this.inspectorEl.innerHTML =
			'<div class="scene-explorer__empty">Select a node to inspect</div>';

		if (!this.viewer.content) {
			this.treeEl.innerHTML = '<div class="scene-explorer__empty">No model loaded</div>';
			return;
		}
		this.treeEl.appendChild(this._buildNodeElement(this.viewer.content, 0, true));
	}

	_buildPanel() {
		const panel = document.createElement('div');
		panel.className = 'scene-explorer hidden';
		panel.innerHTML = `
			<div class="scene-explorer__header">
				<span class="scene-explorer__title">Scene</span>
				<button class="scene-explorer__close" type="button" title="Close [T]" aria-label="Close scene explorer">×</button>
			</div>
			<input type="text" class="scene-explorer__search" placeholder="Search nodes…" aria-label="Search scene nodes">
			<div class="scene-explorer__hint">W translate · E rotate · R scale · Esc deselect</div>
			<div class="scene-explorer__tree"></div>
			<div class="scene-explorer__inspector"></div>
		`;
		this.viewer.el.appendChild(panel);
		this.panel = panel;
		this.treeEl = panel.querySelector('.scene-explorer__tree');
		this.inspectorEl = panel.querySelector('.scene-explorer__inspector');
		this.searchEl = panel.querySelector('.scene-explorer__search');

		panel.querySelector('.scene-explorer__close').addEventListener('click', () => {
			this.toggle(false);
		});
		this.searchEl.addEventListener('input', () => {
			this._filter(this.searchEl.value);
		});
	}

	_buildNodeElement(node, depth, autoExpand = false) {
		const div = document.createElement('div');
		div.className = 'scene-node';
		div.dataset.uuid = node.uuid;

		const hasChildren = node.children && node.children.length > 0;
		const name = node.name || node.type;
		const label = escapeHTML(name);

		const row = document.createElement('div');
		row.className = 'scene-node__row';
		row.style.paddingLeft = depth * 12 + 'px';
		row.innerHTML = `
			<span class="scene-node__expander">${hasChildren ? '▸' : '·'}</span>
			<span class="scene-node__icon">${iconFor(node)}</span>
			<span class="scene-node__label" title="${label}">${label}</span>
			<button class="scene-node__visibility" title="Toggle visibility">${node.visible ? '●' : '○'}</button>
		`;

		const childrenEl = document.createElement('div');
		childrenEl.className = 'scene-node__children';
		if (autoExpand) childrenEl.classList.add('open');

		const expander = row.querySelector('.scene-node__expander');
		const visBtn = row.querySelector('.scene-node__visibility');

		row.addEventListener('click', (e) => {
			if (e.target === visBtn || e.target === expander) return;
			this.selectNode(node);
		});
		row.addEventListener('dblclick', () => this._frameNode(node));

		if (hasChildren) {
			expander.addEventListener('click', (e) => {
				e.stopPropagation();
				const open = childrenEl.classList.toggle('open');
				expander.textContent = open ? '▾' : '▸';
			});
			if (autoExpand) expander.textContent = '▾';
		}

		visBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			node.visible = !node.visible;
			visBtn.textContent = node.visible ? '●' : '○';
			this.session.recordVisibilityEdit(node, node.visible);
			this.viewer.invalidate();
		});

		div.appendChild(row);
		div.appendChild(childrenEl);

		if (hasChildren) {
			node.children.forEach((child) => {
				childrenEl.appendChild(this._buildNodeElement(child, depth + 1));
			});
		}
		return div;
	}

	selectNode(node) {
		this.selectedNode = node;
		this.treeEl
			.querySelectorAll('.scene-node__row.selected')
			.forEach((r) => r.classList.remove('selected'));
		const target = this.treeEl.querySelector(
			`.scene-node[data-uuid="${node.uuid}"] > .scene-node__row`,
		);
		if (target) target.classList.add('selected');

		if (
			this.transformControls &&
			node !== this.viewer.content.parent &&
			!node.isScene &&
			node !== this.viewer.defaultCamera
		) {
			try {
				this.transformControls.attach(node);
			} catch (e) {}
		}
		this._renderInspector(node);
		this.viewer.invalidate();
	}

	_renderInspector(node) {
		if (!this.inspectorEl) return;
		const rad2deg = 180 / Math.PI;
		const parts = [];
		parts.push(`<div class="inspector__title">${escapeHTML(node.name || node.type)}</div>`);
		parts.push(
			`<div class="inspector__sub">${node.type} · uuid: ${node.uuid.slice(0, 8)}</div>`,
		);

		parts.push('<div class="inspector__section">Transform</div>');
		parts.push(this._vec3Row('pos', [node.position.x, node.position.y, node.position.z]));
		parts.push(
			this._vec3Row('rot°', [
				node.rotation.x * rad2deg,
				node.rotation.y * rad2deg,
				node.rotation.z * rad2deg,
			]),
		);
		parts.push(this._vec3Row('scl', [node.scale.x, node.scale.y, node.scale.z]));

		if (node.isMesh && node.geometry) {
			const g = node.geometry;
			const posAttr = g.getAttribute('position');
			const vertices = posAttr ? posAttr.count : 0;
			const index = g.getIndex();
			const triangles = Math.round(index ? index.count / 3 : vertices / 3);
			const attrs = Object.keys(g.attributes).join(', ');
			parts.push('<div class="inspector__section">Geometry</div>');
			parts.push(this._kv('vertices', vertices));
			parts.push(this._kv('triangles', triangles));
			parts.push(this._kv('indexed', index ? 'yes' : 'no'));
			parts.push(this._kv('attrs', attrs));
			if (posAttr) {
				try {
					const box = new Box3().setFromBufferAttribute(posAttr);
					const size = new Vector3();
					box.getSize(size);
					parts.push(
						this._kv(
							'size',
							`${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`,
						),
					);
				} catch (e) {}
			}
			const mats = Array.isArray(node.material) ? node.material : [node.material];
			parts.push(
				this._kv(
					'materials',
					mats
						.filter(Boolean)
						.map((m) => m.name || m.type)
						.join(', '),
				),
			);
		}

		if (node.isLight) {
			parts.push('<div class="inspector__section">Light</div>');
			parts.push(this._kv('intensity', node.intensity?.toFixed(2)));
			if (node.color) parts.push(this._kv('color', '#' + node.color.getHexString()));
			if (node.distance !== undefined) parts.push(this._kv('distance', node.distance));
		}

		if (node.isCamera) {
			parts.push('<div class="inspector__section">Camera</div>');
			if (node.fov) parts.push(this._kv('fov', node.fov.toFixed(1) + '°'));
			parts.push(this._kv('near', node.near));
			parts.push(this._kv('far', node.far));
		}

		parts.push('<div class="inspector__section">Actions</div>');
		parts.push(
			`<div class="inspector__actions">
				<button data-act="frame">Frame</button>
				<button data-act="hide">${node.visible ? 'Hide' : 'Show'}</button>
				<button data-act="deselect">Deselect</button>
			</div>`,
		);

		this.inspectorEl.innerHTML = parts.join('');

		this.inspectorEl.querySelectorAll('.vec3-row input').forEach((inp) => {
			inp.addEventListener('change', () => this._onVec3Change(node));
		});

		this.inspectorEl
			.querySelector('[data-act="frame"]')
			?.addEventListener('click', () => this._frameNode(node));
		this.inspectorEl.querySelector('[data-act="hide"]')?.addEventListener('click', () => {
			node.visible = !node.visible;
			this.session.recordVisibilityEdit(node, node.visible);
			const visBtn = this.treeEl.querySelector(
				`.scene-node[data-uuid="${node.uuid}"] .scene-node__visibility`,
			);
			if (visBtn) visBtn.textContent = node.visible ? '●' : '○';
			this._renderInspector(node);
			this.viewer.invalidate();
		});
		this.inspectorEl.querySelector('[data-act="deselect"]')?.addEventListener('click', () => {
			this.transformControls?.detach();
			this.selectedNode = null;
			this.treeEl
				.querySelectorAll('.scene-node__row.selected')
				.forEach((r) => r.classList.remove('selected'));
			this.inspectorEl.innerHTML =
				'<div class="scene-explorer__empty">Select a node to inspect</div>';
			this.viewer.invalidate();
		});
	}

	_onVec3Change(node) {
		const rows = this.inspectorEl.querySelectorAll('.vec3-row');
		if (rows.length < 3) return;
		const read = (row) => {
			const inputs = row.querySelectorAll('input');
			return [
				parseFloat(inputs[0].value) || 0,
				parseFloat(inputs[1].value) || 0,
				parseFloat(inputs[2].value) || 0,
			];
		};
		const [px, py, pz] = read(rows[0]);
		const [rx, ry, rz] = read(rows[1]);
		const [sx, sy, sz] = read(rows[2]);
		const deg2rad = Math.PI / 180;
		node.position.set(px, py, pz);
		node.rotation.set(rx * deg2rad, ry * deg2rad, rz * deg2rad);
		node.scale.set(sx || 0.0001, sy || 0.0001, sz || 0.0001);
		this.session.recordTransformEdit(node);
		this.viewer.invalidate();
	}

	_vec3Row(label, values) {
		const [x, y, z] = values;
		return `<div class="inspector__row vec3-row">
			<span class="inspector__label">${label}</span>
			<span class="vec3">
				<input type="number" step="0.01" value="${x.toFixed(3)}">
				<input type="number" step="0.01" value="${y.toFixed(3)}">
				<input type="number" step="0.01" value="${z.toFixed(3)}">
			</span>
		</div>`;
	}

	_kv(k, v) {
		return `<div class="inspector__row">
			<span class="inspector__label">${k}</span>
			<span class="inspector__value">${escapeHTML(v ?? '')}</span>
		</div>`;
	}

	_frameNode(node) {
		const box = new Box3().setFromObject(node);
		if (box.isEmpty()) return;
		const center = new Vector3();
		const size = new Vector3();
		box.getCenter(center);
		box.getSize(size);
		const radius = Math.max(size.length(), 0.001);
		const cam = this.viewer.defaultCamera;
		const ctrl = this.viewer.controls;
		const dir = cam.position.clone().sub(ctrl.target).normalize();
		if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
		ctrl.target.copy(center);
		cam.position.copy(center).add(dir.multiplyScalar(radius * 1.5));
		ctrl.update();
		this.viewer.invalidate();
	}

	_filter(query) {
		const q = query.trim().toLowerCase();
		const rows = this.treeEl.querySelectorAll('.scene-node');
		rows.forEach((row) => {
			const label = row.querySelector('.scene-node__label');
			if (!label) return;
			const match = !q || label.textContent.toLowerCase().includes(q);
			row.classList.toggle('filtered-out', !match);
			if (match && q) {
				let p = row.parentElement;
				while (p && p.classList.contains('scene-node__children')) {
					p.classList.add('open');
					const exp = p.previousElementSibling?.querySelector('.scene-node__expander');
					if (exp) exp.textContent = '▾';
					p = p.parentElement?.parentElement;
				}
			}
		});
	}

	_setupTransformControls() {
		const tc = new TransformControls(
			this.viewer.defaultCamera,
			this.viewer.renderer.domElement,
		);
		tc.addEventListener('dragging-changed', (e) => {
			this.viewer.controls.enabled = !e.value;
		});
		tc.addEventListener('objectChange', () => {
			if (this.selectedNode) {
				this.session.recordTransformEdit(this.selectedNode);
				if (this.inspectorEl && this.selectedNode === this.selectedNode) {
					this._renderInspector(this.selectedNode);
				}
			}
			this.viewer.invalidate();
		});
		tc.addEventListener('change', () => this.viewer.invalidate());
		this.viewer.scene.add(tc.getHelper ? tc.getHelper() : tc);
		this.transformControls = tc;
	}

	_onKeyDown(e) {
		if (this.viewer.isInputFocused()) return;
		if (!this.transformControls) return;

		if (e.key === 't' || e.key === 'T') {
			e.preventDefault();
			this.toggle();
			return;
		}
		if (this.panel?.classList.contains('hidden')) return;

		if (e.key === 'w' || e.key === 'W') this.transformControls.setMode('translate');
		else if (e.key === 'e' || e.key === 'E') this.transformControls.setMode('rotate');
		else if (e.key === 'r' || e.key === 'R') this.transformControls.setMode('scale');
		else if (e.key === 'Escape') {
			this.transformControls.detach();
			this.selectedNode = null;
		}
	}

	_onPointerDown(e) {
		if (e.button !== 0) return;
		if (this.panel?.classList.contains('hidden')) return;
		if (this.transformControls?.dragging) return;
		if (!this.viewer.content) return;
		if (this.panel && this.panel.contains(e.target)) return;

		const rect = this.viewer.renderer.domElement.getBoundingClientRect();
		const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

		this.raycaster.setFromCamera({ x, y }, this.viewer.defaultCamera);
		const hits = this.raycaster.intersectObject(this.viewer.content, true);
		if (hits.length > 0) {
			let target = hits[0].object;
			while (target.parent && !(target.isMesh || target.isLight || target.isCamera)) {
				target = target.parent;
			}
			this.selectNode(target);
		}
	}
}
