// End-to-end tests: the MCP server is spawned over stdio and fed a small fixture (46 real rows).
// One block also checks the bundled full data file. No network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'mcp-wilayah-indonesia.mjs');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'wilayah-mini.json');
let tmp;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wilayah-mcp-'));
  fs.writeFileSync(path.join(tmp, 'mini.json.gz'), zlib.gzipSync(fs.readFileSync(FIXTURE)));
  fs.writeFileSync(path.join(tmp, 'broken.json'), '{"wilayah": nope');
  fs.writeFileSync(path.join(tmp, 'wrong-shape.json'), '{"rows": []}');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Spawns the MCP server and talks to it line by line.
function startMcp(dataFile = FIXTURE) {
  const env = { ...process.env };
  if (dataFile === null) delete env.WILAYAH_DATA_FILE;
  else env.WILAYAH_DATA_FILE = dataFile;
  const proc = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let nextId = 1;
  const waiting = new Map();
  const lines = [];
  proc.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      lines.push(msg);
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  proc.stderr.on('data', () => {});
  const request = (method, params) => new Promise(resolve => {
    const id = nextId++;
    waiting.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const raw = (line, id) => new Promise(resolve => {
    waiting.set(id, resolve);
    proc.stdin.write(line + '\n');
  });
  const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
  const callJson = async (name, args) => {
    const r = await call(name, args);
    assert.ok(!r.isError, 'unexpected error: ' + (r.content && r.content[0].text));
    const parsed = JSON.parse(r.content[0].text);
    assert.deepEqual(parsed, r.structuredContent);
    return parsed;
  };
  const stop = () => new Promise(resolve => { proc.on('close', resolve); proc.stdin.end(); });
  return { request, raw, call, callJson, stop, lines };
}

test('initialize negotiates the protocol version, lists 4 read-only tools, answers ping', async () => {
  const m = startMcp();
  const init = await m.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.serverInfo.name, 'wilayah-indonesia');
  const odd = await m.request('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(odd.result.protocolVersion, '2025-06-18');
  const list = await m.request('tools/list', {});
  const names = list.result.tools.map(t => t.name).sort();
  assert.deepEqual(names, ['cari_wilayah', 'daftar_anak', 'detail_kode', 'validasi_kode']);
  for (const t of list.result.tools) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.openWorldHint, false);
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 40);
  }
  assert.deepEqual((await m.request('ping', {})).result, {});
  await m.stop();
});

test('protocol errors: unknown tool, unknown method, parse error, notifications get no answer', async () => {
  const m = startMcp();
  const unk = await m.request('tools/call', { name: 'hapus_semua', arguments: {} });
  assert.equal(unk.error.code, -32602);
  const meth = await m.request('foo/bar', {});
  assert.equal(meth.error.code, -32601);
  const parse = await m.raw('{not json', null);
  assert.equal(parse.error.code, -32700);
  m.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), 'never');
  assert.deepEqual((await m.request('ping', {})).result, {});
  assert.equal(m.lines.filter(l => l.id === undefined).length, 0);
  await m.stop();
});

test('cari_wilayah: exact name, kinds, full path, BMKG adm4, ranking by level', async () => {
  const m = startMcp();
  const r = await m.callJson('cari_wilayah', { nama: 'Kemayoran' });
  assert.equal(r.total_cocok, 3);
  assert.equal(r.hasil[0].kode, '31.71.03');
  assert.equal(r.hasil[0].jenis, 'kecamatan');
  assert.equal(r.hasil[0].path, 'Kec. Kemayoran, Kota Adm. Jakarta Pusat, Prov. Daerah Khusus Ibukota Jakarta');
  const kel = r.hasil.find(h => h.kode === '31.71.03.1001');
  assert.equal(kel.path, 'Kel. Kemayoran, Kec. Kemayoran, Kota Adm. Jakarta Pusat, Prov. Daerah Khusus Ibukota Jakarta');
  assert.equal(kel.bmkg_adm4, '31.71.03.1001');
  assert.ok(r.hasil.some(h => h.path === 'Kel. Kemayoran, Kec. Bangkalan, Kab. Bangkalan, Prov. Jawa Timur'));
  await m.stop();
});

