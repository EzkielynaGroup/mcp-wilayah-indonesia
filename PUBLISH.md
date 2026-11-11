# Publish notes (owner)

Built locally on 11 Nov 2026. Nothing is pushed or published.

- **GitHub description (≤ 120):** `MCP server for Indonesian regions: provinsi to desa/kelurahan with Kemendagri codes. Offline, typo tolerant, BMKG adm4.`
- **Topics:** `mcp`, `mcp-server`, `model-context-protocol`, `indonesia`, `kode-wilayah`, `wilayah-indonesia`, `kemendagri`, `desa`, `kelurahan`, `kecamatan`, `bmkg`, `claude-desktop`, `cursor`, `nodejs`
- **Homepage:** `https://www.npmjs.com/package/mcp-wilayah-indonesia` (after npm publish)

## Owner actions, in order

1. Run the org leak check (`gh_public_check.sh .`); it must print CLEAN.
2. `gh repo create EzkielynaGroup/mcp-wilayah-indonesia --public --source . --remote origin --description "<above>"` then `git push -u origin main`, then add the topics with `gh repo edit --add-topic ...`.
3. `npm publish` (package is 675 KB packed: the server file plus `data/wilayah.json.gz` and its MIT notice). Check first with `npm pack --dry-run`.
4. MCP registry: `mcp-publisher publish` with `server.json` (name `io.github.EzkielynaGroup/mcp-wilayah-indonesia`).
5. The README links to `EzkielynaGroup/mcp-bmkg`; publish that repo too, or remove the two links.

## Data upkeep

Data = `cahyadsn/wilayah` (MIT) commit `d68e8d5`, Kepmendagri 300.2.2-2430/2025. When Kemendagri issues a new decree and upstream
updates, rebuild with `scripts/build-data.mjs` (see README), update the totals in README + the bundled-data test, bump the version.
