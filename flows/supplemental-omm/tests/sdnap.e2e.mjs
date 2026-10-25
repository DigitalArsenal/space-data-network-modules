#!/usr/bin/env node
// E2E (task modules-catalog-sdnap-publish-flow-20261025): the release in the isomorphic flow host publishes SDN-AP
// element sets beside the OD node's.
//   - Every SDN-AP fit is handed one ephemeris and exactly ONE $PCF (the fit's configuration port takes one frame);
//     the fit takes the ephemerides one at a time, so the ones it refuses (too few states, a frame it does not read)
//     cost only their own object and every other object is still fitted, stored and published.
//   - What is stored under SOURCE_NAME sdn-ap: $OMM records with MEAN_ELEMENT_THEORY SDNAP and COVARIANCE (21 values),
//     and their $OBD, each batch filed by an IngestRequest naming the provider and the stream's SHA-256, and published.
//   - The OD node's records are the same as without the SDN-AP lane (tests/flow.test.mjs holds that byte for byte).
//   node tests/sdnap.e2e.mjs [--out <file>]   --out writes the stored SDN-AP $OMM stream (size-prefixed records)
import assert from "node:assert/strict";
import fs from "node:fs";

import { CODE_SP3, PUBLISH_URL, runRelease, sha256 } from "./lib/flow.mjs";
import { decodeIngestResult, decodeOmmRecord } from "./lib/sds.mjs";

const argv = process.argv.slice(2);
const out = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;
const failures = [];
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };

const trace = [];
const run = await runRelease({
  trace,
  config: {
    "com.orbpro.glonass-source": { sourceUrl: CODE_SP3 },
    "org.sdn.flows.supplemental-omm.od": { omm_publish_url: PUBLISH_URL },
  },
});
const fits = trace.filter((t) => t.nodeId === "sdnap_fit");
const taken = fits.filter((t) => !t.errors);
check(fits.length === 30, `the fit is invoked once for each of the 30 ephemerides (${fits.length})`);
check(fits.every((t) => t.inputs.filter((p) => p === "configuration").length === 1 && t.inputs.filter((p) => p === "ephemeris").length === 1),
  "every invocation has one ephemeris and exactly one $PCF");
check(taken.length >= 1, `the fit takes ${taken.length} of them (the others are refused by name: ${[...new Set(fits.filter((t) => t.errors).map((t) => t.errors))].join(", ")})`);
check(taken.every((t) => t.outputs.includes("elements") && t.outputs.includes("determination")), "a taken ephemeris gives its $OMM and its $OBD");

const ap = run.ingests.filter((i) => i.source_name === "sdn-ap");
const apOmm = ap.filter((i) => i.schema === "OMM.fbs");
const apObd = ap.filter((i) => i.schema === "OBD.fbs");
check(apOmm.length === taken.length && apObd.length === taken.length, `one OMM batch and one OBD batch for each taken ephemeris (${apOmm.length}, ${apObd.length})`);
check(ap.every((i) => i.provider_id === "supplemental-omm" && i.content_key_id === "public" && i.batch_id === sha256(Buffer.concat(i.records))),
  "each batch is filed under supplemental-omm / sdn-ap, public, BATCH_ID the SHA-256 of its stream");
const sets = apOmm.flatMap((i) => i.records.map(decodeOmmRecord));
check(sets.length > 0 && sets.every((o) => o.MEAN_ELEMENT_THEORY === 4), "every stored element set is MEAN_ELEMENT_THEORY SDNAP");
check(sets.every((o) => o.COVARIANCE.length === 21 && o.COVARIANCE.every(Number.isFinite) && o.COVARIANCE[0] > 0), "every one carries COVARIANCE (21 values, finite, positive variance)");
check(sets.every((o) => o.NORAD_CAT_ID > 0), `named objects: ${sets.map((o) => `${o.OBJECT_NAME} (${o.NORAD_CAT_ID})`).join(", ")}`);

const posts = run.calls.filter((c) => c.operation === "http.request" && c.params.url === PUBLISH_URL).map((c) => decodeIngestResult(c.params.body));
check(ap.every((i) => posts.some((r) => r.batchId === i.batch_id && r.sourceName === "sdn-ap")), "each SDN-AP batch is published (the POST names it)");
check(run.ingests.filter((i) => i.source_name !== "sdn-ap").length === 90, "the OD node's 90 batches are as before");
check(run.egress.notices.length === 30 && run.egress.notices.every((n) => n.reason === "fitted"), "the OD notices are as before");

if (out) fs.writeFileSync(out, Buffer.concat(apOmm.flatMap((i) => i.records)));
console.log(failures.length ? `SDNAP-FLOW-E2E FAIL (${failures.length})` : `SDNAP-FLOW-E2E PASS (${sets.length} SDN-AP set(s) with COVARIANCE)`);
process.exit(failures.length ? 1 : 0);
