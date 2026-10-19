// The Mars terrain retrieval flow (flow-body.mjs with the Mars table: body_plan config body mars).
import { bodyTerrainFlow } from "./flow-body.mjs";

export function marsTerrainFlow(args) {
  return bodyTerrainFlow(args, {
    programId: "com.digitalarsenal.flows.mars-terrain-ingest",
    name: "Mars terrain (NASA MGS MOLA)",
    description: "Mars's terrain from the NASA MGS MOLA Mission Experiment Gridded Data Records (MEGDR) in the PDS Geosciences Node (public domain), one unit per tick: body_plan (config body mars) resumes the walk from the durable $IRM mark and asks, per file of the unit's product, for its PDS3 label and whole-line byte ranges of its image (If-Match on each file's ETag, so a reprocessed file stops the run; at most 16 requests); terrain-source decodes them in WASM into quantized-mesh tiles on the 3396.0 km reference sphere (GEOGRAPHIC_TWO_ROOT_BODY, planetocentric east-positive, oct-encoded normals, no water mask, 32 KiB per tile) and packs them into terrain/499 root.dtts and 4x4 block files (size-prefixed $DTT streams); the host adapter adds each file to the node's IPFS and announce_files publishes one $PNM per file (provider nasa-mola, source mars-terrain), which the console resolves and fetches by CID; publish_request advances the mark only from the verified store result. Levels 0-3 from megr 4 ppd, 4-5 from 16 ppd, 6 from 32 ppd, 7 from 64 ppd, 8 from 128 ppd (~463 m) within 87.1875 degrees, and the 512 ppd polar products for level 8 beyond it, level 9 beyond 78.75 and level 10 beyond 84.375 degrees. The configured SDN auto-publisher signs and announces each batch.",
    triggerId: "mars-terrain-unit",
    triggerDescription: "One unit of the walk per tick (385 units for the whole of Mars); a drained walk is a clean no-op until caps or the edition changes.",
    requests: 16,
  });
}
