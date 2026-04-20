import * as flatbuffers from "flatbuffers";
import { ReferenceFrame } from "./reference-frame.js";
class PropagatorState {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  static getRootAsPropagatorState(bb, obj) {
    return (obj || new PropagatorState()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static getSizePrefixedRootAsPropagatorState(bb, obj) {
    bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
    return (obj || new PropagatorState()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static bufferHasIdentifier(bb) {
    return bb.__has_identifier("PRST");
  }
  /**
   * Position [x, y, z] in specified reference frame (meters)
   */
  position(index) {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? this.bb.readFloat64(this.bb.__vector(this.bb_pos + offset) + index * 8) : 0;
  }
  positionLength() {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
  }
  positionArray() {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? new Float64Array(this.bb.bytes().buffer, this.bb.bytes().byteOffset + this.bb.__vector(this.bb_pos + offset), this.bb.__vector_len(this.bb_pos + offset)) : null;
  }
  /**
   * Velocity [vx, vy, vz] in specified reference frame (m/s)
   */
  velocity(index) {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.readFloat64(this.bb.__vector(this.bb_pos + offset) + index * 8) : 0;
  }
  velocityLength() {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
  }
  velocityArray() {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? new Float64Array(this.bb.bytes().buffer, this.bb.bytes().byteOffset + this.bb.__vector(this.bb_pos + offset), this.bb.__vector_len(this.bb_pos + offset)) : null;
  }
  /**
   * Epoch timestamp (milliseconds since J2000)
   */
  epoch() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.readInt64(this.bb_pos + offset) : BigInt("0");
  }
  /**
   * Reference frame for position/velocity
   */
  referenceFrame() {
    const offset = this.bb.__offset(this.bb_pos, 10);
    return offset ? this.bb.readInt8(this.bb_pos + offset) : ReferenceFrame.TEME;
  }
  /**
   * Covariance matrix (lower triangular, 21 elements for 6x6)
   */
  covariance(index) {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? this.bb.readFloat64(this.bb.__vector(this.bb_pos + offset) + index * 8) : 0;
  }
  covarianceLength() {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
  }
  covarianceArray() {
    const offset = this.bb.__offset(this.bb_pos, 12);
    return offset ? new Float64Array(this.bb.bytes().buffer, this.bb.bytes().byteOffset + this.bb.__vector(this.bb_pos + offset), this.bb.__vector_len(this.bb_pos + offset)) : null;
  }
  /**
   * Ballistic coefficient (m^2/kg) for drag
   */
  ballisticCoefficient() {
    const offset = this.bb.__offset(this.bb_pos, 14);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Solar radiation pressure coefficient
   */
  srpCoefficient() {
    const offset = this.bb.__offset(this.bb_pos, 16);
    return offset ? this.bb.readFloat64(this.bb_pos + offset) : 0;
  }
  /**
   * Satellite ID / NORAD catalog number
   */
  catalogNumber() {
    const offset = this.bb.__offset(this.bb_pos, 18);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  /**
   * Entity index in propagator
   */
  entityIndex() {
    const offset = this.bb.__offset(this.bb_pos, 20);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  /**
   * Propagation valid flag
   */
  valid() {
    const offset = this.bb.__offset(this.bb_pos, 22);
    return offset ? !!this.bb.readInt8(this.bb_pos + offset) : true;
  }
  static startPropagatorState(builder) {
    builder.startObject(10);
  }
  static addPosition(builder, positionOffset) {
    builder.addFieldOffset(0, positionOffset, 0);
  }
  static createPositionVector(builder, data) {
    builder.startVector(8, data.length, 8);
    for (let i = data.length - 1; i >= 0; i--) {
      builder.addFloat64(data[i]);
    }
    return builder.endVector();
  }
  static startPositionVector(builder, numElems) {
    builder.startVector(8, numElems, 8);
  }
  static addVelocity(builder, velocityOffset) {
    builder.addFieldOffset(1, velocityOffset, 0);
  }
  static createVelocityVector(builder, data) {
    builder.startVector(8, data.length, 8);
    for (let i = data.length - 1; i >= 0; i--) {
      builder.addFloat64(data[i]);
    }
    return builder.endVector();
  }
  static startVelocityVector(builder, numElems) {
    builder.startVector(8, numElems, 8);
  }
  static addEpoch(builder, epoch) {
    builder.addFieldInt64(2, epoch, BigInt("0"));
  }
  static addReferenceFrame(builder, referenceFrame) {
    builder.addFieldInt8(3, referenceFrame, ReferenceFrame.TEME);
  }
  static addCovariance(builder, covarianceOffset) {
    builder.addFieldOffset(4, covarianceOffset, 0);
  }
  static createCovarianceVector(builder, data) {
    builder.startVector(8, data.length, 8);
    for (let i = data.length - 1; i >= 0; i--) {
      builder.addFloat64(data[i]);
    }
    return builder.endVector();
  }
  static startCovarianceVector(builder, numElems) {
    builder.startVector(8, numElems, 8);
  }
  static addBallisticCoefficient(builder, ballisticCoefficient) {
    builder.addFieldFloat64(5, ballisticCoefficient, 0);
  }
  static addSrpCoefficient(builder, srpCoefficient) {
    builder.addFieldFloat64(6, srpCoefficient, 0);
  }
  static addCatalogNumber(builder, catalogNumber) {
    builder.addFieldInt32(7, catalogNumber, 0);
  }
  static addEntityIndex(builder, entityIndex) {
    builder.addFieldInt32(8, entityIndex, 0);
  }
  static addValid(builder, valid) {
    builder.addFieldInt8(9, +valid, 1);
  }
  static endPropagatorState(builder) {
    const offset = builder.endObject();
    return offset;
  }
  static finishPropagatorStateBuffer(builder, offset) {
    builder.finish(offset, "PRST");
  }
  static finishSizePrefixedPropagatorStateBuffer(builder, offset) {
    builder.finish(offset, "PRST", true);
  }
  static createPropagatorState(builder, positionOffset, velocityOffset, epoch, referenceFrame, covarianceOffset, ballisticCoefficient, srpCoefficient, catalogNumber, entityIndex, valid) {
    PropagatorState.startPropagatorState(builder);
    PropagatorState.addPosition(builder, positionOffset);
    PropagatorState.addVelocity(builder, velocityOffset);
    PropagatorState.addEpoch(builder, epoch);
    PropagatorState.addReferenceFrame(builder, referenceFrame);
    PropagatorState.addCovariance(builder, covarianceOffset);
    PropagatorState.addBallisticCoefficient(builder, ballisticCoefficient);
    PropagatorState.addSrpCoefficient(builder, srpCoefficient);
    PropagatorState.addCatalogNumber(builder, catalogNumber);
    PropagatorState.addEntityIndex(builder, entityIndex);
    PropagatorState.addValid(builder, valid);
    return PropagatorState.endPropagatorState(builder);
  }
  unpack() {
    return new PropagatorStateT(
      this.bb.createScalarList(this.position.bind(this), this.positionLength()),
      this.bb.createScalarList(this.velocity.bind(this), this.velocityLength()),
      this.epoch(),
      this.referenceFrame(),
      this.bb.createScalarList(this.covariance.bind(this), this.covarianceLength()),
      this.ballisticCoefficient(),
      this.srpCoefficient(),
      this.catalogNumber(),
      this.entityIndex(),
      this.valid()
    );
  }
  unpackTo(_o) {
    _o.position = this.bb.createScalarList(this.position.bind(this), this.positionLength());
    _o.velocity = this.bb.createScalarList(this.velocity.bind(this), this.velocityLength());
    _o.epoch = this.epoch();
    _o.referenceFrame = this.referenceFrame();
    _o.covariance = this.bb.createScalarList(this.covariance.bind(this), this.covarianceLength());
    _o.ballisticCoefficient = this.ballisticCoefficient();
    _o.srpCoefficient = this.srpCoefficient();
    _o.catalogNumber = this.catalogNumber();
    _o.entityIndex = this.entityIndex();
    _o.valid = this.valid();
  }
}
class PropagatorStateT {
  constructor(position = [], velocity = [], epoch = BigInt("0"), referenceFrame = ReferenceFrame.TEME, covariance = [], ballisticCoefficient = 0, srpCoefficient = 0, catalogNumber = 0, entityIndex = 0, valid = true) {
    this.position = position;
    this.velocity = velocity;
    this.epoch = epoch;
    this.referenceFrame = referenceFrame;
    this.covariance = covariance;
    this.ballisticCoefficient = ballisticCoefficient;
    this.srpCoefficient = srpCoefficient;
    this.catalogNumber = catalogNumber;
    this.entityIndex = entityIndex;
    this.valid = valid;
  }
  pack(builder) {
    const position = PropagatorState.createPositionVector(builder, this.position);
    const velocity = PropagatorState.createVelocityVector(builder, this.velocity);
    const covariance = PropagatorState.createCovarianceVector(builder, this.covariance);
    return PropagatorState.createPropagatorState(
      builder,
      position,
      velocity,
      this.epoch,
      this.referenceFrame,
      covariance,
      this.ballisticCoefficient,
      this.srpCoefficient,
      this.catalogNumber,
      this.entityIndex,
      this.valid
    );
  }
}
export {
  PropagatorState,
  PropagatorStateT
};
