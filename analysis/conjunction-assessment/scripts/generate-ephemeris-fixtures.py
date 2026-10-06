#!/usr/bin/env python3
"""Offline synthetic fixtures; native upstream ERFA reference, no module oracle."""
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parents[1]
erfa = root.parents[1] / 'higherpop/third_party/erfa'
cache = root / '.sdk-build/ephemeris-fixtures'
cache.mkdir(parents=True, exist_ok=True)
files = sorted(p for p in erfa.glob('*.c') if p.name not in ['t_erfa_c.c', 't_erfa_c_extra.c', 'erfaversion.c'])
subprocess.run(['c++', '-std=c++17', '-O2', '-Wno-deprecated', '-I'+str(erfa), '-I'+str(root/'src/cpp/include'), str(root/'scripts/generate-ephemeris-fixtures.cpp'), *map(str, files), '-o', str(cache/'generate')], check=True)
subprocess.run([str(cache/'generate'), str(root/'tests/fixtures/ephemeris-upload')], check=True)
