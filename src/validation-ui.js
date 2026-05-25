/**
 * ValidationDashboard — UI controller for browsing and submitting validation records on-chain.
 *
 * Uses:
 * - getLatestValidation() to fetch past validation records
 * - recordValidation() to submit new reports
 * - hashReport() to compute client-side hash
 * - pinFile() for IPFS storage
 * - ethers for wallet connection
 */

import { ensureWallet } from './erc8004/agent-registry.js';
import {
	getLatestValidation,
	recordValidation,
	hashReport,
} from './erc8004/validation-recorder.js';

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

			const result = await getLatestValidation({
				agentId: this.currentAgentId,
				runner: null,
				chainId: this.currentChainId,
			});

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
						<div class="record-meta-value" title="${this.escapeHtml(validator)}" style="cursor:pointer" onclick="valDash._copyAddr('${this.escapeHtml(validator)}')">${this.escapeHtml(validatorShort)}</div>
					</div>
					<div class="record-meta-item" style="flex:1">
						<div class="record-meta-label">Report Hash</div>
						<div class="record-meta-value">${reportHash ? this.escapeHtml(reportHash.substring(0, 18)) + '…' : '—'}</div>
					</div>
				</div>
				${notes ? `<div class="record-notes">${this.escapeHtml(notes)}</div>` : ''}
				<div class="record-actions">
					${reportUri ? `<a href="${this.resolveIPFS(this.escapeHtml(reportUri))}" target="_blank" rel="noopener noreferrer">View Report ↗</a>` : ''}
					${reportHash ? `<button onclick="valDash._copyHash('${this.escapeHtml(reportHash)}')">Copy Hash</button>` : ''}
				</div>
			</div>
		`;
	}

	openModal() {
		this.els.submitModal.classList.add('open');
		this.currentReport = null;
		this.currentReportHash = null;
		this.els.previewSection.style.display = 'none';
		this.els.hashSection.style.display = 'none';
		this.els.reportFile.value = '';
		this.els.fileStatus.textContent = '';
		this.els.submitReportBtn.disabled = true;
	}

	closeModal() {
		this.els.submitModal.classList.remove('open');
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

			this.showToast('Submitting validation record on-chain...');

			const result = await recordValidation({
				agentId: this.currentAgentId,
				report: this.currentReport,
				signer,
				chainId: this.currentChainId,
				apiToken: import.meta.env.VITE_IPFS_API_TOKEN,
				pin: true,
			});

			this.showToast(
				`✓ Validation submitted! TX: ${result.txHash.substring(0, 10)}...`,
				false,
			);

			this.closeModal();

			await new Promise((r) => setTimeout(r, 2000));
			await this.loadRecords();
		} catch (err) {
			this.showToast(`Error: ${err.message}`, true);
			this.els.submitReportBtn.disabled = false;
		}
	}

	resolveIPFS(uri) {
		if (uri?.startsWith('ipfs://')) {
			const cid = uri.slice(7);
			return `https://dweb.link/ipfs/${cid}`;
		}
		return uri;
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
