// Local API server with .env.local + .env loaded, for exercising handlers.
import { readFileSync } from 'node:fs';
for (const f of ['.env.local', '.env']) {
	try {
		for (const line of readFileSync(f, 'utf8').split('\n')) {
			const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
			if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
		}
	} catch {}
}
process.env.PORT = process.env.PORT || '3099';
await import('./server/index.mjs');
