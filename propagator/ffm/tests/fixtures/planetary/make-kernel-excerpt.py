#!/usr/bin/env python3
"""CSPICE copies (never refits) the DE440s records covering a window, as files/orbit-products/tests/fixtures/de440/extract_2026.py does for 2026.

    make-kernel-excerpt.py <de440s.bsp> <start UTC> <stop UTC> <naif0012.tls> <out.bsp>

Uses NAIF spksub_c, which copies only the records each original segment needs for the window. Fixture preparation on the
host, never a production physics path. The source's SHA-256 is pinned in scripts/planetary-sources.json (de440s).
"""
import hashlib, os, sys
import spiceypy as spice

def main():
    source_path, start, stop, lsk, out = sys.argv[1:6]
    spice.furnsh(lsk)
    first, last = spice.str2et(start), spice.str2et(stop)
    if os.path.exists(out):
        os.remove(out)
    source = spice.dafopr(source_path)
    target = spice.spkopn(out, 'DE440S WINDOW COPY VIA NAIF SPKSUB', 0)
    count = 0
    try:
        spice.dafbfs(source)
        while spice.daffna():
            descriptor = spice.dafgs(5)
            name = spice.dafgn()
            spice.spksub(source, descriptor, name, first, last, target)
            count += 1
    finally:
        spice.spkcls(target)
        spice.dafcls(source)
    digest = hashlib.sha256(open(out, 'rb').read()).hexdigest()
    print(f'{out}: {count} segments, {os.path.getsize(out)} bytes, SHA-256 {digest}')
    sys.stdout.flush()

if __name__ == '__main__':
    main()
    os._exit(0)
