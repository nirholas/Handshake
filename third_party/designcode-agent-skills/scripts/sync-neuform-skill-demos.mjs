#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const dryRun = process.argv.includes("--dry-run");
const hardenExisting = process.argv.includes("--harden-existing");
const maxAssetBytes = 5 * 1024 * 1024;
const maxHtmlBytes = 5 * 1024 * 1024;
const concurrency = 5;
const neuformRepo = process.env.NEUFORM_REPO || path.resolve(root, "..", "Landing Pages");
const sourceEnvFile = path.join(neuformRepo, ".env");
const sandboxMarker = '<meta name="neuform-sandboxed-demo" content="1">';
const defaultRemoteHosts = new Set(["images.unsplash.com"]);
const allowedRuntimeScriptHosts = new Set([
  "cdn.tailwindcss.com",
  "cdnjs.cloudflare.com",
  "code.iconify.design",
]);
const allowedRuntimeStyleHosts = new Set([
  "api.fontshare.com",
  "fonts.googleapis.com",
]);
const sandboxContentPolicy = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src data: https://fonts.gstatic.com",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src blob:",
  "media-src blob:",
  "navigate-to 'none'",
  "object-src 'none'",
  "script-src 'unsafe-inline' __NEUFORM_RUNTIME_SOURCES__",
  `style-src 'unsafe-inline' ${[...allowedRuntimeStyleHosts].map((host) => `https://${host}`).join(" ")}`,
  "worker-src 'none'",
].join("; ");
const runtimeDownloadCache = new Map();
const sandboxAssetReceiver = `<script data-neuform-asset-bootstrap>
(() => {
  let received = false;
  const objectUrls = [];
  const replaceAll = (value, replacements) => {
    let next = String(value || "");
    for (const [file, objectUrl] of replacements) next = next.split(file).join(objectUrl);
    return next;
  };
  window.addEventListener("message", (event) => {
    if (received || event.source !== parent || event.data?.type !== "neuform-assets-v1") return;
    received = true;
    const replacements = [];
    for (const asset of event.data.assets || []) {
      if (!asset || typeof asset.file !== "string" || typeof asset.base64 !== "string") continue;
      const binary = atob(asset.base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: asset.contentType || "application/octet-stream" }));
      objectUrls.push(objectUrl);
      replacements.push([asset.file, objectUrl]);
    }
    for (const element of document.querySelectorAll("*")) {
      for (const name of ["src", "poster", "srcset", "style"]) {
        const value = element.getAttribute(name);
        if (value) element.setAttribute(name, replaceAll(value, replacements));
      }
    }
    for (const style of document.querySelectorAll("style")) {
      style.textContent = replaceAll(style.textContent, replacements);
    }
  });
  window.addEventListener("pagehide", () => {
    for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
  }, { once: true });
})();
</script>`;

const targets = [
  ["media", "aura-asset-images"],
  ["web-design", "agency-grid-layout-minimal"],
  ["web-design", "atmosphere-background"],
  ["web-design", "background-grid-webgl"],
  ["web-design", "beautiful-shadows"],
  ["web-design", "blue-cloudy-clean-modern"],
  ["web-design", "blue-laser-clean-glass-layout"],
  ["web-design", "book-serif-index"],
  ["web-design", "bright-green-tech-system-webgl"],
  ["web-design", "clean-minimal-beige-light-mode"],
  ["web-design", "company-logos"],
  ["web-design", "container-lines"],
  ["web-design", "corner-diagonals"],
  ["web-design", "corner-lasers"],
  ["web-design", "css-border-gradient"],
  ["web-design", "dark-blue-contrasting-clean"],
  ["web-design", "dark-glass-clean-layout"],
  ["web-design", "dither-background"],
  ["web-design", "dither-laser-dark-mode"],
  ["web-design", "editorial-tech"],
  ["web-design", "framed-grid-layout"],
  ["web-design", "framed-tech-dark-border-gradient"],
  ["web-design", "funky-purple-container-tech"],
  ["web-design", "glass-dark-mode-clock"],
  ["web-design", "globe-particles"],
  ["web-design", "gooey-blob-system"],
  ["web-design", "gsap"],
  ["web-design", "gsap-scrolltrigger-storytelling"],
  ["web-design", "high-contrast-skeuomorphic-clean"],
  ["web-design", "image-first-grid-layout"],
  ["web-design", "light-mode-paper-technical"],
  ["web-design", "marquee-loop"],
  ["web-design", "masked-reveal"],
  ["web-design", "mesh-gradient-dark-blue-clean"],
  ["web-design", "nested-container-clean-agency"],
  ["web-design", "nested-container-frames"],
  ["web-design", "number-details"],
  ["web-design", "orange-clean-paper-saas"],
  ["web-design", "progressive-blur"],
  ["web-design", "skeuomorphic-ui"],
  ["web-design", "solar-duotone-bold"],
  ["web-design", "split-layout-technical"],
  ["web-design", "tech-green-dark-mode-modern"],
  ["web-design", "technical-wireframe-info-layout"],
  ["web-design", "webgl-3d-object"],
  ["web-design", "webgl-laser"],
].map(([category, slug]) => ({ category, slug }));

