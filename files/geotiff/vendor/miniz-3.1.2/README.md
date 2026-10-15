# miniz 3.1.2

This directory contains the unmodified `miniz.c`, `miniz.h`, and `LICENSE`
files from the official miniz 3.1.2 release:

- repository: `https://github.com/richgel999/miniz`
- release asset: `miniz-3.1.2.zip`
- release asset SHA-256:
  `f0446d863f9c19926ad9483c523fdc42e42b8d4a6a431d27e09d49c79a140d9a`
- tag commit: `77d0dce8627735138c51770d1799a1ef48f2117d`

The Starlink build verifies the vendored source hashes before concatenating
the upstream header and implementation into the signed WASM translation unit.
Archive, stdio, time, and zlib-compatibility APIs are disabled; only the
low-level deterministic DEFLATE/inflate codec is used.
