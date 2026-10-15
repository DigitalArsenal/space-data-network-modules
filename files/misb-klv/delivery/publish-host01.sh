#!/bin/zsh
# Offer files/misb-klv and files/geotiff in host-01's module catalog
# (sdn.spaceaware.io /.well-known/sdn/modules.pmm), so the console's IMAGERY tab
# can attach them (KLV full-motion video, GeoTIFF / COG). Until they are offered,
# those layer types say in STATUS that the module is not offered.
#
# FOR THE OWNER TO RUN: a production host write. Nothing here runs from an agent.
#
#   zsh files/misb-klv/delivery/publish-host01.sh             # dry run: every check, nothing written
#   PUBLISH=1 zsh files/misb-klv/delivery/publish-host01.sh   # does it
#
# ADDITIVE: two new rows (files/{misb-klv,geotiff}/delivery/modules-catalog.entry.json:
# ANONYMOUS, OPTIONAL, Parser, DEFAULT_ENABLED false) and their two plaintext
# artifacts, content-addressed. No existing row or artifact changes.
# BYTES: each module's committed dist/isomorphic/module.wasm at REF; its sha256 and
# size must equal the entry's CONTENT_HASH and ARTIFACT_SIZE_BYTES (neither module
# carries an SDS publication trailer, so the node computes the same hash). Both
# rows were loaded, hashed, built, validated and encoded with the node's own
# internal/pmm code before they were committed.
# LIVE: the node's pmm plugin re-reads the catalog and re-hashes every artifact on
# its 6 h refresh. NO daemon restart: pmmPlugin.Start fails closed and host-01
# terminates TLS on :443. A refresh that fails keeps serving the old manifest.
# ROLLBACK: the script prints the backup to move back over the catalog.
set -euo pipefail

MODS=${MODS:-$HOME/software/spacedatanetwork-stack/repos/main-packages/space-data-network-modules}
REF=${REF:-origin/main}
TARGET=${TARGET:-space-data-network-01}
ROOT=/opt/data/sdn-module-delivery/modules
CATALOG=$ROOT/modules-catalog.json
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
MODULE_DIRS=(files/misb-klv files/geotiff)

