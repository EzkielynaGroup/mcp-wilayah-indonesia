# mcp-wilayah-indonesia

<!-- ezk:badges -->
[![npm](https://img.shields.io/npm/v/mcp-wilayah-indonesia?color=c2410c)](https://www.npmjs.com/package/mcp-wilayah-indonesia) [![CI](https://github.com/EzkielynaGroup/mcp-wilayah-indonesia/actions/workflows/test.yml/badge.svg)](https://github.com/EzkielynaGroup/mcp-wilayah-indonesia/actions/workflows/test.yml) [![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.EzkielynaGroup%2Fmcp--wilayah--indonesia-1f6feb)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.EzkielynaGroup/mcp-wilayah-indonesia) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
<!-- /ezk:badges -->

An [MCP](https://modelcontextprotocol.io) server that lets your AI assistant **look up Indonesian administrative regions and their Kemendagri codes**: provinsi, kabupaten/kota, kecamatan (distrik) and desa/kelurahan. It works **offline** from a bundled copy of the current code list (Kepmendagri No. 300.2.2-2430 Tahun 2025, 91,599 regions) and tolerates typos.

Example: *"What is the Kemendagri code of Kelurahan Kemayoran in Jakarta Pusat, and which BMKG adm4 code do I use for its weather forecast?"*

> 🇮🇩 Bahasa Indonesia: lihat [bagian di bawah](#bahasa-indonesia).

- **One file, no dependencies**: only Node.js 18 or newer. The data (≈ 660 KB gzip) ships with the package.
- No API key, no network calls, no cost. Read-only: the server never writes files.
- Full path in every answer, e.g. `Kel. Kemayoran, Kec. Kemayoran, Kota Adm. Jakarta Pusat, Prov. Daerah Khusus Ibukota Jakarta`.
- Accepts codes with or without dots (`31.71.03.1001` or `3171031001`).

## Tools

| Tool | What it does |
|---|---|
| `cari_wilayah` | Search by name, typo tolerant. Extra words can name a parent (`"sukamaju garut"`), a leading `kab`/`kota`/`kec`/`desa`/`kel` is used as a hint, common short names work (`jogja`, `DKI`, `jatim`, `NTT`). Filters: `tingkat` (1–4), `jenis` (`provinsi`, `kabupaten`, `kota`, `kecamatan`, `kelurahan`, `desa`), `kode_induk` (search inside a parent), `batas` (max 50). Returns code, kind, level, full path and a score. |
| `detail_kode` | Code → name, kind, every parent from the province down, and how many regions sit below it. |
| `daftar_anak` | Direct children of a code (province → kabupaten/kota → kecamatan → desa/kelurahan), paginated with `offset` and `batas` (max 200). Without a code it lists the 38 provinces. |
| `validasi_kode` | Checks the format (2/4/6/10 digits, segment rules such as kota = 71–79, kelurahan = 1xxx, desa = 2xxx, desa adat = 3xxx) and whether the code exists. For an unknown code it names the nearest parent that does exist; island codes (`xx.xx.4xxxx`) are recognised and explained. |

Every tool is read-only (`readOnlyHint: true`, `openWorldHint: false`). Answers are JSON text plus `structuredContent`.

### Code format

| Level | Kind | Digits | Example |
|---|---|---|---|
| 1 | provinsi | 2 | `32` Jawa Barat |
| 2 | kabupaten (01–69) / kota (71–79) | 2.2 | `32.73` Kota Bandung |
| 3 | kecamatan (called *distrik* in the Papua provinces) | 2.2.2 | `32.73.01` Sukasari |
| 4 | kelurahan (1xxx) / desa (2xxx; 3xxx for the 14 *desa adat* in Kab. Jayapura) | 2.2.2.4 | `31.71.03.1001` Kemayoran |

## Works with BMKG weather (adm4)

BMKG's public weather forecast API identifies villages by the **same level-4 Kemendagri code with dots**, as the `adm4` parameter, e.g. `https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=31.71.03.1001` (checked 11 Nov 2026). Level-4 results therefore include a `bmkg_adm4` field. Pair this server with [mcp-bmkg](https://github.com/EzkielynaGroup/mcp-bmkg) so the assistant can go from "weather in Kemayoran tomorrow" to the right village code to the forecast.

## Install

**With npx (recommended):** nothing to install. The configs below run `npx -y mcp-wilayah-indonesia`, which downloads the package (one `.mjs` file plus the data file, no dependencies) on first start.

**From source:**

```bash
git clone https://github.com/EzkielynaGroup/mcp-wilayah-indonesia.git
cd mcp-wilayah-indonesia
node --test test/        # optional, offline
```

Then use `"command": "node"` with `"args": ["/full/path/to/mcp-wilayah-indonesia.mjs"]` instead of `npx`.

On Windows, if the app cannot start `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "mcp-wilayah-indonesia"]`. Write paths in JSON with forward slashes (`C:/Users/you/mcp-wilayah-indonesia/mcp-wilayah-indonesia.mjs`) or double backslashes.

### Claude Desktop

Settings → Developer → Edit Config (`claude_desktop_config.json`), then fully quit and reopen Claude Desktop.

```json
{
  "mcpServers": {
    "wilayah-indonesia": {
      "command": "npx",
      "args": ["-y", "mcp-wilayah-indonesia"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add wilayah-indonesia -- npx -y mcp-wilayah-indonesia
```

Add `--scope user` to make it available in every project. Check with `claude mcp list`.

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project), same JSON as Claude Desktop.

### OpenCode

`opencode.json` in the project, or `~/.config/opencode/opencode.json` for all projects.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "wilayah-indonesia": {
      "type": "local",
      "command": ["npx", "-y", "mcp-wilayah-indonesia"],
      "enabled": true
    }
  }
}
```

## Configuration (environment)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `WILAYAH_DATA_FILE` | no | bundled `data/wilayah.json.gz` | Use another data file (`.json` or `.json.gz`) with the same shape, e.g. a newer build made with `scripts/build-data.mjs`. |

## Safety and limits

- Offline and read-only: no network requests, no file writes. Logs go to stderr; stdout carries only MCP messages.
- Input limits: names up to 200 characters, up to 50 search results and 200 children per page.
- Errors come back as short tool errors (Indonesian + English) without stack traces or local paths.
- The data is a snapshot. Codes and names change when regions split or are renamed; check the decree itself for legal or administrative use.

## Data source and license

| | |
|---|---|
| Legal basis | Keputusan Menteri Dalam Negeri **No. 300.2.2-2430 Tahun 2025** (amends No. 300.2.2-2138 Tahun 2025), as stated by the upstream dataset |
| Dataset | [`cahyadsn/wilayah`](https://github.com/cahyadsn/wilayah), file `db/wilayah.sql`, commit `d68e8d5` (last data change 13 Feb 2026), downloaded 11 Nov 2026 |
| Dataset license | **MIT**, Copyright (c) 2017-2025 Cahya DSN. The full notice ships as `data/LICENSE-DATA.txt`. |
| Contents | 38 provinsi, 416 kabupaten, 98 kota, 7,285 kecamatan, 8,496 kelurahan, 75,266 desa (91,599 rows). These totals were checked against the table in the upstream README. |
| Changes | Converted to compact JSON + gzip; 5 names had a trailing space removed. Nothing else changed. |

Notes: the comment header inside the upstream SQL file still mentions No. 300.2.2-2138 while the upstream README and its change notes say the data follows No. 300.2.2-2430; we follow the README. The province name for Jakarta is kept as it appears in the list (*Daerah Khusus Ibukota Jakarta*). This project has not compared every row against the decree PDF itself.

To rebuild after an upstream update:

```bash
curl -sL -o /tmp/wilayah.sql https://raw.githubusercontent.com/cahyadsn/wilayah/master/db/wilayah.sql
node scripts/build-data.mjs /tmp/wilayah.sql --commit <upstream sha> --date <YYYY-MM-DD>
node --test test/
```

## FAQ

**What is the Kemendagri code of my village (kode desa / kode kelurahan)?**
Ask your assistant with this server enabled, e.g. "kode wilayah Desa Sukamaju, Kec. Cilawu, Garut". `cari_wilayah` returns the 10-digit code (`32.05.19.2014`) and the full path.

**Is this the same code BMKG uses for weather (adm4)?**
Yes. BMKG's forecast API takes the level-4 Kemendagri code with dots as `adm4`, so `bmkg_adm4` can be passed straight to it or to [mcp-bmkg](https://github.com/EzkielynaGroup/mcp-bmkg).

**How many provinces, regencies and villages does Indonesia have in the current list?**
Per Kepmendagri 300.2.2-2430/2025: 38 provinces, 416 kabupaten, 98 kota, 7,285 kecamatan, 8,496 kelurahan and 75,266 desa.

**Is this the same as the postal code (kode pos) or the BPS code?**
No. Kemendagri region codes are different from postal codes, and from BPS (statistics) codes below the province level, which can differ (for example Kota Jakarta Pusat). This server only knows Kemendagri codes.

**Does it need internet or an API key?**
No. The data is bundled; after `npx` has downloaded the package once, everything runs locally and costs nothing.

**Is this data published by the government?**
The codes come from a Kemendagri decree, but this package uses an MIT-licensed community compilation of it, not a government service. For legal or administrative documents, check the decree published by Kemendagri.

## Development

```bash
node --test test/
```

11 tests spawn the server over stdio against a 46-row fixture taken from the real data (every tool, filters, typos, pagination, error paths, broken data files) and check that the bundled full list loads with the published totals. No network.

## License

Code: MIT, Copyright (c) 2026 Ezekiel Lieberhart (Ezkielyna). Data: MIT, Copyright (c) 2017-2025 Cahya DSN (see `data/LICENSE-DATA.txt`). This project is not affiliated with Kemendagri, BMKG or the upstream dataset author.

Made by [Ezkielyna](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=mcp-wilayah-indonesia), an independent AI API gateway for Indonesian developers (QRIS).

---

## Bahasa Indonesia

Server MCP agar asisten AI (Claude Desktop, Claude Code, Cursor, OpenCode, dan klien MCP lain) bisa **mencari wilayah administrasi Indonesia beserta kode Kemendagri-nya**: provinsi, kabupaten/kota, kecamatan (distrik) dan desa/kelurahan. Berjalan **offline** dari salinan daftar kode terbaru (Kepmendagri No. 300.2.2-2430 Tahun 2025, 91.599 wilayah) dan tahan salah ketik.

Contoh pertanyaan: *"Apa kode wilayah Kelurahan Kemayoran, Jakarta Pusat? Kode adm4 BMKG-nya apa?"*

- Cukup **Node.js 18+**, tanpa dependensi, tanpa API key, tanpa internet setelah paket terunduh, gratis.
- Setiap hasil memuat path lengkap, misalnya `Desa Sukamaju, Kec. Cilawu, Kab. Garut, Prov. Jawa Barat`.
- Kode boleh ditulis dengan atau tanpa titik (`31.71.03.1001` atau `3171031001`).

### Tool

| Tool | Fungsi |
|---|---|
| `cari_wilayah` | Cari berdasarkan nama (tahan salah ketik). Kata tambahan bisa berupa nama induk (`"sukamaju garut"`); awalan `kab`/`kota`/`kec`/`desa`/`kel` dipakai sebagai petunjuk; singkatan umum dikenali (`jogja`, `DKI`, `jatim`, `NTT`). Filter: `tingkat` (1–4), `jenis`, `kode_induk`, `batas` (maks 50). |
| `detail_kode` | Kode → nama, jenis, semua induk dari provinsi ke bawah, dan jumlah wilayah di bawahnya. |
| `daftar_anak` | Daftar wilayah satu tingkat di bawah kode, dengan halaman (`offset`, `batas` maks 200). Tanpa kode: 38 provinsi. |
| `validasi_kode` | Cek format (2/4/6/10 digit, kota = 71–79, kelurahan = 1xxx, desa = 2xxx, desa adat = 3xxx) dan apakah kode ada. Untuk kode yang tidak ada, disebutkan induk terdekat yang ada. Kode pulau (`xx.xx.4xxxx`) dikenali. |

### Pasangan dengan BMKG

API prakiraan cuaca publik BMKG memakai **kode desa/kelurahan Kemendagri bertitik** sebagai parameter `adm4`, misalnya `https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=31.71.03.1001`. Hasil tingkat 4 punya kolom `bmkg_adm4`. Pakai bersama [mcp-bmkg](https://github.com/EzkielynaGroup/mcp-bmkg): asisten mencari kode desa di sini, lalu mengambil prakiraan cuacanya di sana.

### Pasang

Tambahkan ke konfigurasi aplikasi (sama seperti contoh di atas):

```json
{
  "mcpServers": {
    "wilayah-indonesia": { "command": "npx", "args": ["-y", "mcp-wilayah-indonesia"] }
  }
}
```

Claude Code: `claude mcp add wilayah-indonesia -- npx -y mcp-wilayah-indonesia`. Di Windows, bila `npx` tidak jalan, pakai `"command": "cmd"` dan `"args": ["/c", "npx", "-y", "mcp-wilayah-indonesia"]`.

### Sumber data dan lisensi

Data diambil dari repositori [`cahyadsn/wilayah`](https://github.com/cahyadsn/wilayah) (lisensi **MIT**, Copyright (c) 2017-2025 Cahya DSN), file `db/wilayah.sql` commit `d68e8d5` (perubahan data terakhir 13 Feb 2026, diunduh 11 Nov 2026), yang menurut README-nya mengikuti **Kepmendagri No. 300.2.2-2430 Tahun 2025**. Jumlahnya cocok dengan tabel di README sumber: 38 provinsi, 416 kabupaten, 98 kota, 7.285 kecamatan, 8.496 kelurahan, 75.266 desa. Kami tidak mencocokkan setiap baris dengan PDF Kepmendagri. Untuk keperluan hukum atau administrasi, rujuk dokumen Kepmendagri yang diterbitkan Kemendagri.

### Tanya jawab

- **Bagaimana cara cari kode desa?** Tanyakan ke asisten, misalnya "kode wilayah Desa Sukamaju Cilawu Garut"; `cari_wilayah` memberi kode 10 digit dan path lengkap.
- **Apakah sama dengan kode pos?** Tidak. Kode wilayah Kemendagri berbeda dengan kode pos dan kode BPS.
- **Perlu internet atau API key?** Tidak. Data ikut dalam paket dan semuanya gratis.

Kode: MIT. Data: MIT (Cahya DSN). Dibuat oleh [Ezkielyna](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=mcp-wilayah-indonesia), gateway API AI independen untuk developer Indonesia (bayar pakai QRIS).

<!-- ezk:toolkit -->
---

### Part of the Ezkielyna developer toolkit

Open-source tools from [Ezkielyna](https://ezkielyna.store/?utm_source=github&utm_medium=readme&utm_campaign=mcp-wilayah-indonesia), an independent OpenAI- and Anthropic-compatible AI API gateway (pay with QRIS, USDT or Binance Pay; no credit card).

| No API key needed | With an Ezkielyna key |
|---|---|
| [mcp-bmkg](https://github.com/EzkielynaGroup/mcp-bmkg) · [mcp-wilayah-indonesia](https://github.com/EzkielynaGroup/mcp-wilayah-indonesia) · [mcp-hari-libur-indonesia](https://github.com/EzkielynaGroup/mcp-hari-libur-indonesia) · [mcp-rupiah](https://github.com/EzkielynaGroup/mcp-rupiah) · [mcp-qris](https://github.com/EzkielynaGroup/mcp-qris) · [ai-model-status-mcp](https://github.com/EzkielynaGroup/ai-model-status-mcp) | [ezkielyna-mcp](https://github.com/EzkielynaGroup/ezkielyna-mcp) · [ezkielyna-image-mcp](https://github.com/EzkielynaGroup/ezkielyna-image-mcp) · [ezkielyna-audio-mcp](https://github.com/EzkielynaGroup/ezkielyna-audio-mcp) · [n8n-nodes-ezkielyna](https://github.com/EzkielynaGroup/n8n-nodes-ezkielyna) |

More: [all repositories](https://github.com/EzkielynaGroup) · [awesome-mcp-indonesia](https://github.com/EzkielynaGroup/awesome-mcp-indonesia) · [awesome-ai-indonesia](https://github.com/EzkielynaGroup/awesome-ai-indonesia)
<!-- /ezk:toolkit -->
