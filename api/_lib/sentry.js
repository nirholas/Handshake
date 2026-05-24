// Sentry error reporting for Vercel serverless functions.
// Required env: SENTRY_DSN
// Optional env: SENTRY_ENVIRONMENT (defaults to VERCEL_ENV), SENTRY_RELEASE (defaults to VERCEL_GIT_COMMIT_SHA)
//
// Usage: import { captureException } from './_lib/sentry.js'
// wrap() in http.js calls this automatically for 5xx errors.
//
// @sentry/node pulls in the full OpenTelemetry instrumentation tree at import
// time (~30s of cold-start cost per process). Defer the SDK behind a lazy
// import that only fires when SENTRY_DSN is set AND an error needs reporting.
// Endpoints without errors never pay the cost; CI / local tests that
// transitively import http.js no longer time out.

let _sdkPromise = null;
let _initialised = false;

function loadSdk() {
	if (!_sdkPromise) _sdkPromise = import('@sentry/node');
	return _sdkPromise;
}

async function ensureInit() {
	const Sentry = await loadSdk();
	if (!_initialised) {
		Sentry.init({
			dsn: process.env.SENTRY_DSN,
			environment: process.env.SENTRY_ENVIRONMENT || process.env.VERCEL_ENV || 'development',
			release: process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA || undefined,
			tracesSampleRate: 0.1,
			sendDefaultPii: false,
		});
		_initialised = true;
	}
	return Sentry;
}

export function captureException(err, context = {}) {
	if (!process.env.SENTRY_DSN) return;
	// Fire-and-forget — error reporting must not block the response path. If
	// Sentry's loader / init throws, swallow it; the handler already replied.
	ensureInit()
		.then((Sentry) => {
			Sentry.withScope((scope) => {
				for (const [key, value] of Object.entries(context)) {
					scope.setExtra(key, value);
				}
				Sentry.captureException(err);
			});
		})
		.catch(() => {});
}

export function captureMessage(message, level = 'info', context = {}) {
	if (!process.env.SENTRY_DSN) return;
	ensureInit()
		.then((Sentry) => {
			Sentry.withScope((scope) => {
				scope.setLevel(level);
				for (const [key, value] of Object.entries(context)) {
					scope.setExtra(key, value);
				}
				Sentry.captureMessage(message);
			});
		})
		.catch(() => {});
}
