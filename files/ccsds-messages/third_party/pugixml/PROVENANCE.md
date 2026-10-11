# pugixml 1.15

Light-weight, simple and fast XML parser for C++ by Arseny Kapoulkine, MIT licence
(`LICENSE.md`, copied unmodified).

- Source: `https://github.com/zeux/pugixml/releases/download/v1.15/pugixml-1.15.tar.gz`
- SHA-256 of the tarball: `655ade57fa703fb421c2eb9a0113b5064bddb145d415dd1f88c79353d90d511a`
- Files: `src/pugixml.cpp`, `src/pugixml.hpp`, `src/pugiconfig.hpp`, unmodified.

Built with `PUGIXML_NO_EXCEPTIONS` and `PUGIXML_NO_XPATH`, defined by the build before
the library is included (`build.mjs` for the module, the compiler line for the native
tests); the library is never edited. The module reads and writes NDM/XML through it and
nothing else.
