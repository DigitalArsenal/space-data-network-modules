import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "../reference-missions/crew-8");

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(FIXTURE_ROOT, fileName), "utf8"));
}

test("Crew-8 reference package covers every full-mission phase with source IDs", async () => {
  const [sources, mission, events, vehicle, ports, windows] = await Promise.all([
    readJson("sources.json"),
    readJson("mission.json"),
    readJson("events.json"),
    readJson("vehicle.falcon9-dragon.json"),
    readJson("docking-ports.json"),
    readJson("validation-windows.json"),
  ]);

  const sourceIds = new Set(sources.sources.map((source) => source.id));
  assert.ok(sourceIds.has("nasa-crew8-launch-to-dock-timeline"));
  assert.ok(sourceIds.has("nasa-crew8-splashdown-release"));

  assert.equal(mission.missionId, "nasa-spacex-crew-8");
  assert.equal(mission.launch.vehicle, "falcon9-block5-dragon-crew");
  assert.equal(mission.spacecraft.name, "Endeavour");

  const phases = new Set(events.events.map((event) => event.phase));
  for (const phase of [
    "launch",
    "ascent",
    "rendezvous",
    "docking",
    "docked",
    "relocation",
    "departure",
    "reentry",
    "splashdown",
  ]) {
    assert.ok(phases.has(phase), `missing phase ${phase}`);
  }

  for (const event of events.events) {
    assert.ok(Date.parse(event.utc), `invalid UTC for ${event.id}`);
    assert.ok(sourceIds.has(event.sourceId), `unknown source ${event.sourceId}`);
    assert.ok(Number.isFinite(event.uncertaintySeconds));
  }

  for (let index = 1; index < events.events.length; index += 1) {
    const previous = Date.parse(events.events[index - 1].utc);
    const current = Date.parse(events.events[index].utc);
    assert.ok(current >= previous, `${events.events[index].id} is out of order`);
  }

  assert.equal(vehicle.vehicleId, "falcon9-block5-dragon-crew");
  assert.ok(vehicle.stages.length >= 2);
  for (const stage of vehicle.stages) {
    assert.ok(stage.sourceIds.every((id) => sourceIds.has(id)));
    assert.ok(["published", "derived", "estimated", "fit"].includes(stage.massConfidence));
  }

  assert.deepEqual(
    ports.occupancy.map((entry) => entry.portId),
    ["harmony-forward", "harmony-zenith", "harmony-zenith"],
  );
  assert.ok(windows.validationWindows.every((window) => sourceIds.has(window.sourceId)));
});
