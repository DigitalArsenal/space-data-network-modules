#!/usr/bin/env python3
"""Samples a reconstructed spacecraft trajectory from a NAIF SPK into the compact JSON fixture tests/planetary.e2e.mjs scores FFM against.

    extract-truth.py <spk> <target> <center> <start UTC> <stop UTC> <step s> <label> <out.json> [--lsk naif0012.tls]

The states are NAIF's, geometric, in the J2000 (ICRF-aligned) frame, km and km/s relative to <center>, at
TDB seconds past J2000 (the SPK's ephemeris time): nothing is fitted, smoothed or converted. The fixture
records the SPK's name and SHA-256 (scripts/planetary-sources.json pins it) so the sampling can be repeated.
Reading uses CSPICE (spiceypy); conformance tooling only, never shipped.

Run with an interpreter that has spiceypy; call os._exit after flushing because spiceypy can stall at exit.
"""
import hashlib, json, os, sys
import spiceypy as sp

def main():
    args = sys.argv[1:]
    lsk = 'naif0012.tls'
    if '--lsk' in args:
        i = args.index('--lsk'); lsk = args[i + 1]; del args[i:i + 2]
    spk, target, center, start, stop, step, label, out = args
    sp.furnsh(lsk)
    sp.furnsh(spk)
    t0 = sp.str2et(start)
    t1 = sp.str2et(stop)
    step = float(step)
    n = int(round((t1 - t0) / step)) + 1
    epochs, states = [], []
    for k in range(n):
        et = t0 + k * step
        state, _ = sp.spkez(int(target), et, 'J2000', 'NONE', int(center))
        epochs.append(round(et, 6))
        states.append([round(float(v), 9) for v in state])
    digest = hashlib.sha256(open(spk, 'rb').read()).hexdigest()
    data = {
        'label': label,
        'source': {'file': os.path.basename(spk), 'sha256': digest},
        'target': int(target), 'center': int(center), 'frame': 'J2000', 'timeScale': 'TDB',
        'start': start, 'stop': stop, 'stepSeconds': step,
        'units': {'position': 'km', 'velocity': 'km/s', 'epoch': 'seconds past J2000 TDB'},
        'epochs': epochs, 'states': states,
    }
    with open(out, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    print(f'{label}: {n} states, {os.path.getsize(out)} bytes')
    sys.stdout.flush()

if __name__ == '__main__':
    main()
    os._exit(0)
