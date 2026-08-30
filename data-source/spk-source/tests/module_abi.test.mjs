// The propagator ABI, driven on the BYTES THAT SHIP.
//
// ephemeris_propagator.test.mjs measures the headers compiled natively. This one
// loads dist/isomorphic/module.wasm — signed, exactly as a consumer receives it —
// strips the publication trailer the way every SDK loader does, instantiates it
// under WASI preview1 and calls the real exports. Nothing here goes through the
// invoke surface: the propagator ABI is a set of directly-callable exports, and
// calling them directly is how the engine calls them.
//
// NOT ONE HARD-CODED BYTE OFFSET. The struct layout, the frame roster and the
// error codes are read from the GENERATED bindings the C header is generated
// from, so the JavaScript reader and the C writer cannot disagree — neither of
// them wrote the layout down. The ABI is located through
// dist/build-provenance.json, which records the exact header this artifact was
// compiled against: the artifact is measured against its own declared ABI rather
// than against whichever copy happens to be installed.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WASI } from "node:wasi";

import { toLoadableWasmBytes, verifyModuleArtifact } from "space-data-module-sdk/bundle";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");
const wasmPath = path.join(packageRoot, "dist", "isomorphic", "module.wasm");
const provenancePath = path.join(packageRoot, "dist", "build-provenance.json");
const fixturesPath = path.join(packageRoot, "fixtures");

// The dev signer this repo signs committed artifacts with. A DEV key with a
// published seed: it proves the artifact came out of this build lane, not that
// it is trustworthy for production delivery.
const DEV_MODULE_SIGNER_PUBLIC_KEY_HEX =
  "cf4625795484d8efe18860141cfdeaaaed7bbee9209488405b6ddeac7543fe78";

/**
 * Where the generated ABI bindings live, in the same resolution order build.mjs
 * uses for the C header — with the artifact's own provenance first, because the
 * question this suite asks is whether the SHIPPED bytes match the ABI they were
 * built against.
 */
function abiCandidates() {
  const out = [];
  if (fs.existsSync(provenancePath)) {
    const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
    if (provenance.propagatorAbiHeader) {
      // <root>/include/orbpro/orbpro_propagator_abi.h -> <root>
      const header = path.resolve(packageRoot, provenance.propagatorAbiHeader);
      out.push(path.join(path.dirname(header), "..", "..", "src", "generated", "orbpro",
        "propagator-abi.js"));
    }
  }
  if (process.env.SPACE_DATA_MODULE_SDK_ABI_ROOT) {
    out.push(path.join(process.env.SPACE_DATA_MODULE_SDK_ABI_ROOT, "src", "generated", "orbpro",
      "propagator-abi.js"));
  }
  out.push(path.join(packageRoot, "node_modules", "space-data-module-sdk", "src", "generated",
    "orbpro", "propagator-abi.js"));
  return out;
}

async function loadAbi() {
  const tried = [];
  for (const candidate of abiCandidates()) {
    tried.push(candidate);
    if (!fs.existsSync(candidate)) continue;
    const abi = await import(`file://${candidate}`);
    // An ABI that predates the ephemeris ingest verb declares neither of these.
    // Skipping such a copy rather than hand-typing round it is the whole point:
    // a literal -8 in this file is a second source of truth for a number the
    // generator owns.
    if (abi.ErrorCode && abi.EphemerisFormat) return { abi, source: candidate };
  }
  return { abi: null, tried };
}

const STATE_BYTES = 64;

class Driver {
  constructor(instance) {
    this.exports = instance.exports;
  }

  static async load() {
    const raw = fs.readFileSync(wasmPath);
    const wasi = new WASI({ version: "preview1", args: ["module"], env: {} });
    // Deliberately NOT wasi.start(): `_start` is the SDK's stdin-driven invoke
    // loop and blocks forever when driven from a test. The propagator ABI is
    // directly callable, which is how the engine calls it.
    const module = await WebAssembly.compile(toLoadableWasmBytes(raw));
    return new Driver(await WebAssembly.instantiate(module, wasi.getImportObject()));
  }

  get memory() {
    return this.exports.memory;
  }

  withBytes(bytes, fn) {
    const pointer = this.exports.plugin_alloc(bytes.length);
    assert.notEqual(pointer, 0, `plugin_alloc(${bytes.length}) returned 0`);
    try {
      new Uint8Array(this.memory.buffer).set(bytes, pointer);
      return fn(pointer, bytes.length);
    } finally {
      this.exports.plugin_free(pointer);
    }
  }

  init(bytes, format) {
    return this.withBytes(bytes, (p, n) => this.exports.plugin_init_ephemeris(p, n, format));
  }

