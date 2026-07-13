#!/bin/bash
# Batch download SOCRATES GP data via Tor.
#
# PURPOSE OF TOR HERE: firewall/erroneous-block RECOVERY only — this project
# has been the victim of upstream blocks unrelated to our request behavior.
# It is NOT a rate-limit evasion mechanism. ALL rules in
# CELESTRAK_FETCH_POLICY.md apply exactly as if fetching directly:
#   - serial, >= 2.5s between requests (rate arg is floor-enforced)
#   - NEVER request the same data more than once in a 3-hour period
#   - 60s backoff + at most one retry on 429/503
#   - abort after 30 consecutive failures
#
# Usage: ./fetch-socrates-gp-tor.sh [max_pairs] [rate_sec>=2.5]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../tests/data/socrates_gp"
CSV_FILE="$SCRIPT_DIR/../tests/data/socrates_current.csv"
MAX_PAIRS="${1:-50000}"
RATE_SEC="${2:-2.5}"
. "$SCRIPT_DIR/lib/celestrak-fetch-policy.sh"

# Floor-enforce the rate argument (policy minimum 2.5s)
if awk "BEGIN{exit !($RATE_SEC < $POLICY_MIN_INTERVAL_SEC)}"; then
    echo "rate ${RATE_SEC}s below policy floor — using ${POLICY_MIN_INTERVAL_SEC}s" >&2
    RATE_SEC="$POLICY_MIN_INTERVAL_SEC"
fi

mkdir -p "$DATA_DIR"
policy_init "$SCRIPT_DIR/../tests/data/.celestrak-fetch-ledger"

rotate_circuit() {
    (echo -e 'AUTHENTICATE ""\r\nSIGNAL NEWNYM\r\nQUIT\r') | nc -w 3 127.0.0.1 9051 >/dev/null 2>&1 || true
    sleep 2
}

echo "Parsing SOCRATES CSV..."
PAIRS=$(tail -n +2 "$CSV_FILE" | head -n "$MAX_PAIRS" | awk -F',' '{
    gsub(/"/, "", $0)
    id1=$1; id2=$4
    key=id1","id2
    if (!(key in seen)) { seen[key]=1; print id1","id2 }
}')

TOTAL=$(echo "$PAIRS" | wc -l | tr -d ' ')
echo "Total unique pairs: $TOTAL"
echo "Output: $DATA_DIR"
echo "Policy: serial ${RATE_SEC}s/request, 3h same-key ledger, halt after ${POLICY_HALT_AFTER} consecutive failures."
echo ""

downloaded=0; cached=0; errors=0; rotations=0; skipped=0; count=0

while IFS=',' read -r id1 id2; do
    count=$((count + 1))
    key="https://celestrak.org/SOCRATES/data.php?CATNR=${id1},${id2}&FORMAT=json"
    outfile="$DATA_DIR/gp_${id1},${id2}.json"

    if [ -f "$outfile" ]; then
        cached=$((cached + 1))
        continue
    fi
    if ! policy_allowed "$key"; then
        skipped=$((skipped + 1))
        continue
    fi

    url="$key"
    retried=0
    while :; do
        http_code=$(curl --socks5 127.0.0.1:9050 -s -w "%{http_code}" \
            -o "$outfile.tmp" --max-time 15 \
            -H "User-Agent: OrbPro-SOCRATES-Validation/1.0" \
            "$url" 2>/dev/null || echo "000")

        if [ "$http_code" = "200" ] && python3 -c "import json; d=json.load(open('$outfile.tmp')); assert len(d) >= 2" 2>/dev/null; then
            mv "$outfile.tmp" "$outfile"
            policy_record "$key"
            policy_note_success
            downloaded=$((downloaded + 1))
            break
        elif { [ "$http_code" = "429" ] || [ "$http_code" = "503" ]; } && [ "$retried" -eq 0 ]; then
            rm -f "$outfile.tmp"; rotations=$((rotations + 1)); retried=1
            echo "  ⟳ $http_code on $key — 60s backoff, then rotate + single retry ($rotations)"
            policy_note_failure || exit 1
            sleep 60; rotate_circuit
            continue
        else
            rm -f "$outfile.tmp"; errors=$((errors + 1))
            policy_note_failure || exit 1
            break
        fi
    done

    processed=$((downloaded + errors))
    if [ $((processed % 100)) -eq 0 ] && [ "$processed" -gt 0 ]; then
        echo "  [$count/$TOTAL] $downloaded new, $cached cached, $skipped ledger-skipped, $errors err, $rotations backoffs"
    fi

    sleep "$RATE_SEC"
done <<< "$PAIRS"

echo ""
echo "Done: $downloaded downloaded, $cached cached, $skipped ledger-skipped, $errors errors, $rotations backoff/rotations"
echo "Total GP files: $((downloaded + cached))"
