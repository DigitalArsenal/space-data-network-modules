import fs from "node:fs";
import path from "node:path";

export function resolveBasiliskRoot(repoRoot) {
  const candidates = [
    process.env.BASILISK_ROOT,
    "../../ancillary-packages/basilisk",
    "../basilisk",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(repoRoot, candidate);
    if (fs.existsSync(path.join(resolved, "src", "architecture"))) {
      return resolved;
    }
  }

  return path.resolve(repoRoot, candidates[0] ?? "../basilisk");
}
