import * as flatbuffers from "flatbuffers";
import { TypedArenaBuffer } from "../stream/typed-arena-buffer.js";
class StreamInvokeRequest {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  static getRootAsStreamInvokeRequest(bb, obj) {
    return (obj || new StreamInvokeRequest()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static getSizePrefixedRootAsStreamInvokeRequest(bb, obj) {
    bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
    return (obj || new StreamInvokeRequest()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  methodId(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return this.bb.__string(this.bb_pos + offset, optionalEncoding);
  }
  /**
   * Input FlatBuffer frames grouped as a vector of descriptors.
   */
  inputs(index, obj) {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? (obj || new TypedArenaBuffer()).__init(this.bb.__indirect(this.bb.__vector(this.bb_pos + offset) + index * 4), this.bb) : null;
  }
  inputsLength() {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
  }
  /**
   * Maximum number of output frames the caller is prepared to accept.
   */
  outputStreamCap() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  static startStreamInvokeRequest(builder) {
    builder.startObject(3);
  }
  static addMethodId(builder, methodIdOffset) {
    builder.addFieldOffset(0, methodIdOffset, 0);
  }
  static addInputs(builder, inputsOffset) {
    builder.addFieldOffset(1, inputsOffset, 0);
  }
  static createInputsVector(builder, data) {
    builder.startVector(4, data.length, 4);
    for (let i = data.length - 1; i >= 0; i--) {
      builder.addOffset(data[i]);
    }
    return builder.endVector();
  }
  static startInputsVector(builder, numElems) {
    builder.startVector(4, numElems, 4);
  }
  static addOutputStreamCap(builder, outputStreamCap) {
    builder.addFieldInt32(2, outputStreamCap, 0);
  }
  static endStreamInvokeRequest(builder) {
    const offset = builder.endObject();
    builder.requiredField(offset, 4);
    return offset;
  }
  static createStreamInvokeRequest(builder, methodIdOffset, inputsOffset, outputStreamCap) {
    StreamInvokeRequest.startStreamInvokeRequest(builder);
    StreamInvokeRequest.addMethodId(builder, methodIdOffset);
    StreamInvokeRequest.addInputs(builder, inputsOffset);
    StreamInvokeRequest.addOutputStreamCap(builder, outputStreamCap);
    return StreamInvokeRequest.endStreamInvokeRequest(builder);
  }
  unpack() {
    return new StreamInvokeRequestT(
      this.methodId(),
      this.bb.createObjList(this.inputs.bind(this), this.inputsLength()),
      this.outputStreamCap()
    );
  }
  unpackTo(_o) {
    _o.methodId = this.methodId();
    _o.inputs = this.bb.createObjList(this.inputs.bind(this), this.inputsLength());
    _o.outputStreamCap = this.outputStreamCap();
  }
}
class StreamInvokeRequestT {
  constructor(methodId = null, inputs = [], outputStreamCap = 0) {
    this.methodId = methodId;
    this.inputs = inputs;
    this.outputStreamCap = outputStreamCap;
  }
  pack(builder) {
    const methodId = this.methodId !== null ? builder.createString(this.methodId) : 0;
    const inputs = StreamInvokeRequest.createInputsVector(builder, builder.createObjectOffsetList(this.inputs));
    return StreamInvokeRequest.createStreamInvokeRequest(
      builder,
      methodId,
      inputs,
      this.outputStreamCap
    );
  }
}
export {
  StreamInvokeRequest,
  StreamInvokeRequestT
};
