#!/usr/bin/env node
// i18n-translate — incremental, glossary-locked machine translation of the
// source catalog into every target locale, modeled on LobeHub's lobe-i18n.
//
// Pipeline (matches the LobeHub approach, adapted for three.ws):
//   1. Read the entryLocale catalog (locales/en.json) as the source of truth.
//   2. For each target locale, diff against the committed translation and
//      translate ONLY the missing/empty keys — re-runs are nearly free.
//   3. Brand/protocol terms, {{placeholders}}, and HTML tags are masked to
//      opaque sentinels before the text reaches the model and restored after,
//      so `$THREE`, the contract address, etc. come back byte-for-byte.
//   4. Large namespaces are split under a token budget; chunks run concurrently.
//   5. Output is committed as static JSON — zero runtime translation cost.
//
// Backends (real APIs, selected by `provider` in .i18nrc.json):
//   gemini    → Generative Language API   (GEMINI_API_KEY | GOOGLE_API_KEY)
//   vertex    → Vertex AI (Gemini)        (GOOGLE_CLOUD_PROJECT + GCP creds; billed to
//                                          platform GCP credits, no free-tier quota to exhaust)
//   openai    → Chat Completions          (OPENAI_API_KEY [+ OPENAI_BASE_URL])
//   anthropic → Messages                  (ANTHROPIC_API_KEY)
//   threews   → three.ws we-pay LLM proxy (/api/llm/anthropic). The zero-local-credential
//               rung: it rides the platform's own free-tier provider keys, so it works
//               from any workspace that can log in as a platform user. Needs
//               THREEWS_I18N_AGENT (an agent id OWNED by that user; the proxy meters
//               per-agent, so never point this at someone else's agent) plus a session
//               saved by `npm run audit:web:login` (or THREEWS_SESSION_FILE). Respects
//               the agent's default embed-policy limits (10 req/min), so bulk runs are
//               slow by design; prefer vertex when GCP credentials exist.
//
// Usage:
//   node scripts/i18n-translate.mjs                 # translate missing keys, all locales
//   node scripts/i18n-translate.mjs --locale=es     # one locale
//   node scripts/i18n-translate.mjs --locales=es,de  # a shard of locales, one process
//   node scripts/i18n-translate.mjs --force         # retranslate everything
//   node scripts/i18n-translate.mjs --lint          # validate only (build gate, no API key needed)
//   node scripts/i18n-translate.mjs --prune         # drop keys the source dropped (no API key needed)
//   node scripts/i18n-translate.mjs --repair        # re-translate only lint-failing keys
//   node scripts/i18n-translate.mjs --dry-run       # report what would translate
//   node scripts/i18n-translate.mjs --concurrency=8 # widen the chunk pool for a bulk run

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config as dotenv } from 'dotenv';
import JSON5 from 'json5';
import './lib/gcloud-path.mjs';
import {
	ROOT,
	loadConfig,
	readJSON,
	flatten,
	setDeep,
	getDeep,
	missingKeys,
	untranslatedCount,
	mergeOrdered,
	pruneStale,
	buildMasker,
	lintLocale,
	markupDrift,
} from './lib/i18n-shared.mjs';

// The backend credentials live in .env alongside every other platform secret.
// Without this the default provider (vertex) has no project, every call fails
// its config check, and the run bakes English into the whole catalog - the
// silent-English failure `i18n:backfill` exists to clean up afterwards. dotenv
// never overrides a var already exported, so a one-off `GEMINI_API_KEY=… npm
// run i18n:translate` still wins.
dotenv({ path: new URL('../.env', import.meta.url), quiet: true });
dotenv({ path: new URL('../.env.local', import.meta.url), quiet: true });

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
	const hit = args.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.split('=').slice(1).join('=') : undefined;
};

const cfg = loadConfig();
// CLI overrides for the backend, so a one-off run can switch provider/model
// without editing the committed .i18nrc.json (e.g. --provider=openrouter
// --model=openai/gpt-4o-mini when the default GCP/Vertex path is unavailable).
if (opt('provider')) cfg.provider = opt('provider');
if (opt('model')) cfg.modelName = opt('model');
// The committed concurrency is tuned for free-tier lanes that rate-limit hard.
// A Vertex run billed to the platform's own project has far more headroom, and
// a from-scratch locale is ~550 chunks, so let a bulk run open it up without
// editing the config every other lane still depends on.
if (opt('concurrency')) cfg.concurrency = Math.max(1, Number(opt('concurrency')) || cfg.concurrency);
const sourcePath = resolve(ROOT, cfg.entry);
const source = readJSON(sourcePath);
if (!source) {
	console.error(`Source catalog not found: ${cfg.entry}. Run \`npm run i18n:extract\` first.`);
	process.exit(1);
}

