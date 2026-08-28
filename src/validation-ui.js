/**
 * ValidationDashboard — UI controller for browsing and submitting validation records on-chain.
 *
 * Uses:
 * - GET /api/erc8004/validation (walletless) to fetch the latest verdict
 * - recordValidation() to submit new reports (request + response, two txs)
 * - hashReport() to compute client-side hash
 * - pinFile() for IPFS storage
 * - ethers for wallet connection
 */

import { ensureWallet } from './erc8004/agent-registry.js';
import { recordValidation, hashReport } from './erc8004/validation-recorder.js';
import { fetchValidationState } from './shared/validation-badge.js';
import { resolveURI } from './ipfs.js';

/**
 * Latest on-chain verdict for an agent, shaped for renderRecord(). Returns null
 * when the chain has no registry, or has no answered validation for this agent.
 */
async function fetchLatestValidation(chainId, agentId) {
	const state = await fetchValidationState(chainId, agentId);
	if (!state || !state.exists) return null;
	return {
		kind: state.kind,
		passed: state.passed,
		validator: state.validator,
		timestamp: state.timestamp,
		proofHash: state.proofHash,
		proofURI: state.proofUrlResolved || state.proofURI || '',
	};
}

export class ValidationDashboard {
	constructor(root, els) {
		this.root = root;
		this.els = els;
		this.currentAgentId = null;
		this.currentChainId = null;
		this.currentReport = null;
		this.currentReportHash = null;
		this.signer = null;

		this.setupEventListeners();
		this._loadFromUrlParams();
	}

	_loadFromUrlParams() {
		const p = new URLSearchParams(location.search);
		const agent = p.get('agent');
		const chain = p.get('chain');
		if (agent) this.els.agentInput.value = agent;
		if (chain) this.els.chainInput.value = chain;
		if (agent && chain) this.loadRecords();
	}

	_syncUrl() {
		if (!this.currentAgentId || !this.currentChainId) return;
		const url = new URL(location.href);
		url.searchParams.set('agent', String(this.currentAgentId));
		url.searchParams.set('chain', String(this.currentChainId));
		history.replaceState(null, '', url);
	}

	_copyHash(hash) {
		navigator.clipboard.writeText(hash).then(() => this.showToast('Hash copied'));
	}

	_copyAddr(addr) {
		navigator.clipboard.writeText(addr).then(() => this.showToast('Address copied'));
	}