function parseEnv(source) {
  const values = {};
  for (const rawLine of String(source || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeLines(value) {
  if (Array.isArray(value)) return value.map(safeText).filter(Boolean);
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function canonicalPageUrl(page) {
  const pathname = String(page?.canonical_path || page?.community_path || "").trim();
  if (pathname) return new URL(pathname, "https://neuform.ai").href;
  return new URL(`/p/${encodeURIComponent(String(page?.slug || page?.id || "design"))}`, "https://neuform.ai").href;
}

function manifestUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function normalizeHostname(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

function isBlockedIp(address) {
  const normalized = String(address || "").trim().toLowerCase();
  const family = isIP(normalized);
  if (family === 4) {
    const parts = normalized.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224
    );
  }
  if (family === 6) {
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("::ffff:")) return isBlockedIp(normalized.slice(7));
    return /^(?:fc|fd|fe[89ab]|ff)/.test(normalized) || normalized.startsWith("2001:db8:");
  }
  return true;
}

function hostAllowed(hostname, allowedHosts) {
  const host = normalizeHostname(hostname);
  return (
    allowedHosts.has(host)
    || host.endsWith(".supabase.co")
  );
}

async function assertSafeRemoteUrl(value, allowedHosts, { resolveDns = true } = {}) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("Remote URL is invalid.");
  }
  const hostname = normalizeHostname(url.hostname);
  if (url.protocol !== "https:") throw new Error(`Remote URL must use HTTPS: ${manifestUrl(url)}`);
  if (url.username || url.password) throw new Error(`Remote URL must not contain credentials: ${manifestUrl(url)}`);
  if (url.port && url.port !== "443") throw new Error(`Remote URL uses a nonstandard port: ${manifestUrl(url)}`);
  if (!hostAllowed(hostname, allowedHosts)) throw new Error(`Remote host is not allowlisted: ${hostname}`);
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname === "metadata.google.internal"
  ) {
    throw new Error(`Remote URL resolves to a blocked address: ${hostname}`);
  }
  if (isIP(hostname) && isBlockedIp(hostname)) throw new Error(`Remote URL resolves to a blocked address: ${hostname}`);

  if (resolveDns && !isIP(hostname)) {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
      throw new Error(`Remote host resolves to a private or reserved address: ${hostname}`);
    }
  }
  return url;
}

async function fetchRequired(url, options = {}, policy = {}) {
  const allowedHosts = policy.allowedHosts || defaultRemoteHosts;
  let current = await assertSafeRemoteUrl(url, allowedHosts, policy);
  const originalHost = normalizeHostname(current.hostname);
  const maxRedirects = Number.isInteger(policy.maxRedirects) ? policy.maxRedirects : 3;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetch(current, { ...options, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === maxRedirects) {
        throw new Error(`Unsafe or excessive redirect from ${manifestUrl(current)}`);
      }
      const next = await assertSafeRemoteUrl(new URL(location, current), allowedHosts, policy);
      if (options.headers && normalizeHostname(next.hostname) !== originalHost) {
        throw new Error(`Authenticated request redirected to another host: ${normalizeHostname(next.hostname)}`);
      }
      current = next;
      continue;
    }
    const allowedStatuses = Array.isArray(policy.allowStatuses) ? policy.allowStatuses : [];
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      throw new Error(`${response.status} ${response.statusText} for ${manifestUrl(current)}`);
    }
    return response;
  }
  throw new Error(`Could not fetch ${manifestUrl(current)}`);
}