const onlyLocale = opt('locale');
// A bulk run rebuilds the manifest first, which reads all 84 catalogs, so
// sharding a backlog across providers one `--locale=` process per locale pays
// that scan 84 times. `--locales=` takes a comma-separated shard instead: each
// process scans once and then works through its own slice.
const localeShard = opt('locales');
const targets = (
	onlyLocale
		? [onlyLocale]
		: localeShard
			? localeShard.split(',').map((c) => c.trim())
			: cfg.outputLocales
).filter(Boolean);
const localePath = (code) => resolve(ROOT, cfg.output, `${code}.json`);

// --- lint mode: pure validation, no network, safe to run in CI -------------

function runLint() {
	let problems = 0;
	for (const code of targets) {
		const target = readJSON(localePath(code));
		if (!target) {
			// Configured but not yet translated — not an integrity failure. Lint
			// gates the catalogs we actually ship; run `npm run i18n:translate` to
			// generate the rest.
			console.log(`◦ ${code}: not generated yet (skipped)`);
			continue;
		}
		const found = lintLocale(source, target, { code, doNotTranslate: cfg.doNotTranslate });
		if (found.length) {
			problems += found.length;
			for (const p of found) console.error('✗ ' + p);
		} else {
			console.log(`✓ ${code}: ${Object.keys(flatten(target)).length} keys OK`);
		}
	}
	if (problems) {
		console.error(`\ni18n lint failed: ${problems} problem(s).`);
		process.exit(1);
	}
	console.log('\ni18n lint passed.');
}

// --- prune mode: drop stale keys, no network -------------------------------
//
// A key renamed or deleted in the source leaves its old translation behind in
// all 84 catalogs, and lint counts every copy ("stale key (not in source)"), so
// one renamed key is 84 failures. A full translate run cleans them up as a side
// effect (persist() rebuilds each catalog from the source), but that needs a
// working backend, which makes a purely subtractive fix hostage to a provider
// outage or an exhausted quota. Prune is that fix on its own: no API key, no
// network, and it only ever deletes.
function runPrune() {
	let removedTotal = 0;
	let touched = 0;
	for (const code of targets) {
		const target = readJSON(localePath(code));
		if (!target) {
			console.log(`◦ ${code}: not generated yet (skipped)`);
			continue;
		}
		const { pruned, removed } = pruneStale(source, target);
		if (!removed.length) {
			console.log(`• ${code}: nothing stale`);
			continue;
		}
		if (!flag('dry-run')) {
			writeFileSync(localePath(code), JSON.stringify(pruned, null, '\t') + '\n');
		}
		removedTotal += removed.length;
		touched++;
		console.log(
			`→ ${code}: ${flag('dry-run') ? 'would drop' : 'dropped'} ${removed.length} stale key(s): ${removed.join(', ')}`,
		);
	}
	console.log(
		`\ni18n-prune: ${flag('dry-run') ? 'would drop' : 'dropped'} ${removedTotal} stale key(s) across ${touched} locale(s).`,
	);
}

// --- chunking --------------------------------------------------------------

// Split missing keys into chunks whose combined source text stays under the
// token budget (≈4 chars/token) so no single request risks truncation.
function chunkKeys(keys, budgetChars) {
	const chunks = [];
	let cur = [];
	let size = 0;
	for (const k of keys) {
		const len = String(getDeep(source, k) ?? '').length + k.length + 8;
		if (cur.length && size + len > budgetChars) {
			chunks.push(cur);
			cur = [];
			size = 0;
		}
		cur.push(k);
		size += len;
	}
	if (cur.length) chunks.push(cur);
	return chunks;
}

// --- LLM backends ----------------------------------------------------------
//
// Every backend below is free-tier capable. Gemini and Anthropic use native
// APIs; the rest are OpenAI-compatible chat-completions endpoints, so a single
// caller serves all of them. Env-var names and model defaults match
// api/_lib/chat-models.js, so a key that already powers /chat works here too.
//
// Free lanes (no card required):
//   groq       GROQ_API_KEY        https://console.groq.com/keys
//   gemini     GEMINI_API_KEY      https://aistudio.google.com/apikey  (free tier)
//   openrouter OPENROUTER_API_KEY  https://openrouter.ai/keys  (use a :free model)
//   nvidia     NVIDIA_API_KEY      https://build.nvidia.com  (free NIM credits)

const PROVIDER_DEFAULT_MODEL = {
	gemini: 'gemini-2.5-flash',
	vertex: 'google/gemini-2.5-flash',
	groq: 'qwen/qwen3.8-27b',
	openrouter: 'openai/gpt-oss-20b:free',
	nvidia: 'meta/llama-3.3-70b-instruct',
	mistral: 'mistral-small-latest',
	openai: 'gpt-4o-mini',
	anthropic: 'claude-haiku-4-5-20251001',
	// The proxy's free Groq lane; resolveRequestedModel clamps paid models to the
	// agent's configured one, so only free-lane ids make sense here.
	threews: 'llama-3.3-70b-versatile',
};

