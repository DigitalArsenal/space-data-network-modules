#!/usr/bin/env node
/**
 * Recompute the artifact locks in cellular-network-aggregate.flow.json.
 *
 * `artifact.sha256` is the sha256 of the artifact FILE AS SHIPPED — signed,
 * trailer included (verified against the supplemental-omm precedent, whose
 * timer lock equals the plain file hash). It therefore CHANGES every time an
 * artifact is rebuilt or re-signed, and a stale digest is a lie the flow
 * compiler cannot catch: it validates the SHAPE of the digest, not its truth.
 *
 * So the locks are generated, never hand-copied. Run this after any rebuild or
 * signing pass, before baking.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// Artifact paths resolve relative to the FLOW FILE, which is how the flow
// compiler resolves them — not relative to the repo root.
const flowDir = path.dirname(fileURLToPath(import.meta.url));
const flowPath = path.join(flowDir, "cellular-network-aggregate.flow.json");
const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));

let changed = 0;
for (const node of flow.nodes) {
  if (!node.artifact?.path) continue;
  const abs = path.resolve(flowDir, node.artifact.path);
  if (!fs.existsSync(abs)) {
    console.error(`MISSING artifact for node ${node.nodeId}: ${node.artifact.path}`);
    process.exitCode = 1;
    continue;
  }
  const sha256 = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  if (node.artifact.sha256 !== sha256) {
    node.artifact.sha256 = sha256;
    changed++;
  }
  console.log(`${node.nodeId.padEnd(16)} ${sha256}  ${node.artifact.path}`);
}
fs.writeFileSync(flowPath, `${JSON.stringify(flow, null, 2)}\n`);
console.log(changed === 0 ? "locks already current" : `updated ${changed} lock(s)`);
