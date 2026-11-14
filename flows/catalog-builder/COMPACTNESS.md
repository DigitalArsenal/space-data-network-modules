# Population annotation encoding

Two synthetic stored AP products average 9,592 bytes against 4,536 bytes of
raw fit output. This is a small functional sample, not a real-catalog transfer
estimate. The fit's original buffer is embedded unchanged with aligned framing;
no native-object repack expands its fields.

Seven symmetric 6-by-6 matrices contain 147 distinct values: 1,176 bytes as
binary doubles. The standard's covariance blocks encode timestamped text rows,
so the stored representation also requires decimal strings, block metadata,
realism labels, offsets and alignment. Each matrix uses 21 lower-triangular
values (`LTM`), shortest decimal spellings that round-trip exactly, shared equal
metadata strings and absent unstated NaN defaults. Every block identifies its
frame, standard-deviation units, seed population model, age and uncalibrated
status.

The new root references the original fit's existing tables and vectors. Scalar
widths come from the generated schema reflection; original calibration values
remain intact. An output verifier runs before emission. Tests compare every
original field and byte range, propagated states and formal covariance against
the chain's own raw output and the stored product. Repeated chain and annotation
invocations produce identical bytes. A separate signed-axis permutation checks
covariance rotation against a hand-computed result with zero tolerance.

A 1,000-record compression benchmark with repacked fit inputs and shorter labels
measured 9,857,952 raw bytes, 2,248,888 bytes at gzip level 6 and 113,293 bytes
at zstd level 3. Its near-circular phases and shared weather favor compression.
Those figures describe that benchmark encoding; compression and full-catalog
scaling of the raw-fit-preserving output are unmeasured. Indexes, sidecars,
retained publication copies and transport overhead add further bytes.
