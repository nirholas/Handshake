#!/usr/bin/env bash
# Submit a new release of the three.ws app to the Solana dApp Store.
#
# Since dapp-store-cli 1.0 (May 2026) publishing is Publisher Portal backed:
# the publisher profile, KYC, the App NFT, and the listing copy + media all
# live in https://publish.solanamobile.com, and the CLI only uploads one APK
# per release. There is no local config.yaml consumed by the CLI anymore; the
# portal matches the APK's Android package name (ws.three.app) to the app it
# already knows, mints the release NFT, and submits it for review.
#
# Prerequisites (one-time, in the portal, by the owner):
#   - publisher profile + KYC/KYB approved
#   - the three.ws app created ("Add a dApp") with its App NFT minted, using
#     the listing text in publish/listing/ and the media in publish/media/
#   - an API key from Settings > API keys
# Per release:
#   - scripts/build-apk.sh produced build/three-ws-release.apk with a bumped
#     appVersionCode
#   - https://three.ws/.well-known/assetlinks.json is live for that key
#
# Usage:
#   SOLANA_KEYPAIR=~/.config/solana/publisher.json \
#   DAPP_STORE_API_KEY=... \
#   ./scripts/publish.sh
#
# Environment:
#   SOLANA_KEYPAIR        path to the signer keypair (the portal's publisher wallet)
#   DAPP_STORE_API_KEY    Publisher Portal API key (read by the CLI over stdin)
#   APK_PATH              override APK path (default: build/three-ws-release.apk)
#   WHATS_NEW             override release notes (default: publish/listing/new-in-version.txt)
#   DAPP_STORE_PORTAL_URL alternate portal origin (staging), passed through as-is
#   DAPP_STORE_DRYRUN     if "1", print the command without executing it

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

require() { command -v "$1" >/dev/null 2>&1 || { echo "[publish] missing $1" >&2; exit 1; }; }
require node
require npx
require curl

if [[ -z "${SOLANA_KEYPAIR:-}" ]]; then
	echo "[publish] SOLANA_KEYPAIR must be set (path to the publisher wallet keypair)" >&2; exit 1
fi
if [[ ! -f "$SOLANA_KEYPAIR" ]]; then
	echo "[publish] keypair not found at $SOLANA_KEYPAIR" >&2; exit 1
fi
if [[ -z "${DAPP_STORE_API_KEY:-}" ]]; then
	echo "[publish] DAPP_STORE_API_KEY must be set." >&2
	echo "[publish] Create one at https://publish.solanamobile.com/dashboard/settings/api-keys" >&2
	exit 1
fi

APK_PATH="${APK_PATH:-$(pwd)/build/three-ws-release.apk}"
if [[ ! -f "$APK_PATH" ]]; then
	echo "[publish] APK missing: $APK_PATH (run scripts/build-apk.sh first)" >&2
	exit 1
fi

WHATS_NEW="${WHATS_NEW:-$(cat publish/listing/new-in-version.txt)}"

# The dApp Store rejects a re-used versionCode, so refuse to ship the same
# number twice from this machine: the last submitted code is recorded next to
# the APK after a successful run.
STAMP="$(pwd)/build/.last-published-version-code"
VERSION_CODE="$(node -e "console.log(require('./twa/twa-manifest.json').appVersionCode)")"
if [[ -f "$STAMP" && "$(cat "$STAMP")" == "$VERSION_CODE" ]]; then
	echo "[publish] appVersionCode $VERSION_CODE was already published from here." >&2
	echo "[publish] Bump appVersionCode in twa/twa-manifest.json, rebuild, then publish." >&2
	exit 1
fi

echo "[publish] verifying assetlinks.json is live"
if ! curl -sSfL -o /dev/null -m 10 "https://three.ws/.well-known/assetlinks.json"; then
	echo "[publish] https://three.ws/.well-known/assetlinks.json is NOT reachable; review will fail." >&2
	exit 1
fi

if ! npx --no-install dapp-store --version >/dev/null 2>&1; then
	echo "[publish] installing @solana-mobile/dapp-store-cli"
	npm install --no-save --no-audit --no-fund @solana-mobile/dapp-store-cli@latest
fi

CMD=(npx --no-install dapp-store
	--apk-file "$APK_PATH"
	--keypair "$SOLANA_KEYPAIR"
	--whats-new "$WHATS_NEW"
	--api-key-stdin
	--verbose)
if [[ -n "${DAPP_STORE_PORTAL_URL:-}" ]]; then
	CMD+=(--portal-url "$DAPP_STORE_PORTAL_URL")
fi

echo "[publish] \$ ${CMD[*]}"
if [[ "${DAPP_STORE_DRYRUN:-0}" == "1" ]]; then
	echo "[publish] dry run, nothing submitted"
	exit 0
fi

# The API key goes over stdin so it never appears in a process listing.
printf '%s' "$DAPP_STORE_API_KEY" | "${CMD[@]}"

printf '%s\n' "$VERSION_CODE" > "$STAMP"
echo "[publish] submitted versionCode $VERSION_CODE. Review results arrive by email from"
echo "[publish] publishersupport@dappstore.solanamobile.com within 3-5 business days;"
echo "[publish] status: https://publish.solanamobile.com"
echo "[publish] If the upload died mid-way: npx --no-install dapp-store resume --release-id <id>"
