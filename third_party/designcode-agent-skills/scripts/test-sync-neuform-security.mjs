#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import {
  assertSafeRemoteUrl,
  buildSandboxedDemo,
  hardenImportedHtml,
  hasExpectedMagic,
  isBlockedIp,
  manifestUrl,
  normalizeAssetFiles,
  sanitizeManifestAssets,
} from "./sync-neuform-skill-demos.mjs";

const allowedHosts = new Set(["images.unsplash.com", "localhost"]);

assert.equal(isBlockedIp("127.0.0.1"), true);
assert.equal(isBlockedIp("169.254.169.254"), true);
assert.equal(isBlockedIp("10.0.0.1"), true);
assert.equal(isBlockedIp("192.168.1.4"), true);
assert.equal(isBlockedIp("::1"), true);
assert.equal(isBlockedIp("fd00::1"), true);
assert.equal(isBlockedIp("8.8.8.8"), false);

await assert.rejects(
  assertSafeRemoteUrl("http://images.unsplash.com/image.jpg", allowedHosts, { resolveDns: false }),
  /must use HTTPS/,
);
await assert.rejects(
  assertSafeRemoteUrl("https://localhost/image.jpg", allowedHosts, { resolveDns: false }),
  /blocked address/,
);
await assert.rejects(
  assertSafeRemoteUrl("https://example.com/image.jpg", allowedHosts, { resolveDns: false }),
  /not allowlisted/,
);
await assert.doesNotReject(
  assertSafeRemoteUrl("https://demo-project.supabase.co/storage/v1/object/public/image.jpg", allowedHosts, { resolveDns: false }),
);

assert.equal(
  manifestUrl("https://example.com/image.jpg?token=secret-value#fragment"),
  "https://example.com/image.jpg",
);
assert.equal(manifestUrl("not a URL"), "");

const sourceHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Imported demo</title>
  <base href="https://attacker.example/">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js"></script>
</head>
<body>
  <a href="javascript:alert(1)">Unsafe link</a>
  <iframe src="https://attacker.example/"></iframe>
  <script>document.body.dataset.ready = "true";</script>
