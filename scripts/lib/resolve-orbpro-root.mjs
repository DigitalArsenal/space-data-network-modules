import fs from "node:fs";
import path from "node:path";

function hasOrbProBuildHelpers(candidate) {
  return (
    fs.existsSync(
      path.join(candidate, "packages", "orbpro-integration", "build-cache.js"),
    ) &&
    fs.existsSync(path.join(candidate, "scripts", "sdn-emception-build.js"))
  );
}

export function resolveOrbProRoot(repoRoot) {
  const candidates = [
    process.env.ORBPRO_ROOT,
    "../OrbPro",
    "../..",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(repoRoot, candidate);
    if (hasOrbProBuildHelpers(resolved)) {
      return resolved;
    }
  }

  throw new Error(
    "OrbPro root not found. Set ORBPRO_ROOT to a checkout containing " +
      "packages/orbpro-integration/build-cache.js and scripts/sdn-emception-build.js.",
  );
}