test('cari_wilayah: typo tolerance, parent words, type hint, aliases, Papua distrik', async () => {
  const m = startMcp();
  const typo = await m.callJson('cari_wilayah', { nama: 'kemayoram' });
  assert.equal(typo.hasil[0].nama, 'Kemayoran');
  const parent = await m.callJson('cari_wilayah', { nama: 'sukamaju garut' });
  assert.equal(parent.total_cocok, 2);
  assert.match(parent.hasil[0].path, /^Desa Sukamaju, Kec\. (Kersamanah|Cilawu), Kab\. Garut, Prov\. Jawa Barat$/);
  const kab = await m.callJson('cari_wilayah', { nama: 'kab bandung' });
  assert.equal(kab.hasil[0].kode, '32.04');
  assert.equal(kab.hasil[1].kode, '32.73');
  const kota = await m.callJson('cari_wilayah', { nama: 'kota bandung' });
  assert.equal(kota.hasil[0].kode, '32.73');
  const jogja = await m.callJson('cari_wilayah', { nama: 'Jogja' });
  assert.equal(jogja.hasil[0].kode, '34');
  assert.ok(jogja.hasil.some(h => h.kode === '11.15.01.2004'));
  const dki = await m.callJson('cari_wilayah', { nama: 'DKI Jakarta', tingkat: 1 });
  assert.equal(dki.hasil[0].kode, '31');
  const wamena = await m.callJson('cari_wilayah', { nama: 'wamena', tingkat: 3 });
  assert.equal(wamena.hasil[0].path, 'Distrik Wamena, Kab. Jayawijaya, Prov. Papua Pegunungan');
  const diacritics = await m.callJson('cari_wilayah', { nama: 'KÉMAYORAN' });
  assert.equal(diacritics.hasil[0].nama, 'Kemayoran');
  await m.stop();
});

test('cari_wilayah: filters (tingkat, jenis, kode_induk), batas, no-match hint', async () => {
  const m = startMcp();
  const lv4 = await m.callJson('cari_wilayah', { nama: 'kemayoran', tingkat: 4 });
  assert.ok(lv4.hasil.length === 2 && lv4.hasil.every(h => h.tingkat === 4));
  const kec = await m.callJson('cari_wilayah', { nama: 'kemayoran', jenis: 'kecamatan' });
  assert.deepEqual(kec.hasil.map(h => h.kode), ['31.71.03']);
  const inJatim = await m.callJson('cari_wilayah', { nama: 'kemayoran', kode_induk: '35' });
  assert.deepEqual(inJatim.hasil.map(h => h.kode), ['35.26.01.1002']);
  const plainParent = await m.callJson('cari_wilayah', { nama: 'sukamaju', kode_induk: '3205' });
  assert.equal(plainParent.total_cocok, 2);
  const one = await m.callJson('cari_wilayah', { nama: 'kemayoran', batas: 1 });
  assert.equal(one.ditampilkan, 1);
  assert.equal(one.total_cocok, 3);
  assert.match(one.saran, /persempit/);
  const none = await m.callJson('cari_wilayah', { nama: 'zzzqqq' });
  assert.equal(none.total_cocok, 0);
  assert.match(none.saran, /Tidak ada/);
  await m.stop();
});

test('cari_wilayah: argument errors are tool errors, not crashes', async () => {
  const m = startMcp();
  for (const [args, re] of [
    [{}, /wajib/],
    [{ nama: '   ' }, /wajib/],
    [{ nama: 'x'.repeat(201) }, /terlalu panjang/],
    [{ nama: '!!!' }, /huruf/],
    [{ nama: 'a', tingkat: 7 }, /tingkat/],
    [{ nama: 'a', batas: 0 }, /batas/],
    [{ nama: 'a', jenis: 'dusun' }, /jenis/],
    [{ nama: 'a', kode_induk: '77' }, /tidak ditemukan/],
    [{ nama: 'a', kode_induk: 'abc' }, /tidak valid/],
  ]) {
    const r = await m.call('cari_wilayah', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, re);
    assert.doesNotMatch(r.content[0].text, /at .*\.mjs/);
  }
  await m.stop();
});

