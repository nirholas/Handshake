#!/usr/bin/env node
// three.ws — Open Badges 2.0 issuing / baking / verification CLI.
//
// Implements the parts of the spec that produce a portable credential:
//   - Assertion creation with hashed recipient identity (sha256 + salt)
//   - PNG "baking": embeds the Assertion JSON in an iTXt chunk keyed `openbadges`
//     (per https://www.imsglobal.org/sites/default/files/Badges/OBv2p0/baking/index.html)
//   - Extraction + structural verification of a baked badge
//
// Usage:
//   node scripts/openbadge/cli.mjs issue  --badge <badgeclass-url> --recipient <email> \
//        --id <assertion-url> [--salt <salt>] [--out <assertion.json>]
//   node scripts/openbadge/cli.mjs bake    --image <in.png> --assertion <assertion.json> --out <baked.png>
//   node scripts/openbadge/cli.mjs verify  --image <baked.png>
//   node scripts/openbadge/cli.mjs extract --image <baked.png>
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import zlib from 'node:zlib';

// ---------- arg parsing ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

// ISO-8601 without sub-second noise.
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------- Assertion ----------
// Hash a recipient identity per the spec: sha256$<hex(sha256(identity + salt))>.
function hashIdentity(identity, salt) {
  const digest = createHash('sha256').update(identity + salt).digest('hex');
  return `sha256$${digest}`;
}

function buildAssertion({ badge, recipient, id, salt, identityType = 'email' }) {
  return {
    '@context': 'https://w3id.org/openbadges/v2',
    type: 'Assertion',
    id,
    recipient: {
      type: identityType,
      hashed: true,
      salt,
      identity: hashIdentity(recipient, salt),
    },
    badge,
    issuedOn: nowIso(),
    verification: { type: 'HostedBadge' },
  };
}

// ---------- PNG chunk plumbing ----------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC-32 (PNG polynomial), table built once.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function* readChunks(png) {
  if (!png.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG file');
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    yield { type, data, start: off, end: off + 12 + len };
    off += 12 + len;
  }
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// Build an iTXt chunk. Open Badges uses keyword "openbadges", uncompressed.
function makeITXtOpenBadges(text) {
  const keyword = Buffer.from('openbadges', 'latin1');
  const data = Buffer.concat([
    keyword,
    Buffer.from([0x00]), // null separator
    Buffer.from([0x00]), // compression flag: 0 = uncompressed
    Buffer.from([0x00]), // compression method
    Buffer.from([0x00]), // language tag (empty) + null
    Buffer.from([0x00]), // translated keyword (empty) + null
    Buffer.from(text, 'utf8'),
  ]);
  return makeChunk('iTXt', data);
}

// Bake: strip any existing openbadges iTXt, insert ours right after IHDR.
function bake(pngPath, assertionPath, outPath) {
  const png = readFileSync(pngPath);
  const assertion = readFileSync(assertionPath, 'utf8').trim();
  JSON.parse(assertion); // validate it is JSON before embedding

  const head = [PNG_SIG];
  let inserted = false;
  for (const ch of readChunks(png)) {
    if (ch.type === 'iTXt' && ch.data.toString('latin1').startsWith('openbadges\x00')) continue; // drop stale bake
    head.push(png.subarray(ch.start, ch.end));
    if (ch.type === 'IHDR' && !inserted) {
      head.push(makeITXtOpenBadges(assertion));
      inserted = true;
    }
  }
  if (!inserted) throw new Error('no IHDR chunk found; not a valid PNG');
  writeFileSync(outPath, Buffer.concat(head));
  return outPath;
}

// Extract the baked Open Badges payload (JSON or URL).
function extract(pngPath) {
  const png = readFileSync(pngPath);
  for (const ch of readChunks(png)) {
    if (ch.type !== 'iTXt') continue;
    const d = ch.data;
    if (!d.toString('latin1').startsWith('openbadges\x00')) continue;
    // layout: keyword \0 compFlag compMethod langTag \0 transKeyword \0 text
    let p = d.indexOf(0x00); // after keyword
    const compFlag = d[p + 1];
    p += 3; // skip compFlag + compMethod
    p = d.indexOf(0x00, p) + 1; // end of language tag
    p = d.indexOf(0x00, p) + 1; // end of translated keyword
    let text = d.subarray(p);
    if (compFlag === 1) text = zlib.inflateSync(text);
    return text.toString('utf8');
  }
  return null;
}

// Structural verification of a baked badge.
function verify(pngPath) {
  const payload = extract(pngPath);
  const problems = [];
  if (!payload) return { ok: false, problems: ['no `openbadges` iTXt chunk found in PNG'] };

  let assertion;
  if (/^https?:\/\//.test(payload.trim())) {
    return {
      ok: true,
      mode: 'url',
      payload: payload.trim(),
      problems: [],
      note: 'Badge is baked with a hosted Assertion URL. Fetch it to complete verification.',
    };
  }
  try { assertion = JSON.parse(payload); } catch { return { ok: false, problems: ['baked payload is neither a URL nor valid JSON'] }; }

  const ctx = assertion['@context'];
  if (ctx !== 'https://w3id.org/openbadges/v2') problems.push(`@context is not Open Badges 2.0 (got ${JSON.stringify(ctx)})`);
  if (assertion.type !== 'Assertion') problems.push(`type is not "Assertion" (got ${JSON.stringify(assertion.type)})`);
  if (!assertion.id) problems.push('missing Assertion id');
  if (!assertion.badge) problems.push('missing badge reference');
  if (!assertion.issuedOn) problems.push('missing issuedOn');
  const r = assertion.recipient;
  if (!r || !r.identity) problems.push('missing recipient identity');
  else if (r.hashed && !/^sha256\$[0-9a-f]{64}$/.test(r.identity)) problems.push('hashed recipient identity is malformed');
  if (!assertion.verification?.type) problems.push('missing verification type');

  return { ok: problems.length === 0, mode: 'embedded', assertion, problems };
}

// ---------- main ----------
const [cmd, ...rest] = process.argv.slice(2);
const a = parseArgs(rest);

try {
  if (cmd === 'issue') {
    if (!a.badge || !a.recipient || !a.id) throw new Error('issue requires --badge --recipient --id');
    const salt = a.salt || randomBytes(8).toString('hex');
    const assertion = buildAssertion({ badge: a.badge, recipient: a.recipient, id: a.id, salt, identityType: a.type || 'email' });
    const json = JSON.stringify(assertion, null, 2);
    if (a.out) { writeFileSync(a.out, json + '\n'); console.error('wrote', a.out, '(salt:', salt + ')'); }
    else console.log(json);
  } else if (cmd === 'bake') {
    if (!a.image || !a.assertion || !a.out) throw new Error('bake requires --image --assertion --out');
    bake(a.image, a.assertion, a.out);
    console.error('baked', a.out);
  } else if (cmd === 'extract') {
    if (!a.image) throw new Error('extract requires --image');
    const p = extract(a.image);
    if (p == null) { console.error('no openbadges payload found'); process.exit(1); }
    console.log(p);
  } else if (cmd === 'verify') {
    if (!a.image) throw new Error('verify requires --image');
    const res = verify(a.image);
    console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  } else {
    console.error('commands: issue | bake | extract | verify');
    process.exit(2);
  }
} catch (err) {
  console.error('error:', err.message);
  process.exit(1);
}
