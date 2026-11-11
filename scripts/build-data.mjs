#!/usr/bin/env node
// Rebuilds data/wilayah.json.gz from the upstream MySQL dump db/wilayah.sql of
// https://github.com/cahyadsn/wilayah (MIT, Copyright (c) 2017-2025 Cahya DSN).
// Not shipped in the npm package; used only by maintainers when the upstream data changes.
//
// Usage:
//   curl -sL -o /tmp/wilayah.sql https://raw.githubusercontent.com/cahyadsn/wilayah/master/db/wilayah.sql
//   node scripts/build-data.mjs /tmp/wilayah.sql --commit <upstream sha> --date <YYYY-MM-DD> [--out data/wilayah.json.gz]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const sqlPath = args.find(a => !a.startsWith('--'));
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
if (!sqlPath) {
  console.error('usage: node scripts/build-data.mjs <wilayah.sql> --commit <sha> --date <YYYY-MM-DD> [--out file]');
  process.exit(2);
}
const out = opt('out') || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data', 'wilayah.json.gz');

const sql = fs.readFileSync(sqlPath, 'utf8');
const re = /\('([0-9.]+)','((?:[^']|'')*)'\)/g;
const rows = [];
const seen = new Set();
for (const m of sql.matchAll(re)) {
  const kode = m[1];
  const nama = m[2].replace(/''/g, "'").replace(/\s+/g, ' ').trim();
  if (!/^\d{2}(\.\d{2}(\.\d{2}(\.\d{4})?)?)?$/.test(kode)) throw new Error('unexpected code ' + kode);
  if (seen.has(kode)) throw new Error('duplicate code ' + kode);
  seen.add(kode);
  rows.push([kode, nama]);
}
rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
for (const [kode] of rows) {
  const parent = kode.split('.').slice(0, -1).join('.');
  if (parent && !seen.has(parent)) throw new Error(`orphan ${kode} (missing ${parent})`);
}
const counts = { provinsi: 0, kabupaten: 0, kota: 0, kecamatan: 0, kelurahan: 0, desa: 0 };
for (const [kode] of rows) {
  const s = kode.split('.');
  if (s.length === 1) counts.provinsi++;
  else if (s.length === 2) counts[s[1][0] === '7' ? 'kota' : 'kabupaten']++;
  else if (s.length === 3) counts.kecamatan++;
  else counts[s[3][0] === '1' ? 'kelurahan' : 'desa']++;
}
const meta = {
  source: 'https://github.com/cahyadsn/wilayah (db/wilayah.sql)',
  source_license: 'MIT, Copyright (c) 2017-2025 Cahya DSN',
  legal_basis: 'Kepmendagri No. 300.2.2-2430 Tahun 2025 (perubahan atas Kepmendagri No. 300.2.2-2138 Tahun 2025)',
  upstream_commit: opt('commit') || 'unknown',
  upstream_date: opt('date') || 'unknown',
  built: new Date().toISOString().slice(0, 10),
  rows: rows.length,
  counts,
};
const json = JSON.stringify({ meta, wilayah: rows });
fs.writeFileSync(out, zlib.gzipSync(Buffer.from(json), { level: 9 }));
console.error(`wrote ${out}: ${rows.length} rows, ${fs.statSync(out).size} bytes`, counts);
