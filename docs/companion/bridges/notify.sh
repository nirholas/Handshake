#!/usr/bin/env bash
# notify.sh - hand anything on a machine to your three.ws companion.
#
# The smallest possible bridge: one curl, no dependencies, works on any Unix,
# in CI, in a cron job, at the end of a long build, from a Raspberry Pi.
#
#   ./notify.sh "Backup finished" "1.2 TB in 41 minutes"
#   ./notify.sh "Deploy failed" "$(tail -5 build.log)" --priority high
#   make release || ./notify.sh "Release build failed" --priority high
#
# Token, in order of precedence:
#   $COMPANION_TOKEN
#   ~/.config/three-ws/companion.json  (written by `companion login`)
#
# Exit codes: 0 delivered or stored, 1 usage error, 2 rejected by the server.

set -euo pipefail

ENDPOINT="${COMPANION_API_BASE:-https://three.ws}/api/companion/ingest"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/three-ws/companion.json"
SENDER="${COMPANION_SENDER:-$(hostname)}"
PRIORITY="normal"

title="${1:-}"
body="${2:-}"
shift $(( $# > 2 ? 2 : $# )) || true

while [ $# -gt 0 ]; do
	case "$1" in
		--priority) PRIORITY="${2:-normal}"; shift 2 ;;
		--from) SENDER="${2:-$SENDER}"; shift 2 ;;
		--url) URL="${2:-}"; shift 2 ;;
		*) shift ;;
	esac
done

if [ -z "$title" ]; then
	echo "usage: notify.sh <title> [body] [--priority high|normal|low] [--from name] [--url link]" >&2
	exit 1
fi

token="${COMPANION_TOKEN:-}"
if [ -z "$token" ] && [ -f "$CONFIG" ]; then
	# Small, flat config; no jq dependency for something this simple.
	token="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG" | head -1)"
fi

if [ -z "$token" ]; then
	echo "No bridge token. Set COMPANION_TOKEN, or run: npx @three-ws/companion login --token cmp_..." >&2
	exit 1
fi

# JSON-escape without assuming python or jq is installed.
escape() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS=""} {print (NR>1 ? "\\n" : "") $0}'
}

payload="{\"title\":\"$(escape "$title")\",\"sender\":\"$(escape "$SENDER")\",\"app\":\"shell\",\"priority\":\"$PRIORITY\""
[ -n "$body" ] && payload="$payload,\"body\":\"$(escape "$body")\""
[ -n "${URL:-}" ] && payload="$payload,\"url\":\"$(escape "$URL")\""
payload="$payload}"

response="$(curl -sS -m 15 -w '\n%{http_code}' -X POST "$ENDPOINT" \
	-H "Authorization: Bearer $token" \
	-H 'Content-Type: application/json' \
	--data-binary "$payload")"

status="$(printf '%s' "$response" | tail -1)"
body_out="$(printf '%s' "$response" | sed '$d')"

if [ "$status" -ge 400 ]; then
	echo "companion rejected it ($status): $body_out" >&2
	exit 2
fi

echo "$body_out"
