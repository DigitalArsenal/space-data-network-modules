#!/bin/sh
# Copyright 2026 Edgesource Corporation
# SPDX-License-Identifier: Apache-2.0
#
# Builds and runs tests/fit_convergence.cpp natively against the OD fitter and the SGP4 base (foundation/sgp4-str3):
#   tests/fit_convergence.sh [--json out.json]     (from analysis/od; Eigen from EIGEN_DIR, default Homebrew's)
set -eu
cd "$(dirname "$0")/.."
EIGEN_DIR="${EIGEN_DIR:-/opt/homebrew/include/eigen3}"
BUILD="${FIT_CONVERGENCE_BUILD:-src/cpp/build-native/fit-convergence}"  # gitignored
mkdir -p "$BUILD"
c++ -std=c++17 -O2 -DNDEBUG -I src/cpp/include -I src/cpp/src -I ../../foundation/sgp4-str3/include -I "$EIGEN_DIR" \
  tests/fit_convergence.cpp src/cpp/src/sgp4_fitter.cpp src/cpp/src/meme_parser.cpp src/cpp/src/frame_transform.cpp \
  src/cpp/src/oem_parser.cpp -o "$BUILD/fit_convergence"
"$BUILD/fit_convergence" "$@"
