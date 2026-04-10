#!/bin/bash
# Download SpaceX MEME ephemeris files in parallel
# Usage: ./download-meme.sh <output_dir> [max_files] [parallel_workers]

set -e

OUTDIR="${1:-.}"
MAX="${2:-0}"
WORKERS="${3:-8}"
BASE_URL="https://api.starlink.com/public-files/ephemerides"

mkdir -p "$OUTDIR"

# Download manifest
echo "Downloading MANIFEST.txt..."
curl -s "$BASE_URL/MANIFEST.txt" > "$OUTDIR/MANIFEST.txt"
TOTAL=$(wc -l < "$OUTDIR/MANIFEST.txt" | tr -d ' ')
echo "Found $TOTAL MEME files"

# Filter already downloaded
EXISTING=$(find "$OUTDIR" -name 'MEME_*.txt' 2>/dev/null | wc -l | tr -d ' ')
echo "Already have $EXISTING files"

# Create download list (skip existing)
DOWNLOAD_LIST=$(mktemp)
while IFS= read -r filename; do
    filename=$(echo "$filename" | tr -d '\r')
    if [ ! -f "$OUTDIR/$filename" ]; then
        echo "$filename"
    fi
done < "$OUTDIR/MANIFEST.txt" > "$DOWNLOAD_LIST"

REMAINING=$(wc -l < "$DOWNLOAD_LIST" | tr -d ' ')
echo "Need to download $REMAINING files"

if [ "$MAX" -gt 0 ] && [ "$REMAINING" -gt "$MAX" ]; then
    head -n "$MAX" "$DOWNLOAD_LIST" > "${DOWNLOAD_LIST}.tmp"
    mv "${DOWNLOAD_LIST}.tmp" "$DOWNLOAD_LIST"
    REMAINING=$MAX
    echo "Capped at $MAX files"
fi

if [ "$REMAINING" -eq 0 ]; then
    echo "All files already downloaded"
    rm -f "$DOWNLOAD_LIST"
    exit 0
fi

# Download in parallel
echo "Downloading $REMAINING files with $WORKERS parallel workers..."
START=$(date +%s)

download_file() {
    local filename="$1"
    local url="$BASE_URL/$filename"
    local outpath="$OUTDIR/$filename"
    curl -s -o "$outpath" "$url"
    if [ $? -ne 0 ] || [ ! -s "$outpath" ]; then
        rm -f "$outpath"
        echo "FAIL: $filename" >&2
    fi
}
export -f download_file
export BASE_URL OUTDIR

cat "$DOWNLOAD_LIST" | xargs -P "$WORKERS" -I {} bash -c 'download_file "$@"' _ {}

END=$(date +%s)
ELAPSED=$((END - START))
DOWNLOADED=$(find "$OUTDIR" -name 'MEME_*.txt' -newer "$OUTDIR/MANIFEST.txt" 2>/dev/null | wc -l | tr -d ' ')

echo ""
echo "=== Download Complete ==="
echo "Downloaded: $DOWNLOADED files"
echo "Time: ${ELAPSED}s"
echo "Rate: $(echo "scale=1; $DOWNLOADED / $ELAPSED" | bc 2>/dev/null || echo "N/A") files/sec"
echo "Total on disk: $(find "$OUTDIR" -name 'MEME_*.txt' | wc -l | tr -d ' ') files"

rm -f "$DOWNLOAD_LIST"
