import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function allowedTypesFor(method, direction, portId) {
  const ports = method[direction] ?? [];
  const port = ports.find((entry) => entry.portId === portId);
  assert.ok(port, `missing ${direction} port ${portId}`);
  return port.acceptedTypeSets.flatMap((set) => set.allowedTypes ?? []);
}

function assertDualWireTypes(types, schemaName, fileIdentifier, description, rootTypeName = null) {
  const flatbuffer = types.find(
    (entry) =>
      entry.schemaName === schemaName &&
      (entry.fileIdentifier ?? null) === fileIdentifier &&
      (rootTypeName === null || entry.rootTypeName === rootTypeName) &&
      !entry.wireFormat,
  );
  const aligned = types.find(
    (entry) =>
      entry.schemaName === schemaName &&
      (entry.fileIdentifier ?? null) === fileIdentifier &&
      (rootTypeName === null || entry.rootTypeName === rootTypeName) &&
      entry.wireFormat === "aligned-binary" &&
      entry.requiredAlignment === 8,
  );
  assert.ok(flatbuffer, `${description} should accept canonical ${schemaName} FlatBuffers`);
  assert.ok(aligned, `${description} should accept aligned-binary ${schemaName} frames`);
}

test("manifest declares SDK-compliant Keplerian-to-Cartesian surface", () => {
  const manifest = readManifest();
  assert.equal(manifest.pluginId, "com.digitalarsenal.foundation.orbits");
  assert.equal(manifest.pluginFamily, "foundation");
  assert.deepEqual(manifest.invokeSurfaces.sort(), ["command", "direct"]);
  assert.ok(manifest.runtimeTargets.includes("browser"));
  assert.ok(manifest.runtimeTargets.includes("wasmedge"));

  const method = manifest.methods.find((entry) => entry.methodId === "keplerian_to_cartesian");
  assert.ok(method, "missing keplerian_to_cartesian method");
  assertDualWireTypes(allowedTypesFor(method, "inputPorts", "mean_elements"), "OMM.fbs", "$OMM", "mean_elements port");
  assertDualWireTypes(allowedTypesFor(method, "outputPorts", "cartesian_state"), "OEM.fbs", "$OEM", "cartesian_state port");

  assert.ok(
    manifest.schemasUsed.some(
      (entry) => entry.schemaName === "OMM.fbs" && entry.fileIdentifier === "$OMM",
    ),
    "manifest should declare SDS OMM usage",
  );
  assert.ok(
    manifest.schemasUsed.some(
      (entry) => entry.schemaName === "OEM.fbs" && entry.fileIdentifier === "$OEM",
    ),
    "manifest should declare SDS OEM usage",
  );
});

test("manifest declares SDK-compliant Cartesian-to-Keplerian surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "cartesian_to_keplerian");
  assert.ok(method, "missing cartesian_to_keplerian method");

  assertDualWireTypes(allowedTypesFor(method, "inputPorts", "cartesian_state"), "OEM.fbs", "$OEM", "cartesian_state port");
  assertDualWireTypes(allowedTypesFor(method, "inputPorts", "gravity_context"), "OMM.fbs", "$OMM", "gravity_context port");
  assertDualWireTypes(allowedTypesFor(method, "outputPorts", "mean_elements"), "OMM.fbs", "$OMM", "mean_elements port");
});

test("manifest declares SDK-compliant OPM-to-OEM surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "opm_to_oem");
  assert.ok(method, "missing opm_to_oem method");

  assertDualWireTypes(allowedTypesFor(method, "inputPorts", "orbit_parameters"), "OPM.fbs", "$OPM", "orbit_parameters port");
  assertDualWireTypes(allowedTypesFor(method, "outputPorts", "cartesian_state"), "OEM.fbs", "$OEM", "cartesian_state port");
  assert.ok(
    manifest.schemasUsed.some(
      (entry) => entry.schemaName === "OPM.fbs" && entry.fileIdentifier === "$OPM",
    ),
    "manifest should declare SDS OPM usage",
  );
});

test("manifest declares SDK-compliant OPM-to-OMM surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "opm_to_omm");
  assert.ok(method, "missing opm_to_omm method");

  assertDualWireTypes(allowedTypesFor(method, "inputPorts", "orbit_parameters"), "OPM.fbs", "$OPM", "orbit_parameters port");
  assertDualWireTypes(allowedTypesFor(method, "outputPorts", "mean_elements"), "OMM.fbs", "$OMM", "mean_elements port");
});

test("manifest declares SDK-compliant Keplerian-to-Equinoctial surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "keplerian_to_equinoctial");
  assert.ok(method, "missing keplerian_to_equinoctial method");

  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "keplerian_state"),
    "OCM.fbs",
    "$OCM",
    "keplerian_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "outputPorts", "equinoctial_state"),
    "OCM.fbs",
    "$OCM",
    "equinoctial_state port",
    "OCM",
  );
  assert.ok(
    manifest.schemasUsed.some(
      (entry) => entry.schemaName === "OCM.fbs" && entry.fileIdentifier === "$OCM",
    ),
    "manifest should declare SDS OCM usage",
  );
});

test("manifest declares SDK-compliant OCM Keplerian-to-OMM surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "ocm_keplerian_to_omm");
  assert.ok(method, "missing ocm_keplerian_to_omm method");

  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "keplerian_state"),
    "OCM.fbs",
    "$OCM",
    "keplerian_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "outputPorts", "mean_elements"),
    "OMM.fbs",
    "$OMM",
    "mean_elements port",
  );
});

test("manifest declares SDK-compliant OCM Keplerian-to-State surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "ocm_keplerian_to_state");
  assert.ok(method, "missing ocm_keplerian_to_state method");

  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "keplerian_state"),
    "OCM.fbs",
    "$OCM",
    "keplerian_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "outputPorts", "vector_state"),
    "OCM.fbs",
    "$OCM",
    "vector_state port",
    "OCM",
  );
});

