import * as flatbuffers from "flatbuffers";
import { TypedArenaBuffer } from "../stream/typed-arena-buffer.js";
class StreamInvokeResponse {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  static getRootAsStreamInvokeResponse(bb, obj) {
    return (obj || new StreamInvokeResponse()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static getSizePrefixedRootAsStreamInvokeResponse(bb, obj) {
    bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
    return (obj || new StreamInvokeResponse()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  /**
   * Output FlatBuffer frames produced by the method.
   */
  outputs(index, obj) {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? (obj || new TypedArenaBuffer()).__init(this.bb.__indirect(this.bb.__vector(this.bb_pos + offset) + index * 4), this.bb) : null;
  }
  outputsLength() {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
  }
  /**
   * Number of queued input frames still waiting upstream after this call.
   */
  backlogRemaining() {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  /**
   * True when the runtime yielded before fully draining the input backlog.
   */
  yielded() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
  }
  /**
   * Error code (0 = success).
   */
  errorCode() {
    const offset = this.bb.__offset(this.bb_pos, 10);
    return offset ? this.bb.readInt32(this.bb_pos + offset) : 0;
  }
  errorMessage(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  static startStreamInvokeResponse(builder) {
    builder.startObject(5);
  }
  static addOutputs(builder, outputsOffset) {
    builder.addFieldOffset(0, outputsOffset, 0);
  }
  static createOutputsVector(builder, data) {
    builder.startVector(4, data.length, 4);
    for (let i = data.length - 1; i >= 0; i--) {
      builder.addOffset(data[i]);
    }
    return builder.endVector();
  }
  static startOutputsVector(builder, numElems) {
    builder.startVector(4, numElems, 4);
  }
  static addBacklogRemaining(builder, backlogRemaining) {
    builder.addFieldInt32(1, backlogRemaining, 0);
  }
  static addYielded(builder, yielded) {
    builder.addFieldInt8(2, +yielded, 0);
  }
  static addErrorCode(builder, errorCode) {
    builder.addFieldInt32(3, errorCode, 0);
  }
  static addErrorMessage(builder, errorMessageOffset) {
    builder.addFieldOffset(4, errorMessageOffset, 0);
  }
  static endStreamInvokeResponse(builder) {
    const offset = builder.endObject();
    return offset;
  }
  static createStreamInvokeResponse(builder, outputsOffset, backlogRemaining, yielded, errorCode, errorMessageOffset) {
    StreamInvokeResponse.startStreamInvokeResponse(builder);
    StreamInvokeResponse.addOutputs(builder, outputsOffset);
    StreamInvokeResponse.addBacklogRemaining(builder, backlogRemaining);
    StreamInvokeResponse.addYielded(builder, yielded);
    StreamInvokeResponse.addErrorCode(builder, errorCode);
    StreamInvokeResponse.addErrorMessage(builder, errorMessageOffset);
    return StreamInvokeResponse.endStreamInvokeResponse(builder);
  }
  unpack() {
    return new StreamInvokeResponseT(
      this.bb.createObjList(this.outputs.bind(this), this.outputsLength()),
      this.backlogRemaining(),
      this.yielded(),
      this.errorCode(),
      this.errorMessage()
    );
  }
  unpackTo(_o) {
    _o.outputs = this.bb.createObjList(this.outputs.bind(this), this.outputsLength());
    _o.backlogRemaining = this.backlogRemaining();
    _o.yielded = this.yielded();
    _o.errorCode = this.errorCode();
    _o.errorMessage = this.errorMessage();
  }
}
class StreamInvokeResponseT {
  constructor(outputs = [], backlogRemaining = 0, yielded = false, errorCode = 0, errorMessage = null) {
    this.outputs = outputs;
    this.backlogRemaining = backlogRemaining;
    this.yielded = yielded;
    this.errorCode = errorCode;
    this.errorMessage = errorMessage;
  }
  pack(builder) {
    const outputs = StreamInvokeResponse.createOutputsVector(builder, builder.createObjectOffsetList(this.outputs));
    const errorMessage = this.errorMessage !== null ? builder.createString(this.errorMessage) : 0;
    return StreamInvokeResponse.createStreamInvokeResponse(
      builder,
      outputs,
      this.backlogRemaining,
      this.yielded,
      this.errorCode,
      errorMessage
    );
  }
}
export {
  StreamInvokeResponse,
  StreamInvokeResponseT
};
