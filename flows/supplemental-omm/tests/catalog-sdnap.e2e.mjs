#!/usr/bin/env node
// E2E (task modules-catalog-sdnap-publish-flow-20261025): the whole-catalog SDN-AP flow (catalog-sdnap/) in the
// isomorphic flow host. The host answers the retrieval module's store read (storage.flatsql_epoch_stream) with a
// catalog of SGP4 element sets; the flow propagates each set (propagator/sdn-ap propagate), fits an SDN-AP set to
// it (fit), files the fit's $OMM and $OBD and publishes both batches.
//   - the request is a $QRP Request for the $OMM catalog of source celestrak-gp, nearest to now, asked inline;
//   - propagate and fit each take one record and one $PCF an invocation, so a set either refuses costs only its
//     own object;
//   - every stored element set is MEAN_ELEMENT_THEORY SDNAP with COVARIANCE (21 values) and the object's NORAD number;
//   - each batch is filed under supplemental-omm / sdn-ap and published.
//   node tests/catalog-sdnap.e2e.mjs [--out <file>]   --out writes the stored SDN-AP $OMM stream
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { PUBLISH_URL, packageRoot, runRelease, sha256, splitRecords } from "./lib/flow.mjs";
import { decodeIngestResult, decodeOmmRecord } from "./lib/sds.mjs";

const argv = process.argv.slice(2);
const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };

// The catalog: the SGP4 sets the OD node's release records hold (ISS, LAGEOS-1 and the Starlink fixtures).
const records = splitRecords(fs.readFileSync(path.join(packageRoot, "nodes/od/release-records/sources-omm-records.bin")))
  .filter((r) => decodeOmmRecord(r).MEAN_ELEMENT_THEORY === 0);
const catalog = new Map();
for (const r of records) catalog.set(decodeOmmRecord(r).NORAD_CAT_ID, r);
const stream = Buffer.concat([...catalog.values()]);

const hostcalls = [];
const trace = [];
const run = await runRelease({
  flowDir: "catalog-sdnap",
  triggerId: "timer-catalog-sdnap",
  trace,
  config: { "org.sdn.flows.supplemental-omm.sdnap": { omm_publish_url: PUBLISH_URL } },
  hostcall(operation, params) {
    hostcalls.push({ operation, params });
    if (operation === "clock.now") return Date.UTC(2026, 6, 21, 12);
    if (operation === "storage.flatsql_epoch_stream") return { rows: catalog.size, columns: 1, stream: new Uint8Array(stream) };
    throw new Error(`unexpected hostcall ${operation}`);
  },
});
const of = (id) => trace.filter((t) => t.nodeId === id);
const reads = hostcalls.filter((c) => c.operation === "storage.flatsql_epoch_stream");
check(reads.length === 1, `one read of the store (${reads.length}) for ${catalog.size} catalog sets`);
check(of("propagate").length === catalog.size && of("propagate").every((t) => t.inputs.filter((p) => p === "omm").length === 1 && t.inputs.filter((p) => p === "configuration").length === 1),
  "propagate takes one set and one $PCF an invocation");
const fits = of("fit");
const taken = fits.filter((t) => !t.errors);
check(fits.every((t) => t.inputs.filter((p) => p === "ephemeris").length === 1 && t.inputs.filter((p) => p === "configuration").length === 1), `fit takes one ephemeris and one $PCF an invocation (${fits.length})`);
check(taken.length >= 1, `the fit takes ${taken.length}; the rest are refused by name (${[...new Set(fits.filter((t) => t.errors).map((t) => t.errors))].join(", ") || "none"}) and cost only their own object`);

const ingests = run.ingests;
const omm = ingests.filter((i) => i.schema === "OMM.fbs"), obd = ingests.filter((i) => i.schema === "OBD.fbs");
check(omm.length === taken.length && obd.length === taken.length && ingests.length === omm.length + obd.length, `one OMM and one OBD batch for each fitted set (${omm.length}, ${obd.length})`);
check(ingests.every((i) => i.provider_id === "supplemental-omm" && i.source_name === "sdn-ap" && i.content_key_id === "public" && i.batch_id === sha256(Buffer.concat(i.records))), "each batch: supplemental-omm / sdn-ap, public, BATCH_ID the SHA-256 of its stream");
const sets = omm.flatMap((i) => i.records.map(decodeOmmRecord));
check(sets.length > 0 && sets.every((o) => o.MEAN_ELEMENT_THEORY === 4), "every stored element set is MEAN_ELEMENT_THEORY SDNAP");
check(sets.every((o) => o.COVARIANCE.length === 21 && o.COVARIANCE.every(Number.isFinite) && o.COVARIANCE[0] > 0), "every one carries COVARIANCE (21 values, finite, positive variance)");
check(sets.every((o) => catalog.has(o.NORAD_CAT_ID)), `of catalog objects: ${sets.map((o) => `${o.OBJECT_NAME} (${o.NORAD_CAT_ID})`).join(", ")}`);
const posts = run.calls.filter((c) => c.operation === "http.request" && c.params.url === PUBLISH_URL).map((c) => decodeIngestResult(c.params.body));
check(ingests.every((i) => posts.some((r) => r.batchId === i.batch_id && r.sourceName === "sdn-ap")), `each batch is published (${posts.length} POSTs)`);
check(run.egress.results.length === ingests.length, "the stores' results reach the egress");

if (out) fs.writeFileSync(out, Buffer.concat(omm.flatMap((i) => i.records)));
console.log(failures.length ? `CATALOG-SDNAP-FLOW-E2E FAIL (${failures.length})` : `CATALOG-SDNAP-FLOW-E2E PASS (${sets.length} SDN-AP set(s) with COVARIANCE)`);
process.exit(failures.length ? 1 : 0);
