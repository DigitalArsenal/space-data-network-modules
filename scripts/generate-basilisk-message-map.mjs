#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBasiliskRoot } from "./lib/resolve-basilisk-root.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const basiliskRoot = resolveBasiliskRoot(repoRoot);
const outPath = path.join(repoRoot, "docs", "basilisk-message-standards.json");
const payloadRoots = [
  "src/architecture/msgPayloadDefC",
  "src/architecture/msgPayloadDefCpp",
];

function walk(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(full);
    }
    return entry.isFile() && entry.name.endsWith(".h") ? [full] : [];
  });
}

function classify(payloadName) {
  const name = payloadName.toLowerCase();
  if (/(dv|burn|thrust|thr|force|torque|rw|mtb|dipole|motor|vscmg)/.test(name)) {
    return { schemas: ["MNV", "MET", "MPE", "XTC"], xtce: true, owner: "actuator and maneuver interfaces" };
  }
  if (/(att|mrp|rate|heading|euler|prv|css|imu|star|sun|camera|opnav|pixel|limb|circle|image)/.test(name)) {
    return { schemas: ["AEM", "APM", "ACM", "ATD", "XTC"], xtce: true, owner: "attitude, sensor, and optical-navigation interfaces" };
  }
  if (/(navtrans|classic|ephem|orbit|hill|lambert|oe|trans|state|position|velocity)/.test(name)) {
    return { schemas: ["OMM", "OPM", "OEM", "OCM", "OSM"], xtce: false, owner: "orbit, translation, and ephemeris interfaces" };
  }
  if (/(ground|access|range|tracking|location|landmark|rf|plasma)/.test(name)) {
    return { schemas: ["TDM", "TRK", "RFM", "XTC"], xtce: true, owner: "ground, tracking, and RF/environment interfaces" };
  }
  if (/(power|battery|solar|thermal|temp|fuel|data|storage|transmitter|device|encoder)/.test(name)) {
    return { schemas: ["XTC", "ENV", "PHY", "TIM"], xtce: true, owner: "power, thermal, device, and data-handling interfaces" };
  }
  if (/(epoch|time|clock)/.test(name)) {
    return { schemas: ["TIM", "XTC"], xtce: true, owner: "time and clock interfaces" };
  }
  return { schemas: ["XTC"], xtce: true, owner: "Basilisk runtime/message interface" };
}

const payloads = payloadRoots.flatMap((root) => walk(path.join(basiliskRoot, root)))
  .map((fullPath) => {
    const payloadName = path.basename(fullPath, ".h");
    const classification = classify(payloadName);
    return {
      basiliskPayload: payloadName,
      basiliskOwner: classification.owner,
      upstreamPath: path.relative(basiliskRoot, fullPath),
      sdsSchemas: classification.schemas,
      fileIdentifiers: classification.schemas.map((schema) => `$${schema}`),
      wireFormat: "SDS FlatBuffer payload in TAB frame under PIV invoke envelope",
      xtceRequired: classification.xtce,
      unitsFrameEpochTimeScale: "derive from Basilisk header fields and document in module fixture before implementation",
      validationFixture: "Basilisk upstream expected values or public standards vector required before module completion",
      standardsGapPolicy: "add SDS-first backlog item before porting if no canonical schema covers durable exchange data",
    };
  })
  .sort((a, b) => a.basiliskPayload.localeCompare(b.basiliskPayload));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  upstreamBasiliskRoot: path.relative(repoRoot, basiliskRoot),
  payloadCount: payloads.length,
  payloads,
}, null, 2)}\n`);
console.log(`wrote ${path.relative(repoRoot, outPath)} (${payloads.length} payloads)`);
