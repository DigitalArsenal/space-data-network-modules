#!/usr/bin/env python3
"""Independent disk-normal oracle; run with .oracle/venv/bin/python offline.

All cases are static encounter-plane geometries (km, km^2), without an epoch.
Integration is scipy.integrate.dblquad of the bivariate normal density, in
standardized principal coordinates. There is no C++ invocation or CDF shortcut.
The orthogonal coordinate change leaves the hard-body disk invariant. Splitting
at normal-density landmarks prevents QUADPACK from missing narrow distributions.
"""
import argparse
import csv
import math
from pathlib import Path

import numpy as np
from scipy.integrate import dblquad

MODULE = Path(__file__).resolve().parents[1]
FIELDS = ['case', 'xi_km', 'zeta_km', 'sxx_km2', 'sxz_km2', 'szz_km2',
          'radius_km', 'expected', 'relative_tolerance', 'absolute_tolerance',
          'repair_expected', 'source', 'epoch']


def disk_probability(mean, covariance, radius, repair=False):
    """Direct two-variable integration, independent of production quadrature."""
    eigenvalues, basis = np.linalg.eigh(covariance)
    if repair:
        eigenvalues = np.maximum(eigenvalues, (1e-4 * radius) ** 2)
    if np.min(eigenvalues) <= 0:
        raise ValueError('non-positive covariance')
    mu = basis.T @ np.asarray(mean)
    sig = np.sqrt(eigenvalues)
    lo = max((-radius - mu[0]) / sig[0], -38.0)
    hi = min((radius - mu[0]) / sig[0], 38.0)
    if lo >= hi:
        return 0.0, 0.0

    def half_width(u):
        x = mu[0] + sig[0] * u
        return math.sqrt(max(0.0, radius * radius - x * x))

    def lower(u):
        return max((-half_width(u) - mu[1]) / sig[1], -38.0)

    def upper(u):
        return min((half_width(u) - mu[1]) / sig[1], 38.0)

    def density(v, u):
        return math.exp(-0.5 * (u * u + v * v)) / (2 * math.pi)

    # Tail landmarks and the disk center bound the adaptive work even at 1000:1.
    cuts = sorted(set([lo, hi] + [x for x in [-12, -8, -4, -1, 0, 1, 4, 8, 12,
                        -mu[0] / sig[0]] if lo < x < hi]))
    value, error = 0.0, 0.0
    for a, b in zip(cuts, cuts[1:]):
        val, err = dblquad(density, a, b, lower, upper, epsabs=1e-14, epsrel=2e-11)
        value += val
        error += err
    return value, error


def cases():
    # sigma_min/R, sigma_major/sigma_min, angle, principal mean/R.
    definitions = [
        ('isotropic-centered', 1, 1, 0, 0, 0),
        ('isotropic-high-pc', .2, 1, 0, .3, .2),
        ('isotropic-boundary', .05, 1, 0, 1, 0),
        ('isotropic-small-hbr', 10, 1, 0, 3, 2),
        ('rotated-aspect3', .5, 3, .61, 1.2, .3),
        ('rotated-aspect10', .2, 10, 1.1, .7, .1),
        ('rotated-aspect30', .4, 30, .4, 1.1, -.4),
        ('rotated-aspect100', .2, 100, .7, .5, .2),
        ('rotated-aspect1000', .2, 1000, 1.2, .6, .2),
        ('axis-near-x', .3, 10, 1e-14, .8, .2),
        ('axis-near-z', .3, 10, math.pi / 2 - 1e-14, .8, .2),
        ('sigma-equals-hbr', 1, 4, .2, 1.4, .9),
        ('high-pc-offset', .1, 3, .8, .6, .1),
        ('narrow-tail', .1, 3, .8, .2, 1.2),
        ('aspect100-centered', .05, 100, .9, 0, 0),
        ('aspect1000-centered', .01, 1000, .3, 0, 0),
        ('aspect1000-edge', .05, 1000, 1.0, .1, .97),
        ('aspect1000-tail', .2, 1000, .45, 2, 1.5),
        ('wide-correlated', 5, 20, -.6, 12, -3),
        ('negative-correlation', .8, 8, -.7, 2, .8),
    ]
    radius = .01
    for name, minor, aspect, theta, mx, mz in definitions:
        ct, st = math.cos(theta), math.sin(theta)
        basis = np.array([[ct, -st], [st, ct]])
        covariance = basis @ np.diag([(radius * minor * aspect) ** 2,
                                      (radius * minor) ** 2]) @ basis.T
        mean = basis @ (radius * np.array([mx, mz]))
        pc, error = disk_probability(mean, covariance, radius)
        if not pc > 0 or error > max(1e-12, pc * 1e-7):
            raise RuntimeError(f'{name}: uncertain integral {pc} +/- {error}')
        yield [name, *mean, covariance[0, 0], covariance[0, 1], covariance[1, 1],
               radius, pc, 1e-4, 0, 0, 'scipy.integrate.dblquad; pc-dblquad-oracle.py',
               'static geometry; no epoch']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=MODULE / 'src/cpp/tests/fixtures/pc_dblquad.csv')
    args = parser.parse_args()
    rows = list(cases())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(FIELDS)
        writer.writerows(rows)
    for row in rows:
        print(f'{row[0]:28s} {row[7]:.15e}')
    print(f'Wrote {len(rows)} independent dblquad geometries to {args.output}')


if __name__ == '__main__':
    main()
