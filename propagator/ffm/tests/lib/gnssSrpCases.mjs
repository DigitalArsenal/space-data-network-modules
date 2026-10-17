// The Orekit GNSS radiation-pressure cases (fixtures/orekit/orekit-gnss-srp-
// reference.json) as PRW execution requests: GNSS_BOX_WING with GNSS_BLOCK,
// or NONE with ECOM2 and its eleven DYNAMIC_PARAMETERS. Representation only.
import fs from 'node:fs';
import { requestInputs } from './orekitCases.mjs';
import { makeTable, sds } from './prwCodec.mjs';

export const REFERENCE = JSON.parse(fs.readFileSync(new URL('../fixtures/orekit/orekit-gnss-srp-reference.json', import.meta.url), 'utf8'));
export const ECOM2_PARAMETERS = ['ECOM2_D0', 'ECOM2_Y0', 'ECOM2_B0', 'ECOM2_D2_COS', 'ECOM2_D2_SIN', 'ECOM2_D4_COS', 'ECOM2_D4_SIN', 'ECOM2_B1_COS', 'ECOM2_B1_SIN', 'ECOM2_B3_COS', 'ECOM2_B3_SIN'];
const ECOM2_FIELDS = ['D0_M_S2', 'Y0_M_S2', 'B0_M_S2', 'D2_COS_M_S2', 'D2_SIN_M_S2', 'D4_COS_M_S2', 'D4_SIN_M_S2', 'B1_COS_M_S2', 'B1_SIN_M_S2', 'B3_COS_M_S2', 'B3_SIN_M_S2'];
const ecom2 = () => makeTable('PRWEcom2', Object.fromEntries(ECOM2_FIELDS.map((k, i) => [k, REFERENCE.ecom2[i]])));

// One Orekit GNSS case as a request: point mass and radiation pressure only.
export function inputs(c, edit) {
  const k = { ...c, srp: true, thirdBodies: false, degree: 0, drag: false, ...(c.model === 'ecom2' ? { parameters: ECOM2_PARAMETERS } : {}) };
  return requestInputs(k, { edit: (exec) => {
    // The box-wing's mass: the force configuration's, which a stated state mass overrides.
    exec.FORCES.INITIAL_MASS_KG = exec.INITIAL.MASS_KG = c.massKg;
    if (c.model === 'boxwing') {
      exec.FORCES.RADIATION_PRESSURE_MODEL = sds.prwRadiationPressureFamily.GNSS_BOX_WING;
      exec.FORCES.GNSS_BLOCK = sds.prwGnssSpacecraftBlock[c.block === 'IIF' ? 'GPS_IIF' : 'GPS_IIR'];
    } else {
      exec.FORCES.RADIATION_PRESSURE_MODEL = sds.prwRadiationPressureFamily.NONE;
      exec.FORCES.ECOM2 = ecom2();
    }
    edit?.(exec);
  } });
}
