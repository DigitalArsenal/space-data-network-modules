#!/bin/bash
# RETIRED 2026-07-13 (owner fetch policy — see CELESTRAK_FETCH_POLICY.md).
#
# Parallel fetching cannot satisfy the serial >=2.5s/request rule, so this
# wrapper now delegates to the policy-compliant serial fetcher. The Tor path
# remains available there for firewall/erroneous-block recovery only.
echo "fetch-tor-fast.sh is retired: parallel fetching violates CELESTRAK_FETCH_POLICY.md." >&2
echo "Delegating to the policy-compliant serial fetch-tor.sh..." >&2
exec "$(cd "$(dirname "$0")" && pwd)/fetch-tor.sh"
