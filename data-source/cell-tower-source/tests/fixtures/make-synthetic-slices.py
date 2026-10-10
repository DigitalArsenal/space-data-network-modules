#!/usr/bin/env python3
"""Writes ised-sms-tafl.slice.zip and comreg-siteviewer.sample.pb with invented rows.

ISED's TAFL terms allow non-commercial reproduction only, and ComReg's SiteViewer
licence could not be verified, so no row of either is kept in this tree. These
files keep the formats the decoders read and the populations the tests count
(200 ISED records, 250 ComReg masts); every identifier, name, coordinate and
licensee is invented from a seeded generator. Run in place:
    python3 make-synthetic-slices.py
"""
import random, zipfile, io, os

here = os.path.dirname(os.path.abspath(__file__))
r = random.Random(20261010)


def ised():
    # Headerless positional CSV with a UTF-8 BOM, 60+ columns; ordinals used by the
    # decoder: 2 frequency record id, 31 location, 40 latitude, 41 longitude, 54 licensee.
    rows = []
    for k in range(200):
        c = ['TX', '999', f'{9000001 + k:010d}', '3', 'D', 'B', '', '', '', 'D', '1000', '1M00P0XAN', 'OTHER-DIGITAL', '1',
             f'{23 + r.random():.5f}', '100', '2.5', '1.', '.064', '-', '-', '* Synthetic manufacturer *', 'OMNI', '7.9984', '', '', '0', 'B', '9', '', '',
             f'SYNTHETIC SITE {k + 1:03d} XX', '', f'S{k + 1:02d}', '6', 'AL', '', '', '', 'ON',
             f'{43 + 12 * r.random():.4f}', f'{-120 + 50 * r.random():.4f}', str(r.randrange(50, 900)), '9', '', '', '',
             f'{r.randrange(10 ** 8, 10 ** 9)}-{r.randrange(1, 9):03d}', '8', '800', 'S', 'G', '2026-01-01', f'{r.randrange(10 ** 11, 10 ** 12)}',
             f'SYNTHETIC LICENSEE {1 + k % 7}', 'Synthetic address', '', '', '0', '0', '']
        rows.append(','.join(f'"{x}"' for x in c))
    first = rows[0].split(',')
    text = '﻿' + '\n'.join(rows) + '\n'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr(zipfile.ZipInfo('TAFL_LTAF.csv', (2026, 1, 1, 0, 0, 0)), text.encode('utf-8'), compress_type=zipfile.ZIP_DEFLATED)
    open(os.path.join(here, 'ised-sms-tafl.slice.zip'), 'wb').write(buf.getvalue())
    return [x.strip('"') for x in first]


def varint(v):
    v &= (1 << 64) - 1
    out = bytearray()
    while True:
        b = v & 0x7F
        v >>= 7
        if v:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def comreg():
    out = bytearray()
    first = None
    counties = ['CE', 'CK', 'DN', 'KY']
    for k in range(250):
        ident = f'1-SYN_{counties[k % 4]}_{1000 + 7 * k}-3GQQVUXZ'.encode()
        lat = round(51.5 + 3.5 * r.random(), 6)
        lon = round(-10.2 + 4.6 * r.random(), 6)
        inner = b'\x0a' + varint(len(ident)) + ident + b'\x10\x01' + b'\x18' + varint(round(lat * 1e6)) + b'\x20' + varint(round(lon * 1e6))
        out += b'\x0a' + varint(len(inner)) + inner
        first = first or (ident.decode(), lat, lon)
    open(os.path.join(here, 'comreg-siteviewer.sample.pb'), 'wb').write(bytes(out))
    return first


print('ised first:', ised()[2], ised.__name__)
print('comreg first:', comreg())
