import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "../../../../spacedatastandards.org/node_modules/flatbuffers/mjs/flatbuffers.js";
import * as TIMStandards from "../../../../spacedatastandards.org/lib/js/TIM/main.js";
import {
  TIM,
  TIMConversionRequestT,
  TIMInstantT,
  TIMT,
  timConversionStatus,
  timEpochRepresentation,
  timingStandard,
} from "../../../../spacedatastandards.org/lib/js/TIM/main.js";
import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule, loadModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT = fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const OREKIT_GNSSDATE_REFERENCE_UTC = "2006-08-09T16:31:03Z";
const OREKIT_GNSSDATE_REFERENCE_RESULT_UTC = "2006-08-09T16:31:03.000000Z";
const OREKIT_GPS_QZSS_SBAS_GNSS_SECONDS = 1387 * 604800 + 318677.0;
const OREKIT_GALILEO_NAVIC_GNSS_SECONDS = 363 * 604800 + 318677.0;

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function encodeConversionRequest({
  sourceSystem,
  sourceIso8601,
  sourceFormat = timEpochRepresentation.ISO8601,
  sourceJulianDate = 0,
  sourceSeconds = 0,
  sourceGnssWeek = 0,
  sourceHasGnssRolloverReference = false,
  sourceGnssRolloverReferenceIso8601 = null,
  sourceCcsdsTimeCode = null,
  targetSystem,
  targetFormat = timEpochRepresentation.ISO8601,
  traceId = "foundation-time-test",
  hasDut1 = false,
  dut1Seconds = 0,
}) {
  const builder = new flatbuffers.Builder(512);
  const envelope = new TIMT(
    sourceSystem,
    null,
    new TIMConversionRequestT(
      new TIMInstantT(
        sourceSystem,
        sourceFormat,
        sourceJulianDate,
        sourceSeconds,
        sourceIso8601,
        0,
        null,
        sourceGnssWeek,
        sourceHasGnssRolloverReference,
        sourceGnssRolloverReferenceIso8601,
        sourceCcsdsTimeCode,
      ),
      targetSystem,
      targetFormat,
      0,
      false,
      dut1Seconds,
      hasDut1,
      traceId,
    ),
    null,
  );
  const root = envelope.pack(builder);
  TIM.finishTIMBuffer(builder, root);
  return builder.asUint8Array();
}

async function invokeConversion(harness, payload) {
  return harness.invoke({
    methodId: "convert_time",
    inputs: [
      {
        portId: "request",
        typeRef: {
          schemaName: "TIM.fbs",
          fileIdentifier: "$TIM",
        },
        payload,
      },
    ],
  });
}

function decodeResult(response) {
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  const [frame] = response.outputs;
  assert.equal(frame.portId, "result");
  assert.equal(frame.typeRef?.schemaName, "TIM.fbs");
  assert.equal(frame.typeRef?.fileIdentifier, "$TIM");
  const bb = new flatbuffers.ByteBuffer(frame.payload);
  assert.equal(TIM.bufferHasIdentifier(bb), true);
  const root = TIM.getRootAsTIM(bb);
  const result = root.CONVERSION_RESULT();
  assert.ok(result, "missing TIM.CONVERSION_RESULT");
  return result;
}

function assertNear(actual, expected, tolerance, label) {
  const delta = Math.abs(actual - expected);
  assert.ok(delta <= tolerance, `${label} delta ${delta} exceeds ${tolerance}`);
}

function secondsOfDayFromIso(iso8601) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(iso8601);
  assert.ok(match, `invalid ISO-8601 timestamp ${iso8601}`);
  const [, , , , hour, minute, second, fraction = "0"] = match;
  return Number(hour) * 3600 + Number(minute) * 60 + Number(second) + Number(`0.${fraction}`);
}

function requireGnssWeekSecondsFormat() {
  assert.equal(
    Number.isInteger(timEpochRepresentation.GNSS_WEEK_SECONDS),
    true,
    "SDS TIM timEpochRepresentation.GNSS_WEEK_SECONDS enum is required",
  );
  return timEpochRepresentation.GNSS_WEEK_SECONDS;
}

function requireCcsdsTimeCodeSurface() {
  assert.equal(
    Number.isInteger(timEpochRepresentation.CCSDS_TIME_CODE),
    true,
    "SDS TIM timEpochRepresentation.CCSDS_TIME_CODE enum is required",
  );
  assert.equal(
    typeof TIMStandards.TIMCcsdsTimeCodeT,
    "function",
    "SDS TIM TIMCcsdsTimeCode table is required",
  );
  assert.equal(
    Number.isInteger(TIMStandards.timCcsdsTimeCodeKind?.UNSEGMENTED),
    true,
    "SDS TIM timCcsdsTimeCodeKind.UNSEGMENTED enum is required",
  );
  assert.equal(
    Number.isInteger(TIMStandards.timCcsdsTimeCodeKind?.DAY_SEGMENTED),
    true,
    "SDS TIM timCcsdsTimeCodeKind.DAY_SEGMENTED enum is required",
  );
  assert.equal(
    Number.isInteger(TIMStandards.timCcsdsTimeCodeKind?.CALENDAR_SEGMENTED),
    true,
    "SDS TIM timCcsdsTimeCodeKind.CALENDAR_SEGMENTED enum is required",
  );
  return {
    ccsdsTimeCodeFormat: timEpochRepresentation.CCSDS_TIME_CODE,
    ccsdsTimeCodeKind: TIMStandards.timCcsdsTimeCodeKind,
    TIMCcsdsTimeCodeT: TIMStandards.TIMCcsdsTimeCodeT,
  };
}

