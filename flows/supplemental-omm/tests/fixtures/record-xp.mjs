#!/usr/bin/env node
// Records tests/fixtures/starlink-xp.ocm: the SGP4-XP window's $OCM that this build of the OD node
// (nodes/od/dist/isomorphic/module.wasm) writes for starlink-synthetic-12h.oem on the 'starlink' port
// (PROVENANCE.md). The node computes the fit; this script moves bytes.
//   cd flows/supplemental-omm && node tests/fixtures/record-xp.mjs
import fs from "node:fs";
import path from "node:path";
import { packageRoot, splitRecords } from "../lib/flow.mjs";
import { odNode } from "../lib/nodes.mjs";
import { decodeOcmRecord } from "../lib/sds.mjs";

const fixture = (name) => path.join(packageRoot, "tests/fixtures", name);
const node = await odNode({ after: () => {} });
const raw = await node.invoke({ methodId: "fit", inputs: [{ portId: "starlink", typeRef: { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM", wireFormat: "flatbuffer" }, payload: new Uint8Array(fs.readFileSync(fixture("starlink-synthetic-12h.oem"))) }] });
if (raw.statusCode !== 0) throw new Error(`fit: ${raw.errorCode} ${raw.errorMessage}`);
const xp = raw.outputs.filter((o) => o.portId === "ocm").flatMap((o) => splitRecords(o.payload)).filter((r) => decodeOcmRecord(r).MEAN_ELEMENTS?.MEAN_ELEMENT_THEORY === 1);
fs.writeFileSync(fixture("starlink-xp.ocm"), Buffer.concat(xp.map((r) => Buffer.from(r))));
console.log(`starlink-xp.ocm: ${xp.length} SGP4-XP $OCM, sha256 ${(await import("node:crypto")).createHash("sha256").update(fs.readFileSync(fixture("starlink-xp.ocm"))).digest("hex")}`);
await node.destroy();
process.exit(0);