run() {
  print -r -- "+ $*"
  if [[ ${PUBLISH:-0} == 1 ]]; then "$@"; fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 1. The rows and the bytes, from the commit REF names (fetched, on origin/main).
git -C "$MODS" fetch -q origin main
COMMIT=$(git -C "$MODS" rev-parse "$REF^{commit}")
git -C "$MODS" merge-base --is-ancestor "$COMMIT" origin/main || { print -r -- "STOP: $COMMIT is not on origin/main."; exit 1; }
print -r -- "space-data-network-modules $COMMIT"
HASHES=()
for d in $MODULE_DIRS; do
  git -C "$MODS" show "$COMMIT:$d/delivery/modules-catalog.entry.json" > "$TMP/${d:t}.entry.json"
  id=$(jq -r .MODULE_ID "$TMP/${d:t}.entry.json")
  want=$(jq -r .CONTENT_HASH "$TMP/${d:t}.entry.json")
  wantsize=$(jq -r .ARTIFACT_SIZE_BYTES "$TMP/${d:t}.entry.json")
  [[ $(jq -r .source_artifact "$TMP/${d:t}.entry.json") == "artifacts/$want.wasm" ]] || { print -r -- "STOP: $id source_artifact is not artifacts/$want.wasm."; exit 1; }
  git -C "$MODS" show "$COMMIT:$d/dist/isomorphic/module.wasm" > "$TMP/$want.wasm"
  sha=$(shasum -a 256 "$TMP/$want.wasm" | cut -d' ' -f1); size=$(wc -c < "$TMP/$want.wasm" | tr -d ' ')
  print -r -- "$id $(jq -r .VERSION "$TMP/${d:t}.entry.json"): sha256 $sha, $size bytes"
  [[ $sha == "$want" && $size == "$wantsize" ]] || { print -r -- "STOP: $id artifact is not the entry's ($want, $wantsize bytes)."; exit 1; }
  HASHES+=($want)
done
jq -s . "$TMP"/*.entry.json > "$TMP/rows.json"
IDS=$(jq -c '[.[].MODULE_ID]' "$TMP/rows.json")

# 2. Read-only checks on host-01: the catalog parses, neither MODULE_ID is in it
#    yet, and the artifacts directory exists.
ssh "$TARGET" "set -e; test -d $ROOT/artifacts; jq -e '.entries | type == \"array\"' $CATALOG > /dev/null; \
  echo \"modules-catalog.json: \$(jq '.entries | length' $CATALOG) rows\"; \
  n=\$(jq --argjson ids '$IDS' '[.entries[] | select(.MODULE_ID as \$m | \$ids | index(\$m))] | length' $CATALOG); \
  if [ \"\$n\" != 0 ]; then echo \"STOP: $CATALOG already has \$n of these rows\"; exit 1; fi; \
  echo 'none of these rows yet; artifacts dir present'"

# 3. Upload to /tmp; on host-01 hash each upload against the entry's CONTENT_HASH,
#    install the artifacts content-addressed, build the new catalog beside the old
#    one, check it (exactly two more rows, no duplicate MODULE_ID), back the old
#    one up and move the new one in.
for h in $HASHES; do
  run scp "$TMP/$h.wasm" "$TARGET:/tmp/$h.wasm"
done
run scp "$TMP/rows.json" "$TARGET:/tmp/imagery-rows-$STAMP.json"
run ssh "$TARGET" "set -e; S=\$([ \$(id -u) = 0 ] || echo sudo); \
  for h in ${HASHES[*]}; do \
    got=\$(sha256sum /tmp/\$h.wasm | cut -d' ' -f1); [ \"\$got\" = \"\$h\" ] || { echo \"HASH MISMATCH /tmp/\$h.wasm: \$got\"; exit 1; }; \
    \$S install -o \$(stat -c %U $CATALOG) -g \$(stat -c %G $CATALOG) -m 0644 /tmp/\$h.wasm $ROOT/artifacts/\$h.wasm; rm -f /tmp/\$h.wasm; \
  done; \
  before=\$(jq '.entries | length' $CATALOG); \
  jq --slurpfile rows /tmp/imagery-rows-$STAMP.json '.entries += \$rows[0]' $CATALOG > /tmp/modules-catalog.new-$STAMP.json; \
  after=\$(jq '.entries | length' /tmp/modules-catalog.new-$STAMP.json); \
  dups=\$(jq '[.entries[].MODULE_ID] | length - (unique | length)' /tmp/modules-catalog.new-$STAMP.json); \
  [ \"\$after\" = \$((before + 2)) ] && [ \"\$dups\" = 0 ] || { echo \"STOP: new catalog has \$after rows (was \$before), \$dups duplicate ids\"; exit 1; }; \
  \$S cp -p $CATALOG $CATALOG.bak-$STAMP; \
  \$S install -o \$(stat -c %U $CATALOG) -g \$(stat -c %G $CATALOG) -m \$(stat -c %a $CATALOG) /tmp/modules-catalog.new-$STAMP.json $CATALOG.new-$STAMP; \
  \$S mv $CATALOG.new-$STAMP $CATALOG; rm -f /tmp/modules-catalog.new-$STAMP.json /tmp/imagery-rows-$STAMP.json; \
  echo \"catalog \$before -> \$after rows; rollback: mv $CATALOG.bak-$STAMP $CATALOG\""

print -r -- "Live on the node's next 6 h pmm refresh (no restart). Then:"
for d in $MODULE_DIRS; do
  print -r -- "  curl -sI https://sdn.spaceaware.io$(jq -r .ARTIFACT_PATH "$TMP/${d:t}.entry.json")   # 200, application/wasm"
done
print -r -- "  curl -s -H 'Accept: application/json' https://sdn.spaceaware.io/.well-known/sdn/modules.pmm | jq '[.MODULES[].MODULE_ID] - ([.MODULES[].MODULE_ID] - $IDS)'"
