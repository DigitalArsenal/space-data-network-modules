import * as flatbuffers from "flatbuffers";
import { KeplerianElements } from "./keplerian-elements.js";
import { TLEData } from "./tledata.js";
class PropagatorInit {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  static getRootAsPropagatorInit(bb, obj) {
    return (obj || new PropagatorInit()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static getSizePrefixedRootAsPropagatorInit(bb, obj) {
    bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
    return (obj || new PropagatorInit()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  /**
   * TLE data (for SGP4/SDP4 propagators)
   */
  tle(index, obj) {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? (obj || new TLEData()).__init(this.bb.__indirect(this.bb.__vector(this.bb_pos + offset) + index * 4), this.bb) : null;
  }
  tleLength() {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
  }
  /**
   * Keplerian elements (for numerical propagators)
   */
  elements(index, obj) {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? (obj || new KeplerianElements()).__init(this.bb.__indirect(this.bb.__vector(this.bb_pos + offset) + index * 4), this.bb) : null;
  }
  elementsLength() {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
  }
  /**
   * Entity handles to assign results to
   */
  entityHandles(index) {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.readUint32(this.bb.__vector(this.bb_pos + offset) + index * 4) : 0;
  }
  entityHandlesLength() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.__vector_len(this.bb_pos + offset) : 0;
  }
  entityHandlesArray() {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? new Uint32Array(this.bb.bytes().buffer, this.bb.bytes().byteOffset + this.bb.__vector(this.bb_pos + offset), this.bb.__vector_len(this.bb_pos + offset)) : null;
  }
  static startPropagatorInit(builder) {
    builder.startObject(3);
  }
  static addTle(builder, tleOffset) {
    builder.addFieldOffset(0, tleOffset, 0);
  }
  static createTleVector(builder, data) {
    builder.startVector(4, data.length, 4);
    for (let i = data.length - 1; i >= 0; i--) {
      builder.addOffset(data[i]);
    }
    return builder.endVector();
  }
  static startTleVector(builder, numElems) {
    builder.startVector(4, numElems, 4);
  }
  static addElements(builder, elementsOffset) {
    builder.addFieldOffset(1, elementsOffset, 0);
  }
  static createElementsVector(builder, data) {
    builder.startVector(4, data.length, 4);
    for (let i = data.length - 1; i >= 0; i--) {
      builder.addOffset(data[i]);
    }
    return builder.endVector();
  }
  static startElementsVector(builder, numElems) {
    builder.startVector(4, numElems, 4);
  }
  static addEntityHandles(builder, entityHandlesOffset) {
    builder.addFieldOffset(2, entityHandlesOffset, 0);
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
  static endPropagatorInit(builder) {
    const offset = builder.endObject();
    return offset;
  }
  static createPropagatorInit(builder, tleOffset, elementsOffset, entityHandlesOffset) {
    PropagatorInit.startPropagatorInit(builder);
    PropagatorInit.addTle(builder, tleOffset);
    PropagatorInit.addElements(builder, elementsOffset);
    PropagatorInit.addEntityHandles(builder, entityHandlesOffset);
    return PropagatorInit.endPropagatorInit(builder);
  }
  unpack() {
    return new PropagatorInitT(
      this.bb.createObjList(this.tle.bind(this), this.tleLength()),
      this.bb.createObjList(this.elements.bind(this), this.elementsLength()),
      this.bb.createScalarList(this.entityHandles.bind(this), this.entityHandlesLength())
    );
  }
  unpackTo(_o) {
    _o.tle = this.bb.createObjList(this.tle.bind(this), this.tleLength());
    _o.elements = this.bb.createObjList(this.elements.bind(this), this.elementsLength());
    _o.entityHandles = this.bb.createScalarList(this.entityHandles.bind(this), this.entityHandlesLength());
  }
}
class PropagatorInitT {
  constructor(tle = [], elements = [], entityHandles = []) {
    this.tle = tle;
    this.elements = elements;
    this.entityHandles = entityHandles;
  }
  pack(builder) {
    const tle = PropagatorInit.createTleVector(builder, builder.createObjectOffsetList(this.tle));
    const elements = PropagatorInit.createElementsVector(builder, builder.createObjectOffsetList(this.elements));
    const entityHandles = PropagatorInit.createEntityHandlesVector(builder, this.entityHandles);
    return PropagatorInit.createPropagatorInit(
      builder,
      tle,
      elements,
      entityHandles
    );
  }
}
export {
  PropagatorInit,
  PropagatorInitT
};
