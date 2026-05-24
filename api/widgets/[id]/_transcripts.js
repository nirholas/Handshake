// Transcripts API helpers — list threads for a widget and fetch one thread's
// full message log. Both calls assume ownership has been verified by the
// caller (handleTranscripts in [action].js).

import { sql } from '../../_lib/db.js';

/**
 * List the N most recent threads for a widget, with the first user line as a
 * preview. `before` is an ISO timestamp for keyset pagination ("show me
 * threads older than this last_message_at").
 */
export async function listTranscripts(widgetId, { limit = 25, before = null } = {}) {
	const threads = await sql`
		select t.id, t.visitor_id, t.referer_host, t.country, t.message_count,
		       t.started_at, t.last_message_at,
		       (select content from widget_chat_messages
		        where thread_id = t.id and role = 'user'
		        order by created_at asc limit 1) as preview,
		       (select count(*) from widget_chat_messages
		        where thread_id = t.id and role = 'user') as user_msgs
		from widget_chat_threads t
		where t.widget_id = ${widgetId}
		  and (${before ?? null}::timestamptz is null
		       or t.last_message_at < ${before ?? null}::timestamptz)
		order by t.last_message_at desc
		limit ${Math.max(1, Math.min(100, limit))}
	`;

	const [counts] = await sql`
		select
			count(*)::bigint as total_threads,
			(select count(*) from widget_chat_messages where widget_id = ${widgetId}) as total_messages,
			count(distinct visitor_id)::bigint as unique_visitors
		from widget_chat_threads
		where widget_id = ${widgetId}
	`;

	return {
		threads: threads.map(decorateThread),
		next_cursor: threads.length === limit ? threads[threads.length - 1].last_message_at : null,
		totals: {
			threads: Number(counts?.total_threads || 0),
			messages: Number(counts?.total_messages || 0),
			unique_visitors: Number(counts?.unique_visitors || 0),
		},
	};
}

/**
 * Fetch one thread's full message log. Returns null if the thread isn't on
 * this widget so the caller can 404 cleanly.
 */
export async function getTranscript(widgetId, threadId) {
	const [thread] = await sql`
		select id, visitor_id, referer_host, country, message_count,
		       started_at, last_message_at
		from widget_chat_threads
		where id = ${threadId} and widget_id = ${widgetId}
		limit 1
	`;
	if (!thread) return null;

	const messages = await sql`
		select id, role, content, actions, provider, model, redacted, created_at
		from widget_chat_messages
		where thread_id = ${threadId}
		order by created_at asc, id asc
	`;

	return {
		thread: decorateThread(thread),
		messages: messages.map((m) => ({
			id: Number(m.id),
			role: m.role,
			content: m.content,
			actions: Array.isArray(m.actions) ? m.actions : (m.actions ?? null),
			provider: m.provider,
			model: m.model,
			redacted: !!m.redacted,
			created_at: m.created_at,
		})),
	};
}

function decorateThread(t) {
	return {
		id: t.id,
		visitor_id: t.visitor_id,
		visitor_label: shortVisitor(t.visitor_id),
		referer_host: t.referer_host,
		country: t.country,
		message_count: Number(t.message_count || 0),
		user_msg_count: t.user_msgs == null ? null : Number(t.user_msgs),
		preview: t.preview || null,
		started_at: t.started_at,
		last_message_at: t.last_message_at,
	};
}

function shortVisitor(id) {
	if (!id) return 'unknown';
	if (id.startsWith('anon_')) return 'anon';
	const tail = id.slice(-4);
	return `visitor·${tail}`;
}
