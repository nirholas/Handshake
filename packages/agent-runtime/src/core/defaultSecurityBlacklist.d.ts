import type { SecurityBlacklistConfig } from '../types/vendor.js';
/**
 * Default Security Blacklist
 * These rules will ALWAYS block execution and require human intervention,
 * regardless of user settings (even in auto-run mode)
 *
 * This is the last line of defense against dangerous operations
 */
export declare const DEFAULT_SECURITY_BLACKLIST: SecurityBlacklistConfig;