// Authoritative numerical sources:
// - Orekit org.orekit.time.TAIScaleTest.testAAS06134 and TTScaleTest.testAAS06134:
//   UTC 2004-04-06T07:51:28.386009, offsets in SI seconds.
// - Orekit org.orekit.time.GPSScaleTest.testT0/testArbitrary:
//   GPS_EPOCH is 1980-01-06T00:00:00 GPS, and 1999-03-04T00:00:00 GPS
//   equals 1999-03-03T23:59:47 UTC. GPS seconds are SI seconds from
//   GPS_EPOCH in GPS time.
// - Orekit org.orekit.time.GNSSDateTest.testFromWeekAndSeconds* and
//   testFromAbsoluteDate*: GNSS week/seconds use constellation-specific epochs
//   such as Galileo/NavIC 1999-08-22 and BeiDou 2006-01-01 in their native
//   time scales.
//   GPS, QZSS, and SBAS use 1980-01-06 and the same 1387/318677 test instant;
//   NavIC uses the same 1999-08-22 epoch and 363/318677 test instant as
//   Galileo.
// - Orekit org.orekit.time.GNSSDateTest.testZeroZeroGPS: GPS week 0 and
//   seconds 0 remain at GPS_EPOCH when the rollover reference is
//   GPS_EPOCH + 512 weeks, but roll forward to week 1024 when the reference is
//   one day later.
// - Orekit org.orekit.time.AbsoluteDateTest.testMJDDate/testJDDate/
//   testGetJulianDates: JD/MJD values are days in the requested time scale.
// - Orekit org.orekit.time.AbsoluteDateTest.testParse: AbsoluteDate accepts
//   signed extended years, date-only, ordinal-date, and ISO week-date strings
//   such as -4712-01-01T12:00:00.000, 1950-01-01, 1958-001, and 1858-W46-3.
// - Orekit org.orekit.time.DateComponentsTest.testParse: date components
//   accept signed/basic calendar dates, basic ordinal dates, and basic ISO
//   week dates such as -47120101, -4712-01-01, 2000001, and 1999W526.
//   The same test's chronology table maps BC/year-zero, Julian leap-year,
//   Gregorian-reform, century, and J2000 dates to exact J2000 day numbers.
// - Orekit org.orekit.time.DateComponentsTest.testMJD: selected calendar
//   dates map to exact Modified Julian Date day numbers.
// - Orekit org.orekit.time.DateComponentsTest.testISO8601Examples: equivalent
//   calendar, ordinal, and ISO week representations all resolve to 1985-04-12.
// - Orekit org.orekit.time.DateComponentsTest.testDayOfYear: ordinal
//   day-of-year fields map across common-year and leap-year boundaries.
// - Orekit org.orekit.time.DateComponentsTest.testWeekComponents: ISO week
//   year/week/day fields map to calendar dates across ordinary year
//   boundaries and the 1582 Gregorian-reform discontinuity.
// - Orekit org.orekit.time.DateComponentsTest.testReferenceDates/testParse:
//   the astronomical calendar skips from 1582-10-04 to 1582-10-15, making
//   those two civil labels consecutive J2000/MJD days.
// - Orekit org.orekit.time.DateComponentsTest.testWellFormed: wide calendar
//   ranges have exact first/last sequential J2000 days across proleptic
//   Julian, Julian, Gregorian, and Gregorian-reform eras.
// - Orekit org.orekit.time.AbsoluteDateTest.testOffsets: UTC leap-second
//   boundary instants around 1976-12-31/1977-01-01 are equivalent to their
//   stated TAI instants, with elapsed duration measured in SI seconds.
// - Orekit org.orekit.time.UTCScaleTest.testCreatingInLeapDateLocalTime50HoursWest:
//   UTC construction intentionally accepts stress-test UTC offsets beyond
//   ordinary civil time zones while preserving leap-second semantics.
// - Orekit org.orekit.time.AbsoluteDateTest.testCCSDSUnsegmentedNoExtension:
//   CCSDS CUC preamble 0x1F with four coarse bytes and three fine bytes uses
//   CCSDS_EPOCH in TAI and decodes to 2002-05-23T12:34:56.789 UTC; formatting
//   the same instant back to CUC emits those raw time-field bytes.
//   Preamble 0x2F covers the same instant with an agency-defined J2000 epoch
//   expressed in TAI as 2000-01-01T11:59:27.816.
// - Orekit org.orekit.time.AbsoluteDateTest.testCCSDSUnsegmentedWithExtendedPreamble:
//   extended CUC preambles 0x9F/0x30 carry five coarse octets and seven fine
//   octets, decoding to 2095-03-03T22:02:45.789012 UTC at module precision;
//   target preservation keeps the raw submicrosecond fine field.
// - Orekit org.orekit.time.AbsoluteDateTest.testCCSDSDaySegmented:
//   CCSDS CDS preamble 0x42 with two day bytes, four millisecond bytes, and
//   four picosecond bytes uses the CCSDS epoch and decodes to
//   2002-05-23T12:34:56.789012345678 UTC; formatting the same instant at the
//   module's microsecond precision emits canonical CDS bytes, while identity
//   CCSDS target preservation keeps the raw picosecond field.
//   Preamble 0x49 covers the same instant with an agency-defined J2000 epoch
//   and the day-segmented microsecond field size.
// - Orekit org.orekit.time.AbsoluteDateTest.testCCSDSCalendarSegmented:
//   CCSDS CCS preambles 0x56 and 0x5E cover month/day and day-of-year calendar
//   variations and decode to 2002-05-23T12:34:56.789012345678 UTC; preamble
//   0x5B covers the same day-of-year representation limited to microsecond
//   precision, while identity CCSDS target preservation keeps the raw calendar
//   source variant.
// - Orekit org.orekit.time.UTCScaleTest.testOffsets: pre-1972 UTC-TAI history
//   uses linear MJD-based offsets such as 1.424114 s on 1961-01-02 and
//   6.188274 s on 1968-02-02, with UTC == TAI before 1961-01-01.
// - Orekit org.orekit.time.UT1ScaleTest.testAAS06134: UTC
//   2004-04-06T07:51:28.386009 with DUT1 -0.439962 s produces UT1
//   2004-04-06T07:51:27.946047.
// - Orekit org.orekit.time.AbsoluteDateTest.testLargeLeapSecond: the
//   pre-1972 UTC label 1960-12-31T23:59:61.4 is the same instant as
//   1961-01-01T00:00:00 UTC shifted back by 22.818 ms.
// - Orekit org.orekit.time.TCGScaleTest.testAAS06134: UTC
//   2004-04-06T07:51:28.386009 produces TCG
//   2004-04-06T07:52:33.1695861742 using the IAU LG linear rate.
// - Orekit org.orekit.time.TCGScaleTest.testReference: 1977-01-01T00:00:32.184
//   TCG is the same instant as 1977-01-01T00:00:00.000 TAI.
// - Orekit org.orekit.time.TDBScaleTest.testReference/testToTAI: J2000 TT
//   corresponds to 2000-01-01T11:59:27.816 TAI and
//   2000-01-01T11:59:59.999927340791372839 TDB using Orekit's conventional
//   two-term periodic TDB offset.
// - Orekit org.orekit.time.TCBScaleTest.testAAS06134: UTC
//   2004-04-06T07:51:28.386009 produces TCB
//   2004-04-06T07:52:45.9109901113 from TDB plus the IAU LB linear rate.
// - Orekit org.orekit.time.GMSTScaleTest.testReference: UT1
//   2001-10-03T06:30:00.000 produces GMST 2001-10-03T07:18:08.329.
// - Orekit org.orekit.time.GLONASSScaleTest.testArbitrary: GLONASS
//   1999-03-04T00:00:00 equals UTC 1999-03-03T21:00:00.
// - Orekit org.orekit.time.GLONASSScaleTest.testDuringLeap: UTC
//   1983-06-30T23:59:60.004 formats in GLONASS as
//   1983-07-01T02:59:60.004.
// - Orekit org.orekit.time.GNSSDateTest.testBadSatelliteSystem: GLONASS is a
//   supported time scale but not a valid GNSSDate week/seconds satellite
//   system.
// - Orekit org.orekit.time.DateComponentsTest.testConstructorBadWeek,
//   testConstructorBadDayOfWeek1, testConstructorBadDayOfWeek2, and
//   testConstructorBadString: ISO week date parsing rejects week 53 on
//   52-week years, day-of-week 0/8, and malformed calendar years.
// - Orekit org.orekit.time.DateTimeComponentsTest.testParse/testLocalTime and
//   TimeComponentsTest.testParse: ISO/RFC3339 date-time strings accept
//   explicit UTC offsets, compact HHMM/hour-only offsets, and comma or period
//   fractional seconds; Orekit basic time forms such as HHMMSS also compose
//   with date components through DateTimeComponents.parseDateTime.
// - Orekit org.orekit.time.GalileoScaleTest.test2006: GST
//   2006-01-02T00:00:00 equals UTC 2006-01-01T23:59:46.
// - Orekit org.orekit.time.BDSScaleTest.test2010: BDT
//   2010-01-02T00:00:00 equals UTC 2010-01-01T23:59:59.
// - Orekit org.orekit.time.QZSSScaleTest.testArbitrary and
//   NavicScaleTest.testArbitrary: QZSS/NavIC 1999-03-04T00:00:00 equals UTC
//   1999-03-03T23:59:47.
// Tolerances are exact to 1e-12 seconds for constant time-scale offsets and
// 1e-6 days for Orekit's JD/MJD tests, matching the upstream published checks.

test("build publishes canonical isomorphic artifact path", () => {
  assert.equal(fs.existsSync(fileURLToPath(ISOMORPHIC_WASM_PATH)), true);
});

test("built artifact passes SDK compliance checks", async () => {
  const report = await validateArtifactWithStandards({
    manifest: readManifest(),
    wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH),
    standardsRoot: STANDARDS_ROOT,
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("built artifact exposes the standalone isomorphic surface", async () => {
  const inspection = await inspectModule(fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)));
  const importedModuleNames = Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort();
  assert.equal(inspection.profile, "standalone");
  assert.deepEqual(importedModuleNames, ["wasi_snapshot_preview1"]);
  for (const required of [
    "_start",
    "plugin_alloc",
    "plugin_free",
    "plugin_invoke_stream",
    "plugin_get_manifest_flatbuffer",
    "plugin_get_manifest_flatbuffer_size",
  ]) {
    assert.ok(inspection.exports.includes(required), `missing export ${required}`);
  }
});

test("converts Orekit TAIScaleTest.testAAS06134 UTC instant to TAI", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2004-04-06T07:51:28.386009Z",
      targetSystem: timingStandard.TAI,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TAI);
  assert.equal(target.ISO8601(), "2004-04-06T07:52:00.386009");
  assertNear(result.DELTA_SECONDS(), 32.0, 1e-12, "UTC to TAI offset");
});

test("converts Orekit UTCScaleTest.testOffsets 1961 linear UTC offset to TAI", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "1961-01-02T00:00:00Z",
      targetSystem: timingStandard.TAI,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TAI);
  assert.equal(target.ISO8601(), "1961-01-02T00:00:01.424114");
  assertNear(result.DELTA_SECONDS(), 1.424114, 1e-12, "1961 UTC to TAI offset");
});

test("parses Orekit AbsoluteDateTest.testLargeLeapSecond pre-1972 UTC label", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "1960-12-31T23:59:61.4Z",
      targetSystem: timingStandard.TAI,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TAI);
  assert.equal(target.ISO8601(), "1961-01-01T00:00:01.400000");
});

test("parses Orekit UTCScaleTest.testCreatingInLeapDateLocalTime50HoursWest stress offset", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2008-12-29T21:59:60-50:00",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2008-12-31T23:59:60.000000Z");
});