  /** Returns {status, bytes} — raw bytes, because the batch comparison is a
   *  BYTE identity and reading through accessors first would hide a padding
   *  difference behind two equal doubles. */
  propagate(julianDate, entityIndex) {
    const pointer = this.exports.plugin_alloc(STATE_BYTES);
    try {
      const status = this.exports.plugin_propagate(julianDate, entityIndex, pointer);
      return {
        status,
        bytes: new Uint8Array(this.memory.buffer.slice(pointer, pointer + STATE_BYTES)),
      };
    } finally {
      this.exports.plugin_free(pointer);
    }
  }

  propagateBatch(julianDate, count) {
    const pointer = this.exports.plugin_alloc(STATE_BYTES * count);
    try {
      const status = this.exports.plugin_propagate_batch(julianDate, pointer, count);
      const rows = [];
      for (let i = 0; i < count; i += 1) {
        const base = pointer + i * STATE_BYTES;
        rows.push(new Uint8Array(this.memory.buffer.slice(base, base + STATE_BYTES)));
      }
      return { status, rows };
    } finally {
      this.exports.plugin_free(pointer);
    }
  }
}

function readState(bytes, layout) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { offsets } = layout;
  return {
    epoch: view.getFloat64(offsets.epoch, true),
    position: [0, 1, 2].map((i) => view.getFloat64(offsets.position + 8 * i, true)),
    velocity: [0, 1, 2].map((i) => view.getFloat64(offsets.velocity + 8 * i, true)),
    referenceFrame: view.getUint8(offsets.reference_frame),
    flags: view.getUint32(offsets.flags, true),
  };
}

// The J2000 Julian date of a UTC calendar instant, computed by V8's own calendar
// rather than by ours. A second implementation of the date arithmetic is exactly
// the point: it is what makes the module's epoch mapping a measurement instead
// of a restatement.
function julianDateOfUtc(iso) {
  const ms = Date.parse(`${iso.endsWith("Z") ? iso : `${iso}Z`}`);
  assert.ok(Number.isFinite(ms), `unparseable epoch ${iso}`);
  return ms / 86400000 + 2440587.5;
}

/** One data row of the committed OEM: its epoch text and its state in km. */
function oemRow(index) {
  const text = fs.readFileSync(path.join(fixturesPath, "ephemeris.oem"), "utf8");
  const lines = text.split("\n");
  const start = lines.indexOf("DATA_START");
  assert.ok(start >= 0, "the OEM fixture has no DATA_START");
  const tokens = lines[start + 1 + index].trim().split(/\s+/);
  assert.equal(tokens.length, 7, `the OEM fixture's data row ${index} is not epoch + 6 columns`);
  return {
    epoch: tokens[0],
    positionKm: tokens.slice(1, 4).map(Number),
    velocityKmS: tokens.slice(4, 7).map(Number),
  };
}

const FIXTURES = [
  ["oem", "ephemeris.oem", "CCSDS_OEM_KVN"],
  ["spk", "ephemeris.bsp", "SPK_DAF"],
  ["code500", "ephemeris.code500", "CODE500"],
  ["stk", "ephemeris.e", "STK_EPHEMERIS"],
];

