// The version-1 paths of fit_batch and their recorded results. On a
// monotone Gauss-Newton path version 3 takes the same steps as version 1, so
// it must reproduce version 1's estimate, covariance and chi-square.
// tests/fixtures/fit-batch-v1-estimates.json holds what the version-1
// algorithm gave for these requests without domains
// (generate-fit-batch-v1-estimates.mjs); version 3 runs them with the
// domains of propagator/ffm's table, which none of these fits reaches.
//
// Cases: the four Orekit comparisons of batch_fit.test.mjs, and two
// variants that reach the version-1 a priori and editing paths: GPS-pv in RTN
// axes with a 7 x 7 a priori (100 km, 10 m/s, AGOM 0.01 m^2/kg), and
// LEO400-drag with that a priori (B 0.02 m^2/kg) and 3-sigma editing.
import { REFERENCE, fit, fitRequest } from './batch-fit-fixtures.mjs';

function apriori(parameterSigma) {
  const sigmas = [1e5, 1e5, 1e5, 10, 10, 10, parameterSigma];
  return sigmas.flatMap((a, i) => sigmas.map((b, j) => (i === j ? a * b : 0)));
}

export function v1Cases() {
  const byName = new Map(REFERENCE.cases.map((c) => [c.name, c]));
  const cases = REFERENCE.cases.flatMap((c) => (c.rtnCovariances ? [[c, 'sigmas'], [c, 'rtn']] : [[c, 'sigmas']]))
    .map(([c, variant]) => ({ id: `${c.name}-${variant}`, c, envelope: (o) => fitRequest(c, variant, o) }));
  cases.push({ id: 'GPS-pv-rtn-apriori', c: byName.get('GPS-pv'), envelope: (o) => {
    const e = fitRequest(byName.get('GPS-pv'), 'rtn', o);
    e.request.batchOptions.aprioriCovariance = apriori(0.01);
    return e;
  } });
  cases.push({ id: 'LEO400-drag-apriori-edit', c: byName.get('LEO400-drag'), envelope: (o) => {
    const e = fitRequest(byName.get('LEO400-drag'), 'sigmas', o);
    Object.assign(e.request.batchOptions, { aprioriCovariance: apriori(0.02), sigmaEditThreshold: 3 });
    return e;
  } });
  return cases;
}

// Runs one case to completion: its estimate, covariance, chi-square and
// propagation rounds.
export async function v1Result(estimator, ffm, entry, { domains = true } = {}) {
  const { result, rounds } = await fit(estimator, ffm, entry.c, entry.envelope({ domains }));
  const b = result.batchFit;
  return { status: result.status, rounds, estimate: [...b.estimate], covariance: [...b.covariance], chiSquare: b.chiSquare };
}
