import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_POSITION_TOLERANCE_M,
  MERGE_METHOD_ORDINALS,
  MergeMethod,
  RADIO_CLASS_ORDINALS,
  deconflictReports,
  groupReports,
  haversineMetres,
  networkIdentity,
  selectWinner,
  toTbsRecord,
} from "../src/deconflict.mjs";

function report(providerId, overrides = {}) {
  return {
    id: `${providerId}:LTE:310:260:40495:17811`,
    radio: "LTE",
    mcc: 310,
    mnc: 260,
    lac: 40495,
    cellId: "17811",
    latitude: 40.7484,
    longitude: -73.9857,
    rangeMeters: 450,
    samples: 12,
    observedAt: 1710000000,
    provenance: {
      providerId,
      authority: `${providerId} authority`,
      sourceUrl: `https://example.test/${providerId}`,
      retrievedAt: "2026-08-08T00:00:00.000Z",
      license: "CC BY-SA 4.0",
      licenseUrl: "https://example.test/license",
      attribution: `${providerId} contributors`,
    },
    ...overrides,
  };
}

test("the merge-method and radio ordinals match the $TBS enums", () => {
  assert.deepEqual(MERGE_METHOD_ORDINALS, [
    "SINGLE_SOURCE",
    "HIGHEST_SAMPLE_COUNT",
    "MOST_RECENT",
    "AUTHORITY_PRECEDENCE",
    "CENTROID",
    "UNSPECIFIED",
  ]);
  assert.deepEqual(RADIO_CLASS_ORDINALS, [
    "GSM",
    "CDMA",
    "UMTS",
    "LTE",
    "NR",
    "OTHER",
    "UNKNOWN",
  ]);
});

test("LAC and TAC are the same slot, so reporting either still matches", () => {
  const withLac = report("a", { lac: 40495, tac: undefined });
  const withTac = report("b", { lac: undefined, tac: 40495 });
  assert.equal(networkIdentity(withLac), networkIdentity(withTac));
});

test("a report missing network identifiers is matched geometrically, not by id", () => {
  const register = report("regulator", {
    mcc: undefined,
    mnc: undefined,
    cellId: undefined,
    latitude: 40.7485,
    longitude: -73.9858,
  });
  assert.equal(networkIdentity(register), null);
  const groups = groupReports([report("crowd"), register]);
  // A mast register entry near a cell is NOT evidence it IS that cell: the
  // identifier group and the geometric report stay separate.
  assert.equal(groups.length, 2);
});

test("two providers reporting the same cell collapse into one site", () => {
  const { sites, statistics } = deconflictReports(
    [report("alpha"), report("bravo", { samples: 99 })],
    { method: MergeMethod.HIGHEST_SAMPLE_COUNT, mergedAt: "2026-08-08T00:00:00.000Z" },
  );
  assert.equal(sites.length, 1);
  assert.equal(statistics.reportsIn, 2);
  assert.equal(statistics.collapsed, 1);
  assert.equal(sites[0].consensus.providersAgreeing, 2);
  assert.equal(sites[0].consensus.winningProviderId, "bravo");
  assert.equal(sites[0].sources.length, 2);
});

test("SINGLE_SOURCE emits every report so the duplicates are visible", () => {
  const { sites, statistics } = deconflictReports(
    [report("alpha"), report("bravo")],
    { method: MergeMethod.SINGLE_SOURCE },
  );
  assert.equal(sites.length, 2);
  assert.equal(statistics.collapsed, 0);
  for (const site of sites) {
    assert.equal(site.consensus.providersAgreeing, 1);
  }
});

test("MOST_RECENT and HIGHEST_SAMPLE_COUNT can pick different winners", () => {
  const group = [
    report("stale-but-dense", { samples: 500, observedAt: 1600000000 }),
    report("fresh-but-thin", { samples: 3, observedAt: 1750000000 }),
  ];
  assert.equal(
    selectWinner(group, MergeMethod.HIGHEST_SAMPLE_COUNT).provenance.providerId,
    "stale-but-dense",
  );
  assert.equal(
    selectWinner(group, MergeMethod.MOST_RECENT).provenance.providerId,
    "fresh-but-thin",
  );
});

test("AUTHORITY_PRECEDENCE puts an administrative register ahead of a denser crowd report", () => {
  const group = [
    report("crowd", { samples: 5000 }),
    report("register", { samples: 1 }),
  ];
  const winner = selectWinner(group, MergeMethod.AUTHORITY_PRECEDENCE, {
    isAuthority: (providerId) => providerId === "register",
  });
  assert.equal(winner.provenance.providerId, "register");
});