test("converts Orekit UTCScaleTest.testOffsets 1968 linear UTC offset to TAI", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "1968-02-02T00:00:00Z",
      targetSystem: timingStandard.TAI,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TAI);
  assert.equal(target.ISO8601(), "1968-02-02T00:00:06.188274");
  assertNear(result.DELTA_SECONDS(), 6.188274, 1e-12, "1968 UTC to TAI offset");
});

test("converts Orekit TTScaleTest.testAAS06134 UTC instant to TT", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2004-04-06T07:51:28.386009Z",
      targetSystem: timingStandard.TT,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TT);
  assert.equal(target.ISO8601(), "2004-04-06T07:52:32.570009");
  assertNear(result.DELTA_SECONDS(), 64.184, 1e-12, "UTC to TT offset");
});

test("converts Orekit UT1ScaleTest.testAAS06134 UTC instant to UT1 with DUT1", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2004-04-06T07:51:28.386009Z",
      targetSystem: timingStandard.UT1,
      hasDut1: true,
      dut1Seconds: -0.439962,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UT1);
  assert.equal(target.ISO8601(), "2004-04-06T07:51:27.946047");
  assertNear(result.DELTA_SECONDS(), -0.439962, 1e-12, "UTC to UT1 offset");
});

test("converts Orekit TCGScaleTest.testAAS06134 UTC instant to TCG", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2004-04-06T07:51:28.386009Z",
      targetSystem: timingStandard.TCG,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TCG);
  assert.equal(target.ISO8601(), "2004-04-06T07:52:33.169586");
  assertNear(result.DELTA_SECONDS(), 64.7835771742, 5e-10, "UTC to TCG offset");
});

test("converts Orekit TCGScaleTest.testReference TCG reference instant to TAI", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.TCG,
      sourceIso8601: "1977-01-01T00:00:32.184000",
      targetSystem: timingStandard.TAI,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TAI);
  assert.equal(target.ISO8601(), "1977-01-01T00:00:00.000000");
  assertNear(result.DELTA_SECONDS(), -32.184, 1e-12, "TCG reference to TAI offset");
});

test("converts Orekit TDBScaleTest.testReference J2000 TAI instant to TDB", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.TAI,
      sourceIso8601: "2000-01-01T11:59:27.816000",
      targetSystem: timingStandard.TDB,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TDB);
  assert.equal(target.ISO8601(), "2000-01-01T11:59:59.999927");
  assertNear(result.DELTA_SECONDS(), 32.18392734079137, 1e-12, "J2000 TAI to TDB offset");
});

test("converts Orekit TDBScaleTest.testToTAI J2000 TDB instant to TAI", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.TDB,
      sourceIso8601: "2000-01-01T11:59:59.999927",
      targetSystem: timingStandard.TAI,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TAI);
  assert.equal(target.ISO8601(), "2000-01-01T11:59:27.816000");
  assertNear(result.DELTA_SECONDS(), -32.18392734079137, 1e-6, "J2000 TDB to TAI offset");
});

test("converts Orekit TCBScaleTest.testAAS06134 UTC instant to TCB", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2004-04-06T07:51:28.386009Z",
      targetSystem: timingStandard.TCB,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TCB);
  assert.equal(target.ISO8601(), "2004-04-06T07:52:45.910990");
  assertNear(result.DELTA_SECONDS(), 77.5249811113, 2e-8, "UTC to TCB offset");
});

test("converts Orekit GMSTScaleTest.testReference UT1 instant to GMST", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UT1,
      sourceIso8601: "2001-10-03T06:30:00.000000",
      targetSystem: timingStandard.GMST,
      hasDut1: true,
      dut1Seconds: 0,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.GMST);
  assert.match(target.ISO8601(), /^2001-10-03T07:18:08\./);
  assertNear(secondsOfDayFromIso(target.ISO8601()), 7 * 3600 + 18 * 60 + 8.329, 4e-4, "GMST reference time");
});

test("converts Orekit GLONASSScaleTest.testArbitrary GLONASS instant to UTC", async (t) => {
  assert.equal(typeof timingStandard.GLONASS, "number", "SDS TIM timingStandard.GLONASS must exist");
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.GLONASS,
      sourceIso8601: "1999-03-04T00:00:00",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "1999-03-03T21:00:00.000000Z");
});

test("formats Orekit GLONASSScaleTest.testDuringLeap UTC leap instant as GLONASS leap second", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "1983-06-30T23:59:60.004Z",
      targetSystem: timingStandard.GLONASS,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.GLONASS);
  assert.equal(target.ISO8601(), "1983-07-01T02:59:60.004000");
});

test("parses Orekit GLONASSScaleTest.testDuringLeap GLONASS leap label to UTC", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.GLONASS,
      sourceIso8601: "1983-07-01T02:59:60.004",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "1983-06-30T23:59:60.004000Z");
});

test("rejects Orekit GNSSDateTest.testBadSatelliteSystem GLONASS GPS_SECONDS source", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.GLONASS,
      sourceIso8601: null,
      sourceFormat: timEpochRepresentation.GPS_SECONDS,
      sourceSeconds: 0,
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  assert.equal(result.STATUS(), timConversionStatus.INVALID_INPUT);
  assert.match(result.ERROR_MESSAGE(), /GPS_SECONDS.*source time system/i);
});

test("rejects Orekit GNSSDateTest.testBadSatelliteSystem GLONASS GPS_SECONDS target", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "1999-03-03T21:00:00Z",
      targetSystem: timingStandard.GLONASS,
      targetFormat: timEpochRepresentation.GPS_SECONDS,
    }),
  );
  const result = decodeResult(response);
  assert.equal(result.STATUS(), timConversionStatus.INVALID_INPUT);
  assert.match(result.ERROR_MESSAGE(), /GPS_SECONDS.*target time system/i);
});

test("parses Orekit DateTimeComponentsTest.testParse UTC zero offset suffix", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2000-01-02T03:04:05.000+00:00",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2000-01-02T03:04:05.000000Z");
});

test("converts Orekit DateTimeComponentsTest.testLocalTime UTC positive offset to UTC", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2000-02-29T03:04:05.000+00:01",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2000-02-29T03:03:05.000000Z");
});

test("converts Orekit AbsoluteDateTest.testLocalTimeParsing compact positive offset to UTC", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2012-01-01T03:30:00+0430",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2011-12-31T23:00:00.000000Z");
});

test("converts Orekit AbsoluteDateTest.testLocalTimeParsing hour-only offset to UTC", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2012-01-01T03:30:00+04",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2011-12-31T23:30:00.000000Z");
});

test("converts Orekit AbsoluteDateTest.testLocalTimeParsing compact negative offset to UTC", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2011-12-31T22:17:00-0700",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2012-01-01T05:17:00.000000Z");
});

test("parses Orekit TimeComponentsTest.testParse comma fractional seconds", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2000-01-02T23:59:59,900Z",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2000-01-02T23:59:59.900000Z");
});

test("parses Orekit TimeComponentsTest.testParse basic UTC time", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2000-01-02T235959.900Z",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2000-01-02T23:59:59.900000Z");
});

test("parses Orekit TimeComponentsTest.testParse reduced local time variants", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const cases = [
    {
      sourceIso8601: "2000-01-02T23:59",
      expectedIso8601: "2000-01-02T23:59:00.000000Z",
    },
    {
      sourceIso8601: "2000-01-02T235959.900+10",
      expectedIso8601: "2000-01-02T13:59:59.900000Z",
    },
    {
      sourceIso8601: "2000-01-02T23:59:59+01:00",
      expectedIso8601: "2000-01-02T22:59:59.000000Z",
    },
  ];

  for (const testCase of cases) {
    const response = await invokeConversion(
      harness,
      encodeConversionRequest({
        sourceSystem: timingStandard.UTC,
        sourceIso8601: testCase.sourceIso8601,
        targetSystem: timingStandard.UTC,
      }),
    );
    const result = decodeResult(response);
    const target = result.TARGET();
    assert.equal(result.STATUS(), timConversionStatus.OK, testCase.sourceIso8601);
    assert.equal(target.TIME_SYSTEM(), timingStandard.UTC, testCase.sourceIso8601);
    assert.equal(target.ISO8601(), testCase.expectedIso8601, testCase.sourceIso8601);
  }
});

test("rejects Orekit TimeComponentsTest.testBadFormat HMS designators", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2000-01-02T23h59m59s",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  assert.equal(result.STATUS(), timConversionStatus.INVALID_INPUT);
  assert.match(result.ERROR_MESSAGE(), /epoch is invalid/i);
});

