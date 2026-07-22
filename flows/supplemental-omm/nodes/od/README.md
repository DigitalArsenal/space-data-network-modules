# Supplemental OMM OD node

This independently signed WASM node consumes bounded FSB chunks containing
complete provider-native response bytes. It reassembles and verifies each
logical response, parses MEME, SP3, ECF, CPF, or CCSDS OEM KVN inside the node,
then passes canonical in-memory OEM records to the existing threaded OD core.

Outputs are canonical size-prefixed OMM, OCM, and OBD records wrapped in paired
canonical/aligned FSB record-stream ports. Native ephemerides never leave the
node as mislabeled OEM frames and are never persisted.

Every successful fit batch also emits one paired canonical/aligned FSO
`CONFIGURE_INDEX` control. It carries the recursively flattened canonical SDS
result IDL and exact `$OMM`/`$OCM`/`$OBD` table bindings, allowing the
independent FlatSQL node to configure and append the batch atomically.
