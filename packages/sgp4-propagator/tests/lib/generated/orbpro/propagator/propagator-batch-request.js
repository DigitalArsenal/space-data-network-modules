import * as flatbuffers from "flatbuffers";
class PropagatorBatchRequest {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  static getRootAsPropagatorBatchRequest(bb, obj) {
    return (obj || new PropagatorBatchRequest()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static getSizePrefixedRootAsPropagatorBatchRequest(bb, obj) {
    bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
    return (obj || new PropagatorBatchRequest()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  /**
   * Target epoch as Julian date
   */
  epoch() {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Entity handles to propagate (empty = all)
   */
  entityHandles(index) {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.readUint32(this.bb.__vector(this.bb_pos + offset) + index * 4) : 0;
  }
  entityHandlesLength() {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
  }
  entityHandlesArray() {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? new Uint32Array(this.bb.bytes().buffer, this.bb.bytes().byteOffset + this.bb.__vector(this.bb_pos + offset), this.bb.__vector_len(this.bb_pos + offset)) : null;
  }
  /**
   * Output buffer offset in arena (bytes from arena base)
   */
  outputOffset() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  /**
   * Maximum entities to process
   */
  maxCount() {
    const offset = this.bb.__offset(this.bb_pos, 10);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  static startPropagatorBatchRequest(builder) {
    builder.startObject(4);
  }
  static addEpoch(builder, epoch) {
    builder.addFieldFloat64(0, epoch, 0);
  }
  static addEntityHandles(builder, entityHandlesOffset) {
    builder.addFieldOffset(1, entityHandlesOffset, 0);
  }
  static createEntityHandlesVector(builder, data) {
    builder.startVector(4, data.length, 4);
    for (let i = data.length - 1; i >= 0; i--) {
      builder.addInt32(data[i]);
    }
    return builder.endVector();
  }
  static startEntityHandlesVector(builder, numElems) {
    builder.startVector(4, numElems, 4);
  }
  static addOutputOffset(builder, outputOffset) {
    builder.addFieldInt32(2, outputOffset, 0);
  }
  static addMaxCount(builder, maxCount) {
    builder.addFieldInt32(3, maxCount, 0);
  }
  static endPropagatorBatchRequest(builder) {
    const offset = builder.endObject();
    return offset;
  }
  static createPropagatorBatchRequest(builder, epoch, entityHandlesOffset, outputOffset, maxCount) {
    PropagatorBatchRequest.startPropagatorBatchRequest(builder);
    PropagatorBatchRequest.addEpoch(builder, epoch);
    PropagatorBatchRequest.addEntityHandles(builder, entityHandlesOffset);
    PropagatorBatchRequest.addOutputOffset(builder, outputOffset);
    PropagatorBatchRequest.addMaxCount(builder, maxCount);
    return PropagatorBatchRequest.endPropagatorBatchRequest(builder);
  }
  unpack() {
    return new PropagatorBatchRequestT(
      this.epoch(),
      this.bb.createScalarList(this.entityHandles.bind(this), this.entityHandlesLength()),
      this.outputOffset(),
      this.maxCount()
    );
  }
  unpackTo(_o) {
    _o.epoch = this.epoch();
    _o.entityHandles = this.bb.createScalarList(this.entityHandles.bind(this), this.entityHandlesLength());
    _o.outputOffset = this.outputOffset();
    _o.maxCount = this.maxCount();
  }
}
class PropagatorBatchRequestT {
  constructor(epoch = 0, entityHandles = [], outputOffset = 0, maxCount = 0) {
    this.epoch = epoch;
    this.entityHandles = entityHandles;
    this.outputOffset = outputOffset;
    this.maxCount = maxCount;
  }
  pack(builder) {
    const entityHandles = PropagatorBatchRequest.createEntityHandlesVector(builder, this.entityHandles);
    return PropagatorBatchRequest.createPropagatorBatchRequest(
      builder,
      this.epoch,
      entityHandles,
      this.outputOffset,
      this.maxCount
    );
  }
}
export {
  PropagatorBatchRequest,
  PropagatorBatchRequestT
};
