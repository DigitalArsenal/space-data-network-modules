# Incremental FlatSQL WASM node

This directory packages FlatSQL as the same independently instantiated signed
WASM node used by the Supplemental OMM flow. Its node-owned persistence keeps a
digest-checked base snapshot and generation-scoped, bounded append deltas.
Steady one-object drains therefore persist only the new canonical record bytes;
they do not rewrite the growing catalog snapshot after every invocation.

Each committed append carries a receipt keyed strictly by request ID, with the
payload SHA-256, byte count, and record count retained as conflict metadata.
Exact response-loss retries are no-ops across restart and compaction; reuse of a
committed request ID for different bytes or metadata is rejected. The node marks its
cached state uncertain before a base or WAL commit and restores the
storage-selected generation after any interrupted boundary. WAL growth remains
bounded at 32,768 entries, 65,536 keys, and 512 MiB. Those bounds admit the
audited 8,825-file Starlink run even under the conservative assumption that its
OMM/OCM streams persist as separate append transactions. The exact
composed scheduler normally concatenates the two streams into one transaction
per fitted object. The projected 263,055,600 fitted bytes require no
intermediate full-base rewrite and leave more than 273 million bytes (about
261 MiB) below the 512 MiB byte ceiling. Explicit snapshots
compact the WAL.

This is first-full-run capacity evidence, not an unbounded retention claim.
Repeated catalog generations still require an approved generic member identity
and keep-latest-K replacement policy. This node does not infer
application-specific membership or silently discard older records.

The C++ node surface is retained here because Supplemental OMM changes are
restricted to this flow directory. The build stages the canonical FlatSQL core
from `repos/main-packages/flatsql/cpp`, replaces only its SDN node surface with
the checked-in source here, and signs the resulting standalone artifact. The
artifact remains a distinct plugin with its own manifest, signature, hash, and
runtime instance; it is not linked into another flow node.

Builds resolve `SDN_LOCAL_EMSDK_DIR` or the repository's
`analysis/od/deps/emsdk` checkout and fail closed if that in-repository
toolchain is unavailable. Machine-global and Homebrew Emscripten are not used.
