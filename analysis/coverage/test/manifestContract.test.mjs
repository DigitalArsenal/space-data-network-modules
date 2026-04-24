import test from "node:test";
import assert from "node:assert/strict";

import { createCoverageAnalyzer } from "../index.js";

test("Coverage analyzer requires embedded manifest runtime identity", async function () {
  const analyzer = await createCoverageAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    assert.equal(analyzer.manifestSource, "embedded-flatbuffer");
    assert.equal(analyzer.manifest.pluginId, "com.orbpro.coverage");
    assert.equal(analyzer.metadata.id, "com.orbpro.coverage");

    const grid = analyzer.createGrid({
      minLatitudeDeg: 0,
      maxLatitudeDeg: 2,
      minLongitudeDeg: 0,
      maxLongitudeDeg: 3,
      latitudeStepDeg: 1,
      longitudeStepDeg: 1,
      startEpochJd: 2451545.0,
      endEpochJd: 2451545.0 + 3600.0 / 86400.0,
    });

    assert.equal(grid.rowCount, 2);
    assert.equal(grid.columnCount, 3);
    assert.equal(grid.cellCount, 6);
    assert.equal(analyzer.getCellIndex(grid.gridId, 0.5, 0.5), 0);
  } finally {
    analyzer.destroy();
  }
});
