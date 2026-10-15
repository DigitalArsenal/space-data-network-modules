// Shared helpers for the cislunar tests: the SDS $TBP bindings (spacedatastandards.org lib/ts/TBP, bundled in memory
// by the standards repo's own esbuild with its flatbuffers runtime), request builders and an invoke wrapper.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

export const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../../spacedatastandards.org/", import.meta.url));
export const MANIFEST_PATH = new URL("../../plugin-manifest.json", import.meta.url);
export const WASM_PATH = new URL("../../dist/isomorphic/module.wasm", import.meta.url);
export const TBP_TYPE = { schemaName: "TBP.fbs", fileIdentifier: "$TBP", rootTypeName: "TBP", wireFormat: "flatbuffer" };

// The dev bindings' lib/ts/TBP/main.ts does not re-export every type yet, so every file of the directory is
// re-exported (each file exports only its own names).
const esbuild = createRequire(path.join(STANDARDS_ROOT, "package.json"))("esbuild");
const tbpFiles = fs.readdirSync(path.join(STANDARDS_ROOT, "lib", "ts", "TBP")).filter((f) => f.endsWith(".ts") && f !== "main.ts");
const bundle = await esbuild.build({
  stdin: {
    contents: `${tbpFiles.map((f) => `export * from "./lib/ts/TBP/${f}";`).join("\n")}\nexport * as flatbuffers from "flatbuffers";`,
    resolveDir: STANDARDS_ROOT,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
export const sds = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

export const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
export const readWasm = () => fs.readFileSync(fileURLToPath(WASM_PATH));

const make = (Cls, fields) => Object.assign(new Cls(), fields);
export const system = (fields) => make(sds.tbpSystemT, fields);
export const state = ([X, Y, Z, VX, VY, VZ]) => make(sds.tbpStateT, { X, Y, Z, VX, VY, VZ });
export const orbit = (fields) => make(sds.tbpPeriodicOrbitT, fields);
export const t = {
  propagation: (fields) => make(sds.tbpPropagationRequestT, fields),
  transfer: (fields) => make(sds.tbpTransferT, fields),
  stationKeeping: (fields) => make(sds.tbpStationKeepingT, fields),
  frameConversion: (fields) => make(sds.tbpFrameConversionT, fields),
};

export function encodeTBP(fields) {
  const builder = new sds.flatbuffers.Builder(1024);
  builder.finish(make(sds.TBPT, fields).pack(builder), "$TBP");
  return builder.asUint8Array().slice();
}
export const requestFrame = (fields) => ({ portId: "request", typeRef: TBP_TYPE, payload: encodeTBP(fields) });

export function decodeTBP(payload) {
  const bb = new sds.flatbuffers.ByteBuffer(payload);
  if (!sds.TBP.bufferHasIdentifier(bb)) throw new Error("the frame is not a $TBP");
  return sds.TBP.getRootAsTBP(bb).unpack();
}

export async function openHarness(testContext, surface = "direct") {
  const harness = await createBrowserModuleHarness({ wasmSource: readWasm(), manifest: readManifest(), surface });
  testContext.after(() => harness.destroy());
  return harness;
}

// One request in, the decoded $TBP answer out (asserting the frame shape).
export async function solve(harness, fields) {
  const result = await harness.invoke({ methodId: "invoke", inputs: [requestFrame(fields)] });
  if (result.statusCode !== 0) throw new Error(`invoke failed ${result.statusCode}: ${result.errorCode} ${result.errorMessage}`);
  if (result.outputs.length !== 1 || result.outputs[0].portId !== "response") throw new Error("expected one response frame");
  return decodeTBP(result.outputs[0].payload);
}
