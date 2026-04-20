class EncodedVec3 {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  highX() {
    return this.bb.readFloat32(this.bb_pos);
  }
  highY() {
    return this.bb.readFloat32(this.bb_pos + 4);
  }
  highZ() {
    return this.bb.readFloat32(this.bb_pos + 8);
  }
  lowX() {
    return this.bb.readFloat32(this.bb_pos + 12);
  }
  lowY() {
    return this.bb.readFloat32(this.bb_pos + 16);
  }
  lowZ() {
    return this.bb.readFloat32(this.bb_pos + 20);
  }
  static sizeOf() {
    return 24;
  }
  static createEncodedVec3(builder, high_x, high_y, high_z, low_x, low_y, low_z) {
    builder.prep(4, 24);
    builder.writeFloat32(low_z);
    builder.writeFloat32(low_y);
    builder.writeFloat32(low_x);
    builder.writeFloat32(high_z);
    builder.writeFloat32(high_y);
    builder.writeFloat32(high_x);
    return builder.offset();
  }
  unpack() {
    return new EncodedVec3T(
      this.highX(),
      this.highY(),
      this.highZ(),
      this.lowX(),
      this.lowY(),
      this.lowZ()
    );
  }
  unpackTo(_o) {
    _o.highX = this.highX();
    _o.highY = this.highY();
    _o.highZ = this.highZ();
    _o.lowX = this.lowX();
    _o.lowY = this.lowY();
    _o.lowZ = this.lowZ();
  }
}
class EncodedVec3T {
  constructor(highX = 0, highY = 0, highZ = 0, lowX = 0, lowY = 0, lowZ = 0) {
    this.highX = highX;
    this.highY = highY;
    this.highZ = highZ;
    this.lowX = lowX;
    this.lowY = lowY;
    this.lowZ = lowZ;
  }
  pack(builder) {
    return EncodedVec3.createEncodedVec3(
      builder,
      this.highX,
      this.highY,
      this.highZ,
      this.lowX,
      this.lowY,
      this.lowZ
    );
  }
}
export {
  EncodedVec3,
  EncodedVec3T
};
