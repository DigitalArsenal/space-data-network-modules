const fsbCanonical = Object.freeze({
  schemaName: "FSB.fbs",
  fileIdentifier: "$FSB",
  schemaVersion: "1.158.1",
  schemaHash: "0b23aa63d0e3f17d828fc84dd433605c2794cb81ade7c043cb200e954c84e945",
  rootTypeName: "FSB",
  wireFormat: "flatbuffer",
});

const fsbAligned = Object.freeze({
  ...fsbCanonical,
  wireFormat: "aligned-binary",
  byteLength: 1_048_744,
  requiredAlignment: 8,
});

const fsoCanonical = Object.freeze({
  schemaName: "FSO.fbs",
  fileIdentifier: "$FSO",
  schemaVersion: "1.158.2",
  schemaHash: "a298ef96af29624073edf749848e8ff1e5b8f45e56966c2e210cb719f3c5e821",
  rootTypeName: "FSO",
  wireFormat: "flatbuffer",
});

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
    maxStreams: 64,
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
    "Reassembles complete provider-native response chunks inside WASM, parses each provider format, fits bounded batches of complete ephemerides with the OD core, and emits multiple epoch-specific OMM and OCM record streams.",
  pluginFamily: "analysis",
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
          "Idempotent FlatSQL CONFIGURE_INDEX control containing the complete canonical result schema and OMM/OCM table bindings.",
        ),
        fsoPort(
          "status",
          "One typed OD outcome for each consumed complete provider response or fitted logical object.",
          { required: false, maxStreams: 64 },
        ),
        fsbPort("omm", "Size-prefixed canonical OMM records in FSB record streams.", true),
        fsbPort("ocm", "Size-prefixed canonical OCM records in FSB record streams.", true),
      ],
      maxBatch: 64,
      drainPolicy: "drain-until-yield",
    },
  ],
  schemasUsed: [
    {
      schemaName: "FSB.fbs",
      fileIdentifier: "$FSB",
      schemaVersion: "1.158.1",
      schemaHash: "0b23aa63d0e3f17d828fc84dd433605c2794cb81ade7c043cb200e954c84e945",
      rootTypeName: "FSB",
    },
    {
      schemaName: "FSO.fbs",
      fileIdentifier: "$FSO",
      schemaVersion: "1.158.2",
      schemaHash: "a298ef96af29624073edf749848e8ff1e5b8f45e56966c2e210cb719f3c5e821",
      rootTypeName: "FSO",
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
