#!/usr/bin/env node
/**
 * Ingest X profile scrapes from data/x-archive/ into Postgres.
 *
 * Usage:
 *   node scripts/x-archive-import.mjs                     # every archive file not yet ingested
 *   node scripts/x-archive-import.mjs --file <path.json>  # one file (also accepts a path outside the archive)
 *   node scripts/x-archive-import.mjs --dry-run           # parse + report, touch nothing
 *   node scripts/x-archive-import.mjs --force             # re-ingest a file already recorded
 *
 * Idempotency: each file is hashed and recorded in x_account_imports. Running
 * the importer twice over the same archive is a no-op, so this is safe to wire
 * into a cron or run by hand after every scrape.
 *
 * Auth: reads DATABASE_URL from .env.local, then .env, then the environment.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { ARCHIVE_DIR, listArchiveFiles, readScrapeFile } from './x-archive-lib.mjs';

neonConfig.webSocketConstructor = ws;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

for (const envFile of ['.env.local', '.env']) {
	try {
		const raw = readFileSync(path.resolve(REPO_ROOT, envFile), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
			if (!m || process.env[m[1]]) continue;
			let val = m[2].trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			process.env[m[1]] = val;
		}
	} catch {
		// A missing env file is normal: production supplies these on the service.
	}
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : null;
};

const DRY_RUN = flag('dry-run');
const FORCE = flag('force');

function rel(file) {
	return path.relative(REPO_ROOT, path.resolve(file));
}

async function collectFiles() {
	const one = value('file');
	if (one) return [path.resolve(REPO_ROOT, one)];
	const files = await listArchiveFiles(path.resolve(REPO_ROOT, ARCHIVE_DIR));
	if (!files.length) {
		throw new Error(`no scrape files in ${ARCHIVE_DIR}. Drop a profile scrape there or pass --file.`);
	}
	return files;
}

async function importScrape(client, scrape) {
	const sourceFile = rel(scrape.sourceFile);

	const existing = await client.query(
		'select id, imported_at from x_account_imports where handle = $1 and source_sha256 = $2',
		[scrape.handle, scrape.sha256],
	);
	if (existing.rowCount && !FORCE) {
		return { skipped: true, reason: `already imported ${existing.rows[0].imported_at.toISOString()}` };
	}

	await client.query('begin');
	try {
		const imp = await client.query(
			`insert into x_account_imports (handle, source_file, source_sha256, scraped_at, tweet_count)
			 values ($1, $2, $3, $4, $5)
			 on conflict (handle, source_sha256) do update set
			   source_file = excluded.source_file,
			   tweet_count = excluded.tweet_count,
			   imported_at = now()
			 returning id`,
			[scrape.handle, sourceFile, scrape.sha256, scrape.scrapedAt, scrape.posts.length],
		);
		const importId = imp.rows[0].id;

		let inserted = 0;
		let updated = 0;
		for (const p of scrape.posts) {
			const res = await client.query(
				`insert into x_account_posts (
					tweet_id, handle, author_handle, url, text, posted_at,
					is_retweet, is_reply, is_pinned, has_image, has_video, has_card,
					hashtags, mentions, urls,
					likes, retweets, replies, views, views_label, views_exact, metrics_source, measured_at
				) values (
					$1, $2, $3, $4, $5, $6,
					$7, $8, $9, $10, $11, $12,
					$13, $14, $15,
					$16, $17, $18, $19, $20, $21, $22, $23
				)
				on conflict (tweet_id) do update set
					url         = excluded.url,
					text        = excluded.text,
					is_pinned   = excluded.is_pinned,
					hashtags    = excluded.hashtags,
					mentions    = excluded.mentions,
					urls        = excluded.urls,
					likes       = excluded.likes,
					retweets    = excluded.retweets,
					replies     = excluded.replies,
					views       = excluded.views,
					views_label = excluded.views_label,
					views_exact = excluded.views_exact,
					metrics_source = excluded.metrics_source,
					measured_at = excluded.measured_at,
					updated_at  = now()
				-- Only accept a scrape that is newer than the one already on the
				-- row. Re-importing an older archive after a newer one must not
				-- roll the counters backwards.
				where x_account_posts.measured_at is null
				   or excluded.measured_at >= x_account_posts.measured_at
				returning (xmax = 0) as is_insert`,
				[
					p.tweetId, p.handle, p.authorHandle, p.url, p.text, p.postedAt,
					p.isRetweet, p.isReply, p.isPinned, p.hasImage, p.hasVideo, p.hasCard,
					p.hashtags, p.mentions, p.urls,
					p.likes, p.retweets, p.replies, p.views, p.viewsLabel, p.viewsExact, p.metricsSource, p.measuredAt,
				],
			);
			if (res.rowCount) {
				if (res.rows[0].is_insert) inserted++;
				else updated++;
			}

			await client.query(
				`insert into x_account_post_snapshots (tweet_id, import_id, captured_at, likes, retweets, replies, views, views_label, metrics_source)
				 values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
				 on conflict (tweet_id, captured_at) do nothing`,
				[p.tweetId, importId, p.measuredAt, p.likes, p.retweets, p.replies, p.views, p.viewsLabel, p.metricsSource],
			);
		}

		await client.query('update x_account_imports set inserted_count = $2, updated_count = $3 where id = $1', [
			importId,
			inserted,
			updated,
		]);
		await client.query('commit');
		return { skipped: false, inserted, updated, total: scrape.posts.length };
	} catch (err) {
		await client.query('rollback');
		throw err;
	}
}

async function main() {
	const files = await collectFiles();
	const scrapes = [];
	for (const file of files) {
		const scrape = await readScrapeFile(file);
		scrapes.push(scrape);
		console.log(`${rel(file)}: @${scrape.handle}, ${scrape.posts.length} posts, scraped ${scrape.scrapedAt}`);
	}

	if (DRY_RUN) {
		const total = scrapes.reduce((n, s) => n + s.posts.length, 0);
		console.log(`\nDry run: ${scrapes.length} file(s), ${total} posts parsed. Nothing written.`);
		return;
	}

	if (!process.env.DATABASE_URL) {
		console.error('\nDATABASE_URL is not set. Add it to .env.local or export it in your shell.');
		console.error('The archive files themselves are the durable copy; run again once the database is reachable.');
		process.exitCode = 3;
		return;
	}

	const pool = new Pool({ connectionString: process.env.DATABASE_URL });
	const client = await pool.connect();
	try {
		const check = await client.query(
			"select to_regclass('public.x_account_posts') is not null as ready",
		);
		if (!check.rows[0].ready) {
			console.error('\nx_account_posts does not exist. Run `npm run db:status`, then `npm run db:migrate`.');
			process.exitCode = 4;
			return;
		}

		for (const scrape of scrapes) {
			const result = await importScrape(client, scrape);
			if (result.skipped) console.log(`  skip ${rel(scrape.sourceFile)}: ${result.reason} (use --force to re-ingest)`);
			else console.log(`  ok   ${rel(scrape.sourceFile)}: ${result.inserted} new, ${result.updated} refreshed, ${result.total} seen`);
		}
	} finally {
		client.release();
		await pool.end();
	}
}

main().catch((err) => {
	console.error(err.message || err);
	process.exitCode = 1;
});
