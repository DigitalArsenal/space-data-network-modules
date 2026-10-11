// The C++ headers of the Space Data Standards this module reads and writes (scripts/lib/sds-cpp-headers.mjs),
// from the spacedatastandards.org and flatc-wasm packages it pins.
import createFlatc from "flatc-wasm/module";
import { generateSdsHeaders as generate } from "../../scripts/lib/sds-cpp-headers.mjs";

export const generateSdsHeaders = (roots, from) => generate(roots, from, createFlatc);
