// Drives the REAL wasm module against the REAL provider services, performing the
// host's http connector step here so the fetch is genuine rather than fixtured.
// Not a unit test: this is the "verify the endpoint against the live service
// before compiling it in" step the endpoints task demands. Run by hand:
//   SPACE_DATA_STANDARDS_ROOT=... node tests/live-probe.mjs
//
// Every frame is the typed one the flow carries: the module's HttpRequests are
// fetched as they stand (method, url, headers, raw body), and each answer goes
// back to parse as the HttpResponse hostcap/http-request would emit — its
// CONTEXT echoed, the body verbatim — never with a field the connector does not
// write (synthesising one is how a green harness once certified a dead pipeline).
import { Buffer } from "node:buffer";

import fs from "node:fs";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import {
  MANIFEST_PATH,
  TYPE,
  WASM_PATH,
  buildApr,
  decodeApr,
  deconflict,
  drainParse,
  failedFetch,
  reportsOf,
  responseFor,
  routeFor,
} from "./helpers.mjs";

const harness = await createBrowserModuleHarness({
  wasmSource: fs.readFileSync(WASM_PATH),
  manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
  surface: "direct",
});

const PROVIDERS = process.env.E2E_PROVIDERS
  ? process.env.E2E_PROVIDERS.split(",")
  : ["openstreetmap-overpass", "fcc-uls-3650"];

// Fetch ONCE, then replay the same reports through every merge method, so a
// difference between methods is a difference in deconfliction and not in what
// the providers happened to serve that second.
const { descriptors, contract } = await routeFor(harness, { PROVIDERS, METHOD: "CENTROID", LIMIT: 400 });
console.log("requests:", descriptors.length, "| consulted:", contract?.headers["x-sdn-providers-consulted"]);

const responses = [];
for (const d of descriptors) {
  try {
    const res = await fetch(d.url, {
      method: d.method,
      headers: d.headers,
      body: d.body.length ? Buffer.from(d.body) : undefined,
      signal: AbortSignal.timeout(45000),
    });
    const body = new Uint8Array(await res.arrayBuffer());
    console.log(`  fetch ${d.provider_id} @ ${new URL(d.url).host} -> ${res.status} ${body.length}B`);
    responses.push(responseFor(d, { status: res.status, body, retrievedMs: Date.now() }));
  } catch (e) {
    console.log(`  fetch ${d.provider_id} @ ${new URL(d.url).host} -> FAILED ${String(e.message).slice(0, 60)}`);
    // A failed fetch still answers, STATUS 0 with its CONTEXT echoed.
    responses.push(failedFetch(d));
  }
}

const parsed = await drainParse(harness, responses);
const reports = reportsOf(parsed.get("reports").payload);
const perProvider = {};
for (const r of reports) perProvider[r.provider_id] = (perProvider[r.provider_id] || 0) + 1;
console.log("REPORTS decoded:", reports.length, JSON.stringify(perProvider));
for (const id of PROVIDERS) {
  const s = reports.find((r) => r.provider_id === id);
  if (s) console.log(`  sample ${id}:`, JSON.stringify(s).slice(0, 170));
}

// The merge method is the contract's METHOD parameter, by name.
const job = parsed.get("job").payload;
for (const METHOD of ["SINGLE_SOURCE", "HIGHEST_SAMPLE_COUNT", "MOST_RECENT", "AUTHORITY_PRECEDENCE", "CENTROID"]) {
  const a = decodeApr(job);
  const rebuilt = buildApr({
    ROUTE: a.ROUTE,
    SCHEMA_NAME: "TBS.fbs",
    params: { ...a.params, METHOD },
    headers: a.headers,
  });
  const merged = await deconflict(harness, new Map([["job", { payload: rebuilt, typeRef: TYPE.APR }], ["reports", parsed.get("reports")]]));
  const s = merged.summary;
  console.log(`${METHOD.padEnd(22)} -> sites=${String(merged.records.length).padEnd(4)} collapsed=${String(s.collapsed).padEnd(4)} multiProvider=${String(s.multiProviderSites).padEnd(4)} truncated=${s.truncated}`);
}
await harness.destroy();