// OpenAI-compatible lanes. jsonMode is set only where the endpoint reliably
// honors response_format:json_object — free models often 400 on it, so those
// rely on prompt-enforced JSON plus fence stripping instead.
const OPENAI_COMPAT = {
	groq: {
		envKey: 'GROQ_API_KEY',
		url: () => 'https://api.groq.com/openai/v1/chat/completions',
		jsonMode: true,
	},
	openrouter: {
		envKey: 'OPENROUTER_API_KEY',
		url: () => 'https://openrouter.ai/api/v1/chat/completions',
		extraHeaders: { 'HTTP-Referer': 'https://three.ws', 'X-Title': 'three.ws i18n' },
	},
	nvidia: {
		envKey: 'NVIDIA_API_KEY',
		url: () => 'https://integrate.api.nvidia.com/v1/chat/completions',
	},
	// Mistral Experiment tier (free, about 1B tokens/month): the strongest free
	// lane for European-language output, and it honors response_format json.
	mistral: {
		envKey: 'MISTRAL_API_KEY',
		url: () => 'https://api.mistral.ai/v1/chat/completions',
		jsonMode: true,
	},
	openai: {
		envKey: 'OPENAI_API_KEY',
		url: () => `${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}/chat/completions`,
		jsonMode: true,
	},
};

function httpError(provider, status, body, retryAfter) {
	return Object.assign(new Error(`${provider} ${status}: ${String(body).slice(0, 300)}`), {
		status,
		retryAfter,
	});
}

/**
 * A backend that is not configured at all - no key, no project. Distinct from a
 * key the model choked on, and it must never be treated like one: the per-key
 * fallback bakes the English source, so an unconfigured provider would quietly
 * rewrite an entire catalog into English and leave lint green. Marked so the
 * run can abort instead.
 */
export function configError(message) {
	return Object.assign(new Error(message), { isConfigError: true });
}

/**
 * Should this failure abort the run instead of falling back to English?
 *
 * True for anything that means "this key will never be served", which fails
 * identically on every key: an absent key or project (configError), an auth
 * rejection from the provider (401/403), and an exhausted balance (402). The
 * English fallback exists for the occasional value a model cannot render as
 * valid JSON; applied to a whole-account failure it silently rewrites a whole
 * catalog into English and exits 0.
 *
 * 402 is here because leaving it out cost a real catalog. A funded OpenRouter
 * key with a spent balance answers every request `402 Insufficient credits`,
 * which is neither a config error nor an auth rejection, so the run treated it
 * as a per-key rendering failure: halve, retry, halve again, and bake English
 * on each lone key. 198 Spanish keys were rewritten into English and the run
 * exited 0. A payment wall is a property of the account, not of the string
 * being translated, so no amount of retrying or splitting changes the outcome.
 */
export function isFatalAuthFailure(err) {
	return Boolean(
		err?.isConfigError ||
			err?.isQuotaExhausted ||
			err?.status === 401 ||
			err?.status === 402 ||
			err?.status === 403,
	);
}

function modelName() {
	return cfg.modelName || PROVIDER_DEFAULT_MODEL[cfg.provider] || PROVIDER_DEFAULT_MODEL.gemini;
}

function stripFences(text) {
	return text
		.replace(/^\s*```(?:json)?/i, '')
		.replace(/```\s*$/, '')
		.trim();
}

function buildPrompt(langName, payload) {
	return [
		`You are a professional software localizer translating UI and marketing copy from English to ${langName}.`,
		cfg.reference || '',
		'',
		'Rules:',
		`- Translate every VALUE in the JSON below into ${langName}. Keep every KEY exactly as-is.`,
		'- Return ONLY a single JSON object with the same keys. No prose, no markdown, no code fences.',
		'- Some values contain protected tokens written as [[T0]], [[T1]], and so on. They stand in for brand names, code, and placeholders. Copy each token VERBATIM into a natural position for the target language. Never translate a token, change its number, add one, or drop one.',
		'- Preserve meaning and tone. Do not add explanations.',
		'',
		'JSON to translate:',
		JSON.stringify(payload),
	]
		.filter(Boolean)
		.join('\n');
}

