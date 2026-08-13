import { readFileSync } from 'node:fs';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;
neonConfig.wsProxy = () => '127.0.0.1:54490/v2';
neonConfig.useSecureWebSocket = false;
neonConfig.pipelineConnect = false;

// Split a .sql file into top-level statements. Handles $$ ... $$ bodies and
// single-quoted strings so a semicolon inside either does not split.
function statements(text) {
	const out = [];
	let buf = '';
	let inDollar = false;
	let inQuote = false;
	let inLineComment = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const next2 = text.slice(i, i + 2);
		if (inLineComment) { buf += c; if (c === '\n') inLineComment = false; continue; }
		if (!inQuote && !inDollar && next2 === '--') { inLineComment = true; buf += c; continue; }
		if (!inQuote && next2 === '$$') { inDollar = !inDollar; buf += next2; i++; continue; }
		if (!inDollar && c === "'") { inQuote = !inQuote; buf += c; continue; }
		if (c === ';' && !inDollar && !inQuote) { out.push(buf); buf = ''; continue; }
		buf += c;
	}
	if (buf.trim()) out.push(buf);
	return out.map((s) => s.trim()).filter((s) => s && !/^(--|\/\*)/.test(s) === true || s.length > 0).filter((s) => s.replace(/--[^\n]*\n/g, '').trim().length > 0);
}

const pool = new Pool({ connectionString: 'postgres://postgres:pg@127.0.0.1:5432/main' });
let ok = 0; const failures = [];
for (const f of process.argv.slice(2)) {
	for (const stmt of statements(readFileSync(f, 'utf8'))) {
		try { await pool.query(stmt); ok++; }
		catch (err) { failures.push(`${f}: ${err.message.slice(0, 120)} :: ${stmt.slice(0, 90).replace(/\s+/g, ' ')}`); }
	}
}
console.log('statements applied:', ok, 'failed:', failures.length);
for (const f of failures.slice(0, 25)) console.log('  x', f);
await pool.end();
