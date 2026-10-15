import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from '../eop-request/build.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
const read=p=>fs.readFile(path.resolve(root,p),'utf8');
// $ICN (the job in HttpResponse.CONTEXT), $FIL (a raw body) and $EOP (the records) are inlined from the SDS checkout.
await build(root,[await read('../eop-request/src/eop_wire.hpp'),'#include "FIL_generated.h"','#include "EOP_generated.h"',
 await read('../../files/orbit-products/src/sha256.hpp'),await read('src/module.cpp')],['ICN','FIL','EOP']);
