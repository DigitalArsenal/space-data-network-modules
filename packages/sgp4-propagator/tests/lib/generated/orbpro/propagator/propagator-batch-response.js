import * as flatbuffers from "flatbuffers";
import { ReferenceFrame } from "./reference-frame.js";
class PropagatorBatchResponse {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  static getRootAsPropagatorBatchResponse(bb, obj) {
    return (obj || new PropagatorBatchResponse()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static getSizePrefixedRootAsPropagatorBatchResponse(bb, obj) {
    bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
    return (obj || new PropagatorBatchResponse()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static bufferHasIdentifier(bb) {
    return bb.__has_identifier("PROP");
  }
  /**
   * Number of state vectors written
   */
  count() {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  /**
   * Offset in arena where StateVector[] starts
   */
  outputOffset() {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  /**
   * Reference frame of all output states
   */
  referenceFrame() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.readUint8(this.bb_pos + offset) : ReferenceFrame.TEME;
  }
  /**
   * Error code (0 = success)
   */
  errorCode() {
    const offset = this.bb.__offset(this.bb_pos, 10);
    return offset ? this.bb.readInt32(this.bb_pos + offset) : 0;
  }
  errorMessage(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  static startPropagatorBatchResponse(builder) {
    builder.startObject(5);
  }
  static addCount(builder, count) {
    builder.addFieldInt32(0, count, 0);
  }
  static addOutputOffset(builder, outputOffset) {
    builder.addFieldInt32(1, outputOffset, 0);
  }
  static addReferenceFrame(builder, referenceFrame) {
    builder.addFieldInt8(2, referenceFrame, ReferenceFrame.TEME);
  }
  static addErrorCode(builder, errorCode) {
    builder.addFieldInt32(3, errorCode, 0);
  }
  static addErrorMessage(builder, errorMessageOffset) {
    builder.addFieldOffset(4, errorMessageOffset, 0);
  }
  static endPropagatorBatchResponse(builder) {
    const offset = builder.endObject();
    return offset;
  }
  static finishPropagatorBatchResponseBuffer(builder, offset) {
    builder.finish(offset, "PROP");
  }
  static finishSizePrefixedPropagatorBatchResponseBuffer(builder, offset) {
    builder.finish(offset, "PROP", true);
  }
  static createPropagatorBatchResponse(builder, count, outputOffset, referenceFrame, errorCode, errorMessageOffset) {
    PropagatorBatchResponse.startPropagatorBatchResponse(builder);
    PropagatorBatchResponse.addCount(builder, count);
    PropagatorBatchResponse.addOutputOffset(builder, outputOffset);
    PropagatorBatchResponse.addReferenceFrame(builder, referenceFrame);
    PropagatorBatchResponse.addErrorCode(builder, errorCode);
    PropagatorBatchResponse.addErrorMessage(builder, errorMessageOffset);
    return PropagatorBatchResponse.endPropagatorBatchResponse(builder);
  }
  unpack() {
    return new PropagatorBatchResponseT(
      this.count(),
      this.outputOffset(),
      this.referenceFrame(),
      this.errorCode(),
      this.errorMessage()
    );
  }
  unpackTo(_o) {
    _o.count = this.count();
    _o.outputOffset = this.outputOffset();
    _o.referenceFrame = this.referenceFrame();
    _o.errorCode = this.errorCode();
    _o.errorMessage = this.errorMessage();
  }
}
class PropagatorBatchResponseT {
  constructor(count = 0, outputOffset = 0, referenceFrame = ReferenceFrame.TEME, errorCode = 0, errorMessage = null) {
    this.count = count;
    this.outputOffset = outputOffset;
    this.referenceFrame = referenceFrame;
    this.errorCode = errorCode;
    this.errorMessage = errorMessage;
  }
  pack(builder) {
    const errorMessage = this.errorMessage !== null ? builder.createString(this.errorMessage) : 0;
    return PropagatorBatchResponse.createPropagatorBatchResponse(
      builder,
      this.count,
      this.outputOffset,
      this.referenceFrame,
      this.errorCode,
      errorMessage
    );
  }
}
export {
  PropagatorBatchResponse,
  PropagatorBatchResponseT
};
