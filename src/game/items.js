// Item display metadata for the /play client — names + glyphs the hotbar and
// inventory render. The authoritative item ids and quantities come from the
// server schema (GamePlayer.inv / .hotbar); this map is presentation only and
// mirrors the server's item vocabulary (tools, gathered resources, currency).
// Unknown ids degrade gracefully to a readable label + initial glyph so a new
// server-side item never renders as a blank slot.

export const ITEM_DISPLAY = {
	axe: { name: 'Axe', glyph: '🪓' },
	pickaxe: { name: 'Pickaxe', glyph: '⛏️' },
	rod: { name: 'Fishing rod', glyph: '🎣' },
	hammer: { name: 'Hammer', glyph: '🔨' },
	sword: { name: 'Sword', glyph: '⚔️' },
	wood: { name: 'Wood', glyph: '🪵' },
	stone: { name: 'Stone', glyph: '🪨' },
	coal: { name: 'Coal', glyph: '🪨' },
	fish: { name: 'Fish', glyph: '🐟' },
	gold: { name: 'Gold', glyph: '🪙' },
};

export function itemDisplay(id) {
	if (!id) return null;
	const known = ITEM_DISPLAY[id];
	if (known) return known;
	const name = String(id)
		.replace(/[-_]/g, ' ')
		.replace(/^\w/, (m) => m.toUpperCase());
	return { name, glyph: String(id).charAt(0).toUpperCase() };
}