test("CENTROID averages the reported positions and publishes the spread", () => {
  const { sites } = deconflictReports(
    [
      report("alpha", { latitude: 40.7484, longitude: -73.9857 }),
      report("bravo", { latitude: 40.7486, longitude: -73.9857 }),
    ],
    { method: MergeMethod.CENTROID },
  );
  assert.equal(sites.length, 1);
  assert.ok(Math.abs(sites[0].latitude - 40.7485) < 1e-9);
  assert.ok(sites[0].consensus.positionSpreadMetres > 0);
});

test("ties break deterministically on provider id, so the parity gate is stable", () => {
  const forward = deconflictReports([report("zulu"), report("alpha")], {
    method: MergeMethod.HIGHEST_SAMPLE_COUNT,
  });
  const reverse = deconflictReports([report("alpha"), report("zulu")], {
    method: MergeMethod.HIGHEST_SAMPLE_COUNT,
  });
  assert.equal(
    forward.sites[0].consensus.winningProviderId,
    reverse.sites[0].consensus.winningProviderId,
  );
  assert.equal(forward.sites[0].consensus.winningProviderId, "alpha");
});

test("a provider that returned nothing is still counted as consulted", () => {
  const { sites } = deconflictReports([report("alpha")], {
    providersConsulted: ["alpha", "bravo", "charlie"],
  });
  assert.equal(sites[0].consensus.providersConsulted, 3);
  assert.equal(sites[0].consensus.providersAgreeing, 1);
});

test("distinct masts beyond tolerance do not collapse", () => {
  const far = report("crowd-b", {
    mcc: undefined,
    mnc: undefined,
    cellId: undefined,
    latitude: 40.7484 + DEFAULT_POSITION_TOLERANCE_M / 111320 + 0.001,
  });
  const near = report("crowd-a", {
    mcc: undefined,
    mnc: undefined,
    cellId: undefined,
  });
  assert.ok(haversineMetres(near, far) > DEFAULT_POSITION_TOLERANCE_M);
  assert.equal(groupReports([near, far]).length, 2);
});

test("an unknown method is refused rather than silently defaulted", () => {
  assert.throws(
    () => deconflictReports([report("alpha")], { method: "BEST_GUESS" }),
    /Unknown deconfliction method/u,
  );
});

test("the $TBS projection uses IDL capitalization and omits absent optionals", () => {
  const { sites } = deconflictReports([report("alpha")], {
    method: MergeMethod.HIGHEST_SAMPLE_COUNT,
    mergedAt: "2026-08-08T00:00:00.000Z",
  });
  const record = toTbsRecord(sites[0]);

  assert.equal(record.MCC, 310);
  assert.equal(record.MNC, 260);
  assert.equal(record.CELL_ID, "17811");
  assert.equal(record.RANGE_M, 450);
  assert.equal(record.CONSENSUS.PROVIDERS_AGREEING, 1);
  assert.equal(record.CONSENSUS.WINNING_PROVIDER_ID, "alpha");
  assert.equal(record.SOURCES[0].PROVIDER_ID, "alpha");
  assert.equal(record.SOURCES[0].LICENSE, "CC BY-SA 4.0");

  // The package's internal camelCase must never reach the wire.
  for (const key of Object.keys(record)) {
    assert.match(key, /^[A-Z][A-Z0-9_]*$/u, `${key} is not an IDL token`);
  }
  for (const key of Object.keys(record.CONSENSUS)) {
    assert.match(key, /^[A-Z][A-Z0-9_]*$/u, `${key} is not an IDL token`);
  }
  for (const key of Object.keys(record.SOURCES[0])) {
    assert.match(key, /^[A-Z][A-Z0-9_]*$/u, `${key} is not an IDL token`);
  }

  // Absent is not zero: an unreported TAC has no key at all.
  assert.equal("TAC" in record, false);
  assert.equal("OPERATOR" in record, false);
});

test("every source is listed, including the ones that lost", () => {
  const { sites } = deconflictReports(
    [report("alpha", { samples: 1 }), report("bravo", { samples: 2 })],
    { method: MergeMethod.HIGHEST_SAMPLE_COUNT },
  );
  const record = toTbsRecord(sites[0]);
  assert.equal(record.SOURCES.length, 2);
  assert.equal(record.SOURCES.filter((s) => s.CONTRIBUTED).length, 1);
  assert.deepEqual(
    record.SOURCES.map((s) => s.PROVIDER_ID).sort(),
    ["alpha", "bravo"],
  );
});
