import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { Builder } from "flatbuffers";

import { sourceOems, statusNode } from "./lib/nodes.mjs";
import { TYPE, decodeOem } from "./lib/sds.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const uiPath = path.join(packageRoot, "app/ui/index.html");
const uiSource = fs.readFileSync(uiPath, "utf8");
const scriptSource = uiSource.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
const providerKeys = ["starlink", "glonass", "intelsat", "cpf", "iss"];
const expectedStatusNodes = [
  "provider-starlink",
  "provider-glonass",
  "provider-intelsat",
  "provider-cpf",
  "provider-iss",
  "store",
];

assert.ok(scriptSource, "Supplemental OMM UI needs one executable inline script");

function makeDss({
  status = 1,
  syncedRows = 11n,
  totalRows = 20n,
  downloadedBytes = 4096n,
  lastSyncedAt = "2026-07-21T18:30:00Z",
  error = "",
} = {}) {
  const builder = new Builder(256);
  const lastSyncedAtOffset = builder.createString(lastSyncedAt);
  const errorOffset = error ? builder.createString(error) : 0;
  builder.startObject(34);
  builder.addFieldInt8(0, status, 0);
  builder.addFieldInt64(1, syncedRows, 0n);
  builder.addFieldInt64(2, totalRows, 0n);
  builder.addFieldInt64(8, downloadedBytes, 0n);
  builder.addFieldOffset(32, lastSyncedAtOffset, 0);
  if (errorOffset) builder.addFieldOffset(33, errorOffset, 0);
  const root = builder.endObject();
  builder.finish(root, "$DSS");
  return builder.asUint8Array();
}

function makeDom() {
  const elements = new Map();
  const element = (id, textContent = "") => {
    const value = {
      id,
      textContent,
      className: "",
      title: "",
      addEventListener() {},
    };
    elements.set(`#${id}`, value);
    return value;
  };
  element("updated", "waiting for node data");
  element("refresh");
  element("active-count", "—");
  element("record-count", "—");
  element("notice");

  const rows = providerKeys.map((provider) => {
    const state = { textContent: "waiting", className: "state", title: "" };
    const cells = [
      {},
      { querySelector: (selector) => (selector === ".state" ? state : null) },
      { textContent: "—" },
      { textContent: "—" },
      { textContent: "—" },
    ];
    return {
      dataset: { provider },
      state,
      cells,
      querySelector: (selector) => (selector === ".state" ? state : null),
      querySelectorAll: (selector) => (selector === "td" ? cells : []),
    };
  });

  return {
    elements,
    rows,
    document: {
      querySelector: (selector) => elements.get(selector) ?? null,
      querySelectorAll: (selector) =>
        selector === "tbody tr[data-provider]" ? rows : [],
    },
  };
}

function response(status, bytes = new Uint8Array()) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
  };
}

async function executeUi(runtimePayload) {
  const dom = makeDom();
  const requests = [];
  const intervals = [];
  const storePayload = makeDss({ syncedRows: 75n, totalRows: 75n });
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.includes("/storage/records/")) return response(404);
    if (url.endsWith("/runtime/nodes/store.dss")) {
      return response(200, storePayload);
    }
    return response(200, runtimePayload);
  };

  vm.runInNewContext(scriptSource, {
    ArrayBuffer,
    DataView,
    Date,
    Intl,
    Map,
    Promise,
    TextDecoder,
    Uint8Array,
    document: dom.document,
    encodeURIComponent,
    fetch,
    setInterval: (callback, interval) => {
      intervals.push({ callback, interval });
      return intervals.length;
    },
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (dom.elements.get("#updated").textContent !== "waiting for node data") {
      return { ...dom, requests, intervals };
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Supplemental OMM UI refresh did not settle");
}

test("the UI accepts only signed-node runtime routes, never host storage queries", () => {
  assert.doesNotMatch(uiSource, /\/storage\/records\//);
  assert.doesNotMatch(uiSource, /\bparseOBD\b|\$OBD/);
  assert.doesNotMatch(uiSource, /\bWRMS\b|mean fit RMS/i);
  assert.deepEqual(
    [...uiSource.matchAll(/<tr\s+data-provider=["']([^"']+)["']/g)].map(
      (match) => match[1],
    ),
    providerKeys,
  );
  assert.doesNotMatch(uiSource, /data-provider=["']od["']|Orbit determination/i);
});

test("the UI parses each route's canonical $DSS, the status node's own snapshot", async (t) => {
  // The status node's snapshot of a provider lane after one $OEM (data-source/spacex-starlink-source's, from its fixture).
  const oems = await sourceOems(t);
  const node = await statusNode(t);
  const snapshot = await node.invoke({ methodId: "record_event", inputs: [{ portId: "provider-starlink", typeRef: TYPE.OEM, payload: oems.starlink[0] }] });
  assert.equal(snapshot.statusCode, 0, snapshot.errorMessage);
  const route = new Uint8Array(snapshot.outputs.find((frame) => frame.portId === "provider-starlink.dss").payload);
  assert.equal(new TextDecoder().decode(route.subarray(4, 8)), "$DSS");

  const result = await executeUi(route);
  assert.equal(result.requests.length, 6);
  assert.deepEqual(
    result.requests.map(({ url }) => url.match(/\/runtime\/nodes\/([^/]+)\.dss$/)?.[1]),
    expectedStatusNodes,
  );
  assert.ok(result.requests.every(({ options }) => options.headers.Accept === "application/x-flatbuffers"));
  const states = decodeOem(oems.starlink[0]).EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA.length / 6;
  assert.equal(result.rows[0].state.textContent, "syncing");
  assert.equal(result.rows[0].cells[2].textContent, String(states));
  assert.equal(result.rows[0].cells[3].textContent, String(states));
  assert.equal(result.rows[0].cells[4].textContent, new Intl.NumberFormat().format(oems.starlink[0].byteLength));
  assert.equal(result.elements.get("#record-count").textContent, "75");
  assert.equal(result.intervals.length, 1);
  assert.equal(result.intervals[0].interval, 5_000);
});

test("the UI refuses a route that is not one canonical $DSS", async () => {
  const builder = new Builder(64);
  builder.startObject(1);
  builder.finish(builder.endObject(), "$FSB");
  for (const payload of [builder.asUint8Array(), (() => { const b = new Builder(64); b.startObject(1); b.finishSizePrefixed(b.endObject(), "$DSS"); return b.asUint8Array(); })()]) {
    const result = await executeUi(payload);
    assert.equal(result.rows[0].state.textContent, "unavailable");
    assert.match(result.rows[0].state.title, /expected a canonical \$DSS/);
  }
});

test("the five-provider UI keeps polling without requesting an OD status row", async () => {
  const result = await executeUi(makeDss());
  assert.equal(result.intervals.length, 1);
  assert.equal(result.intervals[0].interval, 5_000);
  await result.intervals[0].callback();
  assert.equal(result.requests.length, 12);
  assert.deepEqual(
    result.requests.map(({ url }) => url.match(/\/runtime\/nodes\/([^/]+)\.dss$/)?.[1]),
    [...expectedStatusNodes, ...expectedStatusNodes],
  );
  assert.ok(result.requests.every(({ url }) => !url.endsWith("/runtime/nodes/od.dss")));
});
