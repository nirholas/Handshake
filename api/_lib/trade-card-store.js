/**
 * Loader for a single shareable trade.
 *
 * Split out from the pure model (api/_lib/trade-card.js) so the model stays
 * database-free and unit-testable, while the OG image and the share page share
 * one query and can never read the row two different ways.
 *
 * Only CLOSED positions are shareable: a card needs a result. An open position,
 * an unknown id, or a deleted agent resolves to null and the caller renders its
 * own fallback.
 */

import { sql } from './db.js';
import { isUuid } from './validate.js';
import { shapeTradeCard } from './trade-card.js';

/**
 * @param {string} id  agent_sniper_positions.id
 * @param {{ origin?: string }} [opts]
 * @returns {Promise<object|null>} the card model, or null when not shareable
 */
export async function loadTradeCard(id, { origin = 'https://three.ws' } = {}) {
	if (!isUuid(id)) return null;

	let row;
	try {
		[row] = await sql`
			select p.id, p.agent_id, p.network, p.mint, p.symbol, p.name,
			       p.status, p.exit_reason,
			       p.entry_quote_lamports, p.exit_quote_lamports,
			       p.realized_pnl_lamports, p.realized_pnl_pct,
			       p.buy_sig, p.sell_sig,
			       p.moonbag_base_amount, p.moonbag_last_value_lamports,
			       p.opened_at, p.closed_at,
			       a.name              as agent_name,
			       a.profile_image_url as agent_image,
			       a.avatar_url        as agent_avatar
			from agent_sniper_positions p
			join agent_identities a on a.id = p.agent_id and a.deleted_at is null
			where p.id = ${id} and p.status = 'closed'
			limit 1
		`;
	} catch {
		return null;
	}
	if (!row) return null;

	return shapeTradeCard(row, { origin });
}