test('detail_kode: dotted and plain input, parents, children, not found', async () => {
  const m = startMcp();
  const d = await m.callJson('detail_kode', { kode: '3171031001' });
  assert.equal(d.kode, '31.71.03.1001');
  assert.equal(d.jenis, 'kelurahan');
  assert.equal(d.bmkg_adm4, '31.71.03.1001');
  assert.deepEqual(d.induk.map(x => x.kode), ['31', '31.71', '31.71.03']);
  assert.equal(d.jumlah_anak, 0);
  const kec = await m.callJson('detail_kode', { kode: '31.71.03' });
  assert.equal(kec.jumlah_anak, 8);
  assert.deepEqual(kec.jenis_anak, ['kelurahan']);
  const spaced = await m.callJson('detail_kode', { kode: '32 05 13 2005' });
  assert.equal(spaced.path, 'Desa Sukamaju, Kec. Kersamanah, Kab. Garut, Prov. Jawa Barat');
  const missing = await m.call('detail_kode', { kode: '31.71.03.1099' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /31\.71\.03 \(Kec\. Kemayoran/);
  const bad = await m.call('detail_kode', { kode: '12345' });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /2, 4, 6 atau 10 digit/);
  await m.stop();
});

test('daftar_anak: provinces, pagination, leaf, unknown code', async () => {
  const m = startMcp();
  const prov = await m.callJson('daftar_anak', {});
  assert.equal(prov.induk, null);
  assert.deepEqual(prov.items.map(i => i.kode), ['11', '31', '32', '34', '35', '91', '95']);
  const p1 = await m.callJson('daftar_anak', { kode: '31.71', batas: 3 });
  assert.equal(p1.total, 8);
  assert.deepEqual(p1.items.map(i => i.nama), ['Gambir', 'Sawah Besar', 'Kemayoran']);
  assert.equal(p1.next_offset, 3);
  const p3 = await m.callJson('daftar_anak', { kode: '31.71', offset: 6, batas: 3 });
  assert.equal(p3.items.length, 2);
  assert.equal(p3.next_offset, null);
  const kids = await m.callJson('daftar_anak', { kode: '32' });
  assert.deepEqual(kids.items.map(i => i.jenis), ['kabupaten', 'kabupaten', 'kota']);
  const leaf = await m.callJson('daftar_anak', { kode: '31.71.03.1001' });
  assert.equal(leaf.total, 0);
  assert.match(leaf.catatan, /desa\/kelurahan/);
  const unknown = await m.call('daftar_anak', { kode: '33' });
  assert.equal(unknown.isError, true);
  const big = await m.call('daftar_anak', { kode: '31', batas: 500 });
  assert.equal(big.isError, true);
  await m.stop();
});

test('validasi_kode: valid, wrong segment, nonexistent with nearest parent, island code, junk', async () => {
  const m = startMcp();
  const plain = await m.callJson('validasi_kode', { kode: '3526011001' });
  assert.equal(plain.kode, '35.26.01.1001');
  assert.equal(plain.format_valid, true);
  assert.equal(plain.jenis_menurut_format, 'kelurahan');
  const real = await m.callJson('validasi_kode', { kode: '35.26.01.1002' });
  assert.equal(real.ada, true);
  assert.equal(real.kode_tanpa_titik, '3526011002');
  assert.equal(real.bmkg_adm4, '35.26.01.1002');
  assert.equal(real.nama, 'Kemayoran');
  const ghost = await m.callJson('validasi_kode', { kode: '32.05.13.2999' });
  assert.equal(ghost.format_valid, true);
  assert.equal(ghost.ada, false);
  assert.match(ghost.catatan, /32\.05\.13 \(Kec\. Kersamanah/);
  const seg = await m.callJson('validasi_kode', { kode: '32.73.01.5001' });
  assert.equal(seg.format_valid, false);
  assert.equal(seg.jenis_menurut_format, 'tidak dikenal');
  assert.ok(seg.masalah.length === 1);
  const adat = await m.callJson('validasi_kode', { kode: '91.03.01.3007' });
  assert.equal(adat.format_valid, true);
  assert.equal(adat.jenis_menurut_format, 'desa (desa adat)');
  assert.equal(adat.path, 'Desa Adat Yoboi, Distrik Sentani, Kab. Jayapura, Prov. Papua');
  const zero = await m.callJson('validasi_kode', { kode: '32.00' });
  assert.equal(zero.format_valid, false);
  const island = await m.callJson('validasi_kode', { kode: '11.01.40001' });
  assert.equal(island.format_valid, false);
  assert.match(island.alasan, /pulau/);
  const junk = await m.callJson('validasi_kode', { kode: 'Bandung' });
  assert.equal(junk.format_valid, false);
  const empty = await m.callJson('validasi_kode', {});
  assert.equal(empty.format_valid, false);
  await m.stop();
});

test('data file errors are reported as tool errors; gzip data works', async () => {
  const gz = startMcp(path.join(tmp, 'mini.json.gz'));
  const r = await gz.callJson('detail_kode', { kode: '95.01.01' });
  assert.equal(r.path, 'Distrik Wamena, Kab. Jayawijaya, Prov. Papua Pegunungan');
  await gz.stop();
  for (const f of ['missing.json', 'broken.json', 'wrong-shape.json']) {
    const m = startMcp(path.join(tmp, f));
    const e = await m.call('cari_wilayah', { nama: 'bandung' });
    assert.equal(e.isError, true);
    assert.match(e.content[0].text, /Data wilayah/);
    assert.ok(!e.content[0].text.includes(tmp), 'must not leak local paths');
    await m.stop();
  }
});

test('bundled data: full Kepmendagri list loads and matches the published totals', async () => {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data', 'wilayah.json.gz'))));
  assert.equal(d.wilayah.length, 91599);
  assert.equal(d.meta.rows, 91599);
  assert.deepEqual(d.meta.counts, { provinsi: 38, kabupaten: 416, kota: 98, kecamatan: 7285, kelurahan: 8496, desa: 75266 });
  assert.match(d.meta.legal_basis, /300\.2\.2-2430/);
  const m = startMcp(null);
  const prov = await m.callJson('daftar_anak', {});
  assert.equal(prov.total, 38);
  const v = await m.callJson('validasi_kode', { kode: '31.71.03.1001' });
  assert.equal(v.ada, true);
  const t0 = Date.now();
  const s = await m.callJson('cari_wilayah', { nama: 'kemayoram', batas: 5 });
  assert.equal(s.hasil[0].nama, 'Kemayoran');
  assert.ok(Date.now() - t0 < 5000, 'search over the full list should be fast');
  await m.stop();
});
