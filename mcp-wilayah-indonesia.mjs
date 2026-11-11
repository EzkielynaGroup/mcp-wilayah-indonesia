#!/usr/bin/env node
// mcp-wilayah-indonesia: look up Indonesian administrative regions (provinsi, kabupaten/kota, kecamatan,
// desa/kelurahan) and their Kemendagri codes from Claude Desktop, Claude Code, Cursor, OpenCode or any MCP client.
// One file, no dependencies, Node >= 18. MCP over stdio (newline-delimited JSON-RPC). Works offline:
// the code list ships next to this file as data/wilayah.json.gz (MIT data, see README "Data source").
// Logs go to stderr only; stdout carries protocol messages.
//
// Env:
//   WILAYAH_DATA_FILE   optional path to another data file (.json or .json.gz, same shape as data/wilayah.json.gz)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_PROTOCOL = '2025-06-18';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.resolve(expandHome((process.env.WILAYAH_DATA_FILE || '').trim() || path.join(HERE, 'data', 'wilayah.json.gz')));
const MAX_DATA_BYTES = 64 * 1024 * 1024;
const MAX_QUERY = 200;
const SEARCH_MAX = 50;
const CHILDREN_MAX = 200;

// Provinces of the Papua region call their kecamatan "distrik".
const DISTRIK_PROVINCES = new Set(['91', '92', '93', '94', '95', '96']);
// Common short names people type for provinces (matched as whole normalized strings).
const PROVINCE_ALIASES = {
  11: ['nad', 'nanggroe aceh darussalam'], 12: ['sumut'], 13: ['sumbar'], 15: [], 16: ['sumsel'], 19: ['babel', 'bangka belitung'],
  21: ['kepri'], 31: ['dki', 'dki jakarta', 'jakarta'], 32: ['jabar'], 33: ['jateng'], 34: ['diy', 'di yogyakarta', 'yogyakarta', 'jogja', 'jogjakarta', 'yogya'],
  35: ['jatim'], 52: ['ntb'], 53: ['ntt'], 61: ['kalbar'], 62: ['kalteng'], 63: ['kalsel'], 64: ['kaltim'], 65: ['kaltara'],
  71: ['sulut'], 72: ['sulteng'], 73: ['sulsel'], 74: ['sultra'], 76: ['sulbar'], 82: ['malut'], 92: ['pabar'], 93: ['papsel'],
  94: ['papteng'], 95: ['pegunungan'], 96: ['pbd'],
};
// Leading words in a query that name the kind of region (removed before matching, used as a hint).
const TYPE_WORDS = [
  ['provinsi', 'provinsi'], ['prov', 'provinsi'], ['propinsi', 'provinsi'],
  ['kabupaten', 'kabupaten'], ['kab', 'kabupaten'], ['kota', 'kota'],
  ['kecamatan', 'kecamatan'], ['kec', 'kecamatan'], ['distrik', 'kecamatan'],
  ['kelurahan', 'kelurahan'], ['kel', 'kelurahan'], ['desa', 'desa'],
];
const JENIS = ['provinsi', 'kabupaten', 'kota', 'kecamatan', 'kelurahan', 'desa'];

function expandHome(p) {
  return p === '~' ? os.homedir() : p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p;
}

function log(...args) {
  process.stderr.write('[wilayah-indonesia] ' + args.map(String).join(' ') + '\n');
}

class ToolError extends Error {}

// ---------- data ----------

let DB = null;

