// Invariant: NO INPUT FRAME IS EVER DESTROYED SILENTLY.
//
// graph task `modules-guest-nodes-drop-batched-frames`: the compiled flow
// runtime pops a node's queue port-blind (budget 64) while maxStreams is
// declarative only, so a guest that reads ordinal 0 of a single-stream port
// and returns destroys every other frame it was handed there. The
// single-stream ports of data-source/celestrak-reference refuse a surplus by
// name; parse_gp_groups' "response" port is multi-stream BY CONTRACT and is
// read in full, so it is exempt. Frames are the typed contracts' (TimerTick,
// HttpResponse carrying an $ICN job in CONTEXT).

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { encodeHttpResponse, encodeTimerTick } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const ICN_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/ICN/main.js"));
const flatbuffers = createRequire(ICN_LIB)("flatbuffers");
const { ICN } = await import(ICN_LIB.href);

const TYPE = {
  tick: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  response: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
};

// An $ICN job as the builders write it (only the fields the parsers read).
function job(connectorId, sourceName, url, datasetId) {
  const b = new flatbuffers.Builder(256);
  const [c, s, u, d] = [connectorId, sourceName, url, datasetId].map((v) => b.createString(v));
  ICN.startICN(b);
  ICN.addConnectorId(b, c);
  ICN.addSourceName(b, s);
  ICN.addEndpointUrl(b, u);
  ICN.addDatasetId(b, d);
  b.finishSizePrefixed(ICN.endICN(b), "$ICN");
  return b.asUint8Array().slice();
}
const SITES_JOB = job("celestrak-satcat-launch-sites", "celestrak-satcat-launch-sites", "https://celestrak.org/satcat/launchsites.php", "satcat-launch-sites");
const GROUP = (token, kind = "GROUP") =>
  job(`celestrak-gp-groups/${token}`, "celestrak-gp-groups", `https://celestrak.org/NORAD/elements/gp.php?${kind}=${token}&FORMAT=csv`, "gp-groups");

function frame(portId, which) {
  const payload = portId === "tick"
    ? encodeTimerTick({ triggerId: which })
    : encodeHttpResponse({ status: 304, context: SITES_JOB, url: which });
  return { portId, typeRef: TYPE[portId], payload };
}

// plugin.getConfig answered by the SDK harness's BrowserHost from `config` (one ModuleConfig, as the Go node answers it).
async function invoke(t, methodId, inputs, config = {}) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostOptions: { config },
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId, inputs });
}

const CASES = [
  ["gp_groups", "tick"],
  ["satcat_reference", "tick"],
  ["parse_satcat_reference", "response"],
];

for (const [methodId, port] of CASES) {
  test(`${methodId} refuses two frames on the single-stream "${port}" port`, async (t) => {
    const response = await invoke(t, methodId, [frame(port, "first"), frame(port, "second")]);
    assert.notEqual(response.statusCode, 0, "a batched invocation must not report success");
    assert.equal(response.errorCode, "batched-input-frames");
    assert.match(
      response.errorMessage,
      new RegExp(`2 frames on single-stream input port "${port}"`),
      response.errorMessage,
    );
    assert.equal(response.outputs.length, 0);
  });

  test(`${methodId} does not refuse one frame per port`, async (t) => {
    const response = await invoke(t, methodId, [frame(port, "only")]);
    assert.notEqual(response.errorCode, "batched-input-frames");
    assert.equal(response.statusCode, 0, response.errorMessage);
  });
}

test("parse_gp_groups accepts several frames on its multi-stream response port", async (t) => {
  const config = { celestrak_gp_groups: "stations,gpz" };
  const response = await invoke(t, "parse_gp_groups", [
    { portId: "response", typeRef: TYPE.response, payload: encodeHttpResponse({ status: 304, context: GROUP("stations") }) },
    { portId: "response", typeRef: TYPE.response, payload: encodeHttpResponse({ status: 304, context: GROUP("gpz", "SPECIAL") }) },
  ], config);
  assert.notEqual(response.errorCode, "batched-input-frames");
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.deepEqual(response.outputs.map((f) => f.portId), ["unchanged"]);
});

// SOURCE LOCK: no port-blind frame-0 reads (see celestrak-parser for why).
test("data-source/celestrak-reference source contains no port-blind plugin_get_input_frame(0)", () => {
  const source = fs.readFileSync(
    fileURLToPath(new URL("../src/celestrak_reference_module.cpp", import.meta.url)),
    "utf8",
  );
  const offenders = source
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return false;
      return code.includes("plugin_get_input_frame(0)");
    });
  assert.deepEqual(offenders, [], `port-blind frame-0 read(s): ${offenders.map(([n, l]) => `${n}: ${l.trim()}`).join(" | ")}`);
});
