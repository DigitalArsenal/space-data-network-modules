# Population annotation encoding

Annotation adds covariance blocks and realism metadata to each product.
Raw catalog size and compressed transfer size for this configuration are
unmeasured. The fit's original buffer is embedded with aligned framing;
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

Indexes, operational attempt history, retained publication copies, sidecars and
transport overhead add bytes. No compression or catalog-size projection is
attached to this encoding. The ingestion-only SGP4 path repacks to add its
stable reason comment; compiled tests compare every original field and
bit-identical propagated states/formal covariance after storage.
