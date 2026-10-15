// The FlatBuffers the tests read and write: the SDK's runtime contracts, and the Space Data Standards records from the
// spacedatastandards.org package (object API).
import { Builder, ByteBuffer } from "flatbuffers";
import { DSS } from "spacedatastandards.org/lib/js/DSS/DSS.js";
import { OBD } from "spacedatastandards.org/lib/js/OBD/OBD.js";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { OEM } from "spacedatastandards.org/lib/js/OEM/OEM.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";

export {
  decodeFlowNotice,
  decodeHttpRequest,
  decodeHttpResponse,
  decodeIngestRequest,
  decodeIngestResult,
  encodeFlowNotice,
  encodeHttpResponse,
  encodeIngestRequest,
  encodeIngestResult,
  encodeTimerTick,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";

const buffer = (bytes) => new ByteBuffer(Uint8Array.from(bytes));
export const decodeDss = (bytes) => DSS.getRootAsDSS(buffer(bytes)).unpack();
export const decodeOem = (bytes) => OEM.getRootAsOEM(buffer(bytes)).unpack();
export const decodeOmmRecord = (bytes) => OMM.getSizePrefixedRootAsOMM(buffer(bytes)).unpack();
export const decodeObdRecord = (bytes) => OBD.getSizePrefixedRootAsOBD(buffer(bytes)).unpack();
export const decodeOcmRecord = (bytes) => OCM.getSizePrefixedRootAsOCM(buffer(bytes)).unpack();
export function encodeOemSizePrefixed(object) {
  const builder = new Builder(1 << 16);
  builder.finishSizePrefixed(object.pack(builder), "$OEM");
  return builder.asUint8Array();
}
export function encodeOem(object) {
  const builder = new Builder(1 << 16);
  builder.finish(object.pack(builder), "$OEM");
  return builder.asUint8Array();
}

export const TYPE = Object.freeze({
  OEM: { schemaName: "OEM.fbs", fileIdentifier: "$OEM", rootTypeName: "OEM", wireFormat: "flatbuffer" },
  TICK: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
  INGQ: { schemaName: "IngestRequest.fbs", fileIdentifier: "INGQ", rootTypeName: "IngestRequest", wireFormat: "flatbuffer" },
  INGR: { schemaName: "IngestResult.fbs", fileIdentifier: "INGR", rootTypeName: "IngestResult", wireFormat: "flatbuffer" },
  FNTC: { schemaName: "FlowNotice.fbs", fileIdentifier: "FNTC", rootTypeName: "FlowNotice", wireFormat: "flatbuffer" },
});
