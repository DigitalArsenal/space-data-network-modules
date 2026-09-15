// Reuse the canonical ACW evaluator in other C++ SDK modules. This is source
// composition at build time, not a runtime JavaScript implementation.
import fs from 'node:fs/promises';
const read = (file) => fs.readFile(new URL(file, import.meta.url), 'utf8');
export async function createAccessEvaluatorSource({ acwHeader }) {
  // Each consuming package generates bindings from its own locked SDS version.
  if (typeof acwHeader !== 'string') throw new Error('Generated ACW header is required');
  let source = await read('src/access_plugin.cpp');
  source = source.slice(0, source.indexOf('}  // namespace\n\nextern "C"')) + '} // namespace sdn_acw\n';
  source = source.replace('#include "access_abi.h"', await read('src/access_abi.h'))
    .replace('#include "ACW_generated.h"', acwHeader)
    .replace('#include "../../../propagator/events/src/event_locator.hpp"', await read('../../propagator/events/src/event_locator.hpp'))
    .replace('#include "constraint_engine.cpp.inc"', await read('src/constraint_engine.cpp.inc'))
    .replace('#include "constraint_polynomials.hpp"', await read('src/constraint_polynomials.hpp'))
    .replace('namespace {', 'namespace sdn_acw {');
  return source;
}