test("parses Orekit AbsoluteDateTest.testParse date-only Fifties epoch", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.TT,
      sourceIso8601: "1950-01-01",
      targetSystem: timingStandard.TT,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TT);
  assert.equal(target.ISO8601(), "1950-01-01T00:00:00.000000");
});

test("parses Orekit AbsoluteDateTest.testParse ordinal CCSDS epoch", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.TAI,
      sourceIso8601: "1958-001",
      targetSystem: timingStandard.TAI,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TAI);
  assert.equal(target.ISO8601(), "1958-01-01T00:00:00.000000");
});

test("parses Orekit AbsoluteDateTest.testParse ISO week Modified Julian epoch", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.TT,
      sourceIso8601: "1858-W46-3",
      targetSystem: timingStandard.TT,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TT);
  assert.equal(target.ISO8601(), "1858-11-17T00:00:00.000000");
});

test("parses Orekit AbsoluteDateTest.testParse signed Julian epoch", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.TT,
      sourceIso8601: "-4712-01-01T12:00:00.000",
      targetSystem: timingStandard.TT,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TT);
  assert.equal(target.ISO8601(), "-4712-01-01T12:00:00.000000");
});

test("parses Orekit DateComponentsTest.testParse basic and signed date forms", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const cases = [
    {
      sourceSystem: timingStandard.TT,
      sourceIso8601: "-47120101",
      targetSystem: timingStandard.TT,
      expectedIso8601: "-4712-01-01T00:00:00.000000",
    },
    {
      sourceSystem: timingStandard.TT,
      sourceIso8601: "-4712-01-01",
      targetSystem: timingStandard.TT,
      expectedIso8601: "-4712-01-01T00:00:00.000000",
    },
    {
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2000001",
      targetSystem: timingStandard.UTC,
      expectedIso8601: "2000-01-01T00:00:00.000000Z",
    },
    {
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "1999W526",
      targetSystem: timingStandard.UTC,
      expectedIso8601: "2000-01-01T00:00:00.000000Z",
    },
  ];

  for (const vector of cases) {
    const response = await invokeConversion(
      harness,
      encodeConversionRequest({
        sourceSystem: vector.sourceSystem,
        sourceIso8601: vector.sourceIso8601,
        targetSystem: vector.targetSystem,
      }),
    );
    const result = decodeResult(response);
    const target = result.TARGET();
    assert.equal(result.STATUS(), timConversionStatus.OK, vector.sourceIso8601);
    assert.equal(target.TIME_SYSTEM(), vector.targetSystem, vector.sourceIso8601);
    assert.equal(target.ISO8601(), vector.expectedIso8601, vector.sourceIso8601);
  }
});

test("emits Orekit DateComponentsTest.testParse chronology J2000 days as MJD", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const cases = [
    ["-47131231", -2451546],
    ["-4713-12-31", -2451546],
    ["-47120101", -2451545],
    ["-4712-01-01", -2451545],
    ["00001231", -730122],
    ["0000-12-31", -730122],
    ["00010101", -730121],
    ["0001-01-01", -730121],
    ["15000228", -182554],
    ["1500-02-28", -182554],
    ["15000229", -182553],
    ["1500-02-29", -182553],
    ["15000301", -182552],
    ["1500-03-01", -182552],
    ["15821004", -152385],
    ["1582-10-04", -152385],
    ["1582W404", -152385],
    ["1582-W40-4", -152385],
    ["15821015", -152384],
    ["1582-10-15", -152384],
    ["1582W405", -152384],
    ["1582-W40-5", -152384],
    ["16000228", -146039],
    ["1600-02-28", -146039],
    ["16000229", -146038],
    ["1600-02-29", -146038],
    ["16000301", -146037],
    ["17000228", -109514],
    ["1700-02-28", -109514],
    ["17000301", -109513],
    ["1700-03-01", -109513],
    ["18000228", -72990],
    ["1800-02-28", -72990],
    ["18000301", -72989],
    ["1800-03-01", -72989],
    ["18581115", -51546],
    ["1858-11-15", -51546],
    ["18581116", -51545],
    ["1858-11-16", -51545],
    ["19991231", -1],
    ["1999-12-31", -1],
    ["20000101", 0],
    ["2000-01-01", 0],
    ["2000001", 0],
    ["2000-001", 0],
    ["1999-W52-6", 0],
    ["1999W526", 0],
    ["20000228", 58],
    ["2000-02-28", 58],
    ["20000229", 59],
    ["2000-02-29", 59],
    ["20000301", 60],
    ["2000-03-01", 60],
  ];

  for (const [sourceIso8601, expectedJ2000Day] of cases) {
    const response = await invokeConversion(
      harness,
      encodeConversionRequest({
        sourceSystem: timingStandard.TT,
        sourceIso8601,
        targetSystem: timingStandard.TT,
        targetFormat: timEpochRepresentation.MODIFIED_JULIAN_DATE,
      }),
    );
    const result = decodeResult(response);
    const target = result.TARGET();
    assert.equal(result.STATUS(), timConversionStatus.OK, sourceIso8601);
    assert.equal(target.EPOCH_FORMAT(), timEpochRepresentation.MODIFIED_JULIAN_DATE, sourceIso8601);
    assertNear(target.JULIAN_DATE(), expectedJ2000Day + 51544, 1e-12, sourceIso8601);
  }
});

test("emits Orekit DateComponentsTest.testMJD modified Julian days", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const cases = [
    ["1858-11-17", 0],
    ["1962-01-01", 37665],
    ["2008-05-14", 54600],
  ];

  for (const [sourceIso8601, expectedMjd] of cases) {
    const response = await invokeConversion(
      harness,
      encodeConversionRequest({
        sourceSystem: timingStandard.TT,
        sourceIso8601,
        targetSystem: timingStandard.TT,
        targetFormat: timEpochRepresentation.MODIFIED_JULIAN_DATE,
      }),
    );
    const result = decodeResult(response);
    const target = result.TARGET();
    assert.equal(result.STATUS(), timConversionStatus.OK, sourceIso8601);
    assert.equal(target.EPOCH_FORMAT(), timEpochRepresentation.MODIFIED_JULIAN_DATE, sourceIso8601);
    assertNear(target.JULIAN_DATE(), expectedMjd, 1e-12, sourceIso8601);
  }
});

test("parses Orekit DateComponentsTest.testISO8601Examples date forms", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const cases = ["19850412", "1985-04-12", "1985102", "1985-102", "1985W155", "1985-W15-5"];

  for (const sourceIso8601 of cases) {
    const response = await invokeConversion(
      harness,
      encodeConversionRequest({
        sourceSystem: timingStandard.UTC,
        sourceIso8601,
        targetSystem: timingStandard.UTC,
      }),
    );
    const result = decodeResult(response);
    const target = result.TARGET();
    assert.equal(result.STATUS(), timConversionStatus.OK, sourceIso8601);
    assert.equal(target.TIME_SYSTEM(), timingStandard.UTC, sourceIso8601);
    assert.equal(target.ISO8601(), "1985-04-12T00:00:00.000000Z", sourceIso8601);
  }
});

test("parses Orekit DateComponentsTest.testDayOfYear ordinal mappings", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const cases = [
    ["2003-001", "2003-01-01T00:00:00.000000Z"],
    ["2003-365", "2003-12-31T00:00:00.000000Z"],
    ["2004-366", "2004-12-31T00:00:00.000000Z"],
    ["2003-059", "2003-02-28T00:00:00.000000Z"],
    ["2003-060", "2003-03-01T00:00:00.000000Z"],
    ["2004-059", "2004-02-28T00:00:00.000000Z"],
    ["2004-060", "2004-02-29T00:00:00.000000Z"],
    ["2004-061", "2004-03-01T00:00:00.000000Z"],
    ["2003-269", "2003-09-26T00:00:00.000000Z"],
  ];

  for (const [sourceIso8601, expectedIso8601] of cases) {
    const response = await invokeConversion(
      harness,
      encodeConversionRequest({
        sourceSystem: timingStandard.UTC,
        sourceIso8601,
        targetSystem: timingStandard.UTC,
      }),
    );
    const result = decodeResult(response);
    const target = result.TARGET();
    assert.equal(result.STATUS(), timConversionStatus.OK, sourceIso8601);
    assert.equal(target.TIME_SYSTEM(), timingStandard.UTC, sourceIso8601);
    assert.equal(target.ISO8601(), expectedIso8601, sourceIso8601);
  }
});

