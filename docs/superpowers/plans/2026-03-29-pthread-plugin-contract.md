# Pthread Plugin Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repo-local Codex skill for the pthread/shared-memory SDN plugin contract, document the proven dual-runtime browser/WasmEdge build direction, and push the resulting super-repo changes.

**Architecture:** The super-repo becomes the authoritative source for plugin build rules through `AGENTS.md` and a repo-local skill. Browser artifacts use Emscripten pthreads, while standalone WasmEdge artifacts must use a WASI threads toolchain rather than the Emscripten JS thread host. The six migrated packages still need runtime refactors before they can all adopt that standalone threaded path.

**Tech Stack:** Codex repo-local skills, Markdown reference files, Bash, CMake, Emscripten, wasi-sdk, Node test runner, WasmEdge-compatible standalone wasm, git submodules

---

### Task 1: Add Repo-Local Codex Skill Wiring

**Files:**
- Create: `AGENTS.md`
- Create: `skills/building-space-data-network-plugins/SKILL.md`
- Create: `skills/building-space-data-network-plugins/references/pthread-build-contract.md`
- Create: `skills/building-space-data-network-plugins/references/browser-shared-memory.md`
- Create: `skills/building-space-data-network-plugins/references/retrofit-checklist.md`

- [ ] **Step 1: Write the failing discoverability check**

```bash
test -f /Users/tj/software/space-data-network-plugins/AGENTS.md && \
test -f /Users/tj/software/space-data-network-plugins/skills/building-space-data-network-plugins/SKILL.md
```

Expected: command fails because the repo-local Codex wiring does not exist yet.

- [ ] **Step 2: Create the repo-level Codex entry point**

```md
# AGENTS.md

When working in this repository on plugin creation, migration, retrofit, wasm build settings,
browser harness compatibility, or `sdn-flow` compatibility, use the repo-local skill at
`skills/building-space-data-network-plugins/SKILL.md`.
```

- [ ] **Step 3: Create the skill and references**

```md
---
name: building-space-data-network-plugins
description: Use when creating, migrating, retrofitting, or verifying Space Data Network plugins in this repo family
---
```

The skill body should instruct Codex to:

- default all plugin wasm builds to Emscripten pthreads
- use shared-memory FlatBuffer invoke paths
- prohibit Cesium `TaskProcessor` and Cesium data structures
- require SDK/browser/WasmEdge/`sdn-flow` verification

- [ ] **Step 4: Run the discoverability check again**

```bash
test -f /Users/tj/software/space-data-network-plugins/AGENTS.md && \
test -f /Users/tj/software/space-data-network-plugins/skills/building-space-data-network-plugins/SKILL.md
```

Expected: command succeeds.

- [ ] **Step 5: Commit**

```bash
git -C /Users/tj/software/space-data-network-plugins add AGENTS.md skills
git -C /Users/tj/software/space-data-network-plugins commit -m "Add pthread plugin build skill"
```

### Task 2: Prove The Dual Build Pattern

**Files:**
- Modify: `packages/maneuver/src/cpp/CMakeLists.txt`
- Modify: `packages/maneuver/build.sh`
- Modify: `packages/cislunar/src/cpp/CMakeLists.txt`
- Modify: `packages/cislunar/build.sh`
- Modify: `packages/od/src/cpp/CMakeLists.txt`
- Modify: `packages/od/build.sh`
- Modify: `packages/sgp4-propagator/src/cpp/CMakeLists.txt`
- Modify: `packages/sgp4-propagator/build.sh`
- Modify: `packages/atmosphere/src/cpp/CMakeLists.txt`
- Modify: `packages/atmosphere/build.sh`
- Modify: `packages/fred/src/cpp/CMakeLists.txt`
- Modify: `packages/fred/build.sh`

- [ ] **Step 1: Write the failing contract scan**

```bash
rg -n "USE_PTHREADS|PTHREAD_POOL_SIZE|pthread" \
  /Users/tj/software/space-data-network-plugins/packages/{maneuver,cislunar,od,sgp4-propagator,atmosphere,fred}/{build.sh,src/cpp/CMakeLists.txt}
```

Expected: scan misses the required threaded build settings in one or more packages.

- [ ] **Step 2: Update each package CMake file**

Each `src/cpp/CMakeLists.txt` should be updated to express the shared threaded pattern:

```cmake
if(EMSCRIPTEN)
    set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -O3 -DNDEBUG -pthread")
    set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -pthread")
endif()
```

Then add the package-specific link flags needed for:

- `-s USE_PTHREADS=1`
- browser worker-capable output
- standalone WASI threads output
- stable manifest/invoke exports

