class Vec3 {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  x() {
    return this.bb.readFloat64(this.bb_pos);
  }
  y() {
    return this.bb.readFloat64(this.bb_pos + 8);
  }
  z() {
    return this.bb.readFloat64(this.bb_pos + 16);
  }
  static sizeOf() {
    return 24;
  }
  static createVec3(builder, x, y, z) {
    builder.prep(8, 24);
    builder.writeFloat64(z);
    builder.writeFloat64(y);
    builder.writeFloat64(x);
    return builder.offset();
  }
  unpack() {
    return new Vec3T(
      this.x(),
      this.y(),
      this.z()
    );
  }
  unpackTo(_o) {
    _o.x = this.x();
    _o.y = this.y();
    _o.z = this.z();
  }
}
class Vec3T {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  pack(builder) {
    return Vec3.createVec3(
      builder,
      this.x,
      this.y,
      this.z
    );
  }
}
export {
  Vec3,
  Vec3T
};
