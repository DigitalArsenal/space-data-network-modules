import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "tests/sqp_native");
const compile = spawnSync("c++", [
  "-std=c++17",
  "-O2",
  "-I", path.join(root, "include"),
  path.join(root, "tests/sqp_native.cpp"),
  "-o", output,
], { stdio: "inherit" });
if (compile.status !== 0) process.exit(compile.status ?? 1);
const run = spawnSync(output, { stdio: "inherit" });
process.exit(run.status ?? 1);
