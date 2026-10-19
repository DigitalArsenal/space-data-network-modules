// The Moon terrain retrieval flow (flow-body.mjs with the Moon's table: body_plan config body moon, the default).
import { bodyTerrainFlow } from "./flow-body.mjs";

export function moonTerrainFlow(args) {
  return bodyTerrainFlow(args, {
    programId: "com.digitalarsenal.flows.moon-terrain-ingest",
    name: "Moon terrain (NASA LRO LOLA)",
    description: "The Moon's terrain from the NASA LRO LOLA gridded products in the PDS Geosciences Node (public domain), one unit per tick: body_plan (config body moon) resumes the walk from the durable $IRM mark and asks for the product's PDS3 label and three whole-line byte ranges of its image (If-Match on the product's ETag, so a reprocessed product stops the run); terrain-source decodes them in WASM into quantized-mesh tiles on the 1737.4 km reference sphere (GEOGRAPHIC_TWO_ROOT_BODY, oct-encoded normals, no water mask, 32 KiB per tile) and packs them into root.dtts and 4x4 block files (size-prefixed $DTT streams); the host adapter adds each file to the node's IPFS and announce_files publishes one $PNM per file (provider nasa-lola, source moon-terrain), which the console resolves through SOLAR_SYSTEM_LANES.terrain and fetches by CID; publish_request advances the mark only from the verified store result. Levels 0-3 from LDEM_4, 4-5 from LDEM_16, 6-7 from LDEM_64, 8-10 from the polar products over the latitude caps in caps. The configured SDN auto-publisher signs and announces each batch.",
    triggerId: "moon-terrain-unit",
    triggerDescription: "One unit of the walk per tick (about 200 units for the whole Moon); a drained walk is a clean no-op until caps or the edition changes.",
    requests: 4,
  });
}