function loadData() {
  if (DB) return DB;
  let raw;
  try {
    const st = fs.statSync(DATA_FILE);
    if (st.size > MAX_DATA_BYTES) throw new Error('file too large');
    raw = fs.readFileSync(DATA_FILE);
    if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw, { maxOutputLength: MAX_DATA_BYTES });
  } catch (e) {
    log('cannot read data file', DATA_FILE, e && e.message);
    throw new ToolError('Data wilayah tidak bisa dibaca / The region data file cannot be read. Reinstall the package or check WILAYAH_DATA_FILE.');
  }
  let parsed;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.wilayah)) {
    throw new ToolError('Data wilayah rusak / The region data file is not valid JSON of the expected shape.');
  }
  const codes = [];
  const names = [];
  const index = new Map();
  for (const row of parsed.wilayah) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string' || !CODE_RE.test(row[0]) || index.has(row[0])) continue;
    index.set(row[0], codes.length);
    codes.push(row[0]);
    names.push(row[1]);
  }
  const norm = names.map((n, i) => coreName(n, levelOf(codes[i])));
  const children = new Map([['', []]]);
  for (let i = 0; i < codes.length; i++) {
    const p = parentOf(codes[i]);
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(i);
  }
  const cmp = (a, b) => (codes[a] < codes[b] ? -1 : codes[a] > codes[b] ? 1 : 0);
  for (const list of children.values()) list.sort(cmp);
  const aliases = new Map();
  for (const [prov, list] of Object.entries(PROVINCE_ALIASES)) for (const a of list) aliases.set(a, String(prov));
  DB = { codes, names, index, norm, children, aliases, meta: parsed.meta || {} };
  log(`loaded ${codes.length} regions from ${path.basename(DATA_FILE)}`);
  return DB;
}

const CODE_RE = /^\d{2}(\.\d{2}(\.\d{2}(\.\d{4})?)?)?$/;

function levelOf(code) {
  return code.split('.').length;
}

function parentOf(code) {
  const i = code.lastIndexOf('.');
  return i < 0 ? '' : code.slice(0, i);
}

function jenisOf(code) {
  const s = code.split('.');
  if (s.length === 1) return 'provinsi';
  if (s.length === 2) return s[1][0] === '7' ? 'kota' : 'kabupaten';
  if (s.length === 3) return 'kecamatan';
  return s[3][0] === '1' ? 'kelurahan' : 'desa';
}

