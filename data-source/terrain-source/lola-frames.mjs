// THE MOON LANE'S FRAMES, as terrain-ingest hands them to `tile`: a body plan ($DTT headers on
// GEOGRAPHIC_TWO_ROOT_BODY, CENTER_NAME MOON, REFERENCE_RADII_M [1737400]) and a LOLA product read as the ingest reads
// it - the PDS3 label on "dem" frame 0, whole-line byte ranges (Content-Range) on frames 1..3. Shared by the tests and
// tools/moon-sample-budget.mjs; the products are read from local copies of the PDS files (LOLA_DIR).

import fs from "node:fs";
import path from "node:path";

import { granuleFrame, planInputs } from "./typed-frames.mjs";

export const MOON_RADIUS_M = 1737400;
export const PDS_BASE = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/";

// The products the lane reads, by level (PDS4 LIDVIDs from lrolol_1xxx/data/collection_data_gridded_inventory.csv).
export const LOLA_PRODUCTS = {
  ldem_4: { lidvid: "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_4_float::1.0", path: "cylindrical/float_img/ldem_4_float", created: "2017-09-15" },
  ldem_16: { lidvid: "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_16_float::1.0", path: "cylindrical/float_img/ldem_16_float", created: "2019-03-15" },
  ldem_64: { lidvid: "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_64_float::1.0", path: "cylindrical/float_img/ldem_64_float", created: "2019-03-15" },
  ldem_75s_240m: { lidvid: "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75s_240m_float::1.0", path: "polar/float_img/ldem_75s_240m_float", created: "2017-06-15" },
  ldem_75n_240m: { lidvid: "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75n_240m_float::1.0", path: "polar/float_img/ldem_75n_240m_float", created: "2016-09-15" },
  ldem_75s_120m: { lidvid: "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75s_120m_float::1.0", path: "polar/float_img/ldem_75s_120m_float", created: "2017-06-15" },
  ldem_75n_120m: { lidvid: "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75n_120m_float::1.0", path: "polar/float_img/ldem_75n_120m_float", created: "2016-09-15" },
  ldem_75s_60m: { lidvid: "urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_75s_60m_float::1.0", path: "polar/float_img/ldem_75s_60m_float", created: "2017-06-15" },
};

export function moonPlan(tiles, { maxLevel = 10, product = "ldem_64", retrievedAt = "2026-10-16T00:00:00.000Z", options = {} } = {}) {
  const p = LOLA_PRODUCTS[product];
  return {
    tilesetId: "nasa-lola-moon",
    scheme: "GEOGRAPHIC_TWO_ROOT_BODY",
    centerName: "MOON",
    referenceRadiiM: [MOON_RADIUS_M],
    verticalDatum: "REFERENCE_SPHERE",
    verticalDatumName: "LOLA reference sphere 1737.4 km",
    horizontalDatumName: "MOON_ME (DE421 mean Earth/polar axis)",
    sourceClass: "SPACEBORNE_ALTIMETRIC",
    gridSize: 65,
    maxGridSize: 321,
    levelZeroErrorM: 1920,
    errorMetric: "rms",
    maxLevel,
    tiles,
    provenance: {
      datasetId: "nasa-lola-gdr",
      datasetName: "LRO LOLA gridded data records",
      datasetEpoch: `${p.created}T00:00:00.000Z`,
      retrievedAt,
      license: "Public domain (NASA)",
      attribution: "LOLA: NASA/GSFC (Smith et al.)",
      sourceUrl: `${PDS_BASE}${p.path}.img`,
      nativeId: p.lidvid,
    },
    ...options,
  };
}

export function readLabel(dir, product) {
  return fs.readFileSync(path.join(dir, `${path.basename(LOLA_PRODUCTS[product].path)}.lbl`), "utf8");
}

export function labelGeometry(label) {
  const num = (key) => Number(label.match(new RegExp(`^\\s*${key}\\s*=\\s*([-0-9.]+)`, "m"))[1]);
  return { lines: num("LINES"), recordBytes: num("RECORD_BYTES"), samples: num("LINE_SAMPLES") };
}

/** "dem" frames for a product: the label, then whole-line ranges [first, first+count) split into at most `parts` frames. */
export function lolaFrames(dir, product, first, count, parts = 1) {
  const label = readLabel(dir, product);
  const { lines, recordBytes } = labelGeometry(label);
  const file = path.join(dir, `${path.basename(LOLA_PRODUCTS[product].path)}.img`);
  const url = `${PDS_BASE}${LOLA_PRODUCTS[product].path}`;
  const frames = [granuleFrame("dem", Buffer.from(label, "utf8"), 200, { url: `${url}.lbl` })];
  const fd = fs.openSync(file, "r");
  try {
    const per = Math.ceil(count / parts);
    for (let at = first; at < first + count; at += per) {
      const n = Math.min(per, first + count - at);
      const body = Buffer.alloc(n * recordBytes);
      fs.readSync(fd, body, 0, body.length, at * recordBytes);
      const start = at * recordBytes;
      frames.push(granuleFrame("dem", body, 206, {
        url: `${url}.img`,
        headers: { "content-range": `bytes ${start}-${start + body.length - 1}/${lines * recordBytes}` },
      }));
    }
  } finally {
    fs.closeSync(fd);
  }
  return frames;
}

/**
 * The answer hostcap/http-request would give one of lola_plan's requests, served from local copies of the PDS files
 * (LOLA_DIR): the .lbl whole (200), an .img byte range as a 206 with its Content-Range. `request` is the decoded
 * HttpRequest ({url, headers}). The If-Match ETag is checked against the configured product's, as the server would.
 */
export function localResponse(dir, request, portId = "dem") {
  const name = request.url.split("/").at(-1);
  const file = path.join(dir, name);
  if (name.endsWith(".lbl")) return granuleFrame(portId, fs.readFileSync(file), 200, { url: request.url });
  const range = (request.headers?.range ?? "").match(/^bytes=(\d+)-(\d+)$/);
  if (!range) throw new Error(`no whole-line range on ${request.url}`);
  const [a, b] = [Number(range[1]), Number(range[2])];
  const total = fs.statSync(file).size;
  const body = Buffer.alloc(b - a + 1);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, body, 0, body.length, a); } finally { fs.closeSync(fd); }
  return granuleFrame(portId, body, 206, { url: request.url, headers: { "content-range": `bytes ${a}-${b}/${total}` } });
}

export { planInputs };
