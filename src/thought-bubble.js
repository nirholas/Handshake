import { Vector3 } from 'three';

export class ThoughtBubble {
	constructor(viewer) {
		this.viewer = viewer;
		this._visible = false;
		this._hideTimer = null;
		this._projVec = new Vector3();
		this._build();
		this._hookRenderLoop();
	}

	_build() {
		this.el = document.createElement('div');
		this.el.className = 'thought-bubble';
		this._textEl = document.createElement('div');
		this._textEl.className = 'thought-bubble__text';
		this.el.appendChild(this._textEl);
		this.viewer.el.appendChild(this.el);
	}

	_hookRenderLoop() {
		if (!this.viewer._afterAnimateHooks) {
			this.viewer._afterAnimateHooks = [];
		}
		this._tickFn = () => this._updatePosition();
		this.viewer._afterAnimateHooks.push(this._tickFn);
	}

	_updatePosition() {
		if (!this._visible) return;

		const headPos = this.viewer.getHeadScreenPosition();
		if (!headPos) {
			this.el.style.opacity = '0';
			return;
		}

		const scale = this._computeScale(headPos);
		const offset = 28 * scale;

		this.el.style.left = headPos.x + 'px';
		this.el.style.top = (headPos.y - offset) + 'px';
		this.el.style.transform = `translate(-50%, -100%) scale(${scale.toFixed(3)})`;
		this.el.style.opacity = '';
	}

	_computeScale(headPos) {
		const v = this.viewer;
		if (!v.activeCamera || !v.renderer) return 1;

		this._projVec.set(0, 0, 0);
		this._projVec.project(v.activeCamera);
		const canvas = v.renderer.domElement;
		const feetY = (-this._projVec.y * 0.5 + 0.5) * canvas.clientHeight;

		const screenHeight = Math.abs(feetY - headPos.y);
		return Math.max(0.4, Math.min(1.4, screenHeight / 350));
	}

	showThinking() {
		this._textEl.innerHTML =
			'<span class="thought-bubble__dots">' +
			'<span></span><span></span><span></span>' +
			'</span>';
		this._setVisible(true);
		clearTimeout(this._hideTimer);
	}

	showMessage(text) {
		this._textEl.textContent = text;
		this._setVisible(true);

		clearTimeout(this._hideTimer);
		const readTime = Math.max(5000, Math.min(18000, text.length * 55));
		this._hideTimer = setTimeout(() => this.hide(), readTime);
	}

	hide() {
		clearTimeout(this._hideTimer);
		this._setVisible(false);
	}

	_setVisible(visible) {
		this._visible = visible;
		this.el.classList.toggle('thought-bubble--visible', visible);
		if (visible) this.viewer.invalidate();
	}

	dispose() {
		clearTimeout(this._hideTimer);
		this.el?.remove();
		const hooks = this.viewer._afterAnimateHooks;
		if (hooks) {
			const idx = hooks.indexOf(this._tickFn);
			if (idx > -1) hooks.splice(idx, 1);
		}
	}
}