test("manifest declares SDK-compliant OCM State-to-Keplerian surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "ocm_state_to_keplerian");
  assert.ok(method, "missing ocm_state_to_keplerian method");

  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "vector_state"),
    "OCM.fbs",
    "$OCM",
    "vector_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "outputPorts", "keplerian_state"),
    "OCM.fbs",
    "$OCM",
    "keplerian_state port",
    "OCM",
  );
});

test("manifest declares SDK-compliant OCM State-to-Equinoctial surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "ocm_state_to_equinoctial");
  assert.ok(method, "missing ocm_state_to_equinoctial method");

  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "vector_state"),
    "OCM.fbs",
    "$OCM",
    "vector_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "outputPorts", "equinoctial_state"),
    "OCM.fbs",
    "$OCM",
    "equinoctial_state port",
    "OCM",
  );
});

test("manifest declares SDK-compliant OCM State-to-J-zonal-Acceleration surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "ocm_state_to_j_zonal_acceleration_oem");
  assert.ok(method, "missing ocm_state_to_j_zonal_acceleration_oem method");

  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "vector_state"),
    "OCM.fbs",
    "$OCM",
    "vector_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "gravity_context"),
    "GRV.fbs",
    "$GRV",
    "gravity_context port",
    "GRV",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "outputPorts", "cartesian_state"),
    "OEM.fbs",
    "$OEM",
    "cartesian_state port",
  );
  assert.ok(
    manifest.schemasUsed.some(
      (entry) => entry.schemaName === "GRV.fbs" && entry.fileIdentifier === "$GRV",
    ),
    "manifest should declare SDS GRV usage",
  );
});

test("manifest declares SDK-compliant OCM State-to-SRP-Acceleration surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "ocm_state_to_srp_acceleration_oem");
  assert.ok(method, "missing ocm_state_to_srp_acceleration_oem method");

  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "vector_state"),
    "OCM.fbs",
    "$OCM",
    "vector_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "sun_vector"),
    "CRD.fbs",
    "$CRD",
    "sun_vector port",
    "CRD",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "outputPorts", "cartesian_state"),
    "OEM.fbs",
    "$OEM",
    "cartesian_state port",
  );
  assert.ok(
    manifest.schemasUsed.some(
      (entry) => entry.schemaName === "CRD.fbs" && entry.fileIdentifier === "$CRD",
    ),
    "manifest should declare SDS CRD usage",
  );
});

test("manifest declares SDK-compliant OCM Equinoctial-to-State surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "ocm_equinoctial_to_state");
  assert.ok(method, "missing ocm_equinoctial_to_state method");

  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "equinoctial_state"),
    "OCM.fbs",
    "$OCM",
    "equinoctial_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "outputPorts", "vector_state"),
    "OCM.fbs",
    "$OCM",
    "vector_state port",
    "OCM",
  );
});

test("manifest declares SDK-compliant Equinoctial-to-Keplerian surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "equinoctial_to_keplerian");
  assert.ok(method, "missing equinoctial_to_keplerian method");

  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "equinoctial_state"),
    "OCM.fbs",
    "$OCM",
    "equinoctial_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "outputPorts", "keplerian_state"),
    "OCM.fbs",
    "$OCM",
    "keplerian_state port",
    "OCM",
  );
});

test("manifest declares SDK-compliant OCM Equinoctial-to-OMM surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "ocm_equinoctial_to_omm");
  assert.ok(method, "missing ocm_equinoctial_to_omm method");

  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "equinoctial_state"),
    "OCM.fbs",
    "$OCM",
    "equinoctial_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "outputPorts", "mean_elements"),
    "OMM.fbs",
    "$OMM",
    "mean_elements port",
  );
});

test("manifest declares SDK-compliant OCM Equinoctial-to-OEM surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "ocm_equinoctial_to_oem");
  assert.ok(method, "missing ocm_equinoctial_to_oem method");

  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "equinoctial_state"),
    "OCM.fbs",
    "$OCM",
    "equinoctial_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "outputPorts", "cartesian_state"),
    "OEM.fbs",
    "$OEM",
    "cartesian_state port",
  );
});

test("manifest declares SDK-compliant OCM pair to CDM relative Hill surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "ocm_pair_to_cdm_relative_hill");
  assert.ok(method, "missing ocm_pair_to_cdm_relative_hill method");

  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "chief_state"),
    "OCM.fbs",
    "$OCM",
    "chief_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "deputy_state"),
    "OCM.fbs",
    "$OCM",
    "deputy_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "outputPorts", "relative_state"),
    "CDM.fbs",
    "$CDM",
    "relative_state port",
  );
  assert.ok(
    manifest.schemasUsed.some(
      (entry) => entry.schemaName === "CDM.fbs" && entry.fileIdentifier === "$CDM",
    ),
    "manifest should declare SDS CDM usage",
  );
});

test("manifest declares SDK-compliant CDM relative Hill to OCM deputy surface", () => {
  const manifest = readManifest();
  const method = manifest.methods.find((entry) => entry.methodId === "cdm_relative_hill_to_ocm_deputy_state");
  assert.ok(method, "missing cdm_relative_hill_to_ocm_deputy_state method");

  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "chief_state"),
    "OCM.fbs",
    "$OCM",
    "chief_state port",
    "OCM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "inputPorts", "relative_state"),
    "CDM.fbs",
    "$CDM",
    "relative_state port",
    "CDM",
  );
  assertDualWireTypes(
    allowedTypesFor(method, "outputPorts", "deputy_state"),
    "OCM.fbs",
    "$OCM",
    "deputy_state port",
    "OCM",
  );
});
