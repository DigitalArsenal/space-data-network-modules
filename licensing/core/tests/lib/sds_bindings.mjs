// Loads an SDS standard's generated TypeScript bindings (spacedatastandards.org lib/ts/<CODE>) for the tests: the
// standards repo's own esbuild bundles lib/ts/<CODE>/main.ts (with its flatbuffers) into one ES module in memory.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../../spacedatastandards.org/", import.meta.url));

export async function loadStandard(code) {
  const esbuild = createRequire(path.join(STANDARDS_ROOT, "package.json"))("esbuild");
  const built = await esbuild.build({
    stdin: {
      contents: `export * from "./lib/ts/${code}/main.ts"; export * as flatbuffers from "flatbuffers";`,
      resolveDir: STANDARDS_ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
}
