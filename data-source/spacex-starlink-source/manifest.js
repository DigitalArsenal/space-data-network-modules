/**
 * SpaceX Starlink data-source module manifest (WS5).
 *
 * The first executable data-source module: on a TIMERS-driven `pull` it fetches
 * SpaceX/Starlink ephemeris over HTTP, parses + validates it (via its declared
 * dependencies), stores the records, signs a PNM (Provenance/Notification
 * Message), and publishes it — all through host capabilities. This file declares
 * the module contract (family, methods, host capabilities, timers); the C++ ABI
 * + build land alongside it, and the DEPENDENCIES on the Starlink parser /
 * validator are declared on the PLG storefront/publish record (the SDK embedded
 * manifest has no dependencies field).
 */
import {
  AcceptedTypeSetT,
  BuildArtifactT,
  CapabilityKind,
  DrainPolicy,
  FlatBufferTypeRefT,
  HostCapabilityT,
  InvokeSurface,
  MethodManifestT,
  PluginFamily,
  PluginManifestT,
  PortManifestT,
  TimerSpecT,
} from "space-data-module-sdk/manifest";

export const STARLINK_SOURCE_PLUGIN_ID = "com.orbpro.spacex-starlink-source";
export const STARLINK_SOURCE_PLUGIN_NAME = "SpaceX Starlink Data Source";
export const STARLINK_SOURCE_PLUGIN_VERSION = "1.0.0";
export const STARLINK_SOURCE_PLUGIN_DESCRIPTION =
  "Executable data-source: pulls SpaceX/Starlink ephemeris over HTTP on a timer, " +
  "parses + validates, stores records, and signs + publishes a PNM pointer.";
export const STARLINK_SOURCE_MANIFEST_BYTES_SYMBOL =
  "spacex_starlink_source_plugin_manifest_bytes";
export const STARLINK_SOURCE_MANIFEST_SIZE_SYMBOL =
  "spacex_starlink_source_plugin_manifest_size";

// Default pull cadence: hourly.
export const STARLINK_SOURCE_PULL_INTERVAL_MS = 3_600_000;

// Dependency identities (declared on the PLG publish record, not the embedded
// manifest — see WS4.1 / WS5.4).
export const STARLINK_PARSER_PLUGIN_ID = "com.orbpro.starlink-parser";
export const STARLINK_VALIDATOR_PLUGIN_ID = "com.orbpro.starlink-validator";

function createTypeRef(schemaName, fileIdentifier, options = {}) {
  return new FlatBufferTypeRefT(
    schemaName,
    fileIdentifier,
    [],
    false,
    options.wireFormat ?? "flatbuffer",
    options.rootTypeName ?? null,
    0,
    options.byteLength ?? 0,
    options.requiredAlignment ?? 0,
  );
}

function createAcceptedTypeSet(setId, allowedTypes, description) {
  return new AcceptedTypeSetT(setId, allowedTypes, description);
}

function createPort(portId, displayName, acceptedTypeSets, description, options = {}) {
  return new PortManifestT(
    portId,
    displayName,
    acceptedTypeSets,
    options.minStreams ?? 1,
    options.maxStreams ?? 65535,
    options.required ?? true,
    description,
  );
}

function createMethod(methodId, displayName, inputPorts, outputPorts, description, options = {}) {
  return new MethodManifestT(
    methodId,
    displayName,
    inputPorts,
    outputPorts,
    options.maxBatch ?? 1,
    options.drainPolicy ?? DrainPolicy.DRAIN_UNTIL_YIELD,
    description,
  );
}

export function createStarlinkSourcePluginManifest() {
  // Output: a PNM (Provenance/Notification Message) pointer that peers use to
  // asynchronously retrieve the pulled ephemeris from the network.
  const pnmType = createTypeRef("PNM.fbs", "$PNM", { rootTypeName: "PNM" });
  const pnmAlignedType = createTypeRef("PNM.fbs", "$PNM", {
    rootTypeName: "PNM",
    wireFormat: "aligned-binary",
    requiredAlignment: 8,
  });
  const pnmResultSet = createAcceptedTypeSet(
    "data-source.starlink.pnm",
    [pnmType, pnmAlignedType],
    "Signed PNM pointer for each published pull batch.",
  );

  const pullMethod = createMethod(
    "pull",
    "Pull Starlink Ephemeris",
    // No input ports: the pull is driven by the TIMERS entry below (and can be
    // command-invoked on demand).
    [],
    [
      createPort(
        "published",
        "Published PNMs",
        [pnmResultSet],
        "PNM pointers published for each pulled + stored ephemeris batch.",
        { required: false },
      ),
    ],
    "Fetches SpaceX/Starlink ephemeris over HTTP, parses + validates, stores the " +
      "records, signs a PNM, and publishes it.",
  );

  const capabilities = [
    new HostCapabilityT(CapabilityKind.HTTP, null, true, "Fetch the Starlink ephemeris listing + files."),
    new HostCapabilityT(CapabilityKind.STORAGE_WRITE, null, true, "Store parsed ephemeris records."),
    new HostCapabilityT(CapabilityKind.WALLET_SIGN, null, true, "Fetch the node signing key (keyslot) to sign the PNM."),
    new HostCapabilityT(CapabilityKind.CRYPTO_SIGN, null, true, "Sign the published PNM pointer."),
    new HostCapabilityT(CapabilityKind.PUBSUB, null, true, "Publish + stream the PNM to subscribers."),
  ];

  const timers = [
    new TimerSpecT(
      "starlink-pull",
      "pull",
      null,
      BigInt(STARLINK_SOURCE_PULL_INTERVAL_MS),
      "Periodic Starlink ephemeris pull (default hourly).",
    ),
  ];

  return new PluginManifestT(
    STARLINK_SOURCE_PLUGIN_ID,
    STARLINK_SOURCE_PLUGIN_NAME,
    STARLINK_SOURCE_PLUGIN_VERSION,
    PluginFamily.DATA_SOURCE,
    [pullMethod],
    capabilities,
    timers,
    [], // protocols
    [createTypeRef("PNM.fbs", "$PNM", { rootTypeName: "PNM" })],
    [
      new BuildArtifactT(
        "spacex-starlink-source-runtime",
        "wasm",
        "dist/isomorphic/module.wasm",
        "browser,wasmedge",
        null,
      ),
    ],
    1,
    [InvokeSurface.COMMAND],
    ["browser", "wasmedge"],
  );
}

export default createStarlinkSourcePluginManifest;
