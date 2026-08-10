import { loadStandardsCatalog } from "space-data-module-sdk/standards";

// A manifest NEVER hardcodes an SDS version or hash. The SDK validates every
// type reference against the canonical catalog, so a literal here is a
// time-bomb that detonates on the next SDS cut (it did: FSO/FSB 1.158 vs a
// canonical 1.164 refused every one of these ten signed children). Read the
// same catalog the validator reads and the two cannot disagree.
const standardsCatalog = await loadStandardsCatalog();

function canonicalTypeRef(schemaName) {
  const entry = standardsCatalog.find((e) => e.schemaName === schemaName);
  if (!entry?.version || !entry?.hash || !entry?.rootTypeName || !entry?.fileIdentifier) {
    throw new Error(`canonical SDS catalog has no complete entry for ${schemaName}`);
  }
  return Object.freeze({
    schemaName,
    fileIdentifier: entry.fileIdentifier,
    schemaVersion: entry.version,
    schemaHash: entry.hash,
    rootTypeName: entry.rootTypeName,
    wireFormat: "flatbuffer",
  });
}

const fsbCanonical = canonicalTypeRef("FSB.fbs");

const fsbAligned = Object.freeze({
  ...fsbCanonical,
  wireFormat: "aligned-binary",
  byteLength: 1_048_744,
  requiredAlignment: 8,
});

const fsoCanonical = canonicalTypeRef("FSO.fbs");

const fsoAligned = Object.freeze({
  ...fsoCanonical,
  wireFormat: "aligned-binary",
  byteLength: 361_648,
  requiredAlignment: 8,
});

function fsbPort(portId, description, output = false) {
  return {
    portId,
    acceptedTypeSets: [
      {
        setId: "fsb-dual",
        allowedTypes: [{ ...fsbCanonical }, { ...fsbAligned }],
      },
    ],
    minStreams: 0,
    maxStreams: output ? 100_000 : 4096,
    required: false,
    description,
  };
}

function fsoPort(
  portId,
  description,
  { required = true, maxStreams = 1 } = {},
) {
  return {
    portId,
    acceptedTypeSets: [
      {
        setId: "fso-dual",
        allowedTypes: [{ ...fsoCanonical }, { ...fsoAligned }],
      },
    ],
    minStreams: required ? 1 : 0,
    maxStreams,
    required,
    description,
  };
}

export const manifest = {
  pluginId: "org.sdn.flows.supplemental-omm.od",
  name: "Supplemental OMM Native Orbit Determination",
  version: "1.0.0",
  description:
    "Reassembles complete provider-native response chunks inside WASM, parses each provider format, fits the complete ephemeris with the OD core, and emits multiple epoch-specific OMM, OCM, and OBD record streams.",
  pluginFamily: "orbit_determination",
  capabilities: [],
  externalInterfaces: [],
  invokeSurfaces: ["direct"],
  runtimeTargets: ["browser", "wasmedge"],
  methods: [
    {
      methodId: "fit",
      displayName: "Fit complete provider-native ephemerides",
      inputPorts: [
        fsbPort("starlink", "Ordered complete native MEME response chunks."),
        fsbPort("glonass", "Ordered complete native SP3 response chunks."),
        fsbPort("intelsat", "Ordered complete native ECF response chunks."),
        fsbPort("cpf", "Ordered complete native CPF response chunks."),
        fsbPort("iss", "Ordered complete native CCSDS OEM KVN response chunks."),
      ],
      outputPorts: [
        fsoPort(
          "control",
          "Idempotent FlatSQL CONFIGURE_INDEX control containing the complete canonical result schema and OMM/OCM/OBD table bindings.",
        ),
        fsoPort(
          "status",
          "One typed OD outcome for each consumed complete provider response or fitted logical object.",
          { required: false, maxStreams: 4096 },
        ),
        fsbPort("omm", "Size-prefixed canonical OMM records in FSB record streams.", true),
        fsbPort("ocm", "Size-prefixed canonical OCM records in FSB record streams.", true),
        fsbPort("obd", "Size-prefixed canonical OBD records in FSB record streams.", true),
      ],
      maxBatch: 4096,
      drainPolicy: "drain-until-yield",
    },
  ],
  schemasUsed: [
    {
      schemaName: fsbCanonical.schemaName,
      fileIdentifier: fsbCanonical.fileIdentifier,
      schemaVersion: fsbCanonical.schemaVersion,
      schemaHash: fsbCanonical.schemaHash,
      rootTypeName: fsbCanonical.rootTypeName,
    },
    {
      schemaName: fsoCanonical.schemaName,
      fileIdentifier: fsoCanonical.fileIdentifier,
      schemaVersion: fsoCanonical.schemaVersion,
      schemaHash: fsoCanonical.schemaHash,
      rootTypeName: fsoCanonical.rootTypeName,
    },
  ],
  buildArtifacts: [
    {
      artifactId: "supplemental-omm-od-isomorphic",
      kind: "wasm",
      path: "dist/isomorphic/module.wasm",
      target: "browser,wasmedge",
    },
  ],
  abiVersion: 1,
};
