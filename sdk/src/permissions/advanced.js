/**
 * @three-ws/sdk/permissions/advanced
 *
 * Re-exports low-level ERC-7710 delegation helpers from the toolkit for
 * advanced consumers who need direct control over delegation encoding.
 *
 * Tree-shaking note: import from this sub-entry instead of the main package
 * entry to avoid pulling in the full PermissionsClient:
 *
 *   import { encodeScopedDelegation } from '@three-ws/sdk/permissions/advanced';
 */

export {
	encodeScopedDelegation,
	isDelegationValid,
	delegationToManifestEntry,
	PermissionError,
} from './toolkit.js';
