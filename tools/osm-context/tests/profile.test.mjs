// The profile against the plan's layer table. No YAML dependency: the layer
// blocks are sliced by their `- id:` heads (build.mjs profileLayers) and read
// for the tag filters and `- key:` attribute lines the plan requires;
// planetiler's own `verify` (build.mjs, before every build) is what proves the
// rules produce the right features. This test proves the profile still
// promises what the plan's table and the evidence records say it does.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { expectedExampleCount, PLANETILER, PROFILE, profileLayers } from "../build.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const profile = fs.readFileSync(PROFILE, "utf8");

// The plan's "What gets published" table (osm-on-sdn, 2026-09-03): layer,
// OSM source tags, kept attributes. The tag snippets are the exact YAML the
// filter must carry; an attribute is the `key:` of an `attributes:` entry.
const PLAN = {
  water: {
    tags: ["natural: water", "waterway: [riverbank, dock]", "landuse: [reservoir, basin]", "source: ocean"],
    attributes: ["kind"],
  },
  road: {
    tags: ["highway: __any__", "highway: [footway, path, steps, cycleway]"],
    attributes: ["class", "lanes", "width"],
  },
  rail: {
    tags: ["railway: [rail, light_rail, tram]"],
    attributes: ["class"],
  },
  aeroway: {
    tags: ["aeroway: [aerodrome, apron, runway, taxiway, helipad, hangar]"],
    attributes: ["kind"],
  },
  parking: {
    tags: ["amenity: parking"],
    attributes: [],
  },
  industrial: {
    tags: ["landuse: [industrial, port, harbour]", "man_made: [works, storage_tank, pier]"],
    attributes: ["kind"],
  },
  building: {
    tags: ["building: __any__", 'building: "no"'],
    attributes: ["height", "building:levels", "roof:shape", "min_height"],
  },
};

function attributeKeys(block) {
  return [...block.matchAll(/^\s+- key: (\S+)\s*$/gm)].map((match) => match[1]);
}

test("every layer in the plan's table is in the profile with its source tags and kept attributes, and nothing else", () => {
  const layers = profileLayers(profile);
  assert.deepEqual(layers.map((layer) => layer.id).sort(), Object.keys(PLAN).sort());
  for (const { id, block } of layers) {
    const plan = PLAN[id];
    for (const snippet of plan.tags) assert.ok(block.includes(snippet), `${id}: filter ${JSON.stringify(snippet)} is missing`);
    // Attribute lines may sit behind a YAML anchor (aeroway, industrial reuse
    // theirs through `*aeroway_attrs`), so the set is compared, not the count.
    assert.deepEqual([...new Set(attributeKeys(block))].sort(), [...plan.attributes].sort(), `${id}: kept attributes differ from the plan`);
  }
});

test("the profile keeps the choices the prototype build settled", () => {
  // `geometry: any` emits every closed way twice (BUILD-EVIDENCE.md); the
  // polygon/line/point split is the fix and must stay. The profile's own
  // comment names the pitfall, so only YAML outside comments is checked.
  const yamlOnly = profile.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(yamlOnly, /geometry:\s*any\b/);
  assert.match(profile, /^\s+maxzoom: 14\s*$/m);
  assert.match(profile, /^\s+render_maxzoom: 14\s*$/m);
  // Buildings at z14 keep every vertex.
  const building = profileLayers(profile).find((layer) => layer.id === "building").block;
  assert.match(building, /min_size_at_max_zoom: 0/);
  assert.match(building, /tolerance_at_max_zoom: -1/);
  // The ocean is the second source, written into the water layer at z0.
  assert.match(profile, /^\s+ocean:\n\s+type: shapefile\n\s+url: https:\/\/osmdata\.openstreetmap\.de\/download\/water-polygons-split-3857\.zip/m);
  // The header names the planetiler it was tested with.
  assert.ok(profile.startsWith("# tools/osm-context/profile/osm-context.yml"));
  assert.match(profile.split("\n").slice(0, 12).join("\n"), new RegExp(`planetiler ${PLANETILER.version.replace(/\./g, "\\.")}`));
  assert.match(profile.split("\n").slice(0, 12).join("\n"), new RegExp(PLANETILER.sha256));
});

test("every layer has at least one verify case that outputs to it, 21 cases in all", () => {
  assert.equal(expectedExampleCount(profile), 21);
  const examples = profile.slice(profile.search(/^examples:\s*$/m));
  for (const id of Object.keys(PLAN)) {
    assert.match(examples, new RegExp(`^\\s+- layer: ${id}\\s*$`, "m"), `${id} has no verify case`);
  }
});

test("the evidence records carry exactly the profile's layers and attributes", () => {
  for (const region of ["hessen", "zuid-holland"]) {
    const record = JSON.parse(fs.readFileSync(path.join(HERE, "..", "evidence", `osm-context-${region}-20260902T202051Z.vtt.json`), "utf8"));
    assert.deepEqual(record.LAYERS.map((layer) => layer.NAME).sort(), Object.keys(PLAN).sort(), `${region}: layer set`);
    for (const layer of record.LAYERS) {
      assert.deepEqual(layer.FIELDS, [...PLAN[layer.NAME].attributes].sort(), `${region}/${layer.NAME}: fields`);
      assert.equal(layer.MAX_ZOOM, 14);
    }
  }
});
