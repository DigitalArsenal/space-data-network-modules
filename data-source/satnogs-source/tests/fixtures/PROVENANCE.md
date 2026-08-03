# Test fixture provenance

`satnogs-transmitters.sample.json` is a 15-row cut of the **live** SatNOGS DB
transmitters table, fetched 2026-08-03 with the identifying User-Agent
`data-source/enrichment/source-policy.json` mandates:

    GET https://db.satnogs.org/api/transmitters/?format=json
    -> HTTP 200, 3,484,839 bytes, 4,994 transmitter rows over 2,620 distinct
       NORAD-catalogued spacecraft (2,764 rows in the sibling satellites table)

The rows were selected to exercise every branch the parser has, not curated for
appearance:

* the canonical 136,658,500 Hz downlink named in the Hz->MHz ruling
* Transceivers and Transponders (uplink+downlink pairs, passband `*_high`)
* S band (2,304.1 / 2,401.5 MHz), UHF (436.795 / 437.15 MHz), VHF (145.x MHz),
  HF (29.4 MHz) and Ku (15,003.4 MHz) so band classification is covered on both
  sides of every boundary the enum can and cannot express
* `invert: true`, non-null `baud`, and an `inactive` transmitter

SatNOGS DB is licensed **CC-BY-SA-4.0**
(https://creativecommons.org/licenses/by-sa/4.0/). Attribution, carried
verbatim in every emitted record's `CITATION` field and in this fixture's
lineage:

> SatNOGS DB, Libre Space Foundation, https://db.satnogs.org/ (CC BY-SA 4.0)