function normalize(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’‘`´]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Normalized name without the "Kabupaten"/"Kota (Administrasi)" prefix of level-2 names.
function coreName(name, level) {
  const n = normalize(name);
  if (level !== 2) return n;
  return n.replace(/^(kabupaten administrasi|kota administrasi|kabupaten|kota) /, '');
}

function label(i) {
  const { codes, names } = DB;
  const code = codes[i];
  const name = names[i];
  switch (jenisOf(code)) {
    case 'provinsi': return `Prov. ${name}`;
    case 'kabupaten':
    case 'kota': return name.replace(/^Kabupaten Administrasi /, 'Kab. Adm. ').replace(/^Kabupaten /, 'Kab. ').replace(/^Kota Administrasi /, 'Kota Adm. ');
    case 'kecamatan': return `${DISTRIK_PROVINCES.has(code.slice(0, 2)) ? 'Distrik' : 'Kec.'} ${name}`;
    case 'kelurahan': return `Kel. ${name}`;
    default: return /^Desa Adat /.test(name) ? name : `Desa ${name}`;
  }
}

// Indices of the region and all its parents, from the region up to the province.
function chain(i) {
  const out = [i];
  let code = DB.codes[i];
  while ((code = parentOf(code))) {
    const j = DB.index.get(code);
    if (j === undefined) break;
    out.push(j);
  }
  return out;
}

function fullPath(i) {
  return chain(i).map(label).join(', ');
}

function brief(i) {
  const code = DB.codes[i];
  const o = { kode: code, nama: DB.names[i], jenis: jenisOf(code), tingkat: levelOf(code), path: fullPath(i) };
  if (o.tingkat === 4) o.bmkg_adm4 = code;
  return o;
}

// ---------- code parsing ----------

// Accepts 31.71.03.1001, 3171031001, "31 71 03 1001", 31-71-03-1001. Returns { kode } or { error }.
function parseCode(input) {
  let raw = typeof input === 'string' || typeof input === 'number' ? String(input).trim() : '';
  if (!raw) return { error: 'kode kosong / code is empty' };
  if (raw.length > 40) return { error: 'kode terlalu panjang / code is too long' };
  const dotted = raw.split(/[\s.\-_/]+/).filter(Boolean).join('.');
  if (CODE_RE.test(dotted)) return { kode: dotted };
  const digits = raw.replace(/[\s.\-_/]/g, '');
  if (/^\d+$/.test(digits)) {
    const n = digits.length;
    raw = digits;
    if (n === 2) return { kode: raw };
    if (n === 4) return { kode: `${raw.slice(0, 2)}.${raw.slice(2)}` };
    if (n === 6) return { kode: `${raw.slice(0, 2)}.${raw.slice(2, 4)}.${raw.slice(4)}` };
    if (n === 10) return { kode: `${raw.slice(0, 2)}.${raw.slice(2, 4)}.${raw.slice(4, 6)}.${raw.slice(6)}` };
    if (n === 9 && raw[4] === '4') return { error: 'ini tampak seperti kode pulau (9 digit, xx.xx.4xxxx), bukan kode wilayah / this looks like an island code, not a region code', pulau: true };
    return { error: `panjang ${n} digit tidak dikenal; kode wilayah punya 2, 4, 6 atau 10 digit / unknown length, region codes have 2, 4, 6 or 10 digits` };
  }
  if (/^\d{2}\.\d{2}\.4\d{4}$/.test(raw)) return { error: 'ini format kode pulau (xx.xx.4xxxx), bukan kode wilayah / this is an island code format, not a region code', pulau: true };
  return { error: 'format tidak dikenal; contoh yang benar: 32.73 atau 31.71.03.1001 / unknown format, e.g. 32.73 or 31.71.03.1001' };
}

function requireCode(v, name = 'kode') {
  const p = parseCode(v);
  if (p.error) throw new ToolError(`"${name}" tidak valid / invalid: ${p.error}`);
  return p.kode;
}

function optInt(v, name, dflt, min, max) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isInteger(n) || n < min || n > max) throw new ToolError(`"${name}" harus bilangan bulat ${min}-${max} / must be an integer ${min}-${max}.`);
  return n;
}

// ---------- tools ----------

const TOOLS = [
  {
    name: 'cari_wilayah',
    title: 'Cari wilayah / Search regions',
    description: 'Mencari provinsi, kabupaten/kota, kecamatan atau desa/kelurahan berdasarkan nama (tahan salah ketik). '
      + 'Searches Indonesian administrative regions by name (typo tolerant) and returns the Kemendagri code plus the full path, '
      + 'e.g. "Desa X, Kec. Y, Kab. Z, Prov. W". Extra words can name a parent ("gambir jakarta pusat"). Offline, free.',
    inputSchema: {
      type: 'object',
      properties: {
        nama: { type: 'string', description: 'Nama wilayah / region name, e.g. "Kemayoran", "kab bandung", "desa sukamaju garut". Max 200 chars.' },
        tingkat: { type: 'integer', minimum: 1, maximum: 4, description: 'Optional level: 1 provinsi, 2 kabupaten/kota, 3 kecamatan, 4 desa/kelurahan.' },
        jenis: { type: 'string', enum: JENIS, description: 'Optional exact kind (finer than tingkat).' },
        kode_induk: { type: 'string', description: 'Optional parent code to search inside, e.g. "32" (Jawa Barat) or "32.05" (Kab. Garut).' },
        batas: { type: 'integer', minimum: 1, maximum: SEARCH_MAX, default: 10, description: `Max results (default 10, max ${SEARCH_MAX}).` },
      },
      required: ['nama'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'detail_kode',
    title: 'Detail kode wilayah / Code details',
    description: 'Menjelaskan satu kode wilayah: nama, jenis, semua induknya dan jumlah wilayah di bawahnya. '
      + 'Returns the name, kind, all parents (province down) and child count of a Kemendagri region code. '
      + 'Accepts 31.71.03.1001 or 3171031001. Level-4 codes are also the BMKG "adm4" codes. Offline, free.',
    inputSchema: {
      type: 'object',
      properties: { kode: { type: 'string', description: 'Region code, e.g. "32.73", "31.71.03" or "3171031001".' } },
      required: ['kode'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'daftar_anak',
    title: 'Daftar wilayah di bawah kode / List children',
    description: 'Mendaftar wilayah satu tingkat di bawah kode (provinsi → kab/kota → kecamatan → desa/kelurahan), dengan halaman. '
      + 'Lists the direct children of a code, paginated with offset/batas. Without kode it lists the 38 provinces. Offline, free.',
    inputSchema: {
      type: 'object',
      properties: {
        kode: { type: 'string', description: 'Parent code, e.g. "32" or "32.73.01". Leave empty for all provinces.' },
        offset: { type: 'integer', minimum: 0, default: 0, description: 'Start position (use next_offset from the previous page).' },
        batas: { type: 'integer', minimum: 1, maximum: CHILDREN_MAX, default: 50, description: `Page size (default 50, max ${CHILDREN_MAX}).` },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'validasi_kode',
    title: 'Validasi kode wilayah / Validate code',
    description: 'Memeriksa format kode wilayah Kemendagri dan apakah kode itu ada di data Kepmendagri terbaru. '
      + 'Checks the format of a region code and whether it exists in the current list; for unknown codes it reports the nearest existing parent. Offline, free.',
    inputSchema: {
      type: 'object',
      properties: { kode: { type: 'string', description: 'Code to check, e.g. "35.78.01.1001" or "3578011001".' } },
      required: ['kode'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: true },
  },
];

async function callTool(name, args) {
  if (name === 'cari_wilayah') return cariWilayah(args);
  if (name === 'detail_kode') return detailKode(args);
  if (name === 'daftar_anak') return daftarAnak(args);
  if (name === 'validasi_kode') return validasiKode(args);
  throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
}

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function cariWilayah(args) {
  const rawName = typeof args.nama === 'string' ? args.nama.trim() : '';
  if (!rawName) throw new ToolError('"nama" wajib diisi / is required.');
  if (rawName.length > MAX_QUERY) throw new ToolError(`"nama" terlalu panjang (maks ${MAX_QUERY}) / is too long.`);
  const tingkat = optInt(args.tingkat, 'tingkat', 0, 1, 4);
  const jenis = typeof args.jenis === 'string' && args.jenis.trim() ? args.jenis.trim().toLowerCase() : '';
  if (jenis && !JENIS.includes(jenis)) throw new ToolError(`"jenis" harus salah satu dari / must be one of: ${JENIS.join(', ')}.`);
  const batas = optInt(args.batas, 'batas', 10, 1, SEARCH_MAX);
  const db = loadData();
  let induk = '';
  if (args.kode_induk !== undefined && args.kode_induk !== null && String(args.kode_induk).trim()) {
    induk = requireCode(args.kode_induk, 'kode_induk');
    if (!db.index.has(induk)) throw new ToolError(`kode_induk ${induk} tidak ditemukan / not found. Use cari_wilayah without it or check validasi_kode.`);
  }

  let q = normalize(rawName);
  let hint = '';
  for (const [w, kind] of TYPE_WORDS) {
    if (q.startsWith(w + ' ') && q.length > w.length + 1) { hint = kind; q = q.slice(w.length + 1); break; }
  }
  if (!q) throw new ToolError('"nama" berisi huruf/angka / must contain letters or digits.');
  const tokens = q.split(' ');
  const aliasProv = db.aliases.get(q);

  const scores = new Map();
  const consider = i => {
    const code = db.codes[i];
    if (induk && !code.startsWith(induk + '.')) return false;
    const lv = levelOf(code);
    if (tingkat && lv !== tingkat) return false;
    if (jenis && jenisOf(code) !== jenis) return false;
    return true;
  };
  const put = (i, s) => {
    if (hint) {
      const j = jenisOf(db.codes[i]);
      if (j === hint || (hint === 'desa' && j === 'kelurahan') || (hint === 'kelurahan' && j === 'desa')) s += 5;
    }
    if ((scores.get(i) || 0) < s) scores.set(i, s);
  };

  const n = db.codes.length;
  for (let i = 0; i < n; i++) {
    const name = db.norm[i];
    if (!tokens.some(t => name.includes(t)) && !(aliasProv && db.codes[i] === aliasProv)) continue;
    if (!consider(i)) continue;
    if (aliasProv && db.codes[i] === aliasProv) { put(i, 100); continue; }
    if (name === q) { put(i, 100); continue; }
    if (name.startsWith(q + ' ')) { put(i, 90); continue; }
    if ((' ' + name + ' ').includes(' ' + q + ' ')) { put(i, 85); continue; }
    if (name.startsWith(q)) { put(i, 80); continue; }
    if (name.includes(q)) { put(i, 70); continue; }
    const words = name.split(' ');
    if (tokens.every(t => words.some(w => w.startsWith(t)))) { put(i, 65); continue; }
    // Extra words may name a parent: "gambir jakarta pusat", "sukamaju garut".
    if (tokens.length > 1) {
      const nameTokens = tokens.filter(t => words.some(w => w.startsWith(t)));
      if (!nameTokens.length) continue;
      const rest = tokens.filter(t => !nameTokens.includes(t));
      const parents = chain(i).slice(1).map(j => db.norm[j]).join(' ').split(' ');
      if (rest.every(t => parents.some(w => w.startsWith(t)))) put(i, 50 + Math.min(10, nameTokens.length * 3));
    }
  }
  // Typo tolerance: compare against whole names (and each name with the same word count) when exact matching found little.
  if (scores.size < batas && q.length >= 4) {
    const max = q.length <= 5 ? 1 : q.length <= 9 ? 2 : 3;
    for (let i = 0; i < n; i++) {
      if (scores.has(i) || !consider(i)) continue;
      const name = db.norm[i];
      let d = levenshtein(q, name, max);
      if (d > max && tokens.length === 1) {
        for (const w of name.split(' ')) { if (w.length >= 4) d = Math.min(d, levenshtein(q, w, max) + 1); }
      }
      if (d <= max) put(i, 40 - d * 5);
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]
    || levelOf(db.codes[a[0]]) - levelOf(db.codes[b[0]])
    || (db.codes[a[0]] < db.codes[b[0]] ? -1 : 1));
  const hasil = ranked.slice(0, batas).map(([i, s]) => ({ ...brief(i), skor: s }));
  const out = { query: rawName, total_cocok: ranked.length, ditampilkan: hasil.length, hasil };
  if (!hasil.length) out.saran = 'Tidak ada yang cocok. Coba ejaan lain, hapus filter, atau cari induknya dulu lalu pakai daftar_anak. / No match: try another spelling, drop filters, or browse with daftar_anak.';
  else if (ranked.length > hasil.length) out.saran = 'Hasil lain ada; persempit dengan tingkat, jenis atau kode_induk. / More matches exist: narrow with tingkat, jenis or kode_induk.';
  return result(out);
}

function detailKode(args) {
  const kode = requireCode(args.kode);
  const db = loadData();
  const i = db.index.get(kode);
  if (i === undefined) {
    throw new ToolError(`Kode ${kode} tidak ada di data / not found. ${nearestNote(kode)} Gunakan validasi_kode atau cari_wilayah.`);
  }
  const induk = chain(i).slice(1).reverse().map(j => ({ kode: db.codes[j], nama: db.names[j], jenis: jenisOf(db.codes[j]) }));
  const anak = db.children.get(kode) || [];
  const out = { ...brief(i), induk, jumlah_anak: anak.length };
  if (anak.length) out.jenis_anak = [...new Set(anak.map(j => jenisOf(db.codes[j])))];
  return result(out);
}

function daftarAnak(args) {
  const db = loadData();
  const raw = args.kode;
  const kode = raw === undefined || raw === null || String(raw).trim() === '' ? '' : requireCode(raw);
  if (kode && !db.index.has(kode)) throw new ToolError(`Kode ${kode} tidak ada di data / not found. ${nearestNote(kode)}`);
  const offset = optInt(args.offset, 'offset', 0, 0, 1e6);
  const batas = optInt(args.batas, 'batas', 50, 1, CHILDREN_MAX);
  const list = db.children.get(kode) || [];
  const items = list.slice(offset, offset + batas).map(j => ({ kode: db.codes[j], nama: db.names[j], jenis: jenisOf(db.codes[j]) }));
  const out = {
    induk: kode ? { kode, nama: db.names[db.index.get(kode)], path: fullPath(db.index.get(kode)) } : null,
    total: list.length, offset, ditampilkan: items.length,
    next_offset: offset + items.length < list.length ? offset + items.length : null,
    items,
  };
  if (!list.length && kode) out.catatan = 'Kode ini tingkat desa/kelurahan dan tidak punya wilayah di bawahnya. / Village level: no children.';
  return result(out);
}

function nearestNote(kode) {
  let p = kode;
  while ((p = parentOf(p))) {
    const j = DB.index.get(p);
    if (j !== undefined) return `Induk terdekat yang ada / nearest existing parent: ${p} (${fullPath(j)}).`;
  }
  return 'Kode provinsinya pun tidak ada / even the province part does not exist.';
}

function validasiKode(args) {
  const input = typeof args.kode === 'string' || typeof args.kode === 'number' ? String(args.kode) : '';
  const p = parseCode(input);
  if (p.error) {
    return result({ input, format_valid: false, ada: false, alasan: p.error });
  }
  const kode = p.kode;
  const seg = kode.split('.');
  const masalah = [];
  if (!/^[1-9]/.test(seg[0])) masalah.push('kode provinsi tidak boleh diawali 0 / province code cannot start with 0');
  if (seg[1] === '00') masalah.push('segmen kabupaten/kota 00 tidak dipakai / regency segment 00 is not used');
  if (seg[2] === '00') masalah.push('segmen kecamatan 00 tidak dipakai / district segment 00 is not used');
  if (seg[3] && !/^[123]/.test(seg[3])) masalah.push('segmen desa/kelurahan diawali 1 (kelurahan), 2 (desa) atau 3 (desa adat) / village segment starts with 1 (kelurahan), 2 (desa) or 3 (desa adat)');
  const db = loadData();
  const i = db.index.get(kode);
  const out = {
    input, kode, kode_tanpa_titik: seg.join(''), format_valid: masalah.length === 0, tingkat: seg.length,
    jenis_menurut_format: seg[3] && !/^[123]/.test(seg[3]) ? 'tidak dikenal' : seg[3] && seg[3][0] === '3' ? 'desa (desa adat)' : jenisOf(kode), ada: i !== undefined,
  };
  if (masalah.length) out.masalah = masalah;
  if (i !== undefined) Object.assign(out, { nama: db.names[i], path: fullPath(i) });
  else {
    out.catatan = nearestNote(kode) + ' Kode bisa berubah antar-Kepmendagri (pemekaran, mis. provinsi baru di Papua sejak 2022). / Codes can change between editions.';
  }
  if (seg.length === 4 && i !== undefined) out.bmkg_adm4 = kode;
  return result(out);
}

function result(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }], structuredContent: obj };
}

function text(t, isError = false) {
  return isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] };
}

// ---------- JSON-RPC over stdio ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  if (typeof method !== 'string') {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } });
    return;
  }
  if (!isRequest) return; // notifications need no answer
  try {
    let res;
    switch (method) {
      case 'initialize': {
        const asked = params && params.protocolVersion;
        res = {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'wilayah-indonesia', title: 'Wilayah Indonesia', version: VERSION },
          instructions: 'Indonesian administrative regions with Kemendagri codes (Kepmendagri 300.2.2-2430/2025), offline. '
            + 'Find a code with cari_wilayah, explain one with detail_kode, browse with daftar_anak, check one with validasi_kode. '
            + 'Village (level 4) codes like 31.71.03.1001 are the BMKG weather "adm4" codes.',
        };
        break;
      }
      case 'ping': res = {}; break;
      case 'tools/list': res = { tools: TOOLS }; break;
      case 'resources/list': res = { resources: [] }; break;
      case 'resources/templates/list': res = { resourceTemplates: [] }; break;
      case 'prompts/list': res = { prompts: [] }; break;
      case 'tools/call': {
        const name = params && params.name;
        if (!TOOLS.some(t => t.name === name)) {
          send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(name).slice(0, 100)}` } });
          return;
        }
        try {
          res = await callTool(name, (params && typeof params.arguments === 'object' && params.arguments) || {});
        } catch (e) {
          if (!(e instanceof ToolError)) log('tool failed:', e && e.stack || e);
          res = text(e instanceof ToolError ? e.message : 'Terjadi kesalahan / Unexpected error: ' + (e && e.message), true);
        }
        break;
      }
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method.slice(0, 100)}` } });
        return;
    }
    send({ jsonrpc: '2.0', id, result: res });
  } catch (e) {
    log('request failed:', e && e.stack || e);
    send({ jsonrpc: '2.0', id, error: { code: e.rpcCode || -32603, message: e.message || 'Internal error' } });
  }
}

function main() {
  log(`v${VERSION} ready; data ${path.basename(DATA_FILE)}`);
  const pending = new Set();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    if (line.length > 1024 * 1024) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } });
      return;
    }
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    for (const m of msgs) {
      const p = handle(m && typeof m === 'object' ? m : {}).catch(e => log('fatal handler error:', e && e.stack || e));
      pending.add(p);
      p.finally(() => pending.delete(p));
    }
  });
  rl.on('close', async () => {
    await Promise.allSettled([...pending]);
    process.exit(0);
  });
}

main();
