// The module's three units for ANY body of its source table, driven through the SDK harness (tiles_plan, tiles_direct,
// tiles_reduce). The same frames tools/encode.mjs puts on the wire for Mars; the unit names the body by its NAIF id.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { decodeHttpRequest, encodeHttpResponse, encodeModuleConfig } from "space-data-module-sdk/runtime-contracts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const requireSds = createRequire(import.meta.url);
const SDS = path.dirname(requireSds.resolve("spacedatastandards.org/package.json"));
const sdsLib = (code) => pathToFileURL(path.join(SDS, "lib", "js", code, "main.js")).href;
export const flatbuffers = createRequire(sdsLib("PNM"))("flatbuffers");
const { PNM } = await import(sdsLib("PNM"));
export const { DTT, dttTilingScheme } = await import(sdsLib("DTT"));

const T = {
  MCFG: { schemaName: "ModuleConfig.fbs", fileIdentifier: "MCFG", rootTypeName: "ModuleConfig", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
  DTT: { schemaName: "DTT.fbs", fileIdentifier: "$DTT", rootTypeName: "DTT", wireFormat: "flatbuffer" },
};
function outputs(response, method) {
  if (response.statusCode !== 0) throw new Error(`${method}: ${response.errorCode}: ${response.errorMessage}`);
  const map = new Map();
  for (const o of response.outputs) map.set(o.portId, [...(map.get(o.portId) ?? []), new Uint8Array(o.payload)]);
  return map;
}
function names(bytes) {
  const buf = Buffer.from(bytes), out = [];
  for (let at = 0; at + 4 <= buf.length;) {
    const n = buf.readUInt32LE(at);
    at += 4;
    out.push(String(PNM.getRootAsPNM(new flatbuffers.ByteBuffer(Uint8Array.from(buf.subarray(at, at + n)))).FILE_NAME()));
    at += n;
  }
  return out;
}
/** The size-prefixed $DTT records of a file, unpacked. */
export function readFile(bytes) {
  const buf = Buffer.from(bytes), out = [];
  for (let at = 0; at + 4 <= buf.length;) {
    const n = buf.readUInt32LE(at);
    at += 4;
    if (!n) continue;
    out.push(DTT.getRootAsDTT(new flatbuffers.ByteBuffer(Uint8Array.from(buf.subarray(at, at + n)))));
    at += n;
  }
  return out;
}
const unitFrame = (payload) => ({ portId: "unit", typeRef: T.MCFG, payload });
const files = (out, method) => {
  const list = out.get("file") ?? [], listed = names(out.get("names")[0]);
  if (list.length !== listed.length) throw new Error(`${method}: ${list.length} files, ${listed.length} names`);
  return listed.map((name, k) => ({ name, bytes: list[k] }));
};

/** One instance of the module; units run one at a time. `modules` is the data-source/body-imagery-tiles directory. */
export async function openRunner({ modules = path.resolve(HERE, "../.."), quality = 88, retrievedAt = "2026-10-22T00:00:00.000Z" } = {}) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(modules, "dist/isomorphic/module.wasm")),
    manifest: JSON.parse(fs.readFileSync(path.join(modules, "plugin-manifest.json"), "utf8")),
    surface: "direct",
    hostOptions: { config: { jpeg_quality: quality, retrieved_at: retrievedAt } },
  });
  return {
    /** The request (url, headers) and unit of the deepest level's tile row `row` (from the south) of body `naif`. */
    async plan(naif, level, row) {
      const out = outputs(await harness.invoke({ methodId: "tiles_plan", inputs: [unitFrame(encodeModuleConfig({ naif, level, row }))] }), "tiles_plan");
      const requests = [0, 1, 2].filter((b) => out.get(`rows_${b}`)).map((b) => decodeHttpRequest(out.get(`rows_${b}`)[0]));
      return { requests, unit: out.get("unit")[0] };
    },
    /** `answers`: one { url, status, body } per requested band, in order. */
    async direct(unit, answers) {
      const rows = answers.map((a, b) => ({ portId: `rows_${b}`, typeRef: T.HRSP, payload: encodeHttpResponse(a) }));
      return files(outputs(await harness.invoke({ methodId: "tiles_direct", inputs: [unitFrame(unit), ...rows] }), "tiles_direct"), "tiles_direct");
    },
    /** `children`: the child level's files of the rows wanted, as Uint8Arrays. */
    async reduce(naif, level, row, children) {
      const inputs = [unitFrame(encodeModuleConfig({ naif, level, row })), ...children.map((payload) => ({ portId: "child", typeRef: T.DTT, payload }))];
      return files(outputs(await harness.invoke({ methodId: "tiles_reduce", inputs }), "tiles_reduce"), "tiles_reduce");
    },
    destroy: () => harness.destroy?.(),
  };
}

/** Rows of the source: one ranged GET pinned to the edition (retried), or, for a derived source, the same range of the local file. */
export async function fetchRows(request, { localFile, tries = 6 } = {}) {
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (localFile) {
    const [a, b] = headers.range.replace("bytes=", "").split("-").map(Number);
    const fd = fs.openSync(localFile, "r"), body = new Uint8Array(b - a + 1);
    fs.readSync(fd, body, 0, body.length, a);
    fs.closeSync(fd);
    return { status: 206, body };
  }
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(request.url, { headers });
      const body = new Uint8Array(await res.arrayBuffer());
      if (res.status === 412 || res.status === 404) throw Object.assign(new Error(`the source answered ${res.status}: another edition or gone`), { fatal: true });
      if (res.status === 206) return { status: 206, body };
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (e.fatal) throw e;
      last = e;
    }
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  throw last;
}
