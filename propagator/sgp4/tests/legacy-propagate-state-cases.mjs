// propagate_state as a 1.1.0 host drives it: the four-field request layout,
// handles only, Earth-fixed answers. Each invocation's whole PIV response is
// recorded by SHA-256. tests/fixtures/propagate-state-1.1.0-digests.json holds
// the 1.1.0 artifact's digests (generate-propagate-state-digests.mjs), and
// legacyPropagateState.test.mjs requires the current artifact to reproduce
// them byte for byte.
import crypto from "node:crypto";

import { encodePivInvokeRequest, invokePivRaw } from "./lib/pivInvokeHelper.mjs";
import { encodeLegacyPropagatorBatchRequest, encodeOmmPayload, SYNTHETIC_SSO } from "./lib/payloadEncoders.mjs";

const OMM_TYPE = { schemaName: "orbpro.sds.omm", fileIdentifier: "$OMM", rootTypeName: "OMM" };
const PROP_TYPE = { schemaName: "orbpro.propagator.PropagatorBatchRequest", fileIdentifier: "PROP", rootTypeName: "PropagatorBatchRequest" };

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

export function legacyRounds(module) {
  const rounds = [];
  const call = (label, methodId, inputs, outputStreamCap = 0) => {
    rounds.push({ label, sha256: sha256(invokePivRaw(module, encodePivInvokeRequest({ methodId, inputs, outputStreamCap }))) });
  };
  const ingest = (label, payload) => call(label, "ingest_omm", [{ portId: "omm", payload, typeRef: OMM_TYPE }]);
  const propagate = (label, request, cap) =>
    call(label, "propagate_state", [{ portId: "request", payload: encodeLegacyPropagatorBatchRequest(request), typeRef: PROP_TYPE }], cap);

  ingest("ingest ISS", encodeOmmPayload());
  for (const epoch of [2460310.5, 2460310.75, 2460311.0]) propagate(`ISS at JD ${epoch}`, { epoch, entityHandles: [0], maxCount: 1 }, 1);
  ingest("ingest the synthetic sun-synchronous object", encodeOmmPayload(SYNTHETIC_SSO));
  propagate("all objects", { epoch: 2460310.6 }, 2);
  propagate("handles [1, 0]", { epoch: 2460310.6, entityHandles: [1, 0] }, 2);
  propagate("max_count 1", { epoch: 2460310.6, maxCount: 1 }, 1);
  propagate("handle beyond the catalog", { epoch: 2460310.6, entityHandles: [7] }, 1);
  propagate("output cap too small", { epoch: 2460310.6, entityHandles: [0, 1] }, 1);
  ingest("second ISS set", encodeOmmPayload({ epoch: "2024-01-02T00:00:00", meanAnomaly: 12.5 }));
  for (const epoch of [2460310.9, 2460311.2]) propagate(`ISS history at JD ${epoch}`, { epoch, entityHandles: [0], maxCount: 1 }, 1);
  return rounds;
}
