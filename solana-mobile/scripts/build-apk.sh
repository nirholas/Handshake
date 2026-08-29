#!/usr/bin/env bash
# Build a signed release APK for the three.ws Solana Mobile dApp Store
# listing. Requires Node 18+, a JDK (for keytool), and a release keystore.
# Bubblewrap manages its own JDK 17 + Android SDK under ~/.bubblewrap on
# first run.
#
# Usage:
#   KEYSTORE_PASSWORD='...' ./scripts/build-apk.sh
#
# Environment:
#   KEYSTORE_PASSWORD    keystore password          (required; SOLANA_MOBILE_KEYSTORE_PASSWORD,
#                        the name used in the repo's .env, is accepted as a fallback)
#   KEYSTORE_PATH        path to release.keystore   (default: ./android.keystore)
#   KEY_ALIAS            release key alias          (default: threews)
#   KEY_PASSWORD         key password               (defaults to KEYSTORE_PASSWORD)
#   VERSION_NAME         override appVersionName    (default: from twa/twa-manifest.json)
#   VERSION_CODE         override appVersionCode    (default: from twa/twa-manifest.json)
#   ASSETLINKS_OUT       where to write assetlinks.json from the fingerprint
#                        (default: ../public/.well-known/assetlinks.json)
#   ACCEPT_ANDROID_SDK_LICENSES=1
#                        non-interactively accept Android SDK licenses (needed
#                        once per machine, e.g. in CI or a fresh container)
#   BUBBLEWRAP_JDK_PATH / BUBBLEWRAP_ANDROID_SDK_PATH
#                        pre-seed ~/.bubblewrap/config.json on machines where
#                        Bubblewrap's interactive first-run wizard can't run
#
# Non-interactive by design: signing passwords go to Bubblewrap via its
# BUBBLEWRAP_KEYSTORE_PASSWORD / BUBBLEWRAP_KEY_PASSWORD env vars, the TWA
# project is (re)generated from twa/twa-manifest.json with `bubblewrap update`
# (NOT `init` — init only accepts a live web-manifest URL to bootstrap a new
# twa-manifest.json, it can never consume the one we already maintain).

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

require() {
	command -v "$1" >/dev/null 2>&1 || { echo "[build-apk] missing required tool: $1" >&2; exit 1; }
}

require node
require npx
require keytool

# The repo's .env stores the password as SOLANA_MOBILE_KEYSTORE_PASSWORD (a
# name that cannot collide with any other keystore on the machine); accept it
# so `set -a; . ../.env; set +a; ./scripts/build-apk.sh` just works.
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:-${SOLANA_MOBILE_KEYSTORE_PASSWORD:-}}"
if [[ -z "$KEYSTORE_PASSWORD" ]]; then
	echo "[build-apk] KEYSTORE_PASSWORD (or SOLANA_MOBILE_KEYSTORE_PASSWORD) must be set" >&2
	exit 1
fi

KEYSTORE_PATH="${KEYSTORE_PATH:-$(pwd)/android.keystore}"
KEY_ALIAS="${KEY_ALIAS:-threews}"
KEY_PASSWORD="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"
ASSETLINKS_OUT="${ASSETLINKS_OUT:-$(cd .. && pwd)/public/.well-known/assetlinks.json}"
BUBBLEWRAP_CONFIG="$HOME/.bubblewrap/config.json"

echo "[build-apk] working dir: $(pwd)"
echo "[build-apk] keystore: $KEYSTORE_PATH (alias=$KEY_ALIAS)"

# ── 1. Generate keystore if missing ────────────────────────────────────────
if [[ ! -f "$KEYSTORE_PATH" ]]; then
	echo "[build-apk] no keystore at $KEYSTORE_PATH — generating new RSA 2048 release key (valid 30 years)"
	keytool -genkeypair \
		-v \
		-keystore "$KEYSTORE_PATH" \
		-alias "$KEY_ALIAS" \
		-keyalg RSA \
		-keysize 2048 \
		-validity 10950 \
		-storepass "$KEYSTORE_PASSWORD" \
		-keypass "$KEY_PASSWORD" \
		-dname "CN=three.ws, OU=Mobile, O=three.ws, L=Internet, ST=NA, C=US"
fi

# ── 2. Extract SHA-256 fingerprint and write assetlinks.json ───────────────
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
	echo "[build-apk] failed to extract SHA-256 fingerprint from keystore" >&2
	exit 1
fi

echo "[build-apk] SHA-256: $FINGERPRINT"

# Every certificate the app can legitimately be signed with goes in the file,
# not just this keystore: Play App Signing re-signs the upload with Google's
# key, and a Play install presenting an unlisted certificate loses full-screen
# mode. Extra certificates are declared in twa/extra-fingerprints.json.
node scripts/assetlinks.mjs --fingerprint "$FINGERPRINT" --out "$ASSETLINKS_OUT"

