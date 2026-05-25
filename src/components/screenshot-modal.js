export class ScreenshotModal {
	constructor(container) {
		this.container = container;
		this.blob = null;
		this.url = null;
		this._build();
	}

	_build() {
		this.el = document.createElement('div');
		this.el.className = 'screenshot-modal-backdrop';
		this.el.style.display = 'none';

		this.el.innerHTML = `
			<div class="screenshot-modal">
				<div class="screenshot-modal-header">
					<h3>Screenshot Captured</h3>
					<button class="screenshot-modal-close" title="Close">&times;</button>
				</div>
				<div class="screenshot-modal-body">
					<img src="" alt="Screenshot preview" />
				</div>
				<div class="screenshot-modal-footer">
					<button class="btn-secondary screenshot-modal-copy">Copy</button>
					<a href="https://x.com/intent/tweet?text=Check%20out%20my%203D%20Agent!&url=${encodeURIComponent(
						window.location.href,
					)}" target="_blank" rel="noopener noreferrer" class="btn-secondary screenshot-modal-share">Share on X</a>
					<button class="btn-primary screenshot-modal-download">Download</button>
				</div>
			</div>
		`;

		this.container.appendChild(this.el);

		this.previewImg = this.el.querySelector('img');
		const copyBtn = this.el.querySelector('.screenshot-modal-copy');

		this.el
			.querySelector('.screenshot-modal-close')
			.addEventListener('click', () => this.hide());
		this.el
			.querySelector('.screenshot-modal-download')
			.addEventListener('click', () => this._download());
		copyBtn.addEventListener('click', () => this._copy(copyBtn));

		if (!navigator.clipboard || !navigator.clipboard.write) {
			copyBtn.style.display = 'none';
		}
	}

	show(blob) {
		this.blob = blob;
		this.url = URL.createObjectURL(blob);
		this.previewImg.src = this.url;
		this.el.style.display = '';
	}

	hide() {
		if (this.url) {
			URL.revokeObjectURL(this.url);
			this.url = null;
		}
		this.blob = null;
		this.el.style.display = 'none';
	}

	_download() {
		if (!this.url) return;
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		const link = document.createElement('a');
		link.download = `3d-agent-screenshot-${timestamp}.png`;
		link.href = this.url;
		link.click();
	}

	async _copy(btn) {
		if (!this.blob) return;
		const originalText = btn.textContent;
		try {
			await navigator.clipboard.write([new ClipboardItem({ 'image/png': this.blob })]);
			btn.textContent = 'Copied!';
			setTimeout(() => {
				btn.textContent = originalText;
			}, 2000);
		} catch (e) {
			console.error('Failed to copy image to clipboard:', e);
			btn.textContent = 'Error!';
			setTimeout(() => {
				btn.textContent = originalText;
			}, 2000);
		}
	}
}
