import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const modulesRoot = path.resolve(root, "../..");
const output = path.join(root, "tests/targeting_native");
const sdkRoot = process.env.SPACE_DATA_MODULE_SDK_ROOT ??
  fs.realpathSync(path.join(root, "node_modules/space-data-module-sdk"));
const compile = spawnSync("c++", [
  "-std=c++17",
  "-O2",
  "-I", path.join(modulesRoot, "higherpop/include"),
  path.join(root, "tests/targeting_native.cpp"),
  "-o", output,
], { stdio: "inherit" });
if (compile.status !== 0) process.exit(compile.status ?? 1);
const run = spawnSync(output, { stdio: "inherit" });
if (run.status !== 0) process.exit(run.status ?? 1);

const reverseOutput = path.join(root, "tests/reverse_port_native");
const reverseCompile = spawnSync("c++", [
  "-std=c++17",
  "-O2",
  "-I", path.join(sdkRoot, "include/orbpro"),
  "-I", path.join(modulesRoot, "higherpop/include"),
  "-I", path.join(modulesRoot, "analysis/optimal-control/include"),
  "-I", path.join(modulesRoot, "propagator/hpop/lib"),
  path.join(root, "src/targeting_module.cpp"),
  path.join(modulesRoot, "propagator/hpop/lib/coords.cpp"),
  path.join(root, "tests/reverse_port_native.cpp"),
  "-o", reverseOutput,
], { stdio: "inherit" });
if (reverseCompile.status !== 0) process.exit(reverseCompile.status ?? 1);
const reverseRun = spawnSync(reverseOutput, { stdio: "inherit" });
process.exit(reverseRun.status ?? 1);
