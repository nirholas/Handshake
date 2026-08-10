#!/usr/bin/env bash
# Stage a JDK 17 + Android SDK for Bubblewrap on a headless machine (codespace,
# container, CI-less build box) where Bubblewrap's interactive first-run wizard
# cannot run. Idempotent: safe to re-run; skips anything already staged.
#
# Layout notes that cost a debugging session to learn (2026-08-10):
#   * Bubblewrap's androidSdkPath must be the directory that directly contains
#     bin/sdkmanager (the extracted cmdline-tools folder itself), NOT a
#     conventional SDK root. Its validatePath checks for <path>/bin or
#     <path>/tools, and getAndroidHome() returns the path as-is.
#   * The cmdline-tools zip ships a source.properties at that same root. Every
#     SDK scanner (AGP's and sdkmanager's own) then treats the ROOT as one
#     legacy package and never descends into platforms/ or build-tools/, so
#     installed packages are invisible and each build side-installs duplicates
#     (android-36-2, -3, ...) before failing with "Failed to find target
#     'android-36'". The fix is renaming that root source.properties away.
#
# After this script succeeds, run build-apk.sh normally.

set -euo pipefail

BW_HOME="$HOME/.bubblewrap"
JDK_DIR="$BW_HOME/jdk"
SDK_DIR="$BW_HOME/android_sdk/cmdline-tools"
CMDTOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
JDK_URL="https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
PLATFORM_PKG="${PLATFORM_PKG:-platforms;android-36}"

mkdir -p "$JDK_DIR" "$BW_HOME/android_sdk"

# ── JDK 17 ─────────────────────────────────────────────────────────────────
JDK_HOME="$(find "$JDK_DIR" -maxdepth 1 -type d -name 'jdk-17*' | head -1)"
if [[ -z "$JDK_HOME" ]]; then
	echo "[setup-android-sdk] downloading Temurin JDK 17"
	curl -fsSL -o "$BW_HOME/jdk17.tar.gz" "$JDK_URL"
	tar -xzf "$BW_HOME/jdk17.tar.gz" -C "$JDK_DIR"
	rm -f "$BW_HOME/jdk17.tar.gz"
	JDK_HOME="$(find "$JDK_DIR" -maxdepth 1 -type d -name 'jdk-17*' | head -1)"
fi
echo "[setup-android-sdk] JDK: $JDK_HOME"

# ── Android command-line tools ─────────────────────────────────────────────
if [[ ! -x "$SDK_DIR/bin/sdkmanager" ]]; then
	echo "[setup-android-sdk] downloading Android command-line tools"
	curl -fsSL -o "$BW_HOME/cmdtools.zip" "$CMDTOOLS_URL"
	unzip -q -o "$BW_HOME/cmdtools.zip" -d "$BW_HOME/android_sdk"
	rm -f "$BW_HOME/cmdtools.zip"
fi

# Neutralize the root package marker so SDK scanners descend into subdirs
# (see layout notes above).
if [[ -f "$SDK_DIR/source.properties" ]]; then
	mv "$SDK_DIR/source.properties" "$SDK_DIR/source.properties.disabled"
	echo "[setup-android-sdk] disabled root source.properties (breaks package scanning)"
fi

# ── SDK packages + licenses ────────────────────────────────────────────────
export JAVA_HOME="$JDK_HOME"
export PATH="$JDK_HOME/bin:$PATH"
# `yes` dies with SIGPIPE (141) once sdkmanager stops reading stdin, which
# happens whenever every license is already accepted; only that code is benign.
yes | "$SDK_DIR/bin/sdkmanager" --sdk_root="$SDK_DIR" --licenses > /dev/null || [[ $? -eq 141 ]]
"$SDK_DIR/bin/sdkmanager" --sdk_root="$SDK_DIR" "$PLATFORM_PKG" > /dev/null
echo "[setup-android-sdk] installed: $("$SDK_DIR/bin/sdkmanager" --sdk_root="$SDK_DIR" --list_installed 2>/dev/null | awk 'NR>3 && $1 !~ /^-/ {print $1}' | paste -sd, -)"

# ── Seed Bubblewrap config ─────────────────────────────────────────────────
mkdir -p "$BW_HOME"
node -e "
	const fs = require('fs');
	const p = process.argv[1];
	let c = {};
	try { c = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
	c.jdkPath = process.argv[2];
	c.androidSdkPath = process.argv[3];
	fs.writeFileSync(p, JSON.stringify(c));
" "$BW_HOME/config.json" "$JDK_HOME" "$SDK_DIR"
echo "[setup-android-sdk] seeded $BW_HOME/config.json"
echo "[setup-android-sdk] done. Run build-apk.sh next."
