// The fit engine as one translation unit of source text: ERFA, foundation/frames' axis engine, and this module's
// engine headers (src/types.hpp, engine.hpp, ussf.hpp, frames.hpp, fit.hpp, window.hpp). It holds no SDS record and no
// SDK header, so it compiles alone (the signed OD node of flows/supplemental-omm links it as an object) and as the first
// part of this module's own single translation unit (build.mjs).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { composeErfaTranslationUnit } from "../../foundation/frames/erfa-amalgamation.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const framesSource = path.resolve(root, "../../foundation/frames/src");
const text = (file) => fs.readFile(file, "utf8");

export const ENGINE_HEADERS = ["types.hpp", "engine.hpp", "ussf.hpp", "frames.hpp", "fit.hpp", "window.hpp"];
const LOCAL_HEADERS = /^#include "(types|engine|ussf|frames|fit|window|records|sds)\.hpp"\n/gm;

/** A header of src/ as text for a concatenated unit: no `#pragma once`, no include of another header of src/. */
export async function localHeader(name) {
  return (await text(path.join(root, "src", name))).replace(/^#pragma once\n/m, "").replace(LOCAL_HEADERS, "");
}

/** { source, erfaFileCount }: the engine translation unit. `defines` are `NAME=value` strings placed ahead of it. */
export async function composeEngineSource({ defines = [] } = {}) {
  const erfa = await composeErfaTranslationUnit();
  const bodyModels = await text(path.join(framesSource, "iau_body_models.hpp"));
  const axisEngine = (await text(path.join(framesSource, "axis_engine.hpp")))
    .replace('#include "iau_body_models.hpp"', "")
    .replace(/extern "C" \{\n#include "erfa\.h"\n#include "erfam\.h"\n\}\n/, "// ERFA declarations are amalgamated ahead of this header.\n");
  if (axisEngine.includes('#include "erfa.h"')) throw new Error("foundation/frames/axis_engine.hpp includes ERFA in a form this build does not strip.");
  const parts = [
    ...defines.filter(Boolean).map((d) => `#define ${d.replace("=", " ")}`),
    erfa.source,
    bodyModels,
    axisEngine,
    ...(await Promise.all(ENGINE_HEADERS.map(localHeader))),
  ];
  return { source: parts.join("\n\n"), erfaFileCount: erfa.fileCount };
}
