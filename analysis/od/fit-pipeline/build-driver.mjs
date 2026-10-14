#!/usr/bin/env node
// The SDK compiler hook (SDN_WASI_CLANGXX), set by build.mjs: the SDK's own clang command plus the OD fit library's
// numerics and include flags on the module's compile - -ffast-math, as analysis/od compiles the fitter, and the Eigen
// headers the fitter includes. The SDK still owns the toolchain, PIV bridge, manifest exports, link and validation.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const compiler = process.env.FIT_PIPELINE_CLANGXX;
const eigen = process.env.FIT_PIPELINE_EIGEN_DIR;
if (!compiler || !eigen) throw new Error("Run this compiler hook through node build.mjs.");
const extra = args.includes("-c") ? ["-ffast-math", `-I${eigen}`] : [];
const result = spawnSync(compiler, [...args, ...extra], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
