# data-source/spk-source — the ephemeris propagator

Propagates a spacecraft from an ephemeris **container** rather than from
elements: **SPK** (NAIF DAF, segment types 8, 9 and 13), **Code-500**, **STK
ephemeris** and **CCSDS-OEM**, behind one format discriminator.

The directory is named `spk-source` because that is the scope path the task
declares. The module is `com.digitalarsenal.propagator.ephemeris` and reads all
four.

## Why this is a propagator and not a loader

Owner law 2026-07-29: every surface that consumes propagation takes it as a
pluggable port. The ephemeris family is the one that most invites a bypass —
the file already contains the answer, so it is tempting to read it in the
consumer and skip the port entirely, which is precisely how a JavaScript
propagator gets built. So this answers the **same** `plugin_propagate` /
`plugin_propagate_batch` the SGP4 and numerical providers answer, and a
consumer that can drive one drives this with no branch of its own.

**One module, four containers.** Format is data, not identity. The
interpolation, the epoch handling and the state assembly are shared; four
artifacts would be four parity envelopes for one behaviour and four places for
SPK and STK to disagree about the same Hermite window.

## Ingest is `plugin_init_ephemeris`, not `plugin_init`

`plugin_init` is bound by the SDK ABI to a packed array of `OrbProOMMRecord`
and **must refuse** any length that is not a whole multiple of that struct. A
DAF is not a sequence of OMM records, so this module **does not export
`plugin_init` at all** rather than exporting a lie.

`plugin_init_ephemeris(const uint8_t* bytes, size_t len, uint32_t format)` was
added to the propagator ABI for exactly this (`schemas/orbpro/Propagator.fbs`,
generated into `include/orbpro/orbpro_propagator_abi.h`), together with
`OrbProEphemerisFormat` and the `ORBPRO_PROP_*` error codes — which had been
documented in prose and declared nowhere, so every module hand-typed them.

`AUTO` is a real member, not a guess: every container here is self-identifying
in its first bytes. Code-500 is the residual and is reached under `AUTO` only
if the buffer also passes Code-500's own header validation — a residual format
identified purely by elimination will happily "read" a corrupted file of any
other kind and return numbers.

## Three contracts this module is held to

**Time.** `julian_date` is interpreted on the **container's own declared time
scale**. This module carries no leap-second table and performs no scale
conversion: `foundation/time` owns that table and measures it. The convention
is safe for what this module is asked to prove because every acceptance number
is *differential* — propagation against direct interpolation of the same file,
and four containers of one trajectory against each other. A consumer mixing
scales normalises upstream through the time module.

**Frames.** The state exits in the container's **declared** frame with
`StateVector.reference_frame` set to say which, through
`orbpro_state_set_reference_frame()` so the padding cannot go stale. This is
the one propagator family that may exit non-ECEF, and the reason is arithmetic:
rotating a J2000 kernel to ECEF so `PropagatedPositionProperty` can rotate it
straight back adds two interpolated rotations to an answer that was already
exact, and would need a second copy of the IAU series inside this module.
Frames are translated by **named token** — `ECI == 0`, `TEME == 0` and
`FIXED == 0` collide across the five `ReferenceFrame` vocabularies that meet at
this seam. A declared frame with no roster member is `UNSUPPORTED_FORMAT`,
never a guess: a guessed frame is wrong by up to a full Earth rotation.

**Interpolation.** Each container is evaluated by the rule **it** declares — an
SPK segment type fixes it, an OEM and an STK file say it outright. A module
that substitutes its own rule is not reading the file, it is fitting one.

## Units

The readers speak kilometres because `$OEM`'s IDL fixes that. The propagator
ABI is **normative metres**. The conversion happens once, at the boundary.

## Exports

`plugin_init_ephemeris`, `plugin_propagate`, `plugin_propagate_batch`,
`plugin_destroy`, `plugin_entity_count`, and the record-shaped
`describe_ephemeris` method — `$OEM` in, `$OEM` out with the frame, centre,
time system, interpolation rule and degree filled in as this module resolved
them. That method exists because the propagation entry point carries raw
container bytes and so has no SDS port identity; without it there would be no
way to ask the module what it thinks a trajectory says without propagating it.

`plugin_destroy` really releases and is idempotent: `plugin_entity_count` reads
0 afterwards and a following init works on a clean slate.

## Build

```sh
npm ci
node build.mjs
```

The format engines are **included** from `files/orbit-products/src/`, the same
seam `foundation/frames` uses to reach `foundation/orbits` — one
implementation, several artifacts. SDS headers are generated from the
**published** package this repo pins.

`SPACE_DATA_MODULE_SDK_ABI_ROOT` overrides where the propagator ABI header
comes from. That exists for the window in which an ABI change has landed in a
task worktree but not yet in the checkout npm resolves to — a real state, not a
convenience, since `plugin_init_ephemeris` was added in exactly that window.
The build **fails loudly** naming the missing symbol rather than compiling a
module whose entry point the installed ABI does not define.

The artifact is **signed in the build**, never as a separate step: the declared
consumer verifies before it instantiates and has no unsigned fallback, so an
unsigned artifact is not a weaker artifact, it is an unloadable one. That is
how `foundation/frames` shipped once — a rebuild dropped the signature and the
demo died on Pages.