test("parses Orekit DateComponentsTest.testWeekComponents ISO week-date sweep", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const cases = [
    ["1994-W52-7", "1995-01-01T00:00:00.000000Z"],
    ["1996-W52-7", "1996-12-29T00:00:00.000000Z"],
    ["1997-W01-1", "1996-12-30T00:00:00.000000Z"],
    ["1997-W01-7", "1997-01-05T00:00:00.000000Z"],
    ["1997-W52-7", "1997-12-28T00:00:00.000000Z"],
    ["1998-W01-1", "1997-12-29T00:00:00.000000Z"],
    ["1998-W01-7", "1998-01-04T00:00:00.000000Z"],
    ["1998-W02-1", "1998-01-05T00:00:00.000000Z"],
    ["1998-W52-7", "1998-12-27T00:00:00.000000Z"],
    ["1998-W53-1", "1998-12-28T00:00:00.000000Z"],
    ["1998-W53-7", "1999-01-03T00:00:00.000000Z"],
    ["1999-W01-1", "1999-01-04T00:00:00.000000Z"],
    ["1582-W40-4", "1582-10-04T00:00:00.000000Z"],
    ["1582-W40-5", "1582-10-15T00:00:00.000000Z"],
    ["1582-W51-5", "1582-12-31T00:00:00.000000Z"],
    ["1582-W51-6", "1583-01-01T00:00:00.000000Z"],
    ["1582-W51-7", "1583-01-02T00:00:00.000000Z"],
    ["1583-W01-1", "1583-01-03T00:00:00.000000Z"],
  ];

  for (const [sourceIso8601, expectedIso8601] of cases) {
    const response = await invokeConversion(
      harness,
      encodeConversionRequest({
        sourceSystem: timingStandard.UTC,
        sourceIso8601,
        targetSystem: timingStandard.UTC,
      }),
    );
    const result = decodeResult(response);
    const target = result.TARGET();
    assert.equal(result.STATUS(), timConversionStatus.OK, sourceIso8601);
    assert.equal(target.TIME_SYSTEM(), timingStandard.UTC, sourceIso8601);
    assert.equal(target.ISO8601(), expectedIso8601, sourceIso8601);
  }
});

test("emits Orekit DateComponentsTest Gregorian reform consecutive MJD days", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const cases = [
    ["1582-10-04", -100841],
    ["1582-W40-4", -100841],
    ["1582-10-15", -100840],
    ["1582-W40-5", -100840],
  ];

  for (const [sourceIso8601, expectedMjd] of cases) {
    const response = await invokeConversion(
      harness,
      encodeConversionRequest({
        sourceSystem: timingStandard.TT,
        sourceIso8601,
        targetSystem: timingStandard.TT,
        targetFormat: timEpochRepresentation.MODIFIED_JULIAN_DATE,
      }),
    );
    const result = decodeResult(response);
    const target = result.TARGET();
    assert.equal(result.STATUS(), timConversionStatus.OK, sourceIso8601);
    assert.equal(target.EPOCH_FORMAT(), timEpochRepresentation.MODIFIED_JULIAN_DATE, sourceIso8601);
    assertNear(target.JULIAN_DATE(), expectedMjd, 1e-12, sourceIso8601);
  }
});

test("rejects Orekit DateComponentsTest.testConstructorBadWeek invalid ISO week date", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2008-W53-1",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  assert.equal(result.STATUS(), timConversionStatus.INVALID_INPUT);
  assert.match(result.ERROR_MESSAGE(), /source timinstant epoch is invalid/i);
});

test("rejects Orekit DateComponentsTest invalid weekday and malformed date strings", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const cases = [
    "2008-W43-0",
    "2008-W43-8",
    "197-05-01",
  ];

  for (const sourceIso8601 of cases) {
    const response = await invokeConversion(
      harness,
      encodeConversionRequest({
        sourceSystem: timingStandard.UTC,
        sourceIso8601,
        targetSystem: timingStandard.UTC,
      }),
    );
    const result = decodeResult(response);
    assert.equal(result.STATUS(), timConversionStatus.INVALID_INPUT, sourceIso8601);
    assert.match(result.ERROR_MESSAGE(), /source timinstant epoch is invalid/i, sourceIso8601);
  }
});

test("emits Orekit DateComponentsTest.testWellFormed range endpoint J2000 days as MJD", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const cases = [
    ["-4800-01-01", -2483687],
    ["-4700-12-31", -2446797],
    ["-0005-01-01", -732313],
    ["0005-12-31", -728296],
    ["1580-01-01", -153392],
    ["1605-12-31", -143906],
    ["1695-01-01", -111398],
    ["1705-12-31", -107382],
    ["1795-01-01", -74874],
    ["1805-12-31", -70858],
    ["1895-01-01", -38350],
    ["1905-12-31", -34334],
    ["1995-01-01", -1826],
    ["2005-12-31", 2191],
  ];

  for (const [sourceIso8601, expectedJ2000Day] of cases) {
    const response = await invokeConversion(
      harness,
      encodeConversionRequest({
        sourceSystem: timingStandard.TT,
        sourceIso8601,
        targetSystem: timingStandard.TT,
        targetFormat: timEpochRepresentation.MODIFIED_JULIAN_DATE,
      }),
    );
    const result = decodeResult(response);
    const target = result.TARGET();
    assert.equal(result.STATUS(), timConversionStatus.OK, sourceIso8601);
    assert.equal(target.EPOCH_FORMAT(), timEpochRepresentation.MODIFIED_JULIAN_DATE, sourceIso8601);
    assertNear(target.JULIAN_DATE(), expectedJ2000Day + 51544, 1e-12, sourceIso8601);
  }
});

test("converts Orekit GalileoScaleTest.test2006 GST instant to UTC", async (t) => {
  assert.equal(typeof timingStandard.GST, "number", "SDS TIM timingStandard.GST must exist");
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.GST,
      sourceIso8601: "2006-01-02T00:00:00",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2006-01-01T23:59:46.000000Z");
  assertNear(result.DELTA_SECONDS(), -14.0, 1e-12, "GST to UTC offset");
});

test("converts Orekit BDSScaleTest.test2010 BDT instant to UTC", async (t) => {
  assert.equal(typeof timingStandard.BDT, "number", "SDS TIM timingStandard.BDT must exist");
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.BDT,
      sourceIso8601: "2010-01-02T00:00:00",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2010-01-01T23:59:59.000000Z");
  assertNear(result.DELTA_SECONDS(), -1.0, 1e-12, "BDT to UTC offset");
});

test("converts Orekit QZSSScaleTest.testArbitrary QZSS instant to UTC", async (t) => {
  assert.equal(typeof timingStandard.QZSS, "number", "SDS TIM timingStandard.QZSS must exist");
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.QZSS,
      sourceIso8601: "1999-03-04T00:00:00",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "1999-03-03T23:59:47.000000Z");
  assertNear(result.DELTA_SECONDS(), -13.0, 1e-12, "QZSS to UTC offset");
});

test("converts Orekit NavicScaleTest.testArbitrary NavIC instant to UTC", async (t) => {
  assert.equal(typeof timingStandard.NAVIC, "number", "SDS TIM timingStandard.NAVIC must exist");
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.NAVIC,
      sourceIso8601: "1999-03-04T00:00:00",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "1999-03-03T23:59:47.000000Z");
  assertNear(result.DELTA_SECONDS(), -13.0, 1e-12, "NavIC to UTC offset");
});

test("converts Orekit GPSScaleTest.testArbitrary GPS instant to UTC", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.GPS,
      sourceIso8601: "1999-03-04T00:00:00",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "1999-03-03T23:59:47.000000Z");
  assertNear(result.DELTA_SECONDS(), -13.0, 1e-12, "GPS to UTC offset");
});

test("emits Orekit AbsoluteDateTest.testGetJulianDates UTC Julian Date", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2024-07-04T13:00:00Z",
      targetSystem: timingStandard.UTC,
      targetFormat: timEpochRepresentation.JULIAN_DATE,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.EPOCH_FORMAT(), timEpochRepresentation.JULIAN_DATE);
  assertNear(target.JULIAN_DATE(), 2460496.0416667, 1e-6, "UTC Julian Date");
});

test("emits Orekit AbsoluteDateTest.testMJDDate TT Modified Julian Date", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.TT,
      sourceIso8601: "2000-01-01T12:00:00",
      targetSystem: timingStandard.TT,
      targetFormat: timEpochRepresentation.MODIFIED_JULIAN_DATE,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TT);
  assert.equal(target.EPOCH_FORMAT(), timEpochRepresentation.MODIFIED_JULIAN_DATE);
  assertNear(target.JULIAN_DATE(), 51544.5, 1e-12, "TT Modified Julian Date");
});

test("parses Orekit AbsoluteDateTest.testGetJulianDates UTC MJD input", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: null,
      sourceFormat: timEpochRepresentation.MODIFIED_JULIAN_DATE,
      sourceJulianDate: 60495.5416667,
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2024-07-04T13:00:00.002883Z");
});

