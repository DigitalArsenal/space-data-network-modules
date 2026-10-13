#!/usr/bin/env node
// Equivalence of a published sites lane with the site-status audit it replaces
// (verification tool, not a test). Reads a size-prefixed $SIT stream (a file,
// or the lane from a node's data query) and compares every record with the
// oracle tests/oracle/status-e0d053f.tsv (SpaceAware-UI e0d053f, verified
// round 5), the round-4/5 samples and the named rows.
//
//   node tools/equivalence.mjs --sit <file> | --node http://127.0.0.1:7245 [--json out.json]
//
// Reports: rows on the other side of the CURRENT / NOT-CURRENT split, other
// status differences, date differences, oracle rows missing from the lane,
// and the named rows that fail. Differences in rows whose evidence was read
// after the audit (a newer SOURCE_VERSION) are listed with that evidence.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const { values: args } = parseArgs({ options: { sit: { type: "string" }, node: { type: "string" }, json: { type: "string" } } });
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sds = process.env.SPACE_DATA_STANDARDS_ROOT ?? path.dirname(require.resolve("spacedatastandards.org/package.json"));
const { SIT } = await import(pathToFileURL(path.join(sds, "lib/js/SIT/main.js")));
const { ByteBuffer } = require("flatbuffers");
const STATUSES = ["UNSPECIFIED", "PLANNED", "UNDER_CONSTRUCTION", "CONSTRUCTION_SUSPENDED", "OPERATING", "LONG_TERM_SHUTDOWN", "PERMANENT_SHUTDOWN", "DECOMMISSIONING", "DECOMMISSIONED", "CANCELLED", "UNVERIFIED"];
const CURRENT = new Set(["OPERATING", "LONG_TERM_SHUTDOWN", "UNDER_CONSTRUCTION", "UNSPECIFIED", "UNVERIFIED"]);

async function laneBytes() {
  if (args.sit) return readFileSync(args.sit);
  const response = await fetch(`${args.node}/api/v1/data/query`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ schema: "SIT.fbs", provider_id: "sdn-site-registry", source_name: "sites", limit: 100000, offset: 0 }),
  });
  if (!response.ok) throw new Error(`data query ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const bytes = await laneBytes();
const lane = new Map();
for (let o = 0; o + 4 <= bytes.length; ) {
  const n = bytes.readUInt32LE(o);
  const s = SIT.getRootAsSIT(new ByteBuffer(new Uint8Array(bytes.subarray(o + 4, o + 4 + n))));
  const versions = [];
  for (let i = 0; i < s.statusEvidenceLength(); i++) {
    const c = s.STATUS_EVIDENCE(i).CITATION();
    if (c) versions.push(`${c.PROVENANCE()?.SOURCE_ID() ?? ""}:${c.SOURCE_RECORD_ID() ?? ""}@${c.SOURCE_VERSION() ?? ""}`);
  }
  const refs = [];
  for (let i = 0; i < s.externalReferencesLength(); i++) refs.push(s.EXTERNAL_REFERENCES(i).RECORD_ID());
  lane.set(s.ID(), { id: s.ID(), name: s.NAME() ?? "", status: STATUSES[s.LIFECYCLE_STATUS()], date: s.LIFECYCLE_STATUS_DATE() ?? "", versions, refs });
  o += 4 + n;
}
const oracle = readFileSync(path.join(here, "../tests/oracle/status-e0d053f.tsv"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t"));
const report = { lane: lane.size, oracle: oracle.length, split: [], status: [], date: [], missing: [], named: [] };
for (const [id, status, date] of oracle) {
  const row = lane.get(id);
  if (!row) { report.missing.push(id); continue; }
  const entry = { id, name: row.name, oracle: `${status}${date ? `@${date}` : ""}`, lane: `${row.status}${row.date ? `@${row.date}` : ""}` };
  if (CURRENT.has(status) !== CURRENT.has(row.status)) report.split.push({ ...entry, evidence: row.versions });
  else if (status !== row.status) report.status.push(entry);
  else if (date !== row.date) report.date.push(entry);
}
for (const line of readFileSync(path.join(here, "../tests/oracle/named.tsv"), "utf8").split("\n")) {
  if (!line || line.startsWith("#")) continue;
  const [key, status, date] = line.split("\t");
  const rows = key.startsWith("name:") ? [...lane.values()].filter((r) => r.name.includes(key.slice(5))) : [lane.get(key.includes(":") ? key : `wikidata:${key}`)].filter(Boolean);
  const ok = rows.some((r) => r.status === status && (!date || r.date === date));
  if (!ok) report.named.push({ key, want: `${status}${date ? `@${date}` : ""}`, got: rows.map((r) => `${r.id} ${r.name}: ${r.status}@${r.date}`) });
}
console.log(`lane ${report.lane} records, oracle ${report.oracle}: split ${report.split.length}, status ${report.status.length}, date ${report.date.length}, missing ${report.missing.length}, named failing ${report.named.length}`);
if (args.json) writeFileSync(args.json, `${JSON.stringify(report, null, 1)}\n`);
