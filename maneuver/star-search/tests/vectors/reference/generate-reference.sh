#!/bin/sh
# Regenerate the Star parity oracle from the upstream Python program.
#
# The vectors in this directory are outputs of UzTak/star-search run UNMODIFIED.
# This script exists so the oracle is reproducible rather than asserted: it pins
# the upstream commit and verifies every SPICE kernel hash before running,
# because a different DE ephemeris silently changes every number in the output.
#
# Usage:  sh generate-reference.sh [work-dir]
# Needs:  git, uv, curl, shasum, ~2.5 GB disk (satellite SPKs are large).

set -eu

WORK="${1:-./star-reference-work}"
UPSTREAM_URL="https://github.com/UzTak/star-search.git"
UPSTREAM_COMMIT="5c667064e8fc5816a94fc1124906997560fd6c55"
NAIF="https://naif.jpl.nasa.gov/pub/naif/generic_kernels"

# path  sha256  (see README.md — a mismatch invalidates the whole oracle)
KERNELS="
lsk/naif0012.tls|678e32bdb5a744117a467cd9601cd6b373f0e9bc9bbde1371d5eee39600a039b
spk/planets/de440s.bsp|c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2
spk/satellites/mar099.bsp|9991e57b196bae1a096acc6e2afc6718102ee420d684695de0f0333064c046bc
spk/satellites/jup365.bsp|dbf016c01ba4d022154838000cf3f06962cf958ddc503a366f7fe8f81495c5cb
"

mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"

echo "==> upstream clone @ $UPSTREAM_COMMIT"
if [ ! -d "$WORK/star-search/.git" ]; then
  git clone "$UPSTREAM_URL" "$WORK/star-search"
fi
git -C "$WORK/star-search" fetch --all --quiet
git -C "$WORK/star-search" checkout --quiet "$UPSTREAM_COMMIT"

echo "==> SPICE kernels"
for entry in $KERNELS; do
  rel="${entry%%|*}"
  want="${entry##*|}"
  dst="$WORK/kernels/$rel"
  mkdir -p "$(dirname "$dst")"
  if [ ! -f "$dst" ]; then
    echo "    fetching $rel"
    curl -sS --fail -o "$dst" "$NAIF/$rel"
  fi
  got="$(shasum -a 256 "$dst" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    echo "FATAL: kernel hash mismatch for $rel" >&2
    echo "  expected $want" >&2
    echo "  got      $got" >&2
    echo "  A different ephemeris changes every number in the oracle. Refusing." >&2
    exit 1
  fi
done
echo "    all kernel hashes match"

echo "==> metakernel (relative paths, resolved from the upstream repo root)"
ln -sfn "$WORK/kernels" "$WORK/star-search/kernels"
cat > "$WORK/star-search/star/METAKERN.tm" <<'META'
KPL/MK

   Star SPICE meta-kernel — SDN port validation (relative paths from repo root).

\begindata

   KERNELS_TO_LOAD = (
      'kernels/lsk/naif0012.tls',
      'kernels/spk/planets/de440s.bsp',
      'kernels/spk/satellites/mar099.bsp',
      'kernels/spk/satellites/jup365.bsp'
   )

\begintext
META

echo "==> python env"
cd "$WORK/star-search"
uv sync
uv pip install -e .

for problem in test2_EMEJ test1_DVEGA; do
  echo "==> running $problem"
  uv run python star.py --problem "$problem" --metakernel star/METAKERN.tm
done

echo
echo "==> results in $WORK/star-search/output/"
wc -l "$WORK/star-search/output/"*.jsonl
shasum -a 256 "$WORK/star-search/output/"*.jsonl
echo
echo "Compare against *.summary.json in this directory:"
echo "  test2_EMEJ  33 rows    sha256 7a29f133d38a8d7e..."
echo "  test1_DVEGA 5952 rows  sha256 b44a0424b78080c1..."
echo
echo "Expected stage counts for test2_EMEJ (match these BEFORE comparing delta-Vs):"
echo "  encounters 6227 | leg0 114294 | leg1 301979 | flyby1 20111 | leg2 52289 | flyby2 90"
echo "  final trajectories 90 -> tfilter 33"
