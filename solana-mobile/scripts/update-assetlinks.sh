#!/usr/bin/env bash
# Refresh public/.well-known/assetlinks.json from the current release keystore.
# Safe to run repeatedly. Useful when rotating release keys.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

KEYSTORE_PATH="${KEYSTORE_PATH:-$(pwd)/android.keystore}"
KEY_ALIAS="${KEY_ALIAS:-threews}"
ASSETLINKS_OUT="${ASSETLINKS_OUT:-$(cd .. && pwd)/public/.well-known/assetlinks.json}"
PACKAGE_ID=$(node -e "console.log(require('./twa/twa-manifest.json').packageId)")

if [[ -z "${KEYSTORE_PASSWORD:-}" ]]; then
	echo "[update-assetlinks] KEYSTORE_PASSWORD must be set" >&2; exit 1
fi
if [[ ! -f "$KEYSTORE_PATH" ]]; then
	echo "[update-assetlinks] no keystore at $KEYSTORE_PATH" >&2; exit 1
fi

FINGERPRINT="$(
	keytool -list -v \
		-keystore "$KEYSTORE_PATH" \
		-alias "$KEY_ALIAS" \
		-storepass "$KEYSTORE_PASSWORD" \
		2>/dev/null \
	| awk -F': ' '/SHA256:/ { print $2; exit }' \
	| tr -d ' '
)"

if [[ -z "$FINGERPRINT" ]]; then
	echo "[update-assetlinks] failed to extract SHA-256" >&2; exit 1
fi

# Includes every certificate from twa/extra-fingerprints.json (Play App
# Signing) alongside this keystore's, so refreshing one channel's key never
# silently un-verifies another channel's installs.
node scripts/assetlinks.mjs --package "$PACKAGE_ID" --fingerprint "$FINGERPRINT" --out "$ASSETLINKS_OUT"

echo "[update-assetlinks] wrote $ASSETLINKS_OUT (SHA-256: $FINGERPRINT)"
echo "[update-assetlinks] deploy three.ws and verify https://three.ws/.well-known/assetlinks.json"