echo "[build-apk] wrote assetlinks.json → $ASSETLINKS_OUT"

# ── 3. Install Bubblewrap CLI locally if missing ───────────────────────────
if ! npx --no-install @bubblewrap/cli --version >/dev/null 2>&1; then
	echo "[build-apk] installing @bubblewrap/cli locally"
	npm install --no-save @bubblewrap/cli@latest
fi

BUBBLEWRAP="npx --no-install @bubblewrap/cli"

# ── 4. Bubblewrap JDK / Android SDK setup ──────────────────────────────────
# Bubblewrap's first run normally walks an interactive wizard to download a
# JDK 17 and the Android SDK into ~/.bubblewrap. In a non-interactive shell
# that wizard crashes (inquirer over piped stdin), so pre-seed the config
# when the caller provides the paths.
if [[ ! -f "$BUBBLEWRAP_CONFIG" ]]; then
	if [[ -n "${BUBBLEWRAP_JDK_PATH:-}" && -n "${BUBBLEWRAP_ANDROID_SDK_PATH:-}" ]]; then
		mkdir -p "$(dirname "$BUBBLEWRAP_CONFIG")"
		node -e "
			const fs = require('fs');
			fs.writeFileSync(process.argv[1], JSON.stringify({
				jdkPath: process.argv[2],
				androidSdkPath: process.argv[3],
			}));
		" "$BUBBLEWRAP_CONFIG" "$BUBBLEWRAP_JDK_PATH" "$BUBBLEWRAP_ANDROID_SDK_PATH"
		echo "[build-apk] seeded $BUBBLEWRAP_CONFIG from env"
	elif [[ ! -t 0 ]]; then
		echo "[build-apk] no ~/.bubblewrap/config.json and stdin is not a TTY." >&2
		echo "[build-apk] Either run this script once from an interactive shell (Bubblewrap" >&2
		echo "[build-apk] will offer to download JDK 17 + Android SDK), or set" >&2
		echo "[build-apk] BUBBLEWRAP_JDK_PATH and BUBBLEWRAP_ANDROID_SDK_PATH." >&2
		exit 1
	fi
	# Interactive shell with no config: fall through and let Bubblewrap's
	# wizard handle the download prompts normally.
fi

# Accept Android SDK package licenses non-interactively when asked to.
# Without this, the first Gradle build fails on the unaccepted
# build-tools license.
if [[ "${ACCEPT_ANDROID_SDK_LICENSES:-0}" == "1" && -f "$BUBBLEWRAP_CONFIG" ]]; then
	SDK_ROOT="$(node -e "console.log(require('$BUBBLEWRAP_CONFIG').androidSdkPath || '')")"
	SDKMANAGER="$(find "$SDK_ROOT" -name sdkmanager -type f 2>/dev/null | head -1)"
	if [[ -n "$SDKMANAGER" ]]; then
		JDK_ROOT="$(node -e "console.log(require('$BUBBLEWRAP_CONFIG').jdkPath || '')")"
		echo "[build-apk] accepting Android SDK licenses"
		yes | JAVA_HOME="$JDK_ROOT" PATH="$JDK_ROOT/bin:$PATH" "$SDKMANAGER" --sdk_root="$SDK_ROOT" --licenses >/dev/null || true
	fi
fi

# ── 5. Generate the TWA project from twa/twa-manifest.json ─────────────────
BUILD_DIR="$(pwd)/build"
mkdir -p "$BUILD_DIR"
cp -f "$KEYSTORE_PATH" "$BUILD_DIR/android.keystore"

# Bubblewrap downloads every icon it embeds from the URL in the manifest. Those
# point at https://three.ws, which only serves what the LAST deploy shipped:
# an icon added in this commit 404s until the site ships, and the APK's icon
# would otherwise trail the repo by one deploy. Serve ../public locally for the
# duration of the build and rewrite three.ws icon URLs to it whenever the file
# exists in the working tree, so the APK always carries this commit's icons.
ICON_PORT="${ICON_PORT:-47391}"
PUBLIC_DIR="$(cd .. && pwd)/public"
python3 -m http.server "$ICON_PORT" --bind 127.0.0.1 --directory "$PUBLIC_DIR" >/dev/null 2>&1 &
ICON_SERVER_PID=$!
trap 'kill "$ICON_SERVER_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
	curl -sf -o /dev/null "http://127.0.0.1:$ICON_PORT/pwa-512x512.png" && break
	sleep 0.2
done
echo "[build-apk] serving $PUBLIC_DIR icons at http://127.0.0.1:$ICON_PORT"