</body>
</html>`;

const hardened = hardenImportedHtml(sourceHtml);
assert.match(hardened, /Content-Security-Policy/);
assert.ok(hardened.indexOf("Content-Security-Policy") < hardened.indexOf("gsap.min.js"));
assert.doesNotMatch(hardened, /<base\b/i);
assert.doesNotMatch(hardened, /<iframe\b/i);
assert.doesNotMatch(hardened, /javascript:/i);
assert.throws(
  () => hardenImportedHtml(sourceHtml.replace("cdnjs.cloudflare.com", "attacker.example")),
  /non-allowlisted script host/,
);
assert.throws(
  () => hardenImportedHtml(`<script>alert(1)</script>${sourceHtml}`),
  /canonical html\/head/,
);

assert.deepEqual(
  normalizeAssetFiles([{ file: "assets/preview.jpg" }, "assets/video/demo.mp4", "assets/preview.jpg"]),
  ["assets/preview.jpg", "assets/video/demo.mp4"],
);
assert.throws(() => normalizeAssetFiles(["../private.txt"]), /Unsafe local asset path/);

const wrapper = buildSandboxedDemo(hardened, ["assets/preview.jpg"]);
assert.match(wrapper, /neuform-sandboxed-demo/);
assert.match(wrapper, /sandbox="allow-scripts"/);
assert.doesNotMatch(wrapper, /allow-same-origin/);
assert.doesNotMatch(wrapper, /attacker\.example/);
const wrapperScript = wrapper.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
assert.doesNotThrow(() => new vm.Script(wrapperScript));
assert.match(wrapperScript, /neuform-assets-v1/);
assert.match(wrapperScript, /postMessage/);
assert.doesNotMatch(wrapperScript, /createObjectURL/);
assert.doesNotMatch(wrapperScript, /data:text\/javascript/);
assert.match(hardened, /data-neuform-asset-bootstrap/);
assert.match(hardened, /new Blob/);
assert.equal((hardened.match(/data-neuform-asset-bootstrap/g) || []).length, 1);
const wrapperWithoutRuntimeFetch = buildSandboxedDemo(hardened, [
  "assets/preview.jpg",
  "../../../../assets/runtime/runtime-123456789abc-example.js",
]);
assert.match(wrapperWithoutRuntimeFetch, /runtime-123456789abc-example\.js/);
assert.match(wrapperWithoutRuntimeFetch, /__NEUFORM_RUNTIME_SOURCES__/);

const sanitizedAssets = sanitizeManifestAssets({
  preview: "assets/source-preview.jpg",
  bundled: [{ file: "assets/image.jpg", original_url: "https://images.unsplash.com/photo.jpg?w=1600&token=secret" }],
  skipped: [{ reason: "Failed for https://images.unsplash.com/photo.jpg?token=secret", url: "https://images.unsplash.com/photo.jpg?token=secret" }],
});
assert.equal(sanitizedAssets.bundled[0].original_url, "https://images.unsplash.com/photo.jpg");
assert.equal(sanitizedAssets.skipped[0].url, "https://images.unsplash.com/photo.jpg");
assert.doesNotMatch(sanitizedAssets.skipped[0].reason, /token=secret/);

assert.equal(hasExpectedMagic(Buffer.from("ffd8ff", "hex"), ".jpg"), true);
assert.equal(hasExpectedMagic(Buffer.from("89504e470d0a1a0a", "hex"), ".png"), true);
assert.equal(hasExpectedMagic(Buffer.from("<svg></svg>"), ".png"), false);

const sourceFiles = execFileSync("git", ["ls-files", "agent-skills/**/demo/source.json"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);
assert.equal(sourceFiles.length, 38);

for (const sourceFile of sourceFiles) {
  const demoDirectory = path.dirname(sourceFile);
  const indexFile = path.join(demoDirectory, "index.html");
  const manifest = JSON.parse(readFileSync(sourceFile, "utf8"));
  const indexHtml = readFileSync(indexFile, "utf8");
  assert.match(indexHtml, /neuform-sandboxed-demo/, indexFile);
  assert.match(indexHtml, /sandbox="allow-scripts"/, indexFile);
  assert.doesNotMatch(indexHtml, /allow-same-origin/, indexFile);
  assert.doesNotMatch(indexHtml, /<script\b[^>]*\bsrc=/i, indexFile);
  assert.equal(manifest?.html?.security_profile, "sandboxed-srcdoc-v1", sourceFile);
  assert.equal(createHash("sha256").update(indexHtml).digest("hex"), manifest?.html?.sandboxed_sha256, sourceFile);

  const encoded = indexHtml.match(/const encodedHtml = "([A-Za-z0-9+/=]+)";/)?.[1] || "";
  assert.ok(encoded, `${indexFile}: missing encoded sandbox payload`);
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  assert.match(decoded, /Content-Security-Policy/, indexFile);
  assert.equal((decoded.match(/data-neuform-asset-bootstrap/g) || []).length, 1, indexFile);
  assert.doesNotMatch(decoded, /__neuform(?:RuntimeScripts|SecondScript|SandboxErrors)/, indexFile);
  assertAllowedRemoteRuntime(decoded, indexFile);
  const runtimeAssets = (manifest?.assets?.bundled || []).filter((asset) => asset?.kind === "runtime-script");
  for (const runtimeAsset of runtimeAssets) {
    assert.match(
      decoded,
      new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["']${escapeRegExp(runtimeAsset.file)}["']`, "i"),
      `${indexFile}: runtime provenance mismatch`,
    );
  }

  for (const entry of [...(manifest?.assets?.bundled || []), ...(manifest?.assets?.skipped || [])]) {
    for (const key of ["url", "original_url"]) {
      if (!entry?.[key]) continue;
      const parsed = new URL(entry[key]);
      assert.equal(parsed.search, "", `${sourceFile}: ${key} retained a query string`);
      assert.equal(parsed.hash, "", `${sourceFile}: ${key} retained a fragment`);
    }
  }
  for (const asset of manifest?.assets?.bundled || []) {
    const assetFile = path.join(demoDirectory, asset.file);
    assert.ok(existsSync(assetFile), `${sourceFile}: missing ${asset.file}`);
    if (asset?.kind === "runtime-script") {
      assert.match(asset.sha256 || "", /^[a-f0-9]{64}$/, `${sourceFile}: missing runtime checksum`);
      assert.equal(
        createHash("sha256").update(readFileSync(assetFile)).digest("hex"),
        asset.sha256,
        `${sourceFile}: runtime checksum mismatch`,
      );
    }
  }
}

console.log("Neuform sync security tests passed.");

function assertAllowedRemoteRuntime(html, file) {
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    assert.doesNotMatch(match[1], /^https?:\/\//i, `${file}: remote runtime script remained`);
    assert.match(
      match[1],
      /^(?:\.\.\/){4}assets\/runtime\/runtime-[a-f0-9]{12}-[a-z0-9.-]+\.js$/,
      `${file}: unsafe runtime path`,
    );
  }
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
