import * as flatbuffers from "flatbuffers";
class TLEData {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  static getRootAsTLEData(bb, obj) {
    return (obj || new TLEData()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  static getSizePrefixedRootAsTLEData(bb, obj) {
    bb.setPosition(bb.position() + flatbuffers.SIZE_PREFIX_LENGTH);
    return (obj || new TLEData()).__init(bb.readInt32(bb.position()) + bb.position(), bb);
  }
  line1(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 4);
    return this.bb.__string(this.bb_pos + offset, optionalEncoding);
  }
  line2(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 6);
    return this.bb.__string(this.bb_pos + offset, optionalEncoding);
  }
  name(optionalEncoding) {
    const offset = this.bb.__offset(this.bb_pos, 8);
    return offset ? this.bb.__string(this.bb_pos + offset, optionalEncoding) : null;
  }
  /**
   * NORAD catalog number (parsed from TLE)
   */
  noradId() {
    const offset = this.bb.__offset(this.bb_pos, 10);
    return offset ? this.bb.readUint32(this.bb_pos + offset) : 0;
  }
  static startTLEData(builder) {
    builder.startObject(4);
  }
  static addLine1(builder, line1Offset) {
    builder.addFieldOffset(0, line1Offset, 0);
  }
  static addLine2(builder, line2Offset) {
    builder.addFieldOffset(1, line2Offset, 0);
  }
  static addName(builder, nameOffset) {
    builder.addFieldOffset(2, nameOffset, 0);
  }
  static addNoradId(builder, noradId) {
    builder.addFieldInt32(3, noradId, 0);
  }
  static endTLEData(builder) {
    const offset = builder.endObject();
    builder.requiredField(offset, 4);
    builder.requiredField(offset, 6);
    return offset;
  }
  static createTLEData(builder, line1Offset, line2Offset, nameOffset, noradId) {
    TLEData.startTLEData(builder);
    TLEData.addLine1(builder, line1Offset);
    TLEData.addLine2(builder, line2Offset);
    TLEData.addName(builder, nameOffset);
    TLEData.addNoradId(builder, noradId);
    return TLEData.endTLEData(builder);
  }
  unpack() {
    return new TLEDataT(
      this.line1(),
      this.line2(),
      this.name(),
      this.noradId()
    );
  }
  unpackTo(_o) {
    _o.line1 = this.line1();
    _o.line2 = this.line2();
    _o.name = this.name();
    _o.noradId = this.noradId();
  }
}
class TLEDataT {
  constructor(line1 = null, line2 = null, name = null, noradId = 0) {
    this.line1 = line1;
    this.line2 = line2;
    this.name = name;
    this.noradId = noradId;
  }
  pack(builder) {
    const line1 = this.line1 !== null ? builder.createString(this.line1) : 0;
    const line2 = this.line2 !== null ? builder.createString(this.line2) : 0;
    const name = this.name !== null ? builder.createString(this.name) : 0;
    return TLEData.createTLEData(
      builder,
      line1,
      line2,
      name,
      this.noradId
    );
  }
}
export {
  TLEData,
  TLEDataT
};
