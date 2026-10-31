#!/bin/bash
# XM7: Orekit 13.1 on LEO400 W1 (20 x 20, Sun, Moon, SRP, NRLMSISE-00 on the CSSI-layout rows) at the storm epochs, switch 9 = 1 and -1.
cd "/private/tmp/claude-501/-Users-tj-software-spacedatanetwork-stack/ccb46d52-d201-41c2-95e9-8200325eb018/scratchpad/xm7/orekit" || exit 1
for E in 2026-01-19T00:00:00 2026-01-20T12:00:00 2026-01-25T00:00:00; do
  for S in 1 -1; do
    O="out-${E%%T*}-${E##*T}-s$S.json"; O=$(echo "$O" | tr -d ':')
    /usr/bin/time -p java -Dffm.epoch=$E -Dffm.switch9=$S -Dorekit.simpleEOP=true -cp "/Users/tj/software/gmat09-authority/jars/*" OrekitReference.java "/private/tmp/claude-501/-Users-tj-software-spacedatanetwork-stack/ccb46d52-d201-41c2-95e9-8200325eb018/scratchpad/xm7/orekit/data" "/private/tmp/claude-501/-Users-tj-software-spacedatanetwork-stack/ccb46d52-d201-41c2-95e9-8200325eb018/scratchpad/xm7/orekit/gfc" "$O" "LEO400 W1-field" 2>&1 | tail -4 | cut -c1-200
    echo "$E switch $S -> $O $(wc -c < "$O" 2>/dev/null) bytes"
  done
done
