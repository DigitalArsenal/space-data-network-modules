import * as flatbuffers from "flatbuffers";
import { ReferenceFrame } from "./reference-frame.js";
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
  /**
   * Objects by NORAD catalog number. Each is resolved by its number, so the
   * answer is never another object's; an unknown number refuses the request.
   * With entity_handles as well, both must name the same objects in order.
   */
  catalogNumbers(index) {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? this.bb.readUint32(this.bb.__vector(this.bb_pos + offset) + index * 4) : 0;
  }
  catalogNumbersLength() {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
  }
  catalogNumbersArray() {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? new Uint32Array(this.bb.bytes().buffer, this.bb.bytes().byteOffset + this.bb.__vector(this.bb_pos + offset), this.bb.__vector_len(this.bb_pos + offset)) : null;
  }
  /**
   * Axes of the output: ECEF (default, Earth-fixed as before), TEME (SGP4's
   * own axes) or ICRF (Earth-centred ICRF axes, that is GCRF).
   */
  outputFrame() {
    const offset = this.bb.__offset(this.bb_pos, 14);
    return offset ? this.bb.readUint8(this.bb_pos + offset) : ReferenceFrame.ECEF;
  }
  /**
   * propagate_ephemeris: the span's end as a Julian date (UTC; epoch is its
   * start) and the sample step in seconds.
   */
  stopEpoch() {
    const offset = this.bb.__offset(this.bb_pos, 16);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  stepSeconds() {
    const offset = this.bb.__offset(this.bb_pos, 18);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * propagate_ephemeris: one data block per element set of each object's
   * history, each propagated from its own set alone from the epoch of the
   * set neighbour_sets earlier to the epoch of the set neighbour_sets later.
   */
  elementSetBlocks() {
    const offset = this.bb.__offset(this.bb_pos, 20);
    return offset ? !!this.bb.readInt8(this.bb_pos + offset) : false;
  }
  neighbourSets() {
    const offset = this.bb.__offset(this.bb_pos, 22);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 2;
  }
  static startPropagatorBatchRequest(builder) {
    builder.startObject(10);
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
  static addCatalogNumbers(builder, catalogNumbersOffset) {
    builder.addFieldOffset(4, catalogNumbersOffset, 0);
  }
  static createCatalogNumbersVector(builder, data) {
    builder.startVector(4, data.length, 4);
    for (let i = data.length - 1; i >= 0; i--) {
      builder.addInt32(data[i]);
    }
    return builder.endVector();
  }
  static startCatalogNumbersVector(builder, numElems) {
    builder.startVector(4, numElems, 4);
  }
  static addOutputFrame(builder, outputFrame) {
    builder.addFieldInt8(5, outputFrame, ReferenceFrame.ECEF);
  }
  static addStopEpoch(builder, stopEpoch) {
    builder.addFieldFloat64(6, stopEpoch, 0);
  }
  static addStepSeconds(builder, stepSeconds) {
    builder.addFieldFloat64(7, stepSeconds, 0);
  }
  static addElementSetBlocks(builder, elementSetBlocks) {
    builder.addFieldInt8(8, +elementSetBlocks, 0);
  }
  static addNeighbourSets(builder, neighbourSets) {
    builder.addFieldInt32(9, neighbourSets, 2);
  }
  static endPropagatorBatchRequest(builder) {
    const offset = builder.endObject();
    return offset;
  }
  static createPropagatorBatchRequest(builder, epoch, entityHandlesOffset, outputOffset, maxCount, catalogNumbersOffset, outputFrame, stopEpoch, stepSeconds, elementSetBlocks, neighbourSets) {
    PropagatorBatchRequest.startPropagatorBatchRequest(builder);
    PropagatorBatchRequest.addEpoch(builder, epoch);
    PropagatorBatchRequest.addEntityHandles(builder, entityHandlesOffset);
    PropagatorBatchRequest.addOutputOffset(builder, outputOffset);
    PropagatorBatchRequest.addMaxCount(builder, maxCount);
    PropagatorBatchRequest.addCatalogNumbers(builder, catalogNumbersOffset);
    PropagatorBatchRequest.addOutputFrame(builder, outputFrame);
    PropagatorBatchRequest.addStopEpoch(builder, stopEpoch);
    PropagatorBatchRequest.addStepSeconds(builder, stepSeconds);
    PropagatorBatchRequest.addElementSetBlocks(builder, elementSetBlocks);
    PropagatorBatchRequest.addNeighbourSets(builder, neighbourSets);
    return PropagatorBatchRequest.endPropagatorBatchRequest(builder);
  }
  unpack() {
    return new PropagatorBatchRequestT(
      this.epoch(),
      this.bb.createScalarList(this.entityHandles.bind(this), this.entityHandlesLength()),
      this.outputOffset(),
      this.maxCount(),
      this.bb.createScalarList(this.catalogNumbers.bind(this), this.catalogNumbersLength()),
      this.outputFrame(),
      this.stopEpoch(),
      this.stepSeconds(),
      this.elementSetBlocks(),
      this.neighbourSets()
    );
  }
  unpackTo(_o) {
    _o.epoch = this.epoch();
    _o.entityHandles = this.bb.createScalarList(this.entityHandles.bind(this), this.entityHandlesLength());
    _o.outputOffset = this.outputOffset();
    _o.maxCount = this.maxCount();
    _o.catalogNumbers = this.bb.createScalarList(this.catalogNumbers.bind(this), this.catalogNumbersLength());
    _o.outputFrame = this.outputFrame();
    _o.stopEpoch = this.stopEpoch();
    _o.stepSeconds = this.stepSeconds();
    _o.elementSetBlocks = this.elementSetBlocks();
    _o.neighbourSets = this.neighbourSets();
  }
}
class PropagatorBatchRequestT {
  constructor(epoch = 0, entityHandles = [], outputOffset = 0, maxCount = 0, catalogNumbers = [], outputFrame = ReferenceFrame.ECEF, stopEpoch = 0, stepSeconds = 0, elementSetBlocks = false, neighbourSets = 2) {
    this.epoch = epoch;
    this.entityHandles = entityHandles;
    this.outputOffset = outputOffset;
    this.maxCount = maxCount;
    this.catalogNumbers = catalogNumbers;
    this.outputFrame = outputFrame;
    this.stopEpoch = stopEpoch;
    this.stepSeconds = stepSeconds;
    this.elementSetBlocks = elementSetBlocks;
    this.neighbourSets = neighbourSets;
  }
  pack(builder) {
    const entityHandles = PropagatorBatchRequest.createEntityHandlesVector(builder, this.entityHandles);
    const catalogNumbers = PropagatorBatchRequest.createCatalogNumbersVector(builder, this.catalogNumbers);
    return PropagatorBatchRequest.createPropagatorBatchRequest(
      builder,
      this.epoch,
      entityHandles,
      this.outputOffset,
      this.maxCount,
      catalogNumbers,
      this.outputFrame,
      this.stopEpoch,
      this.stepSeconds,
      this.elementSetBlocks,
      this.neighbourSets
    );
  }
}
export {
  PropagatorBatchRequest,
  PropagatorBatchRequestT
};
