import fs from "node:fs";
import path from "node:path";

export function resolveOrekitRoot(repoRoot) {
  const candidates = [
    process.env.OREKIT_ROOT,
    "../../ancillary-packages/orekit",
    "/tmp/orekit-source",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(repoRoot, candidate);
    if (fs.existsSync(path.join(resolved, "src", "main", "java", "org", "orekit"))) {
      return resolved;
    }
  }

  return path.resolve(repoRoot, candidates[0] ?? "/tmp/orekit-source");
}