# Copy the manifest and inject the signing key + optional version overrides.
node <<NODE
const fs = require('fs');
const path = require('path');
const manifest = require('./twa/twa-manifest.json');
manifest.signingKey = { path: './android.keystore', alias: '${KEY_ALIAS}' };
const publicDir = '${PUBLIC_DIR}';
const localOrigin = 'http://127.0.0.1:${ICON_PORT}';
const localize = (url) => {
	if (typeof url !== 'string' || !url.startsWith('https://three.ws/')) return url;
	const rel = url.slice('https://three.ws/'.length).split('?')[0];
	return fs.existsSync(path.join(publicDir, rel)) ? localOrigin + '/' + rel : url;
};
for (const key of ['iconUrl', 'maskableIconUrl', 'monochromeIconUrl']) manifest[key] = localize(manifest[key]);
for (const s of manifest.shortcuts || []) s.chosenIconUrl = localize(s.chosenIconUrl);
// Bubblewrap's JSON field for the Android versionName is "appVersion".
if ('${VERSION_NAME:-}') manifest.appVersion = '${VERSION_NAME:-}';
if ('${VERSION_CODE:-}') manifest.appVersionCode = Number('${VERSION_CODE:-}');
fs.writeFileSync('${BUILD_DIR}/twa-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
NODE

pushd "$BUILD_DIR" >/dev/null

rm -f app-release-signed.apk three-ws-release.apk

echo "[build-apk] generating Android project (bubblewrap update)"
$BUBBLEWRAP update --skipVersionUpgrade

# Patch build.gradle to declare resConfigs (avoids the Bubblewrap all-locales
# bug that lists every Android locale on the dApp Store listing). update
# regenerates the project each run, so re-apply every time.
GRADLE_FILE="app/build.gradle"
[[ -f "$GRADLE_FILE" ]] || GRADLE_FILE="build.gradle"
if [[ -f "$GRADLE_FILE" ]] && ! grep -q "resConfigs" "$GRADLE_FILE"; then
	node <<NODE
const fs = require('fs');
const p = '${GRADLE_FILE}';
const src = fs.readFileSync(p, 'utf8');
const patched = src.replace(
	/(defaultConfig\s*\{[^}]*?versionName[^\n]*\n)/,
	(m) => m + '        resConfigs "en"\n',
);
fs.writeFileSync(p, patched);
console.log('[build-apk] patched ' + p + ' with resConfigs "en"');
NODE
fi

# ── 5b. Lay the native overlay over the generated project ─────────────────
# `bubblewrap update` regenerates everything, so the glance home screen widget
# (an AppWidgetProvider, its layouts, a link activity, the WorkManager
# dependency) is applied here, after update and before build. The script exits
# non-zero on a missing overlay or a failed manifest merge: the store listing
# says the app has a widget, so a widget-less APK must never ship silently.
OVERLAY_DIR="$(cd .. && pwd)/android-overlay"
if [[ ! -d "$OVERLAY_DIR" ]]; then
	echo "[build-apk] ERROR: native overlay missing at $OVERLAY_DIR" >&2
	exit 1
fi
echo "[build-apk] applying native overlay (home screen widget)"
node ../scripts/apply-overlay.mjs --project "$BUILD_DIR" --overlay "$OVERLAY_DIR"

# ── 6. Build & sign the APK ────────────────────────────────────────────────
echo "[build-apk] building signed release APK"
BUBBLEWRAP_KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD" \
BUBBLEWRAP_KEY_PASSWORD="$KEY_PASSWORD" \
$BUBBLEWRAP build \
	--skipPwaValidation \
	--signingKeyPath "$(pwd)/android.keystore" \
	--signingKeyAlias "$KEY_ALIAS"

APK_PATH=""
for candidate in app-release-signed.apk app/build/outputs/apk/release/app-release-signed.apk; do
	if [[ -f "$candidate" ]]; then
		APK_PATH="$(pwd)/$candidate"
		break
	fi
done

if [[ -z "$APK_PATH" ]]; then
	echo "[build-apk] ERROR: signed APK not found after build" >&2
	exit 1
fi

popd >/dev/null

# ── 7. Verify signature ────────────────────────────────────────────────────
APKSIGNER="$(command -v apksigner || true)"
if [[ -z "$APKSIGNER" && -f "$BUBBLEWRAP_CONFIG" ]]; then
	SDK_ROOT="$(node -e "console.log(require('$BUBBLEWRAP_CONFIG').androidSdkPath || '')")"
	APKSIGNER="$(find "$SDK_ROOT/build-tools" -name apksigner -type f 2>/dev/null | sort -V | tail -1)"
fi
if [[ -n "$APKSIGNER" ]]; then
	echo "[build-apk] verifying APK signature"
	"$APKSIGNER" verify --print-certs "$APK_PATH" | head -4
else
	echo "[build-apk] apksigner not found — skipping signature verification"
fi

OUT="$(pwd)/build/three-ws-release.apk"
cp -f "$APK_PATH" "$OUT"
echo "[build-apk] ✓ signed APK ready: $OUT"
echo "[build-apk] next: deploy assetlinks.json, then run scripts/publish.sh"
