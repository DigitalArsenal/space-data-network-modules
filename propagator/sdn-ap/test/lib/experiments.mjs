// The orbit-accuracy-experiments libraries the archive replays import (xp2-fit-design, xp-atmosphere-merit,
// ffm-atmosphere-xm3, operator-theory, sdn-gp-starlink-ffm-match, harness): the vendored copy at commit c89f2bc
// (../vendor/orbit-accuracy-experiments-c89f2bc/PROVENANCE.md). SDN_AP_EXPERIMENTS_ROOT names a checkout for
// development only; the E2Es run with it unset.
import {fileURLToPath} from 'node:url';

export const experiments = process.env.SDN_AP_EXPERIMENTS_ROOT ??
  fileURLToPath(new URL('../vendor/orbit-accuracy-experiments-c89f2bc', import.meta.url));
