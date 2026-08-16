/**
 * POST /api/x402-checkout?action=encode rejects a transaction that can never
 * settle, keep passing everything else through.
 *
 * encode wraps the buyer's signed transaction into the base64 X-PAYMENT envelope.
 * Its pre-flight check (confirmSolanaPayment) is deliberately conservative:
 * anything it cannot decode returns `inconclusive` so a parsing quirk never
 * rejects a real payment. That left one gap worth closing: a blob that does not
 * deserialize into a Solana transaction AT ALL used to come back 200 with a fully
 * formed X-PAYMENT header, so the buyer saw "Sending…" and then an opaque
 * facilitator error instead of a clear one at the step that produced the bad
 * signature. Verified against a live handler before the fix: garbage bytes in,
 * 200 + x_payment out.
 *
 * The narrow rejection is safe by construction. An undeserializable blob has no
 * valid interpretation, so it cannot be a false reject.
 */

import { describe, it, expect } from 'vitest';
import { confirmSolanaPayment } from '../../api/_lib/x402-solana-confirm.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PAY_TO = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

const requirement = { asset: USDC, payTo: PAY_TO, amount: '10000' };

describe('encode pre-flight: undeserializable transactions are distinguishable', () => {
	it('reports undeserializable_transaction for random bytes', () => {
		const garbage = Buffer.alloc(300, 7).toString('base64');
		const check = confirmSolanaPayment({
			paymentPayload: { payload: { transaction: garbage } },
			requirement,
		});
		// Not a hard `confirmed: false`, which is why the handler needs the reason.
		expect(check.confirmed).toBeUndefined();
		expect(check.inconclusive).toBe(true);
		expect(check.reason).toBe('undeserializable_transaction');
	});

	it('reports a different reason for a missing transaction, so the 400 stays narrow', () => {
		const check = confirmSolanaPayment({ paymentPayload: { payload: {} }, requirement });
		expect(check.inconclusive).toBe(true);
		expect(check.reason).toBe('no_serialized_transaction');
	});

	it('does not flag a real prepared transaction as undeserializable', async () => {
		// Build the same v0 message shape handlePrepare emits, then round-trip it.
		const { PublicKey, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
		const {
			TOKEN_PROGRAM_ID,
			ASSOCIATED_TOKEN_PROGRAM_ID,
			getAssociatedTokenAddressSync,
			createTransferCheckedInstruction,
		} = await import('@solana/spl-token');

		const mint = new PublicKey(USDC);
		const payTo = new PublicKey(PAY_TO);
		const buyer = new PublicKey(PAY_TO);
		const senderAta = getAssociatedTokenAddressSync(mint, buyer, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
		const receiverAta = getAssociatedTokenAddressSync(mint, payTo, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
		const message = new TransactionMessage({
			payerKey: payTo,
			recentBlockhash: '11111111111111111111111111111111',
			instructions: [
				createTransferCheckedInstruction(senderAta, mint, receiverAta, buyer, 10000n, 6, [], TOKEN_PROGRAM_ID),
			],
		}).compileToV0Message();
		const tx = Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');

		const check = confirmSolanaPayment({ paymentPayload: { payload: { transaction: tx } }, requirement });
		expect(check.reason).not.toBe('undeserializable_transaction');
		expect(check.confirmed).toBe(true);
	});
});
