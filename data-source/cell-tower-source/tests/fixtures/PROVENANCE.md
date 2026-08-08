# Fixture provenance

`opencellid.sample.csv` is a HAND-WRITTEN fixture in the OpenCelliD CSV column
contract (`radio,mcc,net,area,cell,unit,lon,lat,range,samples,changeable,created,updated,averageSignal`),
not a cut of live provider data. It is written that way deliberately:

- The parity gate needs cases that a real extract would only contain by luck —
  in particular TWO reports of the SAME cell (310/260/40495/17811) from two
  different providers, differing in position, sample count and observation
  time, so `HIGHEST_SAMPLE_COUNT` and `MOST_RECENT` provably select different
  winners.
- No provider's terms are engaged by a synthetic five-row file, so this fixture
  carries no licence obligation of its own. Real provider bytes are fetched at
  runtime by the flow's http connector and carry their own attribution through
  `$TBS.SOURCES`.

The first two rows are the same cell; rows 3-5 are distinct cells.
