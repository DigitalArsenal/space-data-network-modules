class Vec4 {
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
  w() {
    return this.bb.readFloat64(this.bb_pos + 24);
  }
  static sizeOf() {
    return 32;
  }
  static createVec4(builder, x, y, z, w) {
    builder.prep(8, 32);
    builder.writeFloat64(w);
    builder.writeFloat64(z);
    builder.writeFloat64(y);
    builder.writeFloat64(x);
    return builder.offset();
  }
  unpack() {
    return new Vec4T(
      this.x(),
      this.y(),
      this.z(),
      this.w()
    );
  }
  unpackTo(_o) {
    _o.x = this.x();
    _o.y = this.y();
    _o.z = this.z();
    _o.w = this.w();
  }
}
class Vec4T {
  constructor(x = 0, y = 0, z = 0, w = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }
  pack(builder) {
    return Vec4.createVec4(
      builder,
      this.x,
      this.y,
      this.z,
      this.w
    );
  }
}
export {
  Vec4,
  Vec4T
};
