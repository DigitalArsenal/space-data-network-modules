import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveOrbProRoot } from "../scripts/lib/resolve-orbpro-root.mjs";

async function createOrbProMarker(root) {
  await mkdir(path.join(root, "packages", "orbpro-integration"), {
    recursive: true,
  });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(
    path.join(root, "packages", "orbpro-integration", "build-cache.js"),
    "export {};\n",
  );
  await writeFile(
    path.join(root, "scripts", "sdn-emception-build.js"),
    "export {};\n",
  );
}

test("resolves OrbPro root from canonical stack sibling layout", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sdn-modules-stack-"));
  try {
    const modulesRoot = path.join(
      tempRoot,
      "repos",
      "main-packages",
      "space-data-network-modules",
    );
    const orbproRoot = path.join(tempRoot, "repos", "main-packages", "OrbPro");
    await mkdir(modulesRoot, { recursive: true });
    await createOrbProMarker(orbproRoot);

    assert.equal(resolveOrbProRoot(modulesRoot), orbproRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("resolves OrbPro root from OrbPro nested packages layout", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sdn-modules-nested-"));
  try {
    const orbproRoot = path.join(tempRoot, "OrbPro");
    const modulesRoot = path.join(
      orbproRoot,
      "packages",
      "space-data-network-modules",
    );
    await mkdir(modulesRoot, { recursive: true });
    await createOrbProMarker(orbproRoot);

    assert.equal(resolveOrbProRoot(modulesRoot), orbproRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