test("uses Orekit GPSScaleTest.testT0 GPS epoch for GPS seconds", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.GPS,
      sourceIso8601: null,
      sourceFormat: timEpochRepresentation.GPS_SECONDS,
      sourceSeconds: 0,
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "1980-01-06T00:00:00.000000Z");
});

test("emits GPS seconds for Orekit GPSScaleTest.testArbitrary instant", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "1999-03-03T23:59:47Z",
      targetSystem: timingStandard.GPS,
      targetFormat: timEpochRepresentation.GPS_SECONDS,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.GPS);
  assert.equal(target.EPOCH_FORMAT(), timEpochRepresentation.GPS_SECONDS);
  assertNear(target.SECONDS(), 604540800, 1e-9, "GPS seconds since Orekit GPS_EPOCH");
});

test("parses Orekit AbsoluteDateTest.testCCSDSUnsegmentedNoExtension CCSDS epoch CUC", async (t) => {
  const {
    ccsdsTimeCodeFormat,
    ccsdsTimeCodeKind,
    TIMCcsdsTimeCodeT,
  } = requireCcsdsTimeCodeSurface();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.TAI,
      sourceIso8601: null,
      sourceFormat: ccsdsTimeCodeFormat,
      sourceCcsdsTimeCode: new TIMCcsdsTimeCodeT(
        ccsdsTimeCodeKind.UNSEGMENTED,
        0x1f,
        0x00,
        Uint8Array.from([0x53, 0x7f, 0x40, 0x90, 0xc9, 0xfb, 0xe7]),
      ),
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2002-05-23T12:34:56.789000Z");
});

test("emits Orekit AbsoluteDateTest.testCCSDSUnsegmentedNoExtension CCSDS epoch CUC target", async (t) => {
  const {
    ccsdsTimeCodeFormat,
    ccsdsTimeCodeKind,
  } = requireCcsdsTimeCodeSurface();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2002-05-23T12:34:56.789Z",
      targetSystem: timingStandard.TAI,
      targetFormat: ccsdsTimeCodeFormat,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  const code = target.CCSDS_TIME_CODE();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TAI);
  assert.equal(target.EPOCH_FORMAT(), ccsdsTimeCodeFormat);
  assert.ok(code, "missing target CCSDS_TIME_CODE payload");
  assert.equal(code.CODE_KIND(), ccsdsTimeCodeKind.UNSEGMENTED);
  assert.equal(code.PREAMBLE_FIELD1(), 0x1f);
  assert.equal(code.PREAMBLE_FIELD2(), 0x00);
  assert.deepEqual(
    Array.from(code.timeFieldArray()),
    [0x53, 0x7f, 0x40, 0x90, 0xc9, 0xfb, 0xe7],
  );
});

test("emits Orekit AbsoluteDateTest.testCCSDSUnsegmentedNoExtension agency epoch CUC target", async (t) => {
  const {
    ccsdsTimeCodeFormat,
    ccsdsTimeCodeKind,
    TIMCcsdsTimeCodeT,
  } = requireCcsdsTimeCodeSurface();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const orekitJ2000Unsegmented = [
    0x04, 0x7e, 0xf5, 0xf0, 0xf9, 0x16, 0x87,
  ];
  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.TAI,
      sourceIso8601: null,
      sourceFormat: ccsdsTimeCodeFormat,
      sourceCcsdsTimeCode: new TIMCcsdsTimeCodeT(
        ccsdsTimeCodeKind.UNSEGMENTED,
        0x2f,
        0x00,
        Uint8Array.from(orekitJ2000Unsegmented),
        "2000-01-01T11:59:27.816",
      ),
      targetSystem: timingStandard.TAI,
      targetFormat: ccsdsTimeCodeFormat,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  const code = target.CCSDS_TIME_CODE();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TAI);
  assert.equal(target.EPOCH_FORMAT(), ccsdsTimeCodeFormat);
  assert.equal(target.ISO8601(), "2002-05-23T12:35:28.789000");
  assert.ok(code, "missing target CCSDS_TIME_CODE payload");
  assert.equal(code.CODE_KIND(), ccsdsTimeCodeKind.UNSEGMENTED);
  assert.equal(code.PREAMBLE_FIELD1(), 0x2f);
  assert.equal(code.PREAMBLE_FIELD2(), 0x00);
  assert.equal(code.AGENCY_DEFINED_EPOCH_ISO8601(), "2000-01-01T11:59:27.816");
  assert.deepEqual(Array.from(code.timeFieldArray()), orekitJ2000Unsegmented);
});

test("emits Orekit AbsoluteDateTest.testCCSDSUnsegmentedWithExtendedPreamble extended CUC target", async (t) => {
  const {
    ccsdsTimeCodeFormat,
    ccsdsTimeCodeKind,
    TIMCcsdsTimeCodeT,
  } = requireCcsdsTimeCodeSurface();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const orekitExtendedUnsegmented = [
    0x01, 0x02, 0x03, 0x04, 0x2a, 0xc9, 0xfc, 0xb6, 0x8c, 0xd4, 0xc4, 0xb8,
  ];
  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.TAI,
      sourceIso8601: null,
      sourceFormat: ccsdsTimeCodeFormat,
      sourceCcsdsTimeCode: new TIMCcsdsTimeCodeT(
        ccsdsTimeCodeKind.UNSEGMENTED,
        0x9f,
        0x30,
        Uint8Array.from(orekitExtendedUnsegmented),
      ),
      targetSystem: timingStandard.TAI,
      targetFormat: ccsdsTimeCodeFormat,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  const code = target.CCSDS_TIME_CODE();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TAI);
  assert.equal(target.EPOCH_FORMAT(), ccsdsTimeCodeFormat);
  assert.equal(target.ISO8601(), "2095-03-03T22:03:22.789012");
  assert.ok(code, "missing target CCSDS_TIME_CODE payload");
  assert.equal(code.CODE_KIND(), ccsdsTimeCodeKind.UNSEGMENTED);
  assert.equal(code.PREAMBLE_FIELD1(), 0x9f);
  assert.equal(code.PREAMBLE_FIELD2(), 0x30);
  assert.deepEqual(Array.from(code.timeFieldArray()), orekitExtendedUnsegmented);
});

test("parses Orekit AbsoluteDateTest.testCCSDSDaySegmented CCSDS epoch CDS", async (t) => {
  const {
    ccsdsTimeCodeFormat,
    ccsdsTimeCodeKind,
    TIMCcsdsTimeCodeT,
  } = requireCcsdsTimeCodeSurface();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: null,
      sourceFormat: ccsdsTimeCodeFormat,
      sourceCcsdsTimeCode: new TIMCcsdsTimeCodeT(
        ccsdsTimeCodeKind.DAY_SEGMENTED,
        0x42,
        0x00,
        Uint8Array.from([0x3f, 0x55, 0x02, 0xb3, 0x2c, 0x95, 0x00, 0xbc, 0x61, 0x4e]),
      ),
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2002-05-23T12:34:56.789012Z");
});

test("emits Orekit AbsoluteDateTest.testCCSDSDaySegmented CCSDS epoch CDS target", async (t) => {
  const {
    ccsdsTimeCodeFormat,
    ccsdsTimeCodeKind,
  } = requireCcsdsTimeCodeSurface();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2002-05-23T12:34:56.789012Z",
      targetSystem: timingStandard.UTC,
      targetFormat: ccsdsTimeCodeFormat,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  const code = target.CCSDS_TIME_CODE();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.EPOCH_FORMAT(), ccsdsTimeCodeFormat);
  assert.ok(code, "missing target CCSDS_TIME_CODE payload");
  assert.equal(code.CODE_KIND(), ccsdsTimeCodeKind.DAY_SEGMENTED);
  assert.equal(code.PREAMBLE_FIELD1(), 0x42);
  assert.equal(code.PREAMBLE_FIELD2(), 0x00);
  assert.deepEqual(
    Array.from(code.timeFieldArray()),
    [0x3f, 0x55, 0x02, 0xb3, 0x2c, 0x95, 0x00, 0xb7, 0x1b, 0x00],
  );
});

