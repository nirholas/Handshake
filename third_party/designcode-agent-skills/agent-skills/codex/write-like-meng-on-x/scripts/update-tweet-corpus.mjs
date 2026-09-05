#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultLedger = resolve(scriptDir, "../references/tweet-corpus.jsonl");

function parseArgs(argv) {
  const args = { check: false, dryRun: false, input: null, ledger: defaultLedger };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") args.check = true;
    else if (value === "--dry-run") args.dryRun = true;
    else if (value === "--input") args.input = resolve(argv[++index]);
    else if (value === "--ledger") args.ledger = resolve(argv[++index]);
    else if (value === "--help") {
      console.log("Usage: update-tweet-corpus.mjs [--input batch.json|jsonl] [--ledger path] [--dry-run] [--check]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!args.check && !args.input) {
    throw new Error("Pass --input <batch.json|jsonl> to ingest posts, or --check to validate the ledger.");
  }

  return args;
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

function hashText(text) {
  const comparable = normalizeText(text).replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(comparable).digest("hex");
}

function statusIdFromUrl(url) {
  const match = String(url ?? "").match(/\/status\/(\d+)/);
  return match?.[1] ?? "";
}

function normalizeFormat(post) {
  if (post.format) return String(post.format).toLowerCase();
  if (post.isQuote) return "quote";
  if (post.isReply) return "reply";
  return "original";
}

function normalizePost(post) {
  const text = normalizeText(post.text ?? post.authoredText);
  const url = String(post.url ?? post.statusUrl ?? "").trim();
  const id = String(post.id ?? post.postId ?? statusIdFromUrl(url)).trim();
  const createdAt = String(post.createdAt ?? post.created_at ?? post.timestamp ?? "").trim();

  if (!id) throw new Error(`Post is missing an ID: ${JSON.stringify(post)}`);
  if (!url) throw new Error(`Post ${id} is missing a canonical URL.`);
  if (!text) throw new Error(`Post ${id} has empty authored text.`);
  if (!/^https:\/\/x\.com\/MengTo\/status\/\d+$/.test(url)) {
    throw new Error(`Post ${id} has a non-canonical Meng status URL: ${url}`);
  }
  if (statusIdFromUrl(url) !== id) {
    throw new Error(`Post ${id} does not match its status URL: ${url}`);
  }
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
    throw new Error(`Post ${id} has an invalid timestamp: ${createdAt}`);
  }

  const format = normalizeFormat(post);
  if (!new Set(["original", "reply", "quote"]).has(format)) {
    throw new Error(`Post ${id} has an invalid format: ${format}`);
  }

  return {
    id,
    url,
    createdAt: new Date(createdAt).toISOString(),
    format,
    text,
    textHash: hashText(text),
  };
}

function parseRecords(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];

  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${path} must contain a JSON array or JSONL records.`);
    return parsed;
  }

  return raw.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${path}:${index + 1} is not valid JSON: ${error.message}`);
    }
  });
}

function findDuplicates(posts) {
  const seenIds = new Set();
  const seenUrls = new Set();
  const seenHashes = new Set();
  const duplicateIds = [];
  const duplicateUrls = [];
  const duplicateHashes = [];

  for (const post of posts) {
    if (seenIds.has(post.id)) duplicateIds.push(post.id);
    if (seenUrls.has(post.url)) duplicateUrls.push(post.url);
    if (seenHashes.has(post.textHash)) duplicateHashes.push(post.id);
    seenIds.add(post.id);
    seenUrls.add(post.url);
    seenHashes.add(post.textHash);
  }

  return { duplicateIds, duplicateUrls, duplicateHashes };
}

function sortPosts(posts) {
  return posts.sort((left, right) => {
    const dateOrder = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return dateOrder || right.id.localeCompare(left.id);
  });
}

function formatCounts(posts) {
  return posts.reduce(
    (counts, post) => ({ ...counts, [post.format]: counts[post.format] + 1 }),
    { original: 0, reply: 0, quote: 0 },
  );
}

const args = parseArgs(process.argv.slice(2));
const existing = parseRecords(args.ledger).map(normalizePost);

if (args.check) {
  const duplicates = findDuplicates(existing);
  const invalidCount = Object.values(duplicates).reduce((total, values) => total + values.length, 0);
  const receipt = {
    ok: invalidCount === 0,
    ledger: args.ledger,
    total: existing.length,
    formats: formatCounts(existing),
    newest: sortPosts([...existing])[0]?.createdAt ?? null,
    oldest: sortPosts([...existing]).at(-1)?.createdAt ?? null,
    duplicates,
  };
  console.log(JSON.stringify(receipt, null, 2));
  if (!receipt.ok) process.exit(1);
  process.exit(0);
}

const incoming = parseRecords(args.input).map(normalizePost);
const byId = new Map(existing.map((post) => [post.id, post]));
const idByHash = new Map(existing.map((post) => [post.textHash, post.id]));
let added = 0;
let replaced = 0;
let skipped = 0;

for (const post of incoming) {
  const current = byId.get(post.id);
  const matchingTextId = idByHash.get(post.textHash);

  if (matchingTextId && matchingTextId !== post.id) {
    skipped += 1;
    continue;
  }

  if (!current) {
    byId.set(post.id, post);
    idByHash.set(post.textHash, post.id);
    added += 1;
    continue;
  }

  if (current.textHash === post.textHash) {
    skipped += 1;
    continue;
  }

  if (post.text.length > current.text.length) {
    idByHash.delete(current.textHash);
    byId.set(post.id, post);
    idByHash.set(post.textHash, post.id);
    replaced += 1;
  } else {
    skipped += 1;
  }
}

const merged = sortPosts([...byId.values()]);
const duplicates = findDuplicates(merged);
const invalidCount = Object.values(duplicates).reduce((total, values) => total + values.length, 0);
if (invalidCount > 0) {
  throw new Error(`Final corpus contains duplicates: ${JSON.stringify(duplicates)}`);
}

if (!args.dryRun) {
  writeFileSync(args.ledger, `${merged.map((post) => JSON.stringify(post)).join("\n")}\n`);
}

console.log(JSON.stringify({
  ok: true,
  dryRun: args.dryRun,
  ledger: args.ledger,
  input: args.input,
  received: incoming.length,
  added,
  replaced,
  skipped,
  total: merged.length,
  formats: formatCounts(merged),
  newest: merged[0]?.createdAt ?? null,
  oldest: merged.at(-1)?.createdAt ?? null,
  duplicates,
}, null, 2));
