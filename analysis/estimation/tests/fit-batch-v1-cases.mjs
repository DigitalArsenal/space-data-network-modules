// Version-1 requests of fit_batch and their replay digests. Every round of
// each case (its query rounds and the final, complete replay) is recorded as
// the SHA-256 of the request payload and of the module's result payload.
// tests/fixtures/fit-batch-v1-digests.json holds the digests the version-1
// artifact produced (generate-fit-batch-v1-digests.mjs); the version-2
// module must reproduce them byte for byte.
//
// Cases: the four Orekit comparisons of batch_fit.test.mjs, and two
// variants that reach the version-1 a priori and editing paths: GPS-pv in RTN
// axes with a 7 x 7 a priori (100 km, 10 m/s, AGOM 0.01 m^2/kg), and
// LEO400-drag with that a priori (B 0.02 m^2/kg) and 3-sigma editing.
import crypto from 'node:crypto';
import { REFERENCE, fit, fitRequest } from './batch-fit-fixtures.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function apriori(parameterSigma) {
  const sigmas = [1e5, 1e5, 1e5, 10, 10, 10, parameterSigma];
  return sigmas.flatMap((a, i) => sigmas.map((b, j) => (i === j ? a * b : 0)));
}

export function v1Cases() {
  const byName = new Map(REFERENCE.cases.map((c) => [c.name, c]));
  const cases = REFERENCE.cases.flatMap((c) => (c.rtnCovariances ? [[c, 'sigmas'], [c, 'rtn']] : [[c, 'sigmas']]))
    .map(([c, variant]) => ({ id: `${c.name}-${variant}`, c, envelope: () => fitRequest(c, variant) }));
  cases.push({ id: 'GPS-pv-rtn-apriori', c: byName.get('GPS-pv'), envelope: () => {
    const e = fitRequest(byName.get('GPS-pv'), 'rtn');
    e.request.batchOptions.aprioriCovariance = apriori(0.01);
    return e;
  } });
  cases.push({ id: 'LEO400-drag-apriori-edit', c: byName.get('LEO400-drag'), envelope: () => {
    const e = fitRequest(byName.get('LEO400-drag'), 'sigmas');
    Object.assign(e.request.batchOptions, { aprioriCovariance: apriori(0.02), sigmaEditThreshold: 3 });
    return e;
  } });
  return cases;
}

// Runs one case to completion and returns each round's digests.
export async function replayDigests(estimator, hpop, entry) {
  const requests = [];
  await fit(estimator, hpop, entry.c, entry.envelope(), requests);
  const rounds = [];
  for (const request of requests) {
    const response = await estimator.invoke(request);
    rounds.push({
      request: sha256(request.inputs[0].payload),
      status: response.statusCode,
      result: sha256(response.outputs.find((o) => o.portId === 'result').payload),
    });
  }
  return rounds;
}
