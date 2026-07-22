import assert from "node:assert/strict";
import test from "node:test";

import { resolveSupplementalSigning } from "../nodes/signing.mjs";

test("production node builds require the shared release signer", () => {
  assert.throws(
    () =>
      resolveSupplementalSigning({
        environment: { NODE_ENV: "production" },
        environmentPrefix: "SUPPLEMENTAL_STATUS",
        developmentSigningSeed: "44".repeat(32),
        defaultSigningKeyId: "supplemental-omm-status-development",
      }),
    /SUPPLEMENTAL_OMM_SIGNING_SEED_HEX/,
  );
});

test("production node builds reject every embedded development signer", () => {
  for (const byte of ["43", "44", "45", "51", "52", "53", "54", "55"]) {
    assert.throws(
      () =>
        resolveSupplementalSigning({
          environment: {
            NODE_ENV: "production",
            SUPPLEMENTAL_OMM_SIGNING_SEED_HEX: byte.repeat(32),
            SUPPLEMENTAL_OMM_SIGNING_KEY_ID: "release",
          },
          environmentPrefix: "SUPPLEMENTAL_STATUS",
          developmentSigningSeed: "44".repeat(32),
          defaultSigningKeyId: "supplemental-omm-status-development",
        }),
      /development signing seed/i,
    );
  }
});

test("one shared production signer marks every child publisher release-safe", () => {
  assert.deepEqual(
    resolveSupplementalSigning({
      environment: {
        NODE_ENV: "production",
        SUPPLEMENTAL_OMM_SIGNING_SEED_HEX: "9a".repeat(32),
        SUPPLEMENTAL_OMM_SIGNING_KEY_ID: "supplemental-omm-release",
      },
      environmentPrefix: "SUPPLEMENTAL_OD",
      developmentSigningSeed: "55".repeat(32),
      defaultSigningKeyId: "supplemental-omm-od-development",
    }),
    {
      signingSeed: "9a".repeat(32),
      signingKeyId: "supplemental-omm-release",
      developmentOnly: false,
      productionMode: true,
    },
  );
});

test("local builds retain explicit development-only metadata", () => {
  assert.deepEqual(
    resolveSupplementalSigning({
      environment: {},
      environmentPrefix: "SUPPLEMENTAL_TIMER",
      developmentSigningSeed: "43".repeat(32),
      defaultSigningKeyId: "supplemental-omm-timer-development",
    }),
    {
      signingSeed: "43".repeat(32),
      signingKeyId: "supplemental-omm-timer-development",
      developmentOnly: true,
      productionMode: false,
    },
  );
});
