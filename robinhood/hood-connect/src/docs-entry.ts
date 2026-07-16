/**
 * Entry point for the browser bundle used by the static docs site
 * (`docs/hood-connect.iife.js`, global `HoodConnect`). Re-exports the whole
 * framework-free core plus the few hoodchain reads the landing page shows
 * live (block height, USDG supply). Not part of the npm package surface.
 */

export * from './index.js'

export { createHoodClient, getUsdgTotalSupply, formatUsdg } from 'hoodchain'
