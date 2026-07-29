// Shared CSV serialization for export endpoints.
//
// Two separate hand-rolled cell writers existed before this module and had
// drifted: one neutralized spreadsheet formula injection, the other did not,
// and the one that did not was the one serializing visitor-supplied chat
// transcripts. Import from here so that class of divergence cannot recur.

// Excel, Google Sheets, and LibreOffice evaluate a cell whose text begins with
// any of these, which turns exported user content into executable formulas
// (`=HYPERLINK(...)`, `=cmd|...`). A leading tab or carriage return also slips
// past naive checks because the spreadsheet trims it before parsing.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\n\r]/;

/**
 * Serialize one value as an RFC 4180 CSV cell, neutralizing formula injection.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function csvCell(value) {
	if (value === null || value === undefined) return '';
	let s = typeof value === 'string' ? value : String(value);
	if (FORMULA_LEAD.test(s)) s = `'${s}`;
	if (NEEDS_QUOTING.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

/**
 * Same as `csvCell`, but non-string values are JSON-encoded rather than
 * stringified — for columns holding structured metadata.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function csvCellJson(value) {
	if (value === null || value === undefined) return '';
	return csvCell(typeof value === 'string' ? value : JSON.stringify(value));
}

/**
 * Build a full CSV document (header + rows, trailing newline).
 *
 * @param {string[]} header Column names.
 * @param {Iterable<unknown[]>} rows Row values, positionally matching `header`.
 * @param {(v: unknown) => string} [cell] Cell serializer, defaults to `csvCell`.
 * @returns {string}
 */
export function toCsv(header, rows, cell = csvCell) {
	const lines = [header.map(cell).join(',')];
	for (const row of rows) lines.push(row.map(cell).join(','));
	return `${lines.join('\n')}\n`;
}
