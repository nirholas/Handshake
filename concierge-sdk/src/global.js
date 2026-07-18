/**
 * CDN entry — @three-ws/concierge
 * ===============================
 *
 * The one-tag build: bundles the whole widget (three inlined), registers
 * <three-concierge>, runs the `data-concierge` script auto-init, and exposes
 * the API at window.ThreeWsConcierge for script consumers.
 */

import * as api from './index.js';

if (typeof window !== 'undefined') {
	window.ThreeWsConcierge = api;
	window.Concierge = window.Concierge || api.Concierge;
}
