# Supplemental OMM OD node

This independently signed WASM node consumes bounded FSB chunks containing
complete provider-native response bytes. It reassembles and verifies each
logical response, parses MEME, SP3, ECF, CPF, or CCSDS OEM KVN inside the node,
then passes canonical in-memory OEM records to the existing threaded OD core.

Outputs are canonical size-prefixed OMM and OCM records wrapped in paired
canonical/aligned FSB record-stream ports. Native ephemerides never leave the
node as mislabeled OEM frames and are never persisted. Up to sixteen complete
in-memory objects enter the bounded work-stealing fitter together; fitted
results retain input order and are emitted as one FlatSQL transaction per
source continuation.

Normal orbital trajectories retain strict epoch-paired OMM/OCM output. A
finite, ordered, uniformly sampled trajectory ending at or below the WGS-72
120 km reentry interface bypasses SGP4 fitting and emits one complete TEME
state-series OCM with no OMM, covariance, or orbit-determination block.

Every successful source fit also emits one paired canonical/aligned FSO
`CONFIGURE_INDEX` control. It carries the recursively flattened canonical SDS
result IDL and exact `$OMM`/`$OCM` table bindings, allowing the independent
FlatSQL node to configure and append every source transaction atomically.