async function callGemini(prompt) {
	const key =
		process.env.GEMINI_API_KEY ||
		process.env.GOOGLE_API_KEY ||
		process.env.GOOGLE_GENAI_API_KEY;
	if (!key)
		throw configError(
			'GEMINI_API_KEY (or GOOGLE_API_KEY) not set — free keys: https://aistudio.google.com/apikey',
		);
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName()}:generateContent?key=${key}`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			contents: [{ role: 'user', parts: [{ text: prompt }] }],
			generationConfig: {
				temperature: cfg.temperature ?? 0.2,
				topP: cfg.topP ?? 0.9,
				responseMimeType: 'application/json',
			},
		}),
	});
	if (!res.ok)
		throw httpError(
			'gemini',
			res.status,
			await res.text(),
			Number(res.headers.get('retry-after')) || 0,
		);
	const data = await res.json();
	const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
	if (!text) throw new Error('gemini returned empty content');
	return text;
}

async function callAnthropic(prompt) {
	const key = process.env.ANTHROPIC_API_KEY;
	if (!key) throw configError('ANTHROPIC_API_KEY not set');
	const res = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': key,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: modelName(),
			max_tokens: 8192,
			temperature: cfg.temperature ?? 0.2,
			messages: [{ role: 'user', content: prompt }],
		}),
	});
	if (!res.ok)
		throw httpError(
			'anthropic',
			res.status,
			await res.text(),
			Number(res.headers.get('retry-after')) || 0,
		);
	const data = await res.json();
	return data?.content?.map((b) => b.text || '').join('') || '';
}

// three.ws we-pay LLM proxy (api/llm/anthropic.js) as a translation backend.
// This is the rung for a workspace with NO provider credentials at all: the
// proxy spends the platform's own free-tier keys (Groq et al) server-side and
// speaks the Anthropic Messages shape in both directions, so the call below is
// callAnthropic with a different host and cookie auth instead of an API key.
//
// Auth is a platform session: the proxy admits Origin-less machine callers only
// when they authenticate, and the sanctioned way to mint a session in an agent
// workspace is `npm run audit:web:login` (QA account from .env), which saves a
// Playwright storageState file this reads the session cookie from. The agent id
// must be one the SAME user owns: the proxy meters calls and tokens against the
// agent's embed policy, and spending another owner's budget is not acceptable.
// `GET /api/agents/me` auto-creates a default agent for the QA user, so
// `THREEWS_I18N_AGENT=$(that id)` is always mintable.
function threewsSessionCookie() {
	const file =
		process.env.THREEWS_SESSION_FILE || resolve(ROOT, '.auth/audit-state.json');
	if (!existsSync(file))
		throw configError(
			`threews session file not found (${file}): run \`npm run audit:web:login\` first, ` +
				'or point THREEWS_SESSION_FILE at a Playwright storageState JSON with a three.ws session.',
		);
	let cookie;
	try {
		const state = JSON.parse(readFileSync(file, 'utf8'));
		cookie = (state.cookies || []).find((c) => c.name === '__Host-sid');
	} catch {
		throw configError(`threews session file is not readable storageState JSON: ${file}`);
	}
	if (!cookie) throw configError('threews session file has no __Host-sid cookie; session expired? Re-run `npm run audit:web:login`.');
	return `${cookie.name}=${cookie.value}`;
}

async function callThreews(prompt) {
	const agentId = process.env.THREEWS_I18N_AGENT;
	if (!agentId)
		throw configError(
			'THREEWS_I18N_AGENT not set: an agent id owned by the session user ' +
				'(GET /api/agents/me returns or creates one).',
		);
	const base = (process.env.THREEWS_BASE_URL || 'https://three.ws').replace(/\/$/, '');
	const res = await fetch(`${base}/api/llm/anthropic?agent=${encodeURIComponent(agentId)}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: threewsSessionCookie() },
		body: JSON.stringify({
			model: modelName(),
			max_tokens: 8192,
			stream: false,
			temperature: cfg.temperature ?? 0.2,
			messages: [{ role: 'user', content: prompt }],
		}),
	});
	if (res.status === 401 || res.status === 403) {
		throw configError(
			`threews ${res.status}: session rejected: re-run \`npm run audit:web:login\` ` +
				'and confirm THREEWS_I18N_AGENT belongs to that user.',
		);
	}
	if (!res.ok)
		throw httpError(
			'threews',
			res.status,
			await res.text(),
			Number(res.headers.get('retry-after')) || 0,
		);
	const data = await res.json();
	const text = data?.content?.map((b) => b.text || '').join('') || '';
	if (!text) throw new Error('threews proxy returned empty content');
	return text;
}

// Vertex AI Gemini — service-account/metadata-server auth, billed to the
// platform's GCP credit pool instead of a free-tier key. No quota to exhaust
// (unlike groq/gemini-aistudio/nvidia's shared free tiers, which can 429
// mid-batch and leave a run partially translated), so this is the reliability
// option when the free lanes are flaky. Same OpenAI-compatible endpoint shape
// api/_lib/llm.js's vertexGeminiProvider() and api/_mcp3d/vertex-imagen.js
// already use, so there is no new wire format to trust. Verified live
// 2026-07-16 (translated a real key through the endpoint end-to-end).
//
// Gotcha (verified live): Gemini 2.5 Flash spends part of its budget on
// internal "reasoning" tokens before emitting any visible content — a tight
// max_tokens (as the chat-completion callers elsewhere use) can burn the
// whole budget on reasoning and return empty content with
// finish_reason:"length". Use a generous ceiling, matching callAnthropic's.
// Mint a Vertex access token, preferring the same service-account path every
// other platform Vertex caller uses. That path is built for Cloud Run and
// Vercel, where a service account is attached or pasted into the environment;
// on a developer machine neither exists, but an authenticated `gcloud` almost
// always does. Falling back to the CLI is what makes the committed default
// provider actually runnable locally instead of failing into English.
let _cliToken = { value: null, expiresAt: 0 };
async function vertexToken({ fresh = false } = {}) {
	if (fresh) _cliToken = { value: null, expiresAt: 0 };
	try {
		const { getGcpAccessToken } = await import('../api/_lib/gcp-auth.js');
		if (!fresh) return await getGcpAccessToken();
	} catch (err) {
		if (err?.code !== 'unconfigured') throw err;
	}
	if (_cliToken.value && Date.now() < _cliToken.expiresAt) return _cliToken.value;
	const { spawnSync } = await import('node:child_process');
	const out = spawnSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' });
	const token = out.status === 0 && out.stdout.trim();
	if (!token) {
		throw configError(
			'No GCP credentials for vertex: set GCP_SERVICE_ACCOUNT_JSON, or run `gcloud auth login` ' +
				'(the CLI token is used automatically). Alternatively pass --provider=gemini with GOOGLE_API_KEY set.',
		);
	}
	// gcloud tokens last an hour; re-shell every 45 minutes rather than per call.
	_cliToken = { value: token, expiresAt: Date.now() + 45 * 60 * 1000 };
	return token;
}

