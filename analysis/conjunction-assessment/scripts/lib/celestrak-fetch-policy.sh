# CelesTrak fetch policy helpers (see ../CELESTRAK_FETCH_POLICY.md).
# Source this file; do not execute.
#
#   policy_init <ledger_path>       # load ledger
#   policy_allowed <key>            # 0 = fetch allowed, 1 = inside 3h window
#   policy_record <key>             # record successful fetch of <key>
#   policy_sleep                    # mandatory inter-request pause (>=2.5s)
#   policy_note_failure             # returns 1 when the run must halt
#   policy_note_success             # resets the consecutive-failure counter
#
# Requires bash 3.2+ (macOS default) — no associative arrays.

POLICY_MIN_INTERVAL_SEC="2.5"
POLICY_WINDOW_SEC=10800
POLICY_HALT_AFTER=30
POLICY_LEDGER=""
POLICY_CONSECUTIVE_FAILURES=0

policy_init() {
    POLICY_LEDGER="$1"
    mkdir -p "$(dirname "$POLICY_LEDGER")"
    touch "$POLICY_LEDGER"
}

# 0 = allowed; 1 = same key fetched successfully within the 3h window
policy_allowed() {
    local key="$1" now cutoff
    now=$(date +%s)
    cutoff=$((now - POLICY_WINDOW_SEC))
    # last recorded epoch for this key, if any
    local last
    last=$(grep -F "$key	" "$POLICY_LEDGER" 2>/dev/null | tail -1 | cut -f2)
    if [ -n "$last" ] && [ "$last" -gt "$cutoff" ] 2>/dev/null; then
        return 1
    fi
    return 0
}

policy_record() {
    printf '%s\t%s\n' "$1" "$(date +%s)" >> "$POLICY_LEDGER"
}

policy_sleep() {
    sleep "$POLICY_MIN_INTERVAL_SEC"
}

policy_note_failure() {
    POLICY_CONSECUTIVE_FAILURES=$((POLICY_CONSECUTIVE_FAILURES + 1))
    if [ "$POLICY_CONSECUTIVE_FAILURES" -ge "$POLICY_HALT_AFTER" ]; then
        echo "POLICY HALT: $POLICY_CONSECUTIVE_FAILURES consecutive failures — aborting run (investigate, do not hammer)." >&2
        return 1
    fi
    return 0
}

policy_note_success() {
    POLICY_CONSECUTIVE_FAILURES=0
}
