import {
  encodeGrantResponse as encodeRawGrantResponse,
  decodeGrantResponse as decodeRawGrantResponse,
} from "../../../../space-data-network/packages/module-sdk/src/module-delivery-codec.js";

export function encodeGrantResponse(payload = {}) {
  return encodeRawGrantResponse(payload);
}

export function decodeGrantResponse(messageBytes) {
  return decodeRawGrantResponse(messageBytes);
}
