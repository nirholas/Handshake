/**
 * Server-side widget type registry — single source of truth for the API layer.
 *
 * Keep aligned with `src/widget-types.js` (which adds zod schemas + brand
 * defaults for the runtime). The arrays here are the authoritative enum the DB
 * CHECK constraint enforces and what `/api/widgets` accepts in POST/PATCH.
 */

export const WIDGET_TYPES = [
	'turntable',
	'animation-gallery',
	'talking-agent',
	'passport',
	'hotspot-tour',
	'pumpfun-feed',
	'kol-trades',
	'live-trades-canvas',
];

export const WIDGET_TYPE_SET = new Set(WIDGET_TYPES);

export function isWidgetType(t) {
	return typeof t === 'string' && WIDGET_TYPE_SET.has(t);
}
