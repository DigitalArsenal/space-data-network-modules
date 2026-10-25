// The reference: the unmodified US Space Force Sgp4Prop library run as a black box, lines in, TEME states out; its
// internals are never read (clean room, side B). The library and the harness that loads it are not in this
// repository: SDN_AP_ORACLE_ROOT names the harness directory (closed-modules packages/sgp4-xp-oracle), leg
// SDN_AP_ORACLE_VERSION (default 9.9, the version SPEC.md specifies). Without it the conformance E2E refuses.
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The oracle; propagate() is async. */
export async function openReference() {
  const root = process.env.SDN_AP_ORACLE_ROOT;
  if (!root) {
    throw new Error("SDN_AP_ORACLE_ROOT is not set. The conformance E2E runs against the SGP4-XP oracle (the unmodified US Space Force Sgp4Prop library behind a black-box harness, closed-modules packages/sgp4-xp-oracle), which this repository does not carry.");
  }
  const version = process.env.SDN_AP_ORACLE_VERSION || "9.9";
  const spec = await import(pathToFileURL(path.join(root, "oracle.mjs")).href);
  const oracle = await spec.openOracle({ version });
  return {
    name: `the SGP4-XP oracle (SDN_AP_ORACLE_ROOT), USSF Sgp4Prop ${oracle.version}, black box`,
    async propagate(lines, minutes) {
      const states = await oracle.propagate(lines, minutes);
      if (!states) return null;
      return states.map((s) => (s && s.error === 0 ? { r: s.r, v: s.v } : null));
    },
    close: () => oracle.close(),
  };
}
