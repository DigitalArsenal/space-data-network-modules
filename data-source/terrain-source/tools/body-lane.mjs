// A BODY'S TERRAIN LANE, RUN LOCALLY: terrain-ingest:body_plan plans a unit, each of its requests is answered from
// local copies of the PDS files exactly as the PDS server answers it (lola-frames.mjs localResponse), terrain-source:tile
// encodes it and terrain-source:pack packs it. Shared by the sample-budget and unit tools and the Moon and Mars checks,
// so all of them run the same frames the flow does. `config.body` picks the body (default moon).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { localResponse } from "../lola-frames.mjs";
import { decodeTileReport, DTT_LIB, flatbuffers, STANDARDS_ROOT, TYPE } from "../typed-frames.mjs";
import {
  createHarness as createIngestHarness,
  decodeHttpRequest,
  decodeIrm,
  irmRecord,
  jobIdOf,
  markFrames,
  outputs,
  tickFrame,
} from "../../terrain-ingest/tests/typed.mjs";

const PNM_LIB = await import(new URL(`file://${STANDARDS_ROOT}/lib/js/PNM/main.js`).href);

export const MOON_CONFIG = {
  tileset_id: "nasa-lola-moon",
  dataset_epoch: "2019-03-15T00:00:00.000Z",
  retrieved_at: "2026-10-16T00:00:00.000Z",
};

export const MARS_CONFIG = {
  body: "mars",
  tileset_id: "nasa-mola-mars",
  dataset_epoch: "2003-03-21T00:00:00.000Z",
  retrieved_at: "2026-10-19T00:00:00.000Z",
};

const BODY_DEFAULTS = { moon: { datasetId: "nasa-lola-gdr", provider: "nasa-lola" }, mars: { datasetId: "nasa-mola-megdr", provider: "nasa-mola" } };

const root = fileURLToPath(new URL("..", import.meta.url));

/** [u32 length][record] stream -> the size-prefixed records (zero prefixes are padding). */
export function splitSized(bytes) {
  const buf = Buffer.from(bytes);
  const out = [];
  for (let at = 0; at + 4 <= buf.length;) {
    const len = buf.readUInt32LE(at);
    at += 4;
    if (len) out.push(buf.subarray(at - 4, at + len));
    at += len;
  }
  return out;
}

/** A $DTT record (no size prefix) through the SDS library. */
export const dttOf = (record) => DTT_LIB.DTT.getRootAsDTT(new flatbuffers.ByteBuffer(Uint8Array.from(record)));

export async function createBodyLane({ dataDir, config = MOON_CONFIG, wasmPath = path.join(root, "dist/isomorphic/module.wasm") }) {
  const source = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(wasmPath),
    manifest: JSON.parse(fs.readFileSync(path.join(root, "plugin-manifest.json"), "utf8")),
    surface: "direct",
  });
  const ingest = await createIngestHarness(null, config);
  const defaults = BODY_DEFAULTS[config.body ?? "moon"];
  const jobId = jobIdOf(config.dataset_id ?? defaults.datasetId, config.tileset_id, config.dataset_epoch);

  async function planUnit(index) {
    const inputs = [tickFrame("2026-10-16T00:00:00Z")];
    if (index > 0) inputs.push(...markFrames([irmRecord({ jobId, next: index, provider: defaults.provider })]));
    const response = await ingest.invoke({ methodId: "body_plan", inputs });
    const out = outputs(response);
    if (!out.has("plan")) return null;
    return {
      index,
      job: decodeIrm(out.get("job")[0]),
      headers: splitSized(out.get("plan")[0]).map((sized) => {
        const t = dttOf(sized.subarray(4));
        return { sized, level: t.LEVEL(), x: t.X(), y: t.Y() };
      }),
      requests: Array.from({ length: 16 }, (_, k) => out.get(`dem_${k}`)?.[0]).filter(Boolean).map(decodeHttpRequest),
      options: out.get("options")[0],
      pack: out.get("pack")[0],
      backlog: response.backlogRemaining,
    };
  }

  /** tile over the unit's tiles that `keep` (default all): the response, its records by address, its report. */
  async function encode(unit, keep = () => true) {
    const plan = Buffer.concat(unit.headers.filter((h) => keep(`${h.level}/${h.x}/${h.y}`)).map((h) => h.sized));
    const inputs = [
      { portId: "plan", typeRef: TYPE.DTT, payload: Uint8Array.from(plan) },
      { portId: "options", typeRef: TYPE.MCFG, payload: unit.options },
      ...unit.requests.map((r) => localResponse(dataDir, r)),
    ];
    const started = performance.now();
    const response = await source.invoke({ methodId: "tile", inputs });
    const ms = performance.now() - started;
    if (response.statusCode !== 0) return { response, ms };
    const records = Buffer.from(response.outputs.find((o) => o.portId === "records").payload);
    const byKey = new Map(splitSized(records).map((sized) => {
      const t = dttOf(sized.subarray(4));
      return [`${t.LEVEL()}/${t.X()}/${t.Y()}`, sized];
    }));
    const report = decodeTileReport(response.outputs.find((o) => o.portId === "report").payload);
    return { response, ms, records, byKey, report };
  }

  /** pack over a records stream with the unit's pack options: [{name, bytes}]. */
  async function pack(unit, records) {
    const response = await source.invoke({
      methodId: "pack",
      inputs: [
        { portId: "records", typeRef: TYPE.DTT, payload: Uint8Array.from(records) },
        { portId: "options", typeRef: TYPE.MCFG, payload: unit.pack },
      ],
    });
    if (response.statusCode !== 0) throw new Error(`pack: ${response.errorCode}: ${response.errorMessage}`);
    const names = splitSized(response.outputs.find((o) => o.portId === "names").payload)
      .map((sized) => PNM_LIB.PNM.getSizePrefixedRootAsPNM(new flatbuffers.ByteBuffer(Uint8Array.from(sized))).FILE_NAME());
    const files = response.outputs.filter((o) => o.portId === "file");
    if (names.length !== files.length) throw new Error("pack named a different number of files than it wrote");
    return files.map((o, k) => ({ name: names[k], bytes: Buffer.from(o.payload) }));
  }

  /** The unit holding a tile, searched among units [from, to). */
  async function unitFor(level, x, y, from = 0, to = 199) {
    for (let i = from; i < to; i++) {
      const u = await planUnit(i);
      if (!u) return null;
      if (u.headers.some((h) => h.level === level && h.x === x && h.y === y)) return u;
    }
    return null;
  }

  return { source, ingest, planUnit, encode, pack, unitFor, destroy: () => { source.destroy(); ingest.destroy(); } };
}
