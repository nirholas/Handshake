/**
 * What counts as a marketplace SALE.
 *
 * `skill_purchases.kind` records how a row granted access, and only some of those
 * ways involved money changing hands for that row:
 *
 *   purchase   a one-time skill sale                         → revenue
 *   time_pass  timed access, bought outright                 → revenue
 *   trial      free evaluation access                        → demand, not revenue
 *   bundle     access granted by a bundle already paid for   → already counted on
 *              bundle_purchases; counting it again would report one sale as N
 *
 * Every aggregate that adds up money or counts distinct buyers/sellers has to
 * gate on `status = 'confirmed' AND kind = ANY(MARKET_PAID_KINDS)`. Filtering on
 * status alone silently admits trials and bundle-access rows into published GMV,
 * which is the exact defect removed from the public /pulse page: one 1000-unit
 * sale alongside a confirmed bundle row and a confirmed trial published GMV 2600
 * and 3 buyers instead of 1000 and 1.
 *
 * This list lives here rather than in any one handler because /pulse (the public
 * transparency page) and the bundle pricing simulator both have to mean the same
 * thing by "sold". A number that disagrees across two surfaces is worse than a
 * number that is missing.
 */
export const MARKET_PAID_KINDS = ['purchase', 'time_pass'];

/**
 * Kinds that grant access without being a sale of their own. Kept explicit so a
 * new kind has to be classified deliberately rather than defaulting into revenue.
 */
export const MARKET_UNPAID_KINDS = ['trial', 'bundle'];