	setupEventListeners() {
		this.els.loadBtn.addEventListener('click', () => this.loadRecords());
		this.els.submitBtn.addEventListener('click', () => this.openModal());
		this.els.reportFile.addEventListener('change', (e) => this.handleFileSelect(e));
		this.els.submitReportBtn.addEventListener('click', () => this.submitReport());
		this.els.agentInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') this.loadRecords();
		});
		this.els.chainInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') this.loadRecords();
		});

		// Modal: dismissible the two ways every dialog is expected to be, with
		// focus kept inside it while it is open.
		this.els.submitModal.addEventListener('mousedown', (e) => {
			if (e.target === this.els.submitModal) this.closeModal();
		});
		document.addEventListener('keydown', (e) => {
			if (!this.els.submitModal.classList.contains('open')) return;
			if (e.key === 'Escape') {
				e.preventDefault();
				this.closeModal();
			} else if (e.key === 'Tab') {
				this._trapFocus(e);
			}
		});

		// Record rows are rendered from strings, so their copy affordances declare
		// what they carry and this delegated listener does the work. Inline onclick
		// attributes cannot run under the site CSP.
		document.addEventListener('click', (e) => {
			const addr = e.target.closest('[data-copy-addr]');
			if (addr) return this._copyAddr(addr.dataset.copyAddr);
			const hash = e.target.closest('[data-copy-hash]');
			if (hash) this._copyHash(hash.dataset.copyHash);
		});

		document.addEventListener('dragover', (e) => {
			if (this.els.submitModal.classList.contains('open')) {
				e.preventDefault();
			}
		});

		document.addEventListener('drop', (e) => {
			if (this.els.submitModal.classList.contains('open')) {
				e.preventDefault();
				const files = e.dataTransfer.files;
				if (files.length > 0) {
					this.els.reportFile.files = files;
					this.handleFileSelect({ target: { files } });
				}
			}
		});
	}

	showError(msg) {
		this.els.errorEl.textContent = msg;
		this.els.errorEl.style.display = 'block';
	}

	hideError() {
		this.els.errorEl.style.display = 'none';
	}

	showInfo(msg) {
		this.els.infoEl.textContent = msg;
		this.els.infoEl.style.display = 'block';
	}

	hideInfo() {
		this.els.infoEl.style.display = 'none';
	}

	showToast(msg, isError = false) {
		const toast = document.createElement('div');
		toast.className = `toast ${isError ? 'err' : ''}`;
		toast.textContent = msg;
		document.body.appendChild(toast);
		setTimeout(() => toast.remove(), 3000);
	}

	async loadRecords() {
		this.hideError();
		this.hideInfo();

		const agentId = this.els.agentInput.value.trim();
		const chainId = this.els.chainInput.value.trim();

		if (!agentId || !chainId) {
			this.showError('Please enter both Agent ID and Chain ID');
			return;
		}

		this.currentAgentId = Number(agentId);
		this.currentChainId = Number(chainId);

		try {
			this.els.loadBtn.disabled = true;
			this.showInfo('Loading validation records...');

			// Read through the walletless server route: it fans out over the RPC
			// failover chain and needs no wallet, so records load for a visitor who
			// never connected one.
			const result = await fetchLatestValidation(this.currentChainId, this.currentAgentId);

			this.hideInfo();
			this.renderRecords(result);
			this._syncUrl();
		} catch (err) {
			this.showError(`Failed to load records: ${err.message}`);
			this.els.recordsContainer.innerHTML = '';
			this.els.emptyState.style.display = 'block';
		} finally {
			this.els.loadBtn.disabled = false;
		}
	}

	renderRecords(records) {
		if (!records || (Array.isArray(records) && records.length === 0)) {
			this.els.recordsContainer.innerHTML = '';
			this.els.emptyState.style.display = 'block';
			return;
		}

		this.els.emptyState.style.display = 'none';
		const recordArray = Array.isArray(records) ? records : [records];

		this.els.recordsContainer.innerHTML = recordArray.map((r) => this.renderRecord(r)).join('');
	}

	_kindLabel(kind) {
		const map = {
			'glb-schema': 'GLB Schema',
			'manifest-integrity': 'Manifest Integrity',
			'skill-handlers-load': 'Skill Handlers',
		};
		return map[kind] || kind;
	}

	renderRecord(record) {
		const verdict = record.verdict || (record.passed ? 'pass' : 'fail');
		const timestamp = record.timestamp
			? new Date(Number(record.timestamp) * 1000).toLocaleString()
			: 'Unknown';

		const reportUri = record.reportUri || record.proofURI || '';
		const reportHash = record.reportHash || record.proofHash || '';
		const validator = record.validator || 'Unknown';
		const kind = record.kind || 'glb-schema';
		const notes = record.notes || '';

		const validatorShort = validator !== 'Unknown'
			? `${validator.substring(0, 6)}…${validator.substring(validator.length - 4)}`
			: 'Unknown';

		return `
			<div class="record">
				<div class="record-header">
					<div class="record-title">
						<h3>${this.escapeHtml(this._kindLabel(kind))}</h3>
						<span class="badge ${verdict}">${verdict.toUpperCase()}</span>
					</div>
					<div style="font-size:12px;color:#666">${timestamp}</div>
				</div>
				<div class="record-meta">
					<div class="record-meta-item">
						<div class="record-meta-label">Validator</div>
						<div class="record-meta-value" title="${this.escapeHtml(validator)}" style="cursor:pointer" data-copy-addr="${this.escapeHtml(validator)}">${this.escapeHtml(validatorShort)}</div>
					</div>
					<div class="record-meta-item" style="flex:1">
						<div class="record-meta-label">Report Hash</div>
						<div class="record-meta-value">${reportHash ? this.escapeHtml(reportHash.substring(0, 18)) + '…' : 'none recorded'}</div>
					</div>
				</div>
				${notes ? `<div class="record-notes">${this.escapeHtml(notes)}</div>` : ''}
				<div class="record-actions">
					${reportUri ? `<a href="${this.resolveIPFS(this.escapeHtml(reportUri))}" target="_blank" rel="noopener noreferrer">View Report ↗</a>` : ''}
					${reportHash ? `<button type="button" data-copy-hash="${this.escapeHtml(reportHash)}">Copy Hash</button>` : ''}
				</div>
			</div>
		`;
	}

	_focusables() {
		return Array.from(
			this.els.submitModal.querySelectorAll(
				'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
			),
		).filter((el) => el.offsetParent !== null);
	}

	_trapFocus(e) {
		const items = this._focusables();
		if (!items.length) return;
		const first = items[0];
		const last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	openModal() {
		this._returnFocusTo = document.activeElement;
		this.els.submitModal.classList.add('open');
		this.currentReport = null;
		this.currentReportHash = null;
		this.els.previewSection.style.display = 'none';
		this.els.hashSection.style.display = 'none';
		this.els.reportFile.value = '';
		this.els.fileStatus.textContent = '';
		this.els.submitReportBtn.disabled = true;
		// Focus the dialog itself so its title is announced and Escape/Tab land
		// inside it. The offsetWidth read is not decoration: it flushes the style
		// change above, and focus() on a still-computed-hidden subtree is a noop.
		const dialog = this.els.submitModal.querySelector('.modal');
		if (dialog) {
			void this.els.submitModal.offsetWidth;
			dialog.focus();
		}
	}

	closeModal() {
		this.els.submitModal.classList.remove('open');
		if (this._returnFocusTo && this._returnFocusTo.isConnected) this._returnFocusTo.focus();
		this._returnFocusTo = null;
	}

	async handleFileSelect(e) {
		const file = e.target.files?.[0];
		if (!file) {
			this.els.fileStatus.textContent = '';
			this.els.previewSection.style.display = 'none';
			this.els.hashSection.style.display = 'none';
			this.els.submitReportBtn.disabled = true;
			return;
		}

		try {
			const text = await file.text();
			const report = JSON.parse(text);

			this.currentReport = report;
			this.currentReportHash = hashReport(report);

			this.els.fileStatus.textContent = `✓ ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
			this.els.fileStatus.style.color = '#76d776';

			this.els.previewJson.textContent = JSON.stringify(report, null, 2);
			this.els.previewSection.style.display = 'block';
			this.els.previewError.style.display = 'none';

			this.els.reportHash.value = this.currentReportHash;
			this.els.hashSection.style.display = 'block';

			this.els.submitReportBtn.disabled = false;
		} catch (err) {
			this.els.fileStatus.textContent = '✗ Invalid JSON';
			this.els.fileStatus.style.color = '#ffb3b3';
			this.els.previewError.textContent = err.message;
			this.els.previewError.style.display = 'block';
			this.els.submitReportBtn.disabled = true;
			this.currentReport = null;
			this.currentReportHash = null;
		}
	}

	async submitReport() {
		if (!this.currentReport || !this.currentReportHash) {
			this.showToast('No valid report selected', true);
			return;
		}

		const agentId = this.currentAgentId ?? Number(this.els.agentInput.value.trim());
		const chainId = this.currentChainId ?? Number(this.els.chainInput.value.trim());
		if (!agentId || !chainId) {
			this.showToast('Enter Agent ID and Chain ID before submitting', true);
			return;
		}
		this.currentAgentId = agentId;
		this.currentChainId = chainId;

		try {
			this.els.submitReportBtn.disabled = true;
			this.showToast('Connecting wallet...');

			const wallet = await ensureWallet();
			const signer = wallet.signer;

			// Two txs on a fresh report: the registry needs an open request before a
			// validator may answer it. An existing request is answered directly.
			this.showToast('Opening the validation request, then recording the verdict...');

			const result = await recordValidation({
				agentId: this.currentAgentId,
				report: this.currentReport,
				signer,
				chainId: this.currentChainId,
				apiToken: import.meta.env.VITE_IPFS_API_TOKEN,
				pin: true,
			});

			this.showToast(`✓ Validation recorded! TX: ${result.txHash.substring(0, 10)}...`, false);

			this.closeModal();
			await this.loadRecords();
		} catch (err) {
			this.showToast(`Error: ${err.message}`, true);
			this.els.submitReportBtn.disabled = false;
		}
	}

	// One hardcoded gateway is one outage away from every validation record
	// rendering blank. resolveURI walks the shared gateway list in src/ipfs.js,
	// which the rest of the platform already rotates through.
	resolveIPFS(uri) {
		return resolveURI(uri);
	}

	escapeHtml(str) {
		const map = {
			'&': '&amp;',
			'<': '&lt;',
			'>': '&gt;',
			'"': '&quot;',
			"'": '&#039;',
		};
		return str.replace(/[&<>"']/g, (m) => map[m]);
	}
}
