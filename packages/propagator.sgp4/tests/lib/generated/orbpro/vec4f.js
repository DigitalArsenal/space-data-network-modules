class Vec4f {
  bb = null;
  bb_pos = 0;
  __init(i, bb) {
    this.bb_pos = i;
    this.bb = bb;
    return this;
  }
  x() {
    return this.bb.readFloat32(this.bb_pos);
  }
  y() {
    return this.bb.readFloat32(this.bb_pos + 4);
  }
  z() {
    return this.bb.readFloat32(this.bb_pos + 8);
  }
  w() {
    return this.bb.readFloat32(this.bb_pos + 12);
  }
  static sizeOf() {
    return 16;
  }
  static createVec4f(builder, x, y, z, w) {
    builder.prep(4, 16);
    builder.writeFloat32(w);
    builder.writeFloat32(z);
    builder.writeFloat32(y);
    builder.writeFloat32(x);
    return builder.offset();
  }
  unpack() {
    return new Vec4fT(
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
class Vec4fT {
  constructor(x = 0, y = 0, z = 0, w = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }
  pack(builder) {
    return Vec4f.createVec4f(
      builder,
      this.x,
      this.y,
      this.z,
      this.w
    );
  }
}
export {
  Vec4f,
  Vec4fT
};
