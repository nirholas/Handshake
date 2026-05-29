// Neon serverless Postgres. HTTP-based, works in edge + node runtimes.
// Use `sql` as a tagged template for queries: sql`SELECT … WHERE id = ${id}`.

import { neon } from '@neondatabase/serverless';
import { env } from './env.js';

// Lazy Neon client — instantiating requires DATABASE_URL. Keeping it lazy lets
// this module be imported (transitively) by endpoints that don't touch the DB
// even when DATABASE_URL isn't configured.
let _sql;
function getSql() {
	if (!_sql) _sql = neon(env.DATABASE_URL);
	return _sql;
}
export const sql = new Proxy(function () {}, {
	apply(_t, _this, args) {
		return getSql()(...args);
	},
	get(_t, prop) {
		return getSql()[prop];
	},
});
