#!/usr/bin/env node
// The build data that build.mjs reads from SDNAP_HAC_ROOT (default /opt/data/sdn-archive/hac): each file fetched from
// its publisher and verified against the SHA-256 that build.mjs pins. Every source here is redistributable public
// data; the repository carries none of the files.
//
//   node tools/fetch-build-data.mjs [--root DIR] [--verify-only]
//
// --verify-only checks the files already under the root and fetches nothing. A file that is present and verifies is
// kept; one that does not is refused (never overwritten).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const BUILD_DATA = Object.freeze([
  {
    file: "pds-grail-gravity/gggrx_0660pm_sha.tab",
    url: "https://pds-geosciences.wustl.edu/grail/grail-l-lgrs-5-rdr-v1/grail_1001/shadr/gggrx_0660pm_sha.tab",
    bytes: 26692624,
    sha256: "a77ee9996aff7341ef89f69aa401f39ba0c2949ed80411505fb4826b771dd63e",
    source: "GRGM660PRIM, the GRAIL lunar gravity field (Lemoine et al. 2013), NASA GSFC, PDS Geosciences Node",
    terms: "NASA PDS public data, no restrictions",
  },
  {
    file: "naif-kernels/pck/moon_pa_de440_200625.bpc",
    url: "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/moon_pa_de440_200625.bpc",
    bytes: 12863488,
    sha256: "60cd55aa401ea2ea97360636f567554bfe4e37bb829f901b4460a455dfaf783f",
    source: "the DE440 lunar principal-axis orientation, NASA JPL NAIF",
    terms: "NAIF public data; unmodified kernels may be redistributed",
  },
  {
    file: "naif-kernels/spk/planets/de440s.bsp",
    url: "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp",
    bytes: 32726016,
    sha256: "c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2",
    source: "the DE440 planetary ephemeris (short span), NASA JPL NAIF",
    terms: "NAIF public data; unmodified kernels may be redistributed",
  },
]);

/** The pins of build.mjs must be the ones listed here. */
function checkPins() {
  const build = fs.readFileSync(path.join(packageRoot, "build.mjs"), "utf8");
  for (const d of BUILD_DATA) {
    const pinned = new RegExp(`file:\\s*"${d.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",\\s*sha256:\\s*"([0-9a-f]{64})"`).exec(build);
    if (!pinned) throw new Error(`build.mjs pins no ${d.file}`);
    if (pinned[1] !== d.sha256) throw new Error(`build.mjs pins ${d.file} at ${pinned[1]}, this list at ${d.sha256}`);
  }
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

async function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--root");
  const root = at >= 0 ? argv[at + 1] : process.env.SDNAP_HAC_ROOT ?? "/opt/data/sdn-archive/hac";
  const verifyOnly = argv.includes("--verify-only");
  checkPins();
  let bad = 0;
  for (const d of BUILD_DATA) {
    const target = path.join(root, d.file);
    if (fs.existsSync(target)) {
      const got = sha256(target);
      if (got === d.sha256) { console.log(`ok       ${d.file}`); continue; }
      console.error(`REFUSED  ${d.file}: sha256 ${got}, expected ${d.sha256} (the file is left as it is)`);
      bad += 1;
      continue;
    }
    if (verifyOnly) { console.error(`MISSING  ${d.file}`); bad += 1; continue; }
    const response = await fetch(d.url);
    if (!response.ok) { console.error(`FAILED   ${d.file}: ${d.url} answered ${response.status}`); bad += 1; continue; }
    const bytes = Buffer.from(await response.arrayBuffer());
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== d.sha256) { console.error(`REFUSED  ${d.file}: ${d.url} gave sha256 ${got}, expected ${d.sha256}`); bad += 1; continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.part`, bytes);
    fs.renameSync(`${target}.part`, target);
    console.log(`fetched  ${d.file} (${bytes.length} bytes)`);
  }
  if (bad) {
    console.error(`${bad} of ${BUILD_DATA.length} build-data files missing or not the pinned ones under ${root}`);
    process.exit(1);
  }
  console.log(`build data: ${BUILD_DATA.length} of ${BUILD_DATA.length} verified under ${root}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
