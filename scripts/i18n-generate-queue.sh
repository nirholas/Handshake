#!/usr/bin/env bash
# i18n-generate-queue - build the configured-but-never-generated locales, N at a time.
#
# `.i18nrc.json` lists 84 output locales; only the ones with a committed catalog
# ship (public/locales/manifest.json holds back anything incomplete, so a locale
# mid-build is never offered in the picker). Generating one from scratch is
# ~18k keys / ~430 chunks, so this runs a small pool rather than 30-odd node
# processes fighting over the same Vertex quota.
#
# Resumable by construction: the translator persists after every chunk and only
# fills keys that are missing, so a killed run loses at most one chunk and
# re-running continues where it stopped.
#
# Usage:
#   scripts/i18n-generate-queue.sh                 # every ungenerated locale, 5 at a time
#   scripts/i18n-generate-queue.sh 3               # 5 → 3 concurrent locales
#   scripts/i18n-generate-queue.sh 5 "ca sr my"    # only these, in this order
set -uo pipefail
cd "$(dirname "$0")/.."

WORKERS="${1:-5}"
LOG_DIR="${I18N_QUEUE_LOG_DIR:-/tmp/i18n-generate}"
mkdir -p "$LOG_DIR"

if [ $# -ge 2 ]; then
	QUEUE="$2"
else
	# Every configured locale that is missing keys - not merely every locale with
	# no file. A run interrupted halfway leaves a partial catalog behind, and
	# selecting on file existence would skip exactly the locales that still need
	# work. Most-complete first, so languages closest to shipping ship soonest.
	QUEUE=$(node -e '
		const cfg = require("./.i18nrc.json");
		const { existsSync, readFileSync } = require("node:fs");
		const flat = (n, p = "", o = {}) => {
			for (const [k, v] of Object.entries(n || {})) {
				const q = p ? `${p}.${k}` : k;
				if (v && typeof v === "object") flat(v, q, o);
				else if (typeof v === "string") o[q] = v;
			}
			return o;
		};
		const src = flat(JSON.parse(readFileSync(cfg.entry, "utf8")));
		const keys = Object.keys(src);
		const missing = (code) => {
			const p = `${cfg.output}/${code}.json`;
			if (!existsSync(p)) return keys.length;
			const t = flat(JSON.parse(readFileSync(p, "utf8")));
			return keys.filter((k) => !t[k] || !String(t[k]).trim()).length;
		};
		const todo = cfg.outputLocales
			.map((code) => ({ code, n: missing(code) }))
			.filter((x) => x.n > 0)
			.sort((a, b) => a.n - b.n);
		console.log(todo.map((x) => x.code).join(" "));
	')
fi

# Never queue a locale another process is already translating: both would write
# the same catalog file and one set of writes would be lost.
INFLIGHT=$(ps -eo args | grep -oE 'i18n-translate\.mjs --locale=[a-zA-Z-]+' | grep -oE '[^=]+$' | sort -u)
for BUSY in $INFLIGHT; do
	QUEUE=$(echo " $QUEUE " | sed "s/ $BUSY / /g")
done

if [ -z "${QUEUE// /}" ]; then
	echo "i18n-generate-queue: every configured locale already has a catalog."
	exit 0
fi

echo "i18n-generate-queue: $(echo "$QUEUE" | wc -w) locale(s), $WORKERS at a time, logs in $LOG_DIR"

for L in $QUEUE; do
	while [ "$(pgrep -fc 'i18n-translate\.mjs --locale=' || true)" -ge "$WORKERS" ]; do
		sleep 20
	done
	echo "[start] $L  ($(date -u +%H:%M:%S)Z)"
	nohup node scripts/i18n-translate.mjs --locale="$L" --concurrency=8 > "$LOG_DIR/$L.log" 2>&1 &
	sleep 5
done

wait
echo "i18n-generate-queue: done ($(date -u +%H:%M:%S)Z)"