async function callVertex(prompt) {
	const project = process.env.GOOGLE_CLOUD_PROJECT;
	if (!project) {
		throw configError(
			'GOOGLE_CLOUD_PROJECT not set — vertex needs the same GCP project + credentials ' +
				'(GCP_SERVICE_ACCOUNT_JSON, or the Cloud Run/GCE metadata server) as the rest of the ' +
				'platform\'s Vertex AI callers.',
		);
	}
	const location = process.env.GOOGLE_CLOUD_LOCATION_GEMINI || 'global';
	const host = location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
	const url = `https://${host}/v1beta1/projects/${project}/locations/${location}/endpoints/openapi/chat/completions`;
	const send = (token) =>
		fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
			body: JSON.stringify({
				model: modelName(),
				temperature: cfg.temperature ?? 0.2,
				top_p: cfg.topP ?? 0.9,
				max_tokens: 8192,
				messages: [{ role: 'user', content: prompt }],
			}),
		});

	let res = await send(await vertexToken());
	// A token that was valid at mint time can be revoked long before it expires
	// (a Workspace reauth policy invalidates outstanding gcloud tokens), and a
	// bulk run holds one for hours. Re-mint once on 401/403 rather than letting
	// a stale token turn into thousands of English-baked keys.
	if (res.status === 401 || res.status === 403) {
		res = await send(await vertexToken({ fresh: true }));
		if (res.status === 401 || res.status === 403) {
			throw configError(
				`vertex ${res.status}: credentials are not valid even after re-minting. ` +
					'Run `gcloud auth login` (this environment revokes tokens on a reauth policy), ' +
					'or pass --provider=gemini with GOOGLE_API_KEY set.',
			);
		}
	}
	if (!res.ok)
		throw httpError('vertex', res.status, await res.text(), Number(res.headers.get('retry-after')) || 0);
	const data = await res.json();
	const content = data?.choices?.[0]?.message?.content || '';
	if (!content) {
		const reason = data?.choices?.[0]?.finish_reason;
		throw new Error(`vertex returned no content${reason ? ` (finish_reason: ${reason})` : ''}`);
	}
	return content;
}