test("emits Orekit AbsoluteDateTest.testCCSDSDaySegmented CCSDS epoch CDS source target", async (t) => {
  const {
    ccsdsTimeCodeFormat,
    ccsdsTimeCodeKind,
    TIMCcsdsTimeCodeT,
  } = requireCcsdsTimeCodeSurface();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const orekitPicosecondDaySegmented = [
    0x3f, 0x55, 0x02, 0xb3, 0x2c, 0x95, 0x00, 0xbc, 0x61, 0x4e,
  ];
  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: null,
      sourceFormat: ccsdsTimeCodeFormat,
      sourceCcsdsTimeCode: new TIMCcsdsTimeCodeT(
        ccsdsTimeCodeKind.DAY_SEGMENTED,
        0x42,
        0x00,
        Uint8Array.from(orekitPicosecondDaySegmented),
      ),
      targetSystem: timingStandard.UTC,
      targetFormat: ccsdsTimeCodeFormat,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  const code = target.CCSDS_TIME_CODE();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.EPOCH_FORMAT(), ccsdsTimeCodeFormat);
  assert.equal(target.ISO8601(), "2002-05-23T12:34:56.789012Z");
  assert.ok(code, "missing target CCSDS_TIME_CODE payload");
  assert.equal(code.CODE_KIND(), ccsdsTimeCodeKind.DAY_SEGMENTED);
  assert.equal(code.PREAMBLE_FIELD1(), 0x42);
  assert.equal(code.PREAMBLE_FIELD2(), 0x00);
  assert.deepEqual(Array.from(code.timeFieldArray()), orekitPicosecondDaySegmented);
});

test("emits Orekit AbsoluteDateTest.testCCSDSDaySegmented agency epoch CDS target", async (t) => {
  const {
    ccsdsTimeCodeFormat,
    ccsdsTimeCodeKind,
    TIMCcsdsTimeCodeT,
  } = requireCcsdsTimeCodeSurface();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const orekitJ2000MicrosecondDaySegmented = [
    0x03, 0x69, 0x02, 0xb3, 0x2c, 0x95, 0x00, 0x0c,
  ];
  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: null,
      sourceFormat: ccsdsTimeCodeFormat,
      sourceCcsdsTimeCode: new TIMCcsdsTimeCodeT(
        ccsdsTimeCodeKind.DAY_SEGMENTED,
        0x49,
        0x00,
        Uint8Array.from(orekitJ2000MicrosecondDaySegmented),
        "2000-01-01",
      ),
      targetSystem: timingStandard.UTC,
      targetFormat: ccsdsTimeCodeFormat,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  const code = target.CCSDS_TIME_CODE();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.EPOCH_FORMAT(), ccsdsTimeCodeFormat);
  assert.equal(target.ISO8601(), "2002-05-23T12:34:56.789012Z");
  assert.ok(code, "missing target CCSDS_TIME_CODE payload");
  assert.equal(code.CODE_KIND(), ccsdsTimeCodeKind.DAY_SEGMENTED);
  assert.equal(code.PREAMBLE_FIELD1(), 0x49);
  assert.equal(code.PREAMBLE_FIELD2(), 0x00);
  assert.equal(code.AGENCY_DEFINED_EPOCH_ISO8601(), "2000-01-01");
  assert.deepEqual(Array.from(code.timeFieldArray()), orekitJ2000MicrosecondDaySegmented);
});

test("parses Orekit AbsoluteDateTest.testCCSDSCalendarSegmented CCS month-day variation", async (t) => {
  const {
    ccsdsTimeCodeFormat,
    ccsdsTimeCodeKind,
    TIMCcsdsTimeCodeT,
  } = requireCcsdsTimeCodeSurface();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: null,
      sourceFormat: ccsdsTimeCodeFormat,
      sourceCcsdsTimeCode: new TIMCcsdsTimeCodeT(
        ccsdsTimeCodeKind.CALENDAR_SEGMENTED,
        0x56,
        0x00,
        Uint8Array.from([0x07, 0xd2, 0x05, 0x17, 0x0c, 0x22, 0x38, 0x4e, 0x5a, 0x0c, 0x22, 0x38, 0x4e]),
      ),
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2002-05-23T12:34:56.789012Z");
});

test("parses Orekit AbsoluteDateTest.testCCSDSCalendarSegmented CCS day-of-year variation", async (t) => {
  const {
    ccsdsTimeCodeFormat,
    ccsdsTimeCodeKind,
    TIMCcsdsTimeCodeT,
  } = requireCcsdsTimeCodeSurface();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: null,
      sourceFormat: ccsdsTimeCodeFormat,
      sourceCcsdsTimeCode: new TIMCcsdsTimeCodeT(
        ccsdsTimeCodeKind.CALENDAR_SEGMENTED,
        0x5e,
        0x00,
        Uint8Array.from([0x07, 0xd2, 0x00, 0x8f, 0x0c, 0x22, 0x38, 0x4e, 0x5a, 0x0c, 0x22, 0x38, 0x4e]),
      ),
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2002-05-23T12:34:56.789012Z");
});

test("emits Orekit AbsoluteDateTest.testCCSDSCalendarSegmented CCS month-day source target", async (t) => {
  const {
    ccsdsTimeCodeFormat,
    ccsdsTimeCodeKind,
    TIMCcsdsTimeCodeT,
  } = requireCcsdsTimeCodeSurface();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const orekitMonthDayCalendarSegmented = [
    0x07, 0xd2, 0x05, 0x17, 0x0c, 0x22, 0x38, 0x4e, 0x5a, 0x0c, 0x22, 0x38, 0x4e,
  ];
  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: null,
      sourceFormat: ccsdsTimeCodeFormat,
      sourceCcsdsTimeCode: new TIMCcsdsTimeCodeT(
        ccsdsTimeCodeKind.CALENDAR_SEGMENTED,
        0x56,
        0x00,
        Uint8Array.from(orekitMonthDayCalendarSegmented),
      ),
      targetSystem: timingStandard.UTC,
      targetFormat: ccsdsTimeCodeFormat,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  const code = target.CCSDS_TIME_CODE();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.EPOCH_FORMAT(), ccsdsTimeCodeFormat);
  assert.equal(target.ISO8601(), "2002-05-23T12:34:56.789012Z");
  assert.ok(code, "missing target CCSDS_TIME_CODE payload");
  assert.equal(code.CODE_KIND(), ccsdsTimeCodeKind.CALENDAR_SEGMENTED);
  assert.equal(code.PREAMBLE_FIELD1(), 0x56);
  assert.equal(code.PREAMBLE_FIELD2(), 0x00);
  assert.deepEqual(Array.from(code.timeFieldArray()), orekitMonthDayCalendarSegmented);
});

test("emits Orekit AbsoluteDateTest.testCCSDSCalendarSegmented CCS day-of-year target", async (t) => {
  const {
    ccsdsTimeCodeFormat,
    ccsdsTimeCodeKind,
    TIMCcsdsTimeCodeT,
  } = requireCcsdsTimeCodeSurface();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const orekitMicrosecondDayOfYear = [
    0x07, 0xd2, 0x00, 0x8f, 0x0c, 0x22, 0x38, 0x4e, 0x5a, 0x0c,
  ];
  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: null,
      sourceFormat: ccsdsTimeCodeFormat,
      sourceCcsdsTimeCode: new TIMCcsdsTimeCodeT(
        ccsdsTimeCodeKind.CALENDAR_SEGMENTED,
        0x5b,
        0x00,
        Uint8Array.from(orekitMicrosecondDayOfYear),
      ),
      targetSystem: timingStandard.UTC,
      targetFormat: ccsdsTimeCodeFormat,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  const code = target.CCSDS_TIME_CODE();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.EPOCH_FORMAT(), ccsdsTimeCodeFormat);
  assert.equal(target.ISO8601(), "2002-05-23T12:34:56.789012Z");
  assert.ok(code, "missing target CCSDS_TIME_CODE payload");
  assert.equal(code.CODE_KIND(), ccsdsTimeCodeKind.CALENDAR_SEGMENTED);
  assert.equal(code.PREAMBLE_FIELD1(), 0x5b);
  assert.equal(code.PREAMBLE_FIELD2(), 0x00);
  assert.deepEqual(Array.from(code.timeFieldArray()), orekitMicrosecondDayOfYear);
});

test("emits Orekit GNSSDateTest.testZeroZeroGPS GPS week and seconds", async (t) => {
  const gnssWeekSeconds = requireGnssWeekSecondsFormat();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "1999-08-21T23:59:47Z",
      targetSystem: timingStandard.GPS,
      targetFormat: gnssWeekSeconds,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.GPS);
  assert.equal(target.EPOCH_FORMAT(), gnssWeekSeconds);
  assert.equal(target.GNSS_WEEK(), 1024);
  assertNear(target.SECONDS(), 0, 1e-9, "GPS seconds in Orekit rollover week");
});

test("parses Orekit GNSSDateTest.testZeroZeroGPS before rollover reference", async (t) => {
  const gnssWeekSeconds = requireGnssWeekSecondsFormat();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.GPS,
      sourceIso8601: null,
      sourceFormat: gnssWeekSeconds,
      sourceSeconds: 0,
      sourceGnssWeek: 0,
      sourceHasGnssRolloverReference: true,
      sourceGnssRolloverReferenceIso8601: "1989-10-29T00:00:00Z",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "1980-01-06T00:00:00.000000Z");
});