async function readResponseBytes(response, maxBytes) {
  const announcedSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(announcedSize) && announcedSize > maxBytes) {
    throw new Error(`Response exceeds ${maxBytes} bytes.`);
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes.`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function hasExpectedMagic(bytes, extension) {
  if (extension === ".jpg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === ".png") return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (extension === ".gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  if (extension === ".webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (extension === ".avif") return bytes.subarray(4, 8).toString("ascii") === "ftyp" && /avi[fs]/.test(bytes.subarray(8, 16).toString("ascii"));
  if (extension === ".mp4") return bytes.subarray(4, 8).toString("ascii") === "ftyp";
  if (extension === ".webm") return bytes.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex"));
  if (extension === ".js") {
    const prefix = bytes.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
    return !bytes.includes(0) && !prefix.startsWith("<!doctype") && !prefix.startsWith("<html") && !prefix.startsWith("<svg");
  }
  return false;
}

function extensionFor(contentType, url) {
  const normalizedType = String(contentType || "").split(";")[0].trim().toLowerCase();
  const byType = {
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/javascript": ".js",
    "application/x-javascript": ".js",
    "text/javascript": ".js",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  if (byType[normalizedType]) return byType[normalizedType];
  const pathname = new URL(url).pathname;
  const extension = path.extname(pathname).toLowerCase();
  return /^\.(?:avif|gif|jpe?g|png|webp|mp4|webm)$/.test(extension) ? extension.replace(".jpeg", ".jpg") : "";
}

function collectPageAssetUrls(html) {
  const urls = new Set();
  const add = (value) => {
    const url = String(value || "").trim();
    if (/^https?:\/\//i.test(url)) urls.add(url);
  };

  for (const match of html.matchAll(/<(?:img|source|video)\b[^>]*>/gi)) {
    const tag = match[0];
    for (const attribute of tag.matchAll(/\b(?:src|poster)\s*=\s*["']([^"']+)["']/gi)) add(attribute[1]);
    for (const attribute of tag.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
      for (const candidate of attribute[1].split(",")) add(candidate.trim().split(/\s+/)[0]);
    }
  }
  for (const match of html.matchAll(/url\(\s*["']?(https?:\/\/[^)'"\s]+)["']?\s*\)/gi)) add(match[1]);
  return [...urls].filter((url) => {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname !== "fonts.googleapis.com" && hostname !== "api.fontshare.com";
  });
}

function runtimeDependencies(html) {
  const urls = new Set();
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["'][^>]*>/gi)) {
    urls.add(match[1]);
  }
  return [...urls].sort();
}

function runtimeScriptUrls(html) {
  const urls = new Set();
  for (const match of String(html || "").matchAll(/<script\b[^>]*\bsrc\s*=\s*["'](https:\/\/[^"']+)["'][^>]*>/gi)) {
    urls.add(match[1]);
  }
  return [...urls].sort();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function restoreBundledRuntime(html, entry) {
  if (!entry?.file || !entry?.original_url) return html;
  const pattern = new RegExp(
    `<script\\b[^>]*\\bdata-bundled-runtime\\s*=\\s*(["'])${escapeRegExp(entry.file)}\\1[^>]*>[\\s\\S]*?<\\/script\\s*>`,
    "gi",
  );
  const restored = String(html || "").replace(pattern, `<script src="${entry.original_url}"></script>`);
  return restored === html ? restored.split(entry.file).join(entry.original_url) : restored;
}

function assertAllowedRuntimeDependencies(html) {
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const value = match[1].trim();
    if (!/^https:\/\//i.test(value)) continue;
    const hostname = normalizeHostname(new URL(value).hostname);
    if (!allowedRuntimeScriptHosts.has(hostname)) {
      throw new Error(`Imported HTML uses a non-allowlisted script host: ${hostname}`);
    }
  }
  for (const match of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const value = match[1].trim();
    if (!/^https:\/\//i.test(value)) continue;
    const tag = match[0];
    if (!/\brel\s*=\s*["'][^"']*stylesheet/i.test(tag)) continue;
    const hostname = normalizeHostname(new URL(value).hostname);
    if (!allowedRuntimeStyleHosts.has(hostname)) {
      throw new Error(`Imported HTML uses a non-allowlisted stylesheet host: ${hostname}`);
    }
  }
}

async function downloadRuntimeScript(url) {
  if (!runtimeDownloadCache.has(url)) {
    runtimeDownloadCache.set(url, (async () => {
      const response = await fetchRequired(url, {}, { allowedHosts: allowedRuntimeScriptHosts });
      const bytes = await readResponseBytes(response, maxAssetBytes);
      if (!hasExpectedMagic(bytes, ".js")) {
        throw new Error(`Runtime dependency did not return JavaScript: ${manifestUrl(url)}`);
      }
      return bytes;
    })());
  }
  return runtimeDownloadCache.get(url);
}

async function bundleRuntimeScripts(html, demoDirectory) {
  assertAllowedRuntimeDependencies(html);
  const bundled = [];
  let rewrittenHtml = html;
  const urls = runtimeScriptUrls(html);

  for (const url of urls) {
    const bytes = await downloadRuntimeScript(url);
    const sourceName = path.basename(new URL(url).pathname, path.extname(new URL(url).pathname))
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 40) || "runtime";
    const fileName = `runtime-${sha256(url).slice(0, 12)}-${sourceName}.js`;
    const runtimeDirectory = path.join(root, "assets", "runtime");
    const runtimeFile = path.join(runtimeDirectory, fileName);
    const relativePath = path.relative(demoDirectory, runtimeFile).split(path.sep).join("/");
    if (!dryRun) {
      await mkdir(runtimeDirectory, { recursive: true });
      await writeFile(runtimeFile, bytes);
    }
    rewrittenHtml = rewrittenHtml.split(url).join(relativePath);
    bundled.push({
      bytes: bytes.byteLength,
      file: relativePath,
      original_url: manifestUrl(url),
      kind: "runtime-script",
      sha256: sha256(bytes),
    });
  }

  return { bundled, html: rewrittenHtml };
}

function hardenImportedHtml(value) {
  let html = String(value || "");
  if (Buffer.byteLength(html, "utf8") > maxHtmlBytes) throw new Error("Imported HTML exceeds the 5 MB safety limit.");
  if (html.includes("\0")) throw new Error("Imported HTML contains a null byte.");
  if (sandboxMarker && html.includes(sandboxMarker)) throw new Error("Imported HTML is already a sandbox wrapper.");

  const opening = html.match(/^\s*(?:<!doctype[^>]*>\s*)?<html\b[^>]*>\s*<head\b[^>]*>/i);
  if (!opening) throw new Error("Imported HTML must begin with a canonical html/head document structure.");

  assertAllowedRuntimeDependencies(html);
  html = html
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(?:refresh|set-cookie)["']?[^>]*>/gi, "")
    .replace(/<(?:iframe|object|embed|applet)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed|applet)\s*>/gi, "")
    .replace(/<(?:iframe|object|embed|applet)\b[^>]*\/?>/gi, "")
    .replace(/\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/\s+(?:href|src|action|formaction)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, "");

  const headEnd = opening[0].length;
  const policyMeta = `<meta http-equiv="Content-Security-Policy" content="${sandboxContentPolicy}">`;
  return `${html.slice(0, headEnd)}\n${policyMeta}\n${sandboxAssetReceiver}\n${html.slice(headEnd)}`;
}

function normalizeAssetFiles(values) {
  const files = [];
  for (const value of values || []) {
    const file = String(typeof value === "string" ? value : value?.file || "").replace(/\\/g, "/").trim();
    const localDemoAsset = /^assets\/[a-z0-9][a-z0-9._/-]*$/i.test(file) && !file.includes("..");
    const sharedRuntimeAsset = /^(?:\.\.\/){4}assets\/runtime\/runtime-[a-f0-9]{12}-[a-z0-9.-]+\.js$/i.test(file);
    if (!localDemoAsset && !sharedRuntimeAsset) {
      throw new Error(`Unsafe local asset path in source manifest: ${file || "(empty)"}`);
    }
    files.push(file);
  }
  return [...new Set(files)].sort();
}

function buildSandboxedDemo(hardenedHtml, assetFiles = []) {
  const payload = Buffer.from(String(hardenedHtml || ""), "utf8").toString("base64");
  const normalizedFiles = normalizeAssetFiles(assetFiles);
  const mediaFiles = JSON.stringify(normalizedFiles.filter((file) => !file.endsWith(".js"))).replace(/</g, "\\u003c");
  const runtimeFiles = JSON.stringify(normalizedFiles.filter((file) => file.endsWith(".js"))).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${sandboxMarker}
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'self'; frame-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'">
  <title>Sandboxed Neuform demo</title>
  <style>
    html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; }
    body { overflow: hidden; background: #0b0b0b; }
    iframe { display: block; background: white; }
    .error { box-sizing: border-box; min-height: 100%; padding: 32px; color: #fff; font: 16px/1.5 system-ui, sans-serif; }
  </style>
</head>
<body>
  <iframe id="neuform-demo" title="Sandboxed Neuform design demo" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
  <script>
    const encodedHtml = "${payload}";
    const assetFiles = ${mediaFiles};
    const runtimeFiles = ${runtimeFiles};
    const frame = document.getElementById("neuform-demo");
    const decodeBytes = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    const decode = (value) => new TextDecoder().decode(decodeBytes(value));
    const encodeBytes = (bytes) => {
      let binary = "";
      for (let index = 0; index < bytes.length; index += 32768) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
      }
      return btoa(binary);
    };
    const mediaTypes = {
      avif: "image/avif",
      gif: "image/gif",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      mp4: "video/mp4",
      png: "image/png",
      webm: "video/webm",
      webp: "image/webp"
    };
    const loadAsset = async (file) => {
      const response = await fetch(file, { cache: "no-store", credentials: "omit", redirect: "error" });
      if (!response.ok) throw new Error("Could not load local demo asset: " + file);
      const extension = file.split(".").pop().toLowerCase();
      const contentType = mediaTypes[extension] || "application/octet-stream";
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { base64: encodeBytes(bytes), contentType, file, kind: "asset" };
    };
    Promise.allSettled(assetFiles.map(loadAsset)).then((results) => {
      const runtimeSources = runtimeFiles.map((file) => new URL(file, location.href).href).join(" ");
      const source = decode(encodedHtml).replace("__NEUFORM_RUNTIME_SOURCES__", runtimeSources);
      const mediaAssets = [];
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        mediaAssets.push(result.value);
      }
      frame.addEventListener("load", () => {
        frame.contentWindow.postMessage({ type: "neuform-assets-v1", assets: mediaAssets }, "*");
      }, { once: true });
      frame.srcdoc = source;
    }).catch((error) => {
      document.body.innerHTML = '<div class="error">Unable to load this sandboxed demo.</div>';
      console.error(error);
    });
  </script>
</body>
</html>
`;
}

function decodeSandboxedDemo(value) {
  const match = String(value || "").match(/const encodedHtml = "([A-Za-z0-9+/=]+)";/);
  if (!match) throw new Error("Sandbox wrapper does not contain a valid encoded payload.");
  return Buffer.from(match[1], "base64").toString("utf8");
}

function removeInjectedContentPolicy(value) {
  return String(value || "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>\s*/i, "")
    .replace(/<script\b[^>]*data-neuform-asset-bootstrap[^>]*>[\s\S]*?<\/script\s*>\s*/gi, "")
    .replace(/<script>\s*window\.__neuformSecondScript\s*=\s*true;\s*<\/script>\s*/gi, "");
}

function sanitizeManifestAssets(assets) {
  const sanitizeEntry = (entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const sanitized = { ...entry };
    if ("url" in sanitized) sanitized.url = manifestUrl(sanitized.url);
    if ("original_url" in sanitized) sanitized.original_url = manifestUrl(sanitized.original_url);
    if ("reason" in sanitized) sanitized.reason = safeText(sanitized.reason).replace(/https?:\/\/\S+/gi, (url) => manifestUrl(url));
    return sanitized;
  };
  return {
    ...assets,
    bundled: Array.isArray(assets?.bundled) ? assets.bundled.map(sanitizeEntry) : [],
    skipped: Array.isArray(assets?.skipped) ? assets.skipped.map(sanitizeEntry) : [],
  };
}

async function bundlePageAssets(html, demoDirectory, allowedHosts) {
  const assetDirectory = path.join(demoDirectory, "assets");
  const sourceUrls = collectPageAssetUrls(html);
  const bundled = [];
  const skipped = [];
  let rewrittenHtml = html;

  if (!dryRun) await mkdir(assetDirectory, { recursive: true });

  for (let index = 0; index < sourceUrls.length; index += 1) {
    const url = sourceUrls[index];
    try {
      const requestUrl = new URL(url);
      if (requestUrl.hostname === "images.unsplash.com") {
        requestUrl.searchParams.set("w", "1600");
        requestUrl.searchParams.set("q", "82");
        requestUrl.searchParams.set("auto", "format");
        requestUrl.searchParams.set("fit", "crop");
      }
      const response = await fetchRequired(requestUrl.href, {}, { allowedHosts });
      const bytes = await readResponseBytes(response, maxAssetBytes);
      const extension = extensionFor(response.headers.get("content-type"), requestUrl.href);
      if (!extension) {
        skipped.push({ reason: "unsupported-content-type", url: manifestUrl(url) });
        continue;
      }
      if (!hasExpectedMagic(bytes, extension)) {
        skipped.push({ reason: "content-signature-mismatch", url: manifestUrl(url) });
        continue;
      }
      const sourceName = path.basename(new URL(url).pathname, path.extname(new URL(url).pathname))
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase()
        .slice(0, 48) || "asset";
      const fileName = `page-${String(index + 1).padStart(2, "0")}-${sourceName}${extension}`;
      const relativePath = `assets/${fileName}`;
      if (!dryRun) await writeFile(path.join(assetDirectory, fileName), bytes);
      rewrittenHtml = rewrittenHtml.split(url).join(relativePath);
      bundled.push({ bytes: bytes.byteLength, file: relativePath, original_url: manifestUrl(url) });
    } catch (error) {
      skipped.push({ reason: safeText(error?.message || error), url: manifestUrl(url) });
    }
  }

  return { bundled, html: rewrittenHtml, skipped };
}

function buildPrompt(skill, page, metrics, sourceUrl) {
  const headings = (Array.isArray(page?.metadata?.headings) ? page.metadata.headings : [])
    .map(safeText)
    .filter(Boolean)
    .slice(0, 5);
  const tags = (Array.isArray(page?.metadata?.tags) ? page.metadata.tags : [])
    .map(safeText)
    .filter(Boolean)
    .slice(0, 8);
  const promptLines = normalizeLines(skill?.prompt_lines).slice(0, 8);
  const title = safeText(page?.title) || safeText(skill?.label) || skill.id;
  const description = safeText(page?.description || page?.metadata?.description);

  return [
    `# ${safeText(skill?.label) || skill.id} Demo Prompts`,
    "",
    "## Minimal prompt",
    "",
    `Use $${skill.id} to create a responsive standalone HTML design with the same visual confidence, hierarchy, and interaction finish as the included Neuform reference.`,
    "",
    "## Recreate the demo",
    "",
    `Use $${skill.id} to recreate the design quality and behavior of **${title}** as a complete responsive HTML document. Treat the included demo/index.html as the visual and interaction reference, not as a loose mood board.`,
    "",
    "### Product brief",
    "",
    `- Page concept: ${title}.`,
    ...(description ? [`- Purpose: ${description}`] : []),
    ...(headings.length ? [`- Content anchors: ${headings.join(" · ")}.`] : []),
    ...(tags.length ? [`- Useful subject tags: ${tags.join(", ")}.`] : []),
    "",
    "### Skill direction",
    "",
    `- ${safeText(skill?.description)}`,
    ...promptLines.map((line) => `- ${line}`),
    "",
    "### Fidelity target",
    "",
    "- Match the reference's composition, information density, type scale, spacing rhythm, surface treatment, color relationships, and motion restraint.",
    "- Preserve the strongest interaction and animated background behavior instead of replacing it with generic fades or decorative movement.",
    "- Keep the first screen art-directed, then carry the same design logic through every supporting section.",
    "- Make the result responsive from mobile to desktop, keyboard accessible, and stable when reduced motion is enabled.",
    "- Deliver a full index.html. Put page-owned images, video, models, and textures in demo/assets/. External runtime libraries may stay as pinned CDN dependencies when the source relies on them.",
    "",
    "### Reference snapshot",
    "",
    `- Source: ${sourceUrl}`,
    `- Neuform rank: #1 for ${skill.id} when synced.`,
    `- Popularity: ${metrics.views.toLocaleString("en-US")} views · ${metrics.favorites.toLocaleString("en-US")} favorites · ${metrics.remixes.toLocaleString("en-US")} remixes.`,
    "- Ranking rule: views descending, then favorites descending.",
    "",
    "## Remix prompt",
    "",
    `Use $${skill.id} and the included Neuform demo as the quality bar, but replace the brand, subject, copy, palette, and content. Preserve the underlying layout logic, signature visual treatment, interaction choreography, responsive behavior, and performance constraints so the remix still clearly demonstrates the skill.`,
    "",
  ].join("\n");
}

async function syncTarget(target, env) {
  const skillDirectory = path.join(root, "agent-skills", target.category, target.slug);
  const demoDirectory = path.join(skillDirectory, "demo");
  if (!existsSync(path.join(skillDirectory, "SKILL.md"))) throw new Error(`Missing local skill ${target.category}/${target.slug}`);

  const params = new URLSearchParams({
    action: "public-skill",
    skillSlug: target.slug,
    page: "1",
    pageSize: "1",
    preview: "1",
    htmlPreviewLimit: "1",
    promptSkillsLimit: "1",
  });
  const endpoint = `${env.apiUrl}/functions/v1/pages?${params}`;
  const payloadResponse = await fetchRequired(
    endpoint,
    { headers: env.headers },
    { allowedHosts: env.apiHosts, maxRedirects: 0, allowStatuses: [404] },
  );
  if (payloadResponse.status === 404) {
    return { ...target, skipped: true };
  }
  const payloadBytes = await readResponseBytes(payloadResponse, maxHtmlBytes);
  const payload = JSON.parse(payloadBytes.toString("utf8"));
  const skill = payload?.skill;
  const page = Array.isArray(payload?.pages) ? payload.pages[0] : null;
  if (!skill || !page?.html_signed_url) throw new Error(`No public ranked design for ${target.slug}`);

  const htmlResponse = await fetchRequired(page.html_signed_url, {}, { allowedHosts: env.assetHosts });
  const originalHtml = (await readResponseBytes(htmlResponse, maxHtmlBytes)).toString("utf8");
  const assetResult = await bundlePageAssets(originalHtml, demoDirectory, env.assetHosts);
  const runtimeResult = await bundleRuntimeScripts(assetResult.html, demoDirectory);
  const bundledAssets = [...assetResult.bundled, ...runtimeResult.bundled];
  const hardenedHtml = hardenImportedHtml(runtimeResult.html);
  const sandboxedHtml = buildSandboxedDemo(hardenedHtml, bundledAssets);
  const sourceUrl = canonicalPageUrl(page);
  const metrics = {
    favorites: Math.max(0, Number(page.community_favorite_count) || 0),
    remixes: Math.max(0, Number(page.remix_count) || 0),
    views: Math.max(0, Number(page.view_count) || 0),
  };

  let previewAsset = "";
  if (page.screenshot_signed_url) {
    const screenshotResponse = await fetchRequired(page.screenshot_signed_url, {}, { allowedHosts: env.assetHosts });
    const screenshotBytes = await readResponseBytes(screenshotResponse, maxAssetBytes);
    const screenshotExtension = extensionFor(screenshotResponse.headers.get("content-type"), page.screenshot_signed_url) || ".jpg";
    if (!hasExpectedMagic(screenshotBytes, screenshotExtension)) {
      throw new Error("Source preview content does not match its announced image type.");
    }
    previewAsset = `assets/source-preview${screenshotExtension}`;
    if (!dryRun) {
      await mkdir(path.join(demoDirectory, "assets"), { recursive: true });
      await writeFile(path.join(demoDirectory, previewAsset), screenshotBytes);
    }
  }

  const manifest = {
    version: 1,
    provider: "Neuform",
    synced_at: new Date().toISOString(),
    skill: {
      id: skill.id,
      label: skill.label,
      usage_count: Math.max(0, Number(skill.usage_count) || 0),
      url: `https://neuform.ai/skill/${encodeURIComponent(skill.id)}`,
    },
    ranking: {
      position: 1,
      order: ["view_count desc", "community_favorite_count desc", "relation_created_at desc"],
      visible_design_count: Math.max(0, Number(payload.visible_page_count) || 0),
    },
    design: {
      id: page.id,
      slug: page.slug,
      title: page.title,
      url: sourceUrl,
      view_count: metrics.views,
      favorite_count: metrics.favorites,
      remix_count: metrics.remixes,
    },
    html: {
      original_sha256: sha256(originalHtml),
      bundled_sha256: sha256(runtimeResult.html),
      hardened_sha256: sha256(hardenedHtml),
      sandboxed_sha256: sha256(sandboxedHtml),
      runtime_dependencies: runtimeDependencies(hardenedHtml),
      security_profile: "sandboxed-srcdoc-v1",
    },
    assets: sanitizeManifestAssets({
      preview: previewAsset,
      bundled: bundledAssets,
      skipped: assetResult.skipped,
    }),
  };

  if (!dryRun) {
    await mkdir(demoDirectory, { recursive: true });
    await writeFile(path.join(demoDirectory, "index.html"), sandboxedHtml);
    await writeFile(path.join(demoDirectory, "PROMPT.md"), buildPrompt(skill, page, metrics, sourceUrl));
    await writeFile(path.join(demoDirectory, "source.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return {
    ...target,
    assets: bundledAssets.length + (previewAsset ? 1 : 0),
    title: safeText(page.title),
    ...metrics,
  };
}

async function hardenExistingDemos() {
  let migrated = 0;
  let sanitizedManifests = 0;
  let repacked = 0;

  for (const target of targets) {
    const demoDirectory = path.join(root, "agent-skills", target.category, target.slug, "demo");
    const htmlFile = path.join(demoDirectory, "index.html");
    const sourceFile = path.join(demoDirectory, "source.json");
    if (!existsSync(htmlFile) || !existsSync(sourceFile)) continue;

    const originalSource = await readFile(sourceFile, "utf8");
    const manifest = JSON.parse(originalSource);
    const originalIndex = await readFile(htmlFile, "utf8");
    const wasSandboxed = originalIndex.includes(sandboxMarker);
    const importedHtml = removeInjectedContentPolicy(wasSandboxed ? decodeSandboxedDemo(originalIndex) : originalIndex);
    const previousBundled = Array.isArray(manifest?.assets?.bundled) ? manifest.assets.bundled : [];
    const previousRuntime = previousBundled.filter((entry) => entry?.kind === "runtime-script");
    const pageAssets = previousBundled.filter((entry) => entry?.kind !== "runtime-script");
    let runtimeSourceHtml = importedHtml;
    for (const entry of previousRuntime) {
      runtimeSourceHtml = restoreBundledRuntime(runtimeSourceHtml, entry);
    }
    const runtimeResult = runtimeScriptUrls(runtimeSourceHtml).length
      ? await bundleRuntimeScripts(runtimeSourceHtml, demoDirectory)
      : { bundled: [], html: runtimeSourceHtml };
    const bundledAssets = [...pageAssets, ...runtimeResult.bundled];
    const hardenedHtml = hardenImportedHtml(runtimeResult.html);
    const sandboxedHtml = buildSandboxedDemo(hardenedHtml, bundledAssets);
    manifest.html = {
      ...manifest.html,
      bundled_sha256: sha256(runtimeResult.html),
      hardened_sha256: sha256(hardenedHtml),
      sandboxed_sha256: sha256(sandboxedHtml),
      runtime_dependencies: runtimeDependencies(hardenedHtml),
      security_profile: "sandboxed-srcdoc-v1",
    };
    manifest.assets = {
      ...(manifest.assets || {}),
      bundled: bundledAssets,
    };
    if (wasSandboxed) repacked += 1;
    else migrated += 1;

    manifest.assets = sanitizeManifestAssets(manifest.assets || {});
    const nextSource = `${JSON.stringify(manifest, null, 2)}\n`;
    if (nextSource !== originalSource) sanitizedManifests += 1;

    if (!dryRun) {
      if (sandboxedHtml !== originalIndex) await writeFile(htmlFile, sandboxedHtml);
      if (nextSource !== originalSource) await writeFile(sourceFile, nextSource);
    }
  }

  console.log(
    `${dryRun ? "Would harden" : "Hardened"} ${migrated} existing Neuform demos; `
    + `${repacked} existing wrappers were safely repacked; ${sanitizedManifests} manifests removed query strings or gained security metadata.`,
  );
}

async function main() {
  if (hardenExisting) {
    await hardenExistingDemos();
    return;
  }

  const fileEnv = existsSync(sourceEnvFile) ? parseEnv(await readFile(sourceEnvFile, "utf8")) : {};
  const apiUrl = String(process.env.NEUFORM_API_URL || fileEnv.VITE_SUPABASE_URL || "").replace(/\/$/, "");
  const anonKey = String(process.env.NEUFORM_ANON_KEY || fileEnv.VITE_SUPABASE_ANON_KEY || "").trim();
  if (!apiUrl || !anonKey) throw new Error("Set NEUFORM_API_URL and NEUFORM_ANON_KEY, or provide the Neuform .env file.");
  const apiHostname = normalizeHostname(new URL(apiUrl).hostname);
  const configuredHosts = String(process.env.NEUFORM_ALLOWED_ASSET_HOSTS || "")
    .split(",")
    .map(normalizeHostname)
    .filter(Boolean);
  const apiHosts = new Set([apiHostname]);
  const assetHosts = new Set([...defaultRemoteHosts, apiHostname, ...configuredHosts]);
  const env = {
    apiUrl,
    apiHosts,
    assetHosts,
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  };

  const queue = [...targets];
  const results = [];
  const skipped = [];
  const failures = [];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const target = queue.shift();
      try {
        const result = await syncTarget(target, env);
        if (result.skipped) {
          skipped.push(result);
          console.log(`skipped ${result.slug}: no ranked public design`);
        } else {
          results.push(result);
          console.log(`synced ${result.slug}: ${result.title} (${result.views} views)`);
        }
      } catch (error) {
        failures.push({ ...target, message: safeText(error?.message || error) });
        console.error(`failed ${target.slug}: ${safeText(error?.message || error)}`);
      }
    }
  });
  await Promise.all(workers);

  console.log(`${dryRun ? "Checked" : "Synced"} ${results.length}/${targets.length} Neuform demos; ${skipped.length} had no ranked public design.`);
  if (failures.length) {
    for (const failure of failures) console.error(`- ${failure.category}/${failure.slug}: ${failure.message}`);
    process.exitCode = 1;
  }
}

export {
  assertAllowedRuntimeDependencies,
  assertSafeRemoteUrl,
  buildSandboxedDemo,
  hardenImportedHtml,
  hasExpectedMagic,
  isBlockedIp,
  manifestUrl,
  normalizeAssetFiles,
  sanitizeManifestAssets,
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
