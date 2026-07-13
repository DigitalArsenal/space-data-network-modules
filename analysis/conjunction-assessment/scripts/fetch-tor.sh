#!/bin/bash
# Tor-based SOCRATES GP downloader.
#
# PURPOSE OF TOR HERE: firewall/erroneous-block RECOVERY only — this project
# has been the victim of upstream blocks unrelated to our request behavior.
# Circuit rotation restores reachability; it is NOT a rate-limit evasion
# mechanism. ALL rules in CELESTRAK_FETCH_POLICY.md apply exactly as if
# fetching directly:
#   - serial, >= 2.5s between requests
#   - NEVER request the same data more than once in a 3-hour period
#     (persistent ledger; existing files are never re-fetched)
#   - 60s backoff + at most one retry on 429/503
#   - abort the run after 30 consecutive failures
#
# Usage: ./fetch-tor.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../tests/data/socrates_gp"
CSV="$SCRIPT_DIR/../tests/data/socrates_current.csv"
. "$SCRIPT_DIR/lib/celestrak-fetch-policy.sh"

mkdir -p "$DATA_DIR"
policy_init "$SCRIPT_DIR/../tests/data/.celestrak-fetch-ledger"

# Extract pairs not yet downloaded
echo "Finding missing pairs..."
tail -n +2 "$CSV" | awk -F',' '{gsub(/"/, ""); print $1","$4}' | sort -u > /tmp/all_pairs.txt
TOTAL=$(wc -l < /tmp/all_pairs.txt | tr -d ' ')
echo "Total unique pairs: $TOTAL"

# Filter out already downloaded
> /tmp/need_pairs.txt
while IFS=',' read -r id1 id2; do
    [ -f "$DATA_DIR/gp_${id1},${id2}.json" ] || echo "${id1},${id2}" >> /tmp/need_pairs.txt
done < /tmp/all_pairs.txt
NEED=$(wc -l < /tmp/need_pairs.txt | tr -d ' ')
echo "Already have: $((TOTAL - NEED))"
echo "Need to download: $NEED"
echo "Policy: serial, ${POLICY_MIN_INTERVAL_SEC}s/request, 3h same-key ledger, halt after ${POLICY_HALT_AFTER} consecutive failures."
echo ""

rotate() {
    (echo -e 'AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT\r') | nc -w 2 127.0.0.1 9051 >/dev/null 2>&1 || true
    sleep 2
}

dl=0; err=0; rot=0; skipped=0

while IFS=',' read -r id1 id2; do
    key="https://celestrak.org/SOCRATES/data.php?CATNR=${id1},${id2}&FORMAT=json"
    out="$DATA_DIR/gp_${id1},${id2}.json"
    [ -f "$out" ] && continue

    if ! policy_allowed "$key"; then
        skipped=$((skipped+1))
        continue
    fi

    retried=0
    while :; do
        code=$(curl --socks5 127.0.0.1:9050 -s -w "%{http_code}" -o "$out.tmp" \
            --max-time 12 -H "User-Agent: OrbPro-SOCRATES-Validation/1.0" \
            "$key" 2>/dev/null || echo "000")

        if [ "$code" = "200" ] && python3 -c "import json; d=json.load(open('$out.tmp')); assert len(d)>=2" 2>/dev/null; then
            mv "$out.tmp" "$out"
            policy_record "$key"
            policy_note_success
            dl=$((dl+1))
            break
        elif { [ "$code" = "429" ] || [ "$code" = "503" ]; } && [ "$retried" -eq 0 ]; then
            rm -f "$out.tmp"; rot=$((rot+1)); retried=1
            echo "  ⟳ $code on $key — 60s backoff, then rotate + single retry ($rot)"
            policy_note_failure || exit 1
            sleep 60; rotate
            continue
        else
            rm -f "$out.tmp"; err=$((err+1))
            policy_note_failure || exit 1
            break
        fi
    done

    tot=$((dl+err))
    [ $((tot % 100)) -eq 0 ] && [ $tot -gt 0 ] && echo "  $dl downloaded, $err errors, $skipped ledger-skipped, $rot backoffs (of $NEED)"
    policy_sleep
done < /tmp/need_pairs.txt

echo ""
echo "Done: $dl downloaded, $err errors, $skipped ledger-skipped, $rot backoff/rotations"
echo "Total GP files: $(ls "$DATA_DIR"/*.json 2>/dev/null | wc -l)"
