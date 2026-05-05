import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { FlatcRunner } from "flatc-wasm";

import {
  CA_SOURCE_KINDS,
  normalizeConjunctionSourceSelection,
} from "../index.js";

function readText(path) {
  return fs.readFileSync(new URL(path, import.meta.url), "utf8");
}

function conjunctionRequestSchema() {
  return {
    entry: "/schemas/ConjunctionScreenCatalogRequest.fbs",
    files: {
      "/schemas/ConjunctionScreenCatalogRequest.fbs": readText(
        "../schemas/ConjunctionScreenCatalogRequest.fbs",
      ),
      "/schemas/ConjunctionCommon.fbs": readText(
        "../schemas/ConjunctionCommon.fbs",
      ),
    },
  };
}

test("screen catalog request schema accepts every CA selected source kind", async () => {
  const flatc = await FlatcRunner.init();

  const payload = flatc.generateBinary(
    conjunctionRequestSchema(),
    JSON.stringify({
      selectedSources: [
        { sourceKind: "OMM", schemaName: "OMM/main.fbs", fileIdentifier: "$OMM" },
        { sourceKind: "OCM", schemaName: "OCM/main.fbs", fileIdentifier: "$OCM" },
        { sourceKind: "OEM", schemaName: "OEM/main.fbs", fileIdentifier: "$OEM" },
        { sourceKind: "CDM", schemaName: "CDM/main.fbs", fileIdentifier: "$CDM" },
        {
          sourceKind: "FLATSQL_QUERY",
          query: "select * from OMM where NORAD_CAT_ID = 25544",
          queryHash: "sha256:8843d7f92416211de9ebb963ff4ce28125932878",
        },
        {
          sourceKind: "PNM",
          pnmCid: "bafybeigdyrzt5sfp7udm7hu76h7fdz6x44ckgw6xckd7tdfnfz4s4s4xzi",
        },
        { sourceKind: "PUBSUB", topic: "sdn.dataset.OMM.celestrak" },
      ],
      startJd: 2460743.5,
      durationDays: 0.01,
    }),
    { sizePrefix: false },
  );

  assert.ok(payload instanceof Uint8Array);
  assert.ok(payload.byteLength > 0);
});

test("CA selected source normalization accepts supported host source descriptors", () => {
  const normalized = normalizeConjunctionSourceSelection([
    { sourceKind: "OMM", schemaName: "OMM/main.fbs", fileIdentifier: "$OMM" },
    { kind: "ocm", schemaName: "OCM/main.fbs", fileIdentifier: "$OCM" },
    { kind: "oem", schemaName: "OEM/main.fbs", fileIdentifier: "$OEM" },
    { kind: "cdm", schemaName: "CDM/main.fbs", fileIdentifier: "$CDM" },
    { kind: "flatsql-query", query: "select * from OMM", queryHash: "abc123" },
    { kind: "pnm", pnmCid: "bafybeigdyrzt5sfp7udm7hu76h7fdz6x44ckgw6xckd7tdfnfz4s4s4xzi" },
    { kind: "pub/sub", topic: "sdn.dataset.OMM.celestrak" },
  ]);

  assert.deepEqual(
    normalized.map((source) => source.sourceKind),
    Array.from(CA_SOURCE_KINDS),
  );
  assert.equal(normalized[0].schemaName, "OMM/main.fbs");
  assert.equal(normalized[4].query, "select * from OMM");
  assert.equal(
    normalized[5].pnmCid,
    "bafybeigdyrzt5sfp7udm7hu76h7fdz6x44ckgw6xckd7tdfnfz4s4s4xzi",
  );
  assert.equal(normalized[6].topic, "sdn.dataset.OMM.celestrak");
});

test("CA selected source normalization rejects unsupported or incomplete descriptors", () => {
  assert.throws(
    () => normalizeConjunctionSourceSelection([{ kind: "tle" }]),
    /Unsupported conjunction source kind "TLE"/,
  );
  assert.throws(
    () => normalizeConjunctionSourceSelection([{ kind: "omm" }]),
    /OMM source requires schemaName and fileIdentifier/,
  );
  assert.throws(
    () => normalizeConjunctionSourceSelection([{ kind: "flatsql_query" }]),
    /FLATSQL_QUERY source requires query or queryHash/,
  );
  assert.throws(
    () => normalizeConjunctionSourceSelection([{ kind: "pnm" }]),
    /PNM source requires pnmCid or manifestCid/,
  );
  assert.throws(
    () => normalizeConjunctionSourceSelection([{ kind: "pubsub" }]),
    /PUBSUB source requires topic/,
  );
});
