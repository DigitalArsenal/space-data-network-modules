#!/usr/bin/env node
// The node's release records: what this build of the OD node (nodes/od/dist/isomorphic/module.wasm) makes of the
// inputs tests/od-node.test.mjs feeds it, as the size-prefixed record streams that test asserts byte for byte:
//   sources-*   every record of the source modules' $OEM (the flow's provider fixtures), in output order;
//   iss-12h-*   the OD core's records (no SGP4-XP sets) of NASA's ISS ephemeris;
//   iss-3day-*  the OD core's records of the three-day ephemeris of tests/fixtures/iss-sgp4xp-3day.oem.
// A new build is a new release with new records (no compatibility with an earlier release's).
//   node nodes/od/release-records/generate.mjs   (after node nodes/od/build.mjs)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { modulesRoot } from "../../../tests/lib/flow.mjs";
import { fit, issOem, odNode, sourceOems } from "../../../tests/lib/nodes.mjs";
import { decodeObdRecord, decodeOmmRecord } from "../../../tests/lib/sds.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SGP4XP = 1;
const core = (standard, records) => records.filter((r) =>
  !(standard === "omm" && decodeOmmRecord(r).MEAN_ELEMENT_THEORY === SGP4XP) &&
  !(standard === "obd" && (decodeObdRecord(r).ID ?? "").endsWith("-SGP4XP")));
const write = (name, standard, records) =>
  fs.writeFileSync(path.join(here, `${name}-${standard}-records.bin`), Buffer.concat(records.map((r) => Buffer.from(r))));

const sources = await fit(await odNode(null), await sourceOems(null));
const iss12h = await fit(await odNode(null), { iss: [await issOem(null, fs.readFileSync(path.join(modulesRoot, "files/ccsds-messages/fixtures/real/nasa-iss.oem")))] });
const iss3day = await fit(await odNode(null), { iss: [await issOem(null, fs.readFileSync(path.join(here, "../../../tests/fixtures/iss-sgp4xp-3day.oem")))] });
for (const standard of ["omm", "ocm", "obd"]) {
  write("sources", standard, sources[standard]);
  write("iss-12h", standard, core(standard, iss12h[standard]));
  write("iss-3day", standard, core(standard, iss3day[standard]));
}
console.log(`sources: ${sources.invocations} invocations; records omm ${sources.omm.length}, ocm ${sources.ocm.length}, obd ${sources.obd.length}`);
process.exit(0);