- [ ] **Step 3: Update each package build script**

Each `build.sh` should standardize:

```bash
emcmake cmake -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD_DIR" -j"$(nproc 2>/dev/null || echo 4)"
```

and copy the full browser artifact set:

```bash
cp "$BUILD_DIR"/*.wasm "$DIST_DIR/"
cp "$BUILD_DIR"/*.js "$DIST_DIR/" 2>/dev/null || true
cp "$BUILD_DIR"/*.worker.js "$DIST_DIR/" 2>/dev/null || true
```

- [ ] **Step 4: Re-run the contract scan**

```bash
rg -n "USE_PTHREADS|PTHREAD_POOL_SIZE|pthread" \
  /Users/tj/software/space-data-network-plugins/packages/{maneuver,cislunar,od,sgp4-propagator,atmosphere,fred}/{build.sh,src/cpp/CMakeLists.txt}
```

Expected: the browser-targeted package path shows the threaded build markers.

### Task 3: Verify Runtime Preconditions

**Files:**
- Modify: `packages/maneuver/tests/sdk_compat.test.mjs`
- Modify: `packages/cislunar/tests/sdk_compat.test.mjs`
- Modify: `packages/od/tests/sdk_compat.test.mjs`
- Modify: `packages/sgp4-propagator/tests/sdk_compat.test.mjs`
- Modify: `packages/atmosphere/tests/sdk_compat.test.mjs`
- Modify: `packages/fred/tests/sdk_compat.test.mjs`

- [ ] **Step 1: Write the failing browser-asset assertions**

```js
import { existsSync } from 'node:fs';
import { strict as assert } from 'node:assert';

assert.equal(existsSync(workerAssetPath), true);
```

Expected: test fails for packages that do not yet emit the worker/bootstrap assets required by threaded browser builds.

- [ ] **Step 2: Update harness expectations**

Add package-local test logic that validates:

- browser bootstrap artifact exists
- worker asset exists when emitted by the package
- command invoke smoke still passes through the shared-memory ABI

- [ ] **Step 3: Re-run the package-local browser tests**

```bash
node --test tests/sdk_compat.test.mjs
```

Expected: package-local harness passes after the browser threaded assets and assertions are aligned.

### Task 4: Verify And Push Each Package Repo

**Files:**
- Verify only: `packages/maneuver`
- Verify only: `packages/cislunar`
- Verify only: `packages/od`
- Verify only: `packages/sgp4-propagator`
- Verify only: `packages/atmosphere`
- Verify only: `packages/fred`

- [ ] **Step 1: Run native tests where they exist**

```bash
cmake -S src/cpp -B build && cmake --build build -j4 && ctest --test-dir build --output-on-failure
```

Expected: native test packages pass. Skip only where the package has no native tests.

- [ ] **Step 2: Run wasm build and compatibility tests**

```bash
bash build.sh
node --test tests/sdk_compat.test.mjs
```

Expected: SDK compliance and browser shim smoke pass, while standalone WasmEdge threading is validated only after the package runtime no longer depends on the exception-heavy JSON-first path.

- [ ] **Step 3: Commit and push the package**

```bash
git add .
git commit -m "Enable pthread shared-memory plugin contract"
git push digitalarsenal HEAD:main
```

Expected: each package repo is published only after its standalone WasmEdge path actually matches the dual-runtime contract.

### Task 5: Update Super-Repo Catalog And Submodules

**Files:**
- Modify: `README.md`
- Modify: `.gitmodules` if package metadata changes
- Modify: submodule pointers for all changed packages

- [ ] **Step 1: Write the failing catalog scan**

```bash
rg -n "pthread|shared-memory|TaskProcessor" /Users/tj/software/space-data-network-plugins/README.md
```

Expected: README does not yet describe the threaded shared-memory standard.

- [ ] **Step 2: Update the catalog**

Add README language that states:

- the repo-local skill defines the pthread/shared-memory plugin contract
- Cesium `TaskProcessor` is not part of the architecture
- browser and WasmEdge paths share one ABI while using different runtime toolchains

- [ ] **Step 3: Stage updated submodule pointers**

```bash
git -C /Users/tj/software/space-data-network-plugins status --short
```

Expected: README plus changed package submodule pointers appear in status.

- [ ] **Step 4: Commit and push the super-repo**

```bash
git -C /Users/tj/software/space-data-network-plugins add README.md AGENTS.md skills docs packages
git -C /Users/tj/software/space-data-network-plugins commit -m "Add pthread plugin skill and retrofit packages"
git -C /Users/tj/software/space-data-network-plugins push origin master
```

Expected: the super-repo publishes the skill, docs, README update, and submodule pointer updates.
