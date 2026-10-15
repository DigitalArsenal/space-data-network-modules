# Fixtures

`testsrc2-64x48-baseline.h264` and `testsrc2-64x48-bframes.h264` are H.264
Annex B elementary streams encoded on 2026-10-13 from FFmpeg's synthetic
`testsrc2` test pattern (no third-party picture content), 12 frames at 30 fps,
one access unit delimiter per frame, an IDR every 6 frames; the second uses
two B-frames (Main profile), so its presentation and decode orders differ.

    ffmpeg -f lavfi -i testsrc2=size=64x48:rate=30 -frames:v 12 -c:v libx264 \
      -profile:v baseline -x264-params "aud=1:keyint=6:min-keyint=6:scenecut=0" \
      -pix_fmt yuv420p -f h264 testsrc2-64x48-baseline.h264
    ffmpeg -f lavfi -i testsrc2=size=64x48:rate=30 -frames:v 12 -c:v libx264 \
      -profile:v main -x264-params "aud=1:keyint=6:min-keyint=6:scenecut=0:bframes=2:b-adapt=0" \
      -pix_fmt yuv420p -f h264 testsrc2-64x48-bframes.h264

The transport streams and the MISB ST 0601 packets the tests read are built
by tests/lib/ts-writer.mjs from these streams and stated values.
