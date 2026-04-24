import test from "node:test";
import assert from "node:assert/strict";

import { createSwathAnalyzer } from "../index.js";

test("Swath analyzer requires embedded manifest runtime identity", async () => {
  const analyzer = await createSwathAnalyzer({
    requireEmbeddedManifest: true,
  });

  try {
    assert.equal(analyzer.manifestSource, "embedded-flatbuffer");
    assert.equal(analyzer.manifest.pluginId, "com.orbpro.swath");
    assert.equal(analyzer.metadata.id, "com.orbpro.swath");

    const ray = analyzer.projectRayToEllipsoid({
      origin: { x: 7000000.0, y: 0.0, z: 0.0 },
      direction: { x: -1.0, y: 0.0, z: 0.0 },
    });

    assert.equal(ray.hit, true);
    assert.ok(Math.abs(ray.position.x - 6378137.0) < 1.0);
    assert.ok(Math.abs(ray.position.y) < 1e-9);
    assert.ok(Math.abs(ray.position.z) < 1e-9);
    assert.ok(Math.abs(ray.cartographic.longitude) < 1e-12);
    assert.ok(Math.abs(ray.cartographic.latitude) < 1e-12);
    assert.ok(Math.abs(ray.cartographic.altitude) < 1e-6);
  } finally {
    analyzer.destroy();
  }
});