test("the shipped ephemeris propagator answers the real ABI", { concurrency: false }, async (t) => {
  if (!fs.existsSync(wasmPath)) {
    t.skip("dist/isomorphic/module.wasm is not built; run npm run build");
    return;
  }
  if (!fs.existsSync(path.join(fixturesPath, "ephemeris.oem"))) {
    t.skip("the four-container fixture set is not in this checkout");
    return;
  }
  const { abi, source, tried } = await loadAbi();
  if (!abi) {
    t.skip(
      "no generated propagator ABI declaring ORBPRO_PROP_* error codes and " +
        `OrbProEphemerisFormat was found. Tried:\n  ${tried.join("\n  ")}`,
    );
    return;
  }
  console.log(`  ABI bindings: ${path.relative(packageRoot, source)}`);

  const { ErrorCode, EphemerisFormat, ORBPRO_STATE_VECTOR, ReferenceFrame } = abi;
  const bytesOf = new Map(
    FIXTURES.map(([label, file]) => [label, fs.readFileSync(path.join(fixturesPath, file))]),
  );

  await t.test("the artifact under test is the signed one", async () => {
    const raw = fs.readFileSync(wasmPath);
    const report = await verifyModuleArtifact(raw, {
      trustedPublicKeys: [DEV_MODULE_SIGNER_PUBLIC_KEY_HEX],
      requireSignature: true,
    });
    assert.equal(report.signed, true);
    assert.equal(report.verified, true);
    assert.equal(report.keyId, "sdm-dev-test-2026");
  });

  await t.test("propagating before any init is NOT_INITIALIZED", async () => {
    // A FRESH instance: this is the one assertion that cannot be made after any
    // other, because every other test leaves entities loaded.
    const driver = await Driver.load();
    assert.equal(driver.exports.plugin_entity_count(), 0);
    const { status } = driver.propagate(2461041.5, 0);
    assert.equal(status, ErrorCode.NOT_INITIALIZED);
  });

  await t.test("every container loads, and AUTO identifies each one", async () => {
    const driver = await Driver.load();
    for (const [label, , formatName] of FIXTURES) {
      const bytes = bytesOf.get(label);
      const explicit = driver.init(bytes, EphemerisFormat[formatName]);
      assert.ok(explicit > 0, `${label}: explicit ${formatName} init returned ${explicit}`);
      assert.equal(driver.exports.plugin_entity_count(), explicit);

      // AUTO is a real member, not a fallback: the container identifies itself,
      // so a consumer that fetched bytes without a MIME type is not forced to
      // assert something it cannot know.
      const auto = driver.init(bytes, EphemerisFormat.AUTO);
      assert.equal(auto, explicit, `${label}: AUTO found ${auto} entities, explicit found ${explicit}`);
      console.log(`  ${label.padEnd(8)} explicit=${explicit} auto=${auto}`);
    }
  });

  await t.test("plugin_propagate and plugin_propagate_batch agree BIT FOR BIT", async () => {
    const driver = await Driver.load();
    // Epochs spread across the whole span, one second inside each end. The
    // ends themselves are excluded on purpose: at JD 2461041 a double resolves
    // 40 microseconds, so the Julian date of the FIRST or LAST node can round to
    // the far side of the file and be refused as out of range. That is a
    // property of carrying an absolute epoch in one double, it is measured as
    // `epoch.map.jd.quantum.sec` in the native harness, and it is not what this
    // assertion is about.
    const base = julianDateOfUtc("2026-01-01T00:00:00");
    const epochs = [1, 1800, 3600, 5400, 7199].map((s) => base + s / 86400);
    let compared = 0;
    for (const [label] of FIXTURES) {
      const count = driver.init(bytesOf.get(label), EphemerisFormat.AUTO);
      assert.ok(count > 0);
      for (const jd of epochs) {
        const batch = driver.propagateBatch(jd, count);
        assert.equal(batch.status, ErrorCode.OK);
        for (let i = 0; i < count; i += 1) {
          const single = driver.propagate(jd, i);
          assert.equal(single.status, ErrorCode.OK);
          // Byte identity, not a tolerance. The batch call exists to amortise
          // the crossing, never to answer a different question.
          assert.deepEqual(
            Array.from(batch.rows[i]),
            Array.from(single.bytes),
            `${label}: batch and single differ at entity ${i}, jd ${jd}`,
          );
          compared += 1;
        }
      }
    }
    console.log(`  ${compared} state vectors compared byte-for-byte`);
  });

  await t.test("the state vector is the ABI's struct, in metres, with clean padding", async () => {
    assert.equal(ORBPRO_STATE_VECTOR.size, STATE_BYTES);
    const driver = await Driver.load();
    const jd = julianDateOfUtc("2026-01-01T01:00:00");

    // Derived from the generated layout, not counted by hand: the padding is
    // whatever sits between the 1-byte frame and the 4-byte flags.
    const paddingStart =
      ORBPRO_STATE_VECTOR.offsets.reference_frame +
      ORBPRO_STATE_VECTOR.fields.reference_frame.size;
    const paddingEnd = ORBPRO_STATE_VECTOR.offsets.flags;
    assert.equal(paddingStart, 57);
    assert.equal(paddingEnd - paddingStart, 3);

    for (const [label] of FIXTURES) {
      assert.ok(driver.init(bytesOf.get(label), EphemerisFormat.AUTO) > 0);
      const { status, bytes } = driver.propagate(jd, 0);
      assert.equal(status, ErrorCode.OK);
      assert.equal(bytes.length, STATE_BYTES);

      const state = readState(bytes, ORBPRO_STATE_VECTOR);
      const radius = Math.hypot(...state.position);
      const speed = Math.hypot(...state.velocity);
      // METRES, the ABI's normative unit. A reader that speaks kilometres and a
      // consumer that expects metres is the factor-of-1000 this assertion
      // exists to make impossible to ship: ~7e6 passes, ~7e3 fails.
      assert.ok(radius > 6.9e6 && radius < 7.1e6, `${label}: |r| = ${radius} is not metres`);
      assert.ok(speed > 7.0e3 && speed < 7.9e3, `${label}: |v| = ${speed} is not m/s`);
      assert.equal(state.referenceFrame, ReferenceFrame.J2000, `${label}: wrong reference frame`);
      assert.equal(state.epoch, jd, `${label}: the state carries a different epoch`);

      for (let offset = paddingStart; offset < paddingEnd; offset += 1) {
        assert.equal(bytes[offset], 0, `${label}: padding byte ${offset} is not zero`);
      }
      console.log(
        `  ${label.padEnd(8)} |r| = ${(radius / 1000).toFixed(3)} km  frame = ${state.referenceFrame}  padding clean`,
      );
    }
  });

  await t.test("the epoch mapping puts the arc where the container says it is", async () => {
    // Independent of everything above: a row of the OEM the module is reading,
    // its epoch turned into a Julian date by V8's calendar, handed to the
    // module. A leap-second offset applied anywhere in the chain would be 32 s
    // of error — about 240 km — and would fail this by seven orders of
    // magnitude.
    //
    // Row 37, not row 0: the arc epoch is exactly representable as a Julian date
    // and would answer to the last bit, which measures nothing. A row 37 minutes
    // in is NOT on that grid, so this number is the real residual a consumer
    // holding a double Julian date gets.
    const driver = await Driver.load();
    const row = oemRow(37);
    assert.ok(driver.init(bytesOf.get("oem"), EphemerisFormat.AUTO) > 0);
    const { status, bytes } = driver.propagate(julianDateOfUtc(row.epoch), 0);
    assert.equal(status, ErrorCode.OK);
    const state = readState(bytes, ORBPRO_STATE_VECTOR);
    const expected = row.positionKm.map((km) => km * 1000);
    const error = Math.hypot(...state.position.map((v, i) => v - expected[i]));
    const relative = error / Math.hypot(...expected);
    console.log(`  ${row.epoch} -> ${error.toFixed(6)} m (${relative.toExponential(3)} relative)`);
    // The floor is the Julian date itself: at JD 2461041 a double resolves 40
    // microseconds, which at 7.5 km/s is 0.3 m. The bound is three orders above
    // that floor and still eight below a one-second time-scale error.
    assert.ok(relative <= 1e-6, `epoch mapping is off by ${error} m`);
  });

  await t.test("an epoch outside the span is refused, never extrapolated", async () => {
    const driver = await Driver.load();
    const beforeStart = julianDateOfUtc("2026-01-01T00:00:00") - 1;
    const afterEnd = julianDateOfUtc("2026-01-01T02:00:00") + 1;
    for (const [label] of FIXTURES) {
      assert.ok(driver.init(bytesOf.get(label), EphemerisFormat.AUTO) > 0);
      assert.equal(
        driver.propagate(beforeStart, 0).status,
        ErrorCode.EPOCH_OUT_OF_RANGE,
        `${label}: an epoch a day before the file returned a state`,
      );
      assert.equal(
        driver.propagate(afterEnd, 0).status,
        ErrorCode.EPOCH_OUT_OF_RANGE,
        `${label}: an epoch a day after the file returned a state`,
      );
    }
  });

  await t.test("bytes that are no container are UNSUPPORTED_FORMAT", async () => {
    const driver = await Driver.load();
    // Long enough to hold a DAF record. A shorter buffer is honestly TRUNCATED
    // rather than unsupported, and the module says so with BAD_INPUT — a more
    // specific answer, and the wrong thing to assert here.
    const garbage = new Uint8Array(4096);
    for (let i = 0; i < garbage.length; i += 1) {
      // Deterministic, and deliberately not text: a run of printable ASCII could
      // be mistaken for an STK banner or an OEM keyword by a weaker detector,
      // and that is a different test.
      garbage[i] = (i * 37 + 11) & 0xff;
    }
    assert.equal(driver.init(garbage, EphemerisFormat.AUTO), ErrorCode.UNSUPPORTED_FORMAT);
    // And with a discriminator, so the refusal is not an artefact of detection.
    assert.equal(driver.init(garbage, EphemerisFormat.SPK_DAF), ErrorCode.UNSUPPORTED_FORMAT);
  });

  await t.test("destroy really releases, and is idempotent", async () => {
    const driver = await Driver.load();
    assert.ok(driver.init(bytesOf.get("spk"), EphemerisFormat.AUTO) > 0);
    assert.equal(driver.exports.plugin_entity_count(), 1);

    driver.exports.plugin_destroy();
    assert.equal(driver.exports.plugin_entity_count(), 0);
    assert.equal(driver.propagate(2461041.5, 0).status, ErrorCode.NOT_INITIALIZED);

    // Twice: a destroy that only marks a flag would fault or leak here.
    driver.exports.plugin_destroy();
    assert.equal(driver.exports.plugin_entity_count(), 0);

    // And a following init works on a clean slate.
    assert.ok(driver.init(bytesOf.get("oem"), EphemerisFormat.AUTO) > 0);
    assert.equal(driver.exports.plugin_entity_count(), 1);
    assert.equal(driver.propagate(julianDateOfUtc("2026-01-01T01:00:00"), 0).status, ErrorCode.OK);
  });
});