async function callOpenAICompat(prompt, providerName = cfg.provider, modelOverride = null) {
	const spec = OPENAI_COMPAT[providerName];
	const key = process.env[spec.envKey];
	if (!key) throw configError(`${spec.envKey} not set`);
	const body = {
		model: modelOverride || modelName(),
		temperature: cfg.temperature ?? 0.2,
		top_p: cfg.topP ?? 0.9,
		messages: [{ role: 'user', content: prompt }],
	};
	if (spec.jsonMode) body.response_format = { type: 'json_object' };
	const res = await fetch(spec.url(), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${key}`,
			...(spec.extraHeaders || {}),
		},
		body: JSON.stringify(body),
	});
	if (!res.ok)
		throw httpError(
			cfg.provider,
			res.status,
			await res.text(),
			Number(res.headers.get('retry-after')) || 0,
		);
	const data = await res.json();
	return data?.choices?.[0]?.message?.content || '';
}

function backend() {
	if (cfg.provider === 'gemini') return callGemini;
	if (cfg.provider === 'anthropic') return callAnthropic;
	if (cfg.provider === 'vertex') return callVertex;
	if (cfg.provider === 'threews') return callThreews;
	if (OPENAI_COMPAT[cfg.provider]) return callOpenAICompat;
	throw new Error(
		`unknown provider: ${cfg.provider} (use gemini, groq, openrouter, nvidia, mistral, vertex, openai, anthropic, or threews)`,
	);
}

// Ordered backend chain: the configured provider first, then OpenRouter as the
// universal failover so a mid-batch outage of the primary lane (a Vertex token
// hiccup, a free-tier 429 storm) doesn't degrade a whole run to English
// fallback. OpenRouter uses a FUNDED model (no :free) so the failover reliably
// serves — a free-tier model would 402/429 exactly when it is needed. Set
// OPENROUTER_I18N_MODEL to override. Skipped when the primary IS OpenRouter or
// no OpenRouter key is configured.
function backendChain() {
	const chain = [{ name: cfg.provider, call: (p) => backend()(p) }];
	const orKey = process.env.OPENROUTER_API_KEY?.trim();
	if (orKey && cfg.provider !== 'openrouter') {
		const orModel = process.env.OPENROUTER_I18N_MODEL?.trim() || 'meta-llama/llama-3.3-70b-instruct';
		chain.push({ name: `openrouter(${orModel})`, call: (p) => callOpenAICompat(p, 'openrouter', orModel) });
	}
	return chain;
}

// Parse the model's reply into an object, tolerating the usual LLM JSON noise:
// code fences (stripped upstream), leading/trailing prose, and a trailing comma.
// Falls back to the largest {...} span when a raw parse fails, so one stray
// character doesn't discard an otherwise-good chunk.
function parseModelJSON(raw) {
	const text = stripFences(raw);
	try {
		return JSON.parse(text);
	} catch {
		const start = text.indexOf('{');
		const end = text.lastIndexOf('}');
		if (start === -1 || end <= start) throw new Error('no JSON object in response');
		const span = text.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
		try {
			return JSON.parse(span);
		} catch {
			// JSON5 tolerates single quotes, unquoted keys, and trailing commas that
			// small models sometimes emit. It still can't fix a truly broken string
			// (an unescaped quote) — that key drops to the per-key split retry.
			return JSON5.parse(span);
		}
	}
}

// Try one backend with the existing retry/backoff. Returns the parsed object or
// throws the last error after exhausting retries for THIS backend.
async function callBackendWithRetry(call, langName, payload, attempt = 0) {
	try {
		const raw = await call(buildPrompt(langName, payload));
		const parsed = parseModelJSON(raw);
		if (!parsed || typeof parsed !== 'object') throw new Error('non-object response');
		return parsed;
	} catch (err) {
		// A missing key or project is not transient - retrying it just burns the
		// backoff budget on an outcome that cannot change.
		if (isFatalAuthFailure(err)) throw err;
		// Free tiers rate-limit hard; honor Retry-After and back off more on a 429
		// than on a transient parse/5xx error.
		const max = err.status === 429 ? 5 : 2;
		if (attempt < max) {
			const wait =
				err.status === 429
					? Math.max((err.retryAfter || 0) * 1000, 2000 * (attempt + 1))
					: 400 * (attempt + 1);
			await new Promise((r) => setTimeout(r, wait));
			return callBackendWithRetry(call, langName, payload, attempt + 1);
		}
		// A 429 that survives the full backoff budget is a spent quota, not one
		// bad key. Mark it so the caller aborts instead of splitting down to
		// single keys and baking English over every key the run had left.
		if (err.status === 429) err.isQuotaExhausted = true;
		throw err;
	}
}

// Translate one chunk, failing over across the backend chain (primary →
// OpenRouter). Each backend gets its full retry budget before the next is tried;
// only when every backend is exhausted does the error propagate (to the caller's
// halve-and-retry / English-fallback logic).
async function translateChunk(langName, payload) {
	const chain = backendChain();
	let lastErr;
	for (const [i, b] of chain.entries()) {
		try {
			return await callBackendWithRetry(b.call, langName, payload);
		} catch (err) {
			lastErr = err;
			if (i < chain.length - 1) {
				console.warn(`  ↻ ${b.name} failed (${err.message?.slice(0, 80)}); failing over to ${chain[i + 1].name}`);
			}
		}
	}
	throw lastErr;
}

// Bounded-concurrency map.
async function pool(items, limit, worker) {
	const results = new Array(items.length);
	let i = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (i < items.length) {
			const idx = i++;
			results[idx] = await worker(items[idx], idx);
		}
	});
	await Promise.all(runners);
	return results;
}

// --- per-locale translation ------------------------------------------------

const masker = buildMasker(cfg.doNotTranslate);

async function translateLocale(code) {
	const langName = cfg.localeNames?.[code] || code;
	const existing = readJSON(localePath(code), {}) || {};
	const todo = flag('force') ? Object.keys(flatten(source)) : missingKeys(source, existing);

	if (!todo.length) {
		console.log(`• ${code}: up to date`);
		return { code, translated: 0 };
	}
	if (flag('dry-run')) {
		console.log(`• ${code}: would translate ${todo.length} key(s)`);
		return { code, translated: 0 };
	}

	const chunks = chunkKeys(todo, (cfg.splitToken || 1200) * 4);
	console.log(
		`→ ${code}: ${todo.length} key(s) in ${chunks.length} chunk(s) via ${cfg.provider}`,
	);

	const translatedFlat = {};
	let done = 0;

	let failedKeys = 0;

	// Translate one set of keys. On a hard failure (a model reply that never
	// parses, a persistent 5xx) the set is split in half and each half retried,
	// down to a single key. This isolates the one value whose translation the
	// model keeps mangling (a stray unescaped quote in Arabic, an empty Korean
	// reply) so it can't sink the dozens of good keys chunked alongside it; only
	// that lone key falls back to English, and the rest land.
	async function translateKeySet(keys) {
		const payload = {};
		const tokenMap = {};
		for (const k of keys) {
			const { masked, tokens } = masker.mask(String(getDeep(source, k) ?? ''));
			payload[k] = masked;
			tokenMap[k] = tokens;
		}
		let out;
		try {
			out = await translateChunk(langName, payload);
		} catch (err) {
			// An unconfigured backend fails identically on every key, so the
			// per-key English fallback below would march through the entire
			// catalog rewriting it into English and finish "successfully". Fail
			// the run instead: nothing already translated is lost (the pipeline
			// persists after each chunk) and the operator gets the one line that
			// actually tells them what to fix.
			if (isFatalAuthFailure(err)) throw err;
			if (keys.length > 1) {
				const mid = Math.ceil(keys.length / 2);
				await translateKeySet(keys.slice(0, mid));
				await translateKeySet(keys.slice(mid));
				return;
			}
			// A lone key that fails every retry is one the model genuinely can't
			// render as valid JSON (usually a value it mangles into an unescaped
			// quote). Bake the English source so the catalog stays complete and
			// lint-clean, the runtime shows English (the same graceful fallback an
			// empty value would trigger), and re-runs don't loop on it forever.
			failedKeys++;
			translatedFlat[keys[0]] = getDeep(source, keys[0]);
			if (cfg.saveImmediately) persist(code, existing, translatedFlat);
			console.warn(`  ! ${code} ${keys[0]}: unrenderable after retries (${err.message}); English fallback baked`);
			return;
		}
		for (const k of keys) {
			const val = out[k];
			const src = getDeep(source, k);
			if (typeof val !== 'string') {
				console.warn(`  ! ${code} ${k}: model omitted key, keeping source`);
				translatedFlat[k] = src;
				continue;
			}
			const unmasked = masker.unmask(val, tokenMap[k]);
			// An empty reply for a non-empty source is the model dropping the
			// value, not a translation. Writing it through is what put 501 empty
			// strings in the catalog: lint then reads them as untranslated
			// forever and the runtime renders a blank label. Keep the source.
			if (!unmasked.trim() && String(src ?? '').trim()) {
				console.warn(`  ! ${code} ${k}: model returned an empty value, keeping source`);
				translatedFlat[k] = src;
				continue;
			}
			translatedFlat[k] = unmasked;
		}
		done += keys.length;
		if (cfg.saveImmediately) persist(code, existing, translatedFlat);
		console.log(`  ${code}: ${done}/${todo.length}`);
	}

	await pool(chunks, cfg.concurrency || 4, (keys) => translateKeySet(keys));
	if (failedKeys) console.warn(`  ⚠ ${code}: ${failedKeys} key(s) left as English fallback — re-run to retry`);

	persist(code, existing, translatedFlat);
	return { code, translated: todo.length };
}

// Merge fresh translations over prior ones, dropping stale keys (mergeOrdered
// only emits keys that exist in the source), and write committed JSON.
function persist(code, existing, translatedFlat) {
	const translatedNested = {};
	for (const [k, v] of Object.entries(translatedFlat)) setDeep(translatedNested, k, v);
	const merged = mergeOrdered(source, existing, translatedNested);
	writeFileSync(localePath(code), JSON.stringify(merged, null, '\t') + '\n');
}

// Refresh the runtime manifest the locale switcher reads. Only locales with a
// COMPLETE catalog are listed, so the switcher never offers a language that
// would silently fall back to English.
//
// File existence is not enough. A run that dies partway (expired credentials, an
// exhausted provider) still writes the full key skeleton with empty-string values
// for everything it never reached, so the catalog looks finished by key count and
// then renders as a half-translated page, because the runtime falls back to English
// per key. Listing such a locale is exactly the failure this manifest exists to
// prevent, so an incomplete catalog is skipped and reported rather than shipped.
function writeManifest() {
	const skipped = [];
	const ready = (code) => {
		if (code === cfg.entryLocale) return true;
		if (!existsSync(localePath(code))) return false;
		let empty = 0;
		try {
			empty = untranslatedCount(readJSON(localePath(code)));
		} catch {
			skipped.push(`${code} (unreadable)`);
			return false;
		}
		if (empty) skipped.push(`${code} (${empty} untranslated key${empty === 1 ? '' : 's'})`);
		return empty === 0;
	};
	const localesList = [cfg.entryLocale, ...cfg.outputLocales].filter(ready).map((code) => ({
		code,
		name: cfg.localeNames?.[code] || code,
		dir: (cfg.rtlLocales || []).includes(code) ? 'rtl' : 'ltr',
	}));
	const manifest = { default: cfg.entryLocale, locales: localesList };
	writeFileSync(
		resolve(ROOT, cfg.output, 'manifest.json'),
		JSON.stringify(manifest, null, '\t') + '\n',
	);
	if (skipped.length) {
		console.log(
			`• manifest: ${localesList.length} locale(s) listed, ${skipped.length} held back until complete: ${skipped.join(', ')}`,
		);
	}
}

// --- repair mode: re-translate only lint-failing keys ----------------------

// The masker replaces glossary terms ("Solana", "x402", …) and {{placeholders}}
// with sentinels the model is meant to reproduce verbatim. A small model
// occasionally omits a sentinel mid-sentence, so the term never gets restored
// on unmask and the key fails lint. That drop is probabilistic, not
// deterministic: re-translating the same key usually preserves the sentinel.
// Repair re-runs only the failing keys, one at a time, retrying until the key
// passes its own integrity check, and bakes English on the rare key that never
// converges (lint-clean, graceful runtime fallback). Idempotent: a clean locale
// reports "nothing to repair".
async function repairLocale(code, maxAttempts = 4) {
	const existing = readJSON(localePath(code), {}) || {};
	if (!existing || !Object.keys(existing).length) {
		console.log(`◦ ${code}: not generated yet (skipped)`);
		return { code, repaired: 0, baked: 0 };
	}
	// Only keys whose current value drops a glossary term, a placeholder, or an
	// HTML entity - the three failures a re-translation reliably fixes.
	const problems = lintLocale(source, existing, { code, doNotTranslate: cfg.doNotTranslate });
	const failingKeys = [
		...new Set(
			problems
				.map(
					(p) =>
						/(?:glossary term dropped|placeholder drift|markup drift) in ([^:]+):/.exec(
							p,
						)?.[1],
				)
				.filter(Boolean),
		),
	];
	if (!failingKeys.length) {
		console.log(`• ${code}: nothing to repair`);
		return { code, repaired: 0, baked: 0 };
	}
	const langName = cfg.localeNames?.[code] || code;
	console.log(`→ ${code}: repairing ${failingKeys.length} key(s) via ${cfg.provider}`);

	const passes = (key, value) => {
		const sv = String(getDeep(source, key) ?? '');
		if (typeof value !== 'string' || value.trim() === '') return false;
		for (const term of cfg.doNotTranslate) {
			if (sv.includes(term) && !value.includes(term)) return false;
		}
		const srcVars = (sv.match(/\{\{[^}]+\}\}/g) || []).sort().join('|');
		const tgtVars = (value.match(/\{\{[^}]+\}\}/g) || []).sort().join('|');
		if (srcVars !== tgtVars) return false;
		return !markupDrift(sv, value);
	};

	let repaired = 0;
	let baked = 0;
	for (const key of failingKeys) {
		let fixed = null;
		for (let attempt = 0; attempt < maxAttempts && fixed === null; attempt++) {
			const { masked, tokens } = masker.mask(String(getDeep(source, key) ?? ''));
			let out;
			try {
				out = await translateChunk(langName, { [key]: masked });
			} catch {
				continue;
			}
			const candidate =
				typeof out[key] === 'string' ? masker.unmask(out[key], tokens) : null;
			if (candidate && passes(key, candidate)) fixed = candidate;
		}
		if (fixed === null) {
			// Never converged: bake the English source so the key is lint-clean and
			// the runtime shows English (the same graceful fallback an empty value
			// triggers). Rare — brand terms preserved on the very next attempt.
			fixed = getDeep(source, key);
			baked++;
			console.warn(`  ! ${code} ${key}: baked English after ${maxAttempts} attempts`);
		} else {
			repaired++;
		}
		setDeep(existing, key, fixed);
		writeFileSync(localePath(code), JSON.stringify(existing, null, '\t') + '\n');
	}
	console.log(`  ${code}: repaired ${repaired}, baked ${baked}`);
	return { code, repaired, baked };
}

async function main() {
	if (flag('lint')) return runLint();
	if (flag('prune')) return runPrune();
	if (flag('repair')) {
		writeManifest();
		const results = await pool(targets, 1, (c) => repairLocale(c));
		const r = results.reduce((s, x) => s + (x?.repaired || 0), 0);
		const b = results.reduce((s, x) => s + (x?.baked || 0), 0);
		console.log(`\ni18n-repair: ${r} key(s) repaired, ${b} baked across ${targets.length} locale(s).`);
		return;
	}

	writeManifest();
	const results = await pool(targets, 1, translateLocale); // locales sequential; chunks parallel within
	const n = results.reduce((s, r) => s + (r?.translated || 0), 0);
	console.log(`\ni18n-translate: ${n} key(s) translated across ${targets.length} locale(s).`);
}

// Run only when invoked as a CLI. Importing this module for its pure helpers
// (the markup tests import `configError` / `isFatalAuthFailure`) must not kick off
// a translation run — it did, and its failure called process.exit(1) from inside
// the test worker, so a fully green suite still reported a red exit code.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
	main().catch((err) => {
		console.error(err.message || err);
		process.exit(1);
	});
}