test("parses Orekit GNSSDateTest.testZeroZeroGPS after rollover reference", async (t) => {
  const gnssWeekSeconds = requireGnssWeekSecondsFormat();
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.GPS,
      sourceIso8601: null,
      sourceFormat: gnssWeekSeconds,
      sourceSeconds: 0,
      sourceGnssWeek: 0,
      sourceHasGnssRolloverReference: true,
      sourceGnssRolloverReferenceIso8601: "1989-10-30T00:00:00Z",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "1999-08-21T23:59:47.000000Z");
});

async function assertEmitsGnssDateWeekSeconds(t, { targetSystem, expectedSeconds, label, epochLabel }) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: OREKIT_GNSSDATE_REFERENCE_UTC,
      targetSystem,
      targetFormat: timEpochRepresentation.GPS_SECONDS,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), targetSystem);
  assert.equal(target.EPOCH_FORMAT(), timEpochRepresentation.GPS_SECONDS);
  assertNear(target.SECONDS(), expectedSeconds, 1e-9, `${label} seconds since Orekit ${epochLabel}`);
}

async function assertParsesGnssDateWeekSeconds(t, { sourceSystem, sourceSeconds }) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem,
      sourceIso8601: null,
      sourceFormat: timEpochRepresentation.GPS_SECONDS,
      sourceSeconds,
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), OREKIT_GNSSDATE_REFERENCE_RESULT_UTC);
}

test("emits Orekit GNSSDateTest.testFromAbsoluteDateGPS GPS week seconds", async (t) => {
  await assertEmitsGnssDateWeekSeconds(t, {
    targetSystem: timingStandard.GPS,
    expectedSeconds: OREKIT_GPS_QZSS_SBAS_GNSS_SECONDS,
    label: "GPS",
    epochLabel: "GPS_EPOCH",
  });
});

test("parses Orekit GNSSDateTest.testFromWeekAndSecondsGPS GPS week seconds", async (t) => {
  await assertParsesGnssDateWeekSeconds(t, {
    sourceSystem: timingStandard.GPS,
    sourceSeconds: OREKIT_GPS_QZSS_SBAS_GNSS_SECONDS,
  });
});

test("emits Orekit GNSSDateTest.testFromAbsoluteDateQZSS QZSS week seconds", async (t) => {
  await assertEmitsGnssDateWeekSeconds(t, {
    targetSystem: timingStandard.QZSS,
    expectedSeconds: OREKIT_GPS_QZSS_SBAS_GNSS_SECONDS,
    label: "QZSS",
    epochLabel: "QZSS_EPOCH",
  });
});

test("parses Orekit GNSSDateTest.testFromWeekAndSecondsQZSS QZSS week seconds", async (t) => {
  await assertParsesGnssDateWeekSeconds(t, {
    sourceSystem: timingStandard.QZSS,
    sourceSeconds: OREKIT_GPS_QZSS_SBAS_GNSS_SECONDS,
  });
});

test("emits Orekit GNSSDateTest.testFromAbsoluteDateSBAS SBAS week seconds", async (t) => {
  assert.equal(Number.isInteger(timingStandard.SBAS), true, "SDS TIM timingStandard.SBAS enum is required");
  await assertEmitsGnssDateWeekSeconds(t, {
    targetSystem: timingStandard.SBAS,
    expectedSeconds: OREKIT_GPS_QZSS_SBAS_GNSS_SECONDS,
    label: "SBAS",
    epochLabel: "GPS_EPOCH",
  });
});

test("parses Orekit GNSSDateTest.testFromWeekAndSecondsSBAS SBAS week seconds", async (t) => {
  assert.equal(Number.isInteger(timingStandard.SBAS), true, "SDS TIM timingStandard.SBAS enum is required");
  await assertParsesGnssDateWeekSeconds(t, {
    sourceSystem: timingStandard.SBAS,
    sourceSeconds: OREKIT_GPS_QZSS_SBAS_GNSS_SECONDS,
  });
});

test("emits Orekit GNSSDateTest.testFromAbsoluteDateNavIC NavIC week seconds", async (t) => {
  await assertEmitsGnssDateWeekSeconds(t, {
    targetSystem: timingStandard.NAVIC,
    expectedSeconds: OREKIT_GALILEO_NAVIC_GNSS_SECONDS,
    label: "NavIC",
    epochLabel: "NAVIC_EPOCH",
  });
});

test("parses Orekit GNSSDateTest.testFromWeekAndSecondsNavIC NavIC week seconds", async (t) => {
  await assertParsesGnssDateWeekSeconds(t, {
    sourceSystem: timingStandard.NAVIC,
    sourceSeconds: OREKIT_GALILEO_NAVIC_GNSS_SECONDS,
  });
});

test("emits Orekit GNSSDateTest.testFromAbsoluteDateGalileo GST week seconds", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2006-08-09T16:31:03Z",
      targetSystem: timingStandard.GST,
      targetFormat: timEpochRepresentation.GPS_SECONDS,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.GST);
  assert.equal(target.EPOCH_FORMAT(), timEpochRepresentation.GPS_SECONDS);
  assertNear(target.SECONDS(), 219861077.0, 1e-9, "GST seconds since Orekit GALILEO_EPOCH");
});

test("parses Orekit GNSSDateTest.testFromWeekAndSecondsGalileo GST week seconds", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.GST,
      sourceIso8601: null,
      sourceFormat: timEpochRepresentation.GPS_SECONDS,
      sourceSeconds: 219861077.0,
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2006-08-09T16:31:03.000000Z");
});

test("emits Orekit GNSSDateTest.testFromAbsoluteDateBeidou BDT week seconds", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2010-02-26T23:15:12Z",
      targetSystem: timingStandard.BDT,
      targetFormat: timEpochRepresentation.GPS_SECONDS,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.BDT);
  assert.equal(target.EPOCH_FORMAT(), timEpochRepresentation.GPS_SECONDS);
  assertNear(target.SECONDS(), 131152513.0, 1e-9, "BDT seconds since Orekit BEIDOU_EPOCH");
});

test("parses Orekit GNSSDateTest.testFromWeekAndSecondsBeidou BDT week seconds", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.BDT,
      sourceIso8601: null,
      sourceFormat: timEpochRepresentation.GPS_SECONDS,
      sourceSeconds: 131152513.0,
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "2010-02-26T23:15:12.000000Z");
});

test("parses Orekit AbsoluteDateTest.testOffsets UTC leap second to TAI", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "1976-12-31T23:59:60Z",
      targetSystem: timingStandard.TAI,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.TAI);
  assert.equal(target.ISO8601(), "1977-01-01T00:00:15.000000");
  assertNear(result.DELTA_SECONDS(), 15.0, 1e-12, "UTC leap second to TAI offset");
});

test("formats Orekit AbsoluteDateTest.testOffsets TAI leap instant as UTC leap second", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.TAI,
      sourceIso8601: "1977-01-01T00:00:15",
      targetSystem: timingStandard.UTC,
    }),
  );
  const result = decodeResult(response);
  const target = result.TARGET();
  assert.equal(result.STATUS(), timConversionStatus.OK);
  assert.equal(target.TIME_SYSTEM(), timingStandard.UTC);
  assert.equal(target.ISO8601(), "1976-12-31T23:59:60.000000Z");
  assertNear(result.DELTA_SECONDS(), -15.0, 1e-12, "TAI to UTC leap second offset");
});

test("fails closed for UT1 conversion without DUT1 data", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    surface: "direct",
  });
  t.after(() => harness.destroy());

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2002-12-31T00:00:00Z",
      targetSystem: timingStandard.UT1,
    }),
  );
  const result = decodeResult(response);
  assert.equal(result.STATUS(), timConversionStatus.EOP_DATA_REQUIRED);
  assert.match(result.ERROR_MESSAGE(), /DUT1/i);
});

test("built artifact loads through WasmEdge server path when available", async (t) => {
  let harness;
  try {
    harness = await loadModule({
      wasmSource: fileURLToPath(ISOMORPHIC_WASM_PATH),
      runtimeKind: "wasmedge",
      enableThreads: false,
    });
  } catch (error) {
    if (/spawn wasmedge ENOENT|command not found|Failed to launch/i.test(String(error))) {
      t.skip("Install wasmedge to verify the server-path harness.");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await harness.destroy();
  });

  const response = await invokeConversion(
    harness,
    encodeConversionRequest({
      sourceSystem: timingStandard.UTC,
      sourceIso8601: "2004-04-06T07:51:28.386009Z",
      targetSystem: timingStandard.TAI,
    }),
  );
  const result = decodeResult(response);
  assert.equal(result.STATUS(), timConversionStatus.OK);
});
