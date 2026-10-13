# files/misb-klv

Full-motion video with MISB ST 0601 metadata, for a video layer draped on the
globe (owner 2026-10-13: "add arbitrary imagery layers as well, including
video").

| method | in | out |
| --- | --- | --- |
| `remux` | `video`: `[u32le n][$NCD][MPEG-2 TS bytes]` | `init` (fMP4 initialization segment), `media` (fMP4 fragments, each from a sync sample, at most 60), `frames` (per-frame footprint table) |
| `footprints` | same | `footprints`: one size-prefixed `$GDI` per ST 0601 packet |

- **Demux**: 188-byte TS and 192-byte M2TS packets; PAT and PMT; H.264
  (stream type 0x1B; HEVC and MPEG-2 video are refused by name); KLV in
  synchronous metadata PES (0x15, metadata AU cells) or asynchronous private
  data (0x06 with a `KLVA` registration descriptor; a packet without a PTS
  takes the time of the video PES before it). PTS/DTS are unwrapped across
  the 33-bit rollover.
- **Remux**: Annex B access units become length-prefixed samples; the first
  SPS and PPS form the `avcC`; width and height come from the SPS. Timescale
  90 kHz; the frame table's key is the presentation time in ticks, which is
  the browser's media time x 90000.
- **ST 0601**: the UAS Local Set key, BER lengths, the tag-1 checksum (a
  packet that fails it is dropped), the standard's linear mappings, error
  values (0x8000 / 0x80000000) treated as absent. Tags 2, 5-7, 10, 11, 13-21,
  23-33, 65, 75, 82-91.
- **Footprint**: tags 82-89 when all are stated; else the frame centre
  (23/24) plus the corner offsets (26-33); else the four corner rays from the
  platform (13/14, 75 or 15; heading 5, pitch 6 or 90, roll 7 or 91) and the
  sensor (relative azimuth 18, elevation 19, roll 20; fields of view 16/17),
  yaw-pitch-roll in NED, intersected with WGS84 raised to the frame-centre
  elevation (25). A frame whose rays do not all reach the ground has none.
  Tag 15 is MSL: without tag 75 the footprint carries the geoid separation.
- **Per frame**: the nearest packet with a footprint within 1 s; otherwise
  the row is marked not valid (the console hides the frame).

Build: `npm ci && node build.mjs`. Tests: `node --test tests/*.test.mjs`
(transport streams and ST 0601 packets written from stated values by
`tests/lib/ts-writer.mjs`; ray footprints checked against an independent
reference, `tests/lib/oracle.mjs`; fixtures in `tests/fixtures/PROVENANCE.md`).
