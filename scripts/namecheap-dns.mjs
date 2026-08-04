#!/usr/bin/env node
// Namecheap DNS management with merge-then-set semantics.
//
// The Namecheap API's setHosts call REPLACES every host record on a domain,
// so a naive update wipes MX/DKIM/verification records. This tool always
// fetches current records, applies a delta, backs up the previous state,
// and only then writes.
//
// Credentials: NAMECHEAP_API_USER + NAMECHEAP_API_KEY in .env (repo root).
// The API is IP-whitelisted (Namecheap dashboard, Tools, API Access); calls
// from a non-whitelisted egress IP fail with an auth error.
//
// Usage:
//   node scripts/namecheap-dns.mjs list
//   node scripts/namecheap-dns.mjs get <domain>
//   node scripts/namecheap-dns.mjs apply <plan.json> [--dry-run]
//
// plan.json is an array of per-domain deltas:
//   [{ "domain": "example.com",
//      "remove": [{ "name": "@", "type": "A" }],
//      "add":    [{ "name": "@", "type": "A", "address": "1.2.3.4", "ttl": "1800" }] }]
// "remove" drops every current record matching name+type (address optional to
// narrow). Records with the same name+type as an "add" entry are replaced.
// Everything else on the domain is preserved verbatim.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = readFileSync(join(root, '.env'), 'utf8');
const envVar = (k) => (env.match(new RegExp(`^${k}=(.+)$`, 'm')) || [])[1]?.trim();
const API_USER = process.env.NAMECHEAP_API_USER || envVar('NAMECHEAP_API_USER');
const API_KEY = process.env.NAMECHEAP_API_KEY || envVar('NAMECHEAP_API_KEY');
if (!API_USER || !API_KEY) {
  console.error('NAMECHEAP_API_USER / NAMECHEAP_API_KEY missing from .env');
  process.exit(2);
}

const PACE_MS = 3300; // stay under the ~20 requests/minute API limit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clientIp() {
  const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(10000) });
  return (await res.text()).trim();
}

async function api(command, params = {}) {
  const qs = new URLSearchParams({
    ApiUser: API_USER,
    ApiKey: API_KEY,
    UserName: API_USER,
    Command: command,
    ClientIp: await clientIp(),
    ...params,
  });
  const res = await fetch(`https://api.namecheap.com/xml.response?${qs}`, {
    method: command.endsWith('.setHosts') ? 'POST' : 'GET',
    signal: AbortSignal.timeout(30000),
  });
  const xml = await res.text();
  if (!xml.includes('Status="OK"')) {
    const err = (xml.match(/<Error [^>]*>([^<]+)</) || [])[1] || xml.slice(0, 300);
    throw new Error(`${command} failed: ${err}`);
  }
  return xml;
}

const splitDomain = (domain) => {
  const [sld, ...rest] = domain.split('.');
  return { SLD: sld, TLD: rest.join('.') };
};

function parseHosts(xml) {
  return [...xml.matchAll(/<host [^>]*\/>/gi)].map((m) => {
    const attr = (n) => (m[0].match(new RegExp(`${n}="([^"]*)"`, 'i')) || [])[1] ?? '';
    return {
      name: attr('Name'),
      type: attr('Type'),
      address: attr('Address'),
      mxPref: attr('MXPref') || '10',
      ttl: attr('TTL') || '1800',
    };
  });
}

async function getHosts(domain) {
  const xml = await api('namecheap.domains.dns.getHosts', splitDomain(domain));
  return parseHosts(xml);
}

async function setHosts(domain, hosts) {
  const params = splitDomain(domain);
  hosts.forEach((h, i) => {
    const n = i + 1;
    params[`HostName${n}`] = h.name;
    params[`RecordType${n}`] = h.type;
    params[`Address${n}`] = h.address;
    params[`TTL${n}`] = h.ttl;
    if (h.type === 'MX') params[`MXPref${n}`] = h.mxPref;
    if (hosts.some((x) => x.type === 'MX')) params.EmailType = 'MX';
  });
  await api('namecheap.domains.dns.setHosts', params);
}

const fmt = (h) => `${h.name.padEnd(24)} ${h.type.padEnd(8)} ${h.address}${h.type === 'MX' ? ` (mx ${h.mxPref})` : ''}`;

const [cmd, arg, flag] = process.argv.slice(2);

if (cmd === 'list') {
  const xml = await api('namecheap.domains.getList', { PageSize: '100' });
  for (const m of xml.matchAll(/<Domain [^>]*Name="([^"]+)"[^>]*IsOurDNS="([^"]+)"/g)) {
    console.log(`${m[1].padEnd(30)} ${m[2] === 'true' ? 'namecheap-dns' : 'external-dns'}`);
  }
} else if (cmd === 'get' && arg) {
  (await getHosts(arg)).forEach((h) => console.log(fmt(h)));
} else if (cmd === 'apply' && arg) {
  const dryRun = flag === '--dry-run';
  const plan = JSON.parse(readFileSync(arg, 'utf8'));
  const backupDir = join(root, '.namecheap-backups');
  mkdirSync(backupDir, { recursive: true });
  for (const entry of plan) {
    const current = await getHosts(entry.domain);
    const matches = (h, sel) =>
      h.name === sel.name && h.type === sel.type && (!sel.address || h.address === sel.address);
    const kept = current.filter(
      (h) =>
        !(entry.remove || []).some((sel) => matches(h, sel)) &&
        !(entry.add || []).some((a) => h.name === a.name && h.type === a.type)
    );
    const adds = (entry.add || []).map((a) => ({ mxPref: '10', ttl: '1800', ...a }));
    const next = [...kept, ...adds];
    const dropped = current.filter((h) => !kept.includes(h));
    console.log(`\n${entry.domain} (${current.length} -> ${next.length} records)`);
    dropped.forEach((h) => console.log(`  - ${fmt(h)}`));
    adds.forEach((h) => console.log(`  + ${fmt(h)}`));
    if (dryRun) continue;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(backupDir, `${entry.domain}.${stamp}.json`), JSON.stringify(current, null, 2));
    await setHosts(entry.domain, next);
    console.log(`  applied (backup in .namecheap-backups/)`);
    await sleep(PACE_MS);
  }
} else {
  console.error('usage: namecheap-dns.mjs list | get <domain> | apply <plan.json> [--dry-run]');
  process.exit(2);
}
