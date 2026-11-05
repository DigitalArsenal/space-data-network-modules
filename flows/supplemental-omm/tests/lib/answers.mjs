// The OD node's answers on the inputs of its tests, for tests/ocm-record.e2e.mjs and for their record
// (tests/fixtures/record-answers.mjs): per input, every record of the omm and ocm streams in output order as the
// SHA-256 of its bytes with the version in PROVENANCE.PRODUCER masked, the notices, and the wall time of each fit.
// The node computes every record; this module moves bytes, hashes them and times the invocations.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { modulesRoot, packageRoot, sha256 } from "./flow.mjs";
import { cpfArc, cpfOem, fit, issOem, odNode, sourceOems } from "./nodes.mjs";
import { decodeOcmRecord } from "./sds.mjs";

// Each input is fitted this many times by a new node; the records must be the same each time.
export const REPEATS = 3;

// The inputs (port -> [$OEM]): the E2E's synthetic Starlink ephemeris and every ephemeris tests/od-node.test.mjs fits.
export async function answerInputs() {
  const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(packageRoot, "tests/fixtures", name)));
  return {
    "starlink-synthetic-12h": { starlink: [fixture("starlink-synthetic-12h.oem")] },
    sources: await sourceOems(null),
    "iss-12h": { iss: [await issOem(null, fs.readFileSync(path.join(modulesRoot, "files/ccsds-messages/fixtures/real/nasa-iss.oem")))] },
    "iss-3day": { iss: [await issOem(null, fixture("iss-sgp4xp-3day.oem"))] },
    "cpf-4h": { cpf: await cpfOem(null, cpfArc) },
  };
}

// The version labels in PROVENANCE.PRODUCER (src/node.cpp kSgp4Product, kXpProduct): the node's own in each SGP4 set
// $OCM, propagator/sgp4-xp's in each SGP4-XP $OCM. No other byte of a record names a version.
const LABELS = {
  node: { kind: "ocm-sgp4", pattern: /(SDN supplemental-omm OD node )(\d+\.\d+\.\d+)( over the frozen complete-arc SGP4 OD core)/g },
  engine: { kind: "ocm-sgp4xp", pattern: /(SDN supplemental-omm OD node over propagator\/sgp4-xp )(\d+\.\d+\.\d+)( and the US Space Force)/g },
};

function kindOf(standard, record) {
  if (standard === "omm") return "omm-sgp4";
  const theory = decodeOcmRecord(record).MEAN_ELEMENTS?.MEAN_ELEMENT_THEORY;
  return theory === undefined ? "ocm-state" : ["ocm-sgp4", "ocm-sgp4xp"][theory] ?? `ocm-theory-${theory}`;
}

// The record with each version in its label replaced by as many '#' (the layout is unchanged), and the versions.
function masked(record, kind) {
  let text = Buffer.from(record).toString("latin1");
  const versions = {};
  for (const [which, label] of Object.entries(LABELS)) {
    const found = [];
    text = text.replace(label.pattern, (_, head, version, tail) => {
      found.push(version);
      return head + "#".repeat(version.length) + tail;
    });
    assert.equal(found.length, kind === label.kind ? 1 : 0, `a ${kind} record with ${found.length} ${which} labels`);
    if (found.length) versions[which] = found[0];
  }
  return { bytes: Buffer.from(text, "latin1"), versions };
}

async function once(frames) {
  const node = await odNode(null);
  const start = performance.now();
  const out = await fit(node, frames);
  const ms = performance.now() - start;
  await node.destroy();
  const versions = { node: new Set(), engine: new Set() };
  const records = ["omm", "ocm"].flatMap((standard) =>
    out[standard].map((record) => {
      const kind = kindOf(standard, record);
      const m = masked(record, kind);
      for (const [which, version] of Object.entries(m.versions)) versions[which].add(version);
      return { standard, kind, sha256: sha256(m.bytes) };
    }),
  );
  return {
    invocations: out.invocations,
    versions: { node: [...versions.node], engine: [...versions.engine] },
    notices: out.notices.map((n) => [n.kind, n.reason, n.sourceName, ...n.items].join(" | ")),
    records,
    ms,
  };
}

// The node's answers on `frames`, fitted REPEATS times: the records, notices and versions (the same each time) and
// the wall time of each fit, ms.
export async function answersOf(frames) {
  const runs = [];
  for (let k = 0; k < REPEATS; k += 1) runs.push(await once(frames));
  const [first] = runs;
  const { ms: _, ...answer } = first;
  for (const run of runs.slice(1)) {
    const { ms: __, ...again } = run;
    assert.deepEqual(again, answer, "a second fit of the same input answered differently");
  }
  return { ...answer, ms: runs.map((run) => Math.round(run.ms * 10) / 10) };
}

export const median = (values) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];
