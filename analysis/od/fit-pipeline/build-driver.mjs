#!/usr/bin/env node
// The SDK compiler hook (SDN_WASI_CLANGXX), set by build.mjs: the SDK's own clang command plus the OD fit library's
// include flags on the module's compile: the Eigen headers the fitter includes. No -ffast-math: analysis/od compiles
// the fitter without it (build-wasi.mjs), and this module's records are to be that module's, byte for byte. The SDK
// still owns the toolchain, PIV bridge, manifest exports, link and validation.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const compiler = process.env.FIT_PIPELINE_CLANGXX;
const eigen = process.env.FIT_PIPELINE_EIGEN_DIR;
if (!compiler || !eigen) throw new Error("Run this compiler hook through node build.mjs.");
const extra = args.includes("-c") ? [`-I${eigen}`] : [];
const result = spawnSync(compiler, [...args, ...extra], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
