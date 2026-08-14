/**
 * Agent Wallet hub — Proof of Custody tab (owner-only).
 *
 * Radical, verifiable transparency: the platform periodically anchors a Merkle
 * root over every custodial wallet's state on-chain. This tab shows the owner
 * their inclusion proof and lets them VERIFY it themselves — the verification
 * runs entirely in their browser (src/proof-of-custody/verifier.js): it
 * recomputes the leaf, walks the Merkle path, fetches the anchor straight off a
 * public Solana RPC, and confirms the on-chain root matches. It never trusts our
 * server for the answer, and it fails honestly (red, with the failing step) when
 * anything doesn't reconcile.
 *
 * Movement transparency is first-class: the reconciliation maps every balance
 * change since the previous epoch to an authorized, logged custody event, and
 * loudly flags any outflow the ledger can't explain.
 */

import { registerWalletTab } from '../registry.js';
import { apiFetch } from '../../api.js';
import { escapeHtml } from '../util.js';
import { verifyInclusionProof } from '../../proof-of-custody/verifier.js';
import { renderProofUI, injectProofStyle } from '../../proof-of-custody/ui.js';

registerWalletTab({
	id: 'proof',
	label: 'Proof of Custody',
	order: 70,
	ownerOnly: true,
	mount({ panel, ctx }) {
		injectProofStyle();
		let destroyed = false;

		async function load() {
			panel.innerHTML = skeleton();
			let proof;
			try {
				const res = await apiFetch(`/api/agents/${encodeURIComponent(ctx.agentId)}/solana/proof`, {
					allowAnonymous: true,
				});
				if (res.status === 401) { panel.innerHTML = signedOut(); return; }
				if (!res.ok) throw new Error(`proof request failed (${res.status})`);
				proof = (await res.json())?.data;
			} catch (err) {
				if (destroyed) return;
				panel.innerHTML = errorState(err.message);
				const retry = panel.querySelector('[data-retry]');
				retry?.addEventListener('click', load);
				retry?.focus();
				return;
			}
			if (destroyed) return;
			renderProofUI(panel, {
				proof,
				ctx,
				verify: verifyInclusionProof,
				shareBase: '/proof',
			});
		}

		load();
		return { destroy() { destroyed = true; } };
	},
});

function skeleton() {
	return `<div class="awh-proof awh-proof-skel" role="status" aria-busy="true" aria-label="Loading custody proof">
		<span style="height:64px"></span>
		<span style="height:120px"></span>
		<span style="height:90px"></span>
	</div>`;
}

function signedOut() {
	return `<div class="awh-proof"><div class="awh-proof-card">
		<h2>Sign in to view your proof</h2>
		<p class="awh-proof-lead">Custody proofs are private to the wallet owner. Sign in to verify this wallet's custody on-chain.</p>
		<a class="awh-proof-btn" href="/login?next=${encodeURIComponent(location.pathname + location.search)}">Sign in</a>
	</div></div>`;
}

function errorState(msg) {
	return `<div class="awh-proof"><div class="awh-proof-card awh-proof-bad" role="alert">
		<h2>Couldn't load your proof</h2>
		<p class="awh-proof-lead">${escapeHtml(msg)}</p>
		<p class="awh-proof-lead">This is usually a momentary network or RPC hiccup — retrying almost always clears it.</p>
		<button class="awh-proof-btn" data-retry type="button">Try again</button>
	</div></div>`;
}
